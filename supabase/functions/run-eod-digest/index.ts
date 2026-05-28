// ============================================================================
// Aether — run-eod-digest Edge Function (Phase 4 step 20 — heartbeat + digest)
// ============================================================================
// Source : STRATEGY.md v2.7 Section 8.5 (heartbeat monitoring + email digest)
//
// Rôle : à 16h15 ET (20h15 UTC) après clôture marché :
//   1. Compute summary du jour (positions, trades exécutés, P&L, coût Claude)
//   2. Insert heartbeat dans system_heartbeats (status, counts, errors)
//   3. (Optionnel) Envoyer email digest si RESEND_API_KEY défini
//
// Si RESEND_API_KEY absent → skip email, juste heartbeat (V1 acceptable).
// Pour activer : Resend free tier 3000 emails/mois, set RESEND_API_KEY dans
// Supabase Edge Function secrets.
//
// Usage : GET /functions/v1/run-eod-digest (one-shot, ou via pg_cron)
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const ADMIN_EMAIL = "aether.trader.project@gmail.com";

interface SignalRow {
  id: string;
  ticker: string;
  action: string;
  conviction: number;
  executed: boolean;
  rationale: string | null;
  created_at: string;
  alpaca_order_id: string | null;
}
interface PositionRow {
  id: string;
  ticker: string;
  status: string;
  pnl_usd: number | null;
  pnl_pct: number | null;
}
interface HeartbeatStatus {
  status: "ok" | "skipped_market_closed" | "partial_error" | "full_error";
  cycles_completed: number;
  trades_executed: number;
  stocks_analyzed: number;
  errors: string[];
}

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

function isoToday(): string { return new Date().toISOString().slice(0, 10); }

async function alpacaGet<T>(path: string): Promise<{ ok: boolean; data?: T; error?: string }> {
  const base = Deno.env.get("ALPACA_API_BASE_URL")!;
  const keyId = Deno.env.get("ALPACA_API_KEY_ID")!;
  const secret = Deno.env.get("ALPACA_API_SECRET_KEY")!;
  try {
    const r = await fetch(`${base}${path}`, { headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret } });
    if (!r.ok) return { ok: false, error: `${r.status}: ${(await r.text()).slice(0, 200)}` };
    return { ok: true, data: await r.json() as T };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

async function buildDigest(supabase: SupabaseClient) {
  const today = isoToday();
  const startOfDay = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";

  // 1. Signals analyzed today
  const { data: signalsToday, count: signalsCount } = await supabase
    .from("signals")
    .select("*", { count: "exact" })
    .gte("created_at", startOfDay);

  const executedToday = (signalsToday as SignalRow[] | null ?? []).filter(s => s.executed);

  // 2. Open positions
  const { data: openPositions } = await supabase
    .from("positions")
    .select("*")
    .eq("status", "OPEN");

  // 3. Closed today
  const { data: closedToday } = await supabase
    .from("positions")
    .select("*")
    .eq("status", "CLOSED")
    .gte("closed_at", startOfDay);

  // 4. Claude cost today
  const { data: logs } = await supabase
    .from("agent_logs")
    .select("cost_usd")
    .gte("created_at", startOfDay);
  const costToday = (logs ?? []).reduce((sum, l) => sum + Number(l.cost_usd ?? 0), 0);

  // 5. Alpaca account snapshot
  const account = await alpacaGet<{ cash: string; portfolio_value: string; buying_power: string; daytrading_buying_power: string; last_equity: string }>("/v2/account");
  const totalValue = account.ok && account.data ? parseFloat(account.data.portfolio_value) : null;
  const cash = account.ok && account.data ? parseFloat(account.data.cash) : null;
  const lastEquity = account.ok && account.data ? parseFloat(account.data.last_equity) : null;
  const dayReturnPct = (totalValue && lastEquity && lastEquity > 0) ? ((totalValue - lastEquity) / lastEquity) * 100 : null;

  // 6. Today's P&L from closed
  const realizedPnlUsd = (closedToday as PositionRow[] | null ?? []).reduce((sum, p) => sum + Number(p.pnl_usd ?? 0), 0);

  // 7. Daily context
  const { data: ctx } = await supabase
    .from("daily_context")
    .select("market_regime, vix, spy_vs_sma50")
    .order("context_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    date: today,
    portfolio: {
      total_value_usd: totalValue,
      cash_usd: cash,
      day_return_pct: dayReturnPct,
      open_positions_count: (openPositions ?? []).length,
      realized_pnl_today_usd: realizedPnlUsd,
    },
    activity: {
      signals_analyzed_today: signalsCount ?? 0,
      trades_executed_today: executedToday.length,
      positions_closed_today: (closedToday ?? []).length,
      executed_trades: executedToday.map(s => ({ ticker: s.ticker, action: s.action, conviction: s.conviction, alpaca_order_id: s.alpaca_order_id })),
    },
    regime: {
      market_regime: ctx?.market_regime ?? "unknown",
      vix: ctx?.vix ?? null,
      spy_vs_sma50: ctx?.spy_vs_sma50 ?? null,
    },
    cost_today_usd: costToday,
    open_positions: (openPositions ?? []).map(p => ({ ticker: p.ticker, status: p.status })),
  };
}

function buildEmailBody(digest: Awaited<ReturnType<typeof buildDigest>>): { subject: string; html: string; text: string } {
  const p = digest.portfolio;
  const subject = `[Aether] ${digest.date} — P&L: ${p.day_return_pct !== null ? (p.day_return_pct >= 0 ? "+" : "") + p.day_return_pct.toFixed(2) + "%" : "?"} | ${digest.activity.trades_executed_today} trades | ${p.open_positions_count} positions`;

  const text = `AETHER EOD DIGEST — ${digest.date}

PORTFOLIO
- Total value: $${p.total_value_usd?.toFixed(2) ?? "?"}
- Cash: $${p.cash_usd?.toFixed(2) ?? "?"}
- Day return: ${p.day_return_pct !== null ? (p.day_return_pct >= 0 ? "+" : "") + p.day_return_pct.toFixed(2) + "%" : "?"}
- Open positions: ${p.open_positions_count}
- Realized P&L today: $${p.realized_pnl_today_usd.toFixed(2)}

ACTIVITY
- Signals analyzed: ${digest.activity.signals_analyzed_today}
- Trades executed: ${digest.activity.trades_executed_today}
- Positions closed: ${digest.activity.positions_closed_today}
${digest.activity.executed_trades.map(t => `  ${t.action} ${t.ticker} conv=${t.conviction} (Alpaca ${t.alpaca_order_id ?? "?"})`).join("\n")}

REGIME
- Market regime: ${digest.regime.market_regime}
- VIX: ${digest.regime.vix ?? "?"}
- SPY vs SMA50: ${digest.regime.spy_vs_sma50 ?? "?"}

COST
- Anthropic spend today: $${digest.cost_today_usd.toFixed(4)}

OPEN POSITIONS
${digest.open_positions.length > 0 ? digest.open_positions.map(p => `  ${p.ticker} (${p.status})`).join("\n") : "  (none)"}
`;

  const html = `<pre style="font-family: monospace; font-size: 13px;">${text.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;

  return { subject, html, text };
}

async function sendEmailResend(to: string, subject: string, html: string, text: string, apiKey: string): Promise<{ ok: boolean; error?: string; messageId?: string }> {
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Aether <onboarding@resend.dev>", to: [to], subject, html, text }),
    });
    if (!r.ok) return { ok: false, error: `${r.status}: ${(await r.text()).slice(0, 300)}` };
    const data = await r.json();
    return { ok: true, messageId: data.id };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

// ζ — Discord webhook alert
async function sendDiscordWebhook(webhookUrl: string, content: string, urgent = false): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Aether",
        avatar_url: "https://i.imgur.com/AfFp7pu.png",
        content: urgent ? `@here 🚨 ${content}` : content,
      }),
    });
    if (!r.ok) return { ok: false, error: `${r.status}: ${(await r.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

function buildDiscordSummary(digest: Awaited<ReturnType<typeof buildDigest>>, alerts: string[]): { content: string; urgent: boolean } {
  const p = digest.portfolio;
  const pnlEmoji = (p.day_return_pct ?? 0) >= 0 ? "📈" : "📉";
  const tradesEmoji = digest.activity.trades_executed_today > 0 ? "💸" : "💤";
  const costEmoji = digest.cost_today_usd > 5 ? "💰" : "💵";

  let content = `**Aether EOD ${digest.date}**\n`;
  content += `${pnlEmoji} P&L: ${p.day_return_pct !== null ? (p.day_return_pct >= 0 ? "+" : "") + p.day_return_pct.toFixed(2) + "%" : "?"} | ${tradesEmoji} ${digest.activity.trades_executed_today} trades | 📊 ${digest.activity.signals_analyzed_today} signals | ${costEmoji} $${digest.cost_today_usd.toFixed(3)}\n`;
  content += `🌍 Regime: **${digest.regime.market_regime}** (VIX ${digest.regime.vix?.toFixed(2) ?? "?"})\n`;
  if (digest.open_positions.length > 0) {
    content += `📂 Open: ${digest.open_positions.map(p => p.ticker).join(", ")}\n`;
  }
  if (alerts.length > 0) {
    content += `\n⚠️ **ALERTS** :\n${alerts.map(a => `• ${a}`).join("\n")}`;
  }
  return { content, urgent: alerts.length > 0 };
}

Deno.serve(async () => {
  const t0 = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");  // Optionnel
  if (!supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  // 1. Build digest
  let digest: Awaited<ReturnType<typeof buildDigest>>;
  const errors: string[] = [];
  try {
    digest = await buildDigest(supabase);
  } catch (e) {
    const errMsg = String((e as Error).message ?? e);
    errors.push(`digest_build_failed: ${errMsg}`);
    // Heartbeat partial_error
    await supabase.from("system_heartbeats").insert({
      status: "full_error",
      errors: { build_error: errMsg },
      notes: "EOD digest build failed",
    });
    return jsonResponse({ ok: false, error: "digest_build_failed", detail: errMsg }, 500);
  }

  // 2. Heartbeat
  const status: HeartbeatStatus["status"] = errors.length === 0 ? "ok" : "partial_error";
  const { data: heartbeat } = await supabase.from("system_heartbeats").insert({
    status,
    cycles_completed: digest.activity.signals_analyzed_today,
    trades_executed: digest.activity.trades_executed_today,
    stocks_analyzed: digest.activity.signals_analyzed_today,
    errors: errors.length > 0 ? errors : null,
    notes: `EOD digest ${digest.date} — regime=${digest.regime.market_regime}, day_return=${digest.portfolio.day_return_pct?.toFixed(2) ?? "?"}%, cost=$${digest.cost_today_usd.toFixed(4)}`,
  }).select("id").single();

  // 3. Email (optional)
  let emailResult: { sent: boolean; messageId?: string; error?: string; reason?: string } = { sent: false };
  const email = buildEmailBody(digest);
  if (resendKey) {
    const send = await sendEmailResend(ADMIN_EMAIL, email.subject, email.html, email.text, resendKey);
    emailResult = send.ok
      ? { sent: true, messageId: send.messageId }
      : { sent: false, error: send.error };
  } else {
    emailResult = { sent: false, reason: "no_resend_api_key_configured" };
  }

  // 4. ζ — Discord webhook (optional, alert on anomalies)
  const discordWebhook = Deno.env.get("DISCORD_WEBHOOK_URL");
  const discordAlerts: string[] = [];
  if (status !== "ok") discordAlerts.push(`System status: ${status}`);
  if (digest.cost_today_usd > 10) discordAlerts.push(`High cost: $${digest.cost_today_usd.toFixed(2)} (cap > $10)`);
  if (digest.activity.signals_analyzed_today === 0 && new Date().getUTCDay() >= 1 && new Date().getUTCDay() <= 5) {
    discordAlerts.push(`Weekday + 0 signals analyzed — cron may have failed`);
  }
  let discordResult: { sent: boolean; error?: string; reason?: string } = { sent: false };
  if (discordWebhook) {
    const { content, urgent } = buildDiscordSummary(digest, discordAlerts);
    const send = await sendDiscordWebhook(discordWebhook, content, urgent);
    discordResult = send.ok ? { sent: true } : { sent: false, error: send.error };
  } else {
    discordResult = { sent: false, reason: "no_discord_webhook_url_configured" };
  }

  return jsonResponse({
    ok: true,
    date: digest.date,
    heartbeat_id: heartbeat?.id,
    digest,
    email: emailResult,
    discord: discordResult,
    discord_alerts: discordAlerts,
    email_subject_preview: email.subject,
    duration_ms: Date.now() - t0,
  }, 200);
});
