// ============================================================================
// Aether — review-positions Edge Function (P2 — revue LLM des positions tenues)
// ============================================================================
// CHAÎNON MANQUANT (diagnostic 18/06) : les positions détenues étaient ré-analysées
// chaque jour par le pipeline BUY, mais "HOLD" = "ne pas entrer", JAMAIS "sortir".
// Aucun chemin LLM ne pouvait fermer une position dont la thèse s'était cassée
// (ex. GTLB tenu en "HOLD" pendant qu'il fondait à -10%).
//
// Cette fonction, pour CHAQUE position OPEN, demande à Claude HOLD/SELL AVEC le
// contexte du holding (P&L, jours tenus, pic, thèse d'origine), et peut DÉCLENCHER
// la vente. Complète update-positions (règles prix) par une sortie qualitative.
//
// Cron : 15 15 * * 1-5 (après analyse 14:00 + sweep 14:45, marché ouvert).
// Usage manuel : GET ?dry_run=true pour simuler.
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const MODEL = "claude-sonnet-4-5-20250929";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const COST_IN = 3.0, COST_OUT = 15.0;
const MAX_HOLD_DAYS = 10;

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// --- Alpaca ---
function alpacaHeaders() {
  return {
    "APCA-API-KEY-ID": Deno.env.get("ALPACA_API_KEY_ID")!,
    "APCA-API-SECRET-KEY": Deno.env.get("ALPACA_API_SECRET_KEY")!,
    "Content-Type": "application/json",
  };
}
async function alpacaRequest<T>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status?: number; data?: T; error?: string }> {
  const base = Deno.env.get("ALPACA_API_BASE_URL")!;
  try {
    const r = await fetch(`${base}${path}`, { method, headers: alpacaHeaders(), body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) return { ok: false, status: r.status, error: (await r.text()).slice(0, 300) };
    const text = await r.text();
    return { ok: true, status: r.status, data: text ? JSON.parse(text) as T : undefined };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}
async function getMarketOpen(): Promise<boolean> {
  const r = await alpacaRequest<{ is_open: boolean }>("GET", "/v2/clock");
  return !!r.data?.is_open;
}
async function cancelOrdersForSymbol(ticker: string): Promise<number> {
  const r = await alpacaRequest<Array<{ id: string; symbol: string }>>("GET", "/v2/orders?status=open&limit=500");
  const mine = (Array.isArray(r.data) ? r.data : []).filter(o => o.symbol === ticker);
  let n = 0;
  for (const o of mine) { const d = await alpacaRequest("DELETE", `/v2/orders/${o.id}`); if (d.ok) n++; }
  return n;
}

async function getCurrentPrice(ticker: string, fmpKey: string): Promise<number | null> {
  try {
    const r = await fetch(`https://financialmodelingprep.com/stable/quote?symbol=${ticker}&apikey=${fmpKey}`);
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d) && typeof d[0]?.price === "number" ? d[0].price : null;
  } catch { return null; }
}

interface PositionRow {
  id: string; ticker: string; signal_id: string | null; opened_at: string;
  entry_price: number; quantity: number; peak_price: number | null;
}

async function closeDb(supabase: SupabaseClient, pos: PositionRow, currentPrice: number, reason: string) {
  const pnl_usd = (currentPrice - pos.entry_price) * pos.quantity;
  const pnl_pct = ((currentPrice - pos.entry_price) / pos.entry_price) * 100;
  const holdDays = Math.round((Date.now() - Date.parse(pos.opened_at)) / 86400000);
  await supabase.from("positions").update({
    status: "CLOSED", exit_price: currentPrice, closed_at: new Date().toISOString(),
    exit_reason: reason, pnl_usd, pnl_pct, hold_days: holdDays,
  }).eq("id", pos.id);
  if (pos.signal_id) await supabase.from("signals").update({ executed: true }).eq("id", pos.signal_id);
}

// AUDIT 25/06 : ne jamais survendre — lit la qty réelle Alpaca ; si le bracket a
// déjà fermé la position, réconcilie la DB sans nouvel ordre (cf incident KBH).
async function sellAtMarket(supabase: SupabaseClient, pos: PositionRow, currentPrice: number, reason: string): Promise<{ ok: boolean; error?: string; canceled: number; reconciled?: boolean }> {
  const real = await alpacaRequest<{ qty: string }>("GET", `/v2/positions/${pos.ticker}`);
  const realQty = real.ok && real.data ? Math.abs(parseFloat(real.data.qty)) : 0;
  const canceled = await cancelOrdersForSymbol(pos.ticker);
  if (realQty < 1) {
    await closeDb(supabase, pos, currentPrice, `${reason}_reconciled`);
    return { ok: true, canceled, reconciled: true };
  }
  const sellQty = Math.min(realQty, pos.quantity);
  const o = await alpacaRequest<{ id: string }>("POST", "/v2/orders", {
    symbol: pos.ticker, qty: String(sellQty), side: "sell", type: "market", time_in_force: "day",
  });
  if (!o.ok) return { ok: false, error: o.error, canceled };
  await closeDb(supabase, pos, currentPrice, reason);
  return { ok: true, canceled };
}

// --- Claude ---
const SYSTEM = `You are the Position Manager in an autonomous swing-trading system (mid-cap US, PEAD + momentum). You manage an OPEN position and must decide HOLD or SELL.

CONTEXT: hard stop-loss, trailing and give-back rules are handled by separate price logic. YOUR job is the QUALITATIVE thesis check: is the reason we own this still valid?

SELL when:
- The original thesis/catalyst is exhausted or broken (post-earnings drift faded — half-life ~6-7 days).
- Momentum clearly reversed with no fresh catalyst.
- The position is stagnating and capital would work better elsewhere.

HOLD when:
- The move is still intact and the thesis holds.
- Constructive consolidation after a gain.

Be decisive and willing to SELL — recycling capital out of dead theses beats hoping for recovery. But don't churn a healthy winner. Respond with ONLY valid JSON.`;

function userPrompt(p: {
  ticker: string; entry: number; current: number; returnPct: number; peakReturnPct: number;
  daysHeld: number; rationale: string | null; scores: Record<string, number | null>; regime: string | null;
}): string {
  return `OPEN POSITION REVIEW
Ticker: ${p.ticker}
Entry: $${p.entry.toFixed(2)} | Current: $${p.current.toFixed(2)} | Return: ${p.returnPct.toFixed(2)}%
Peak return reached: ${p.peakReturnPct.toFixed(2)}% | Days held: ${p.daysHeld} (max ${MAX_HOLD_DAYS})
Market regime: ${p.regime ?? "n/a"}

Cluster scores at entry (1-10): C1 earnings ${p.scores.c1} · C2 momentum ${p.scores.c2} · C3 smart-money ${p.scores.c3} · C4 quality ${p.scores.c4} · C5 valuation ${p.scores.c5} · C6 news ${p.scores.c6}

Original entry rationale:
${p.rationale ?? "(none)"}

Given days held vs the ~6-7d PEAD half-life and current return vs peak, decide.

Respond ONLY with:
{
  "ticker": "${p.ticker}",
  "decision": "HOLD" | "SELL",
  "thesis_status": "intact" | "fading" | "broken",
  "reason": "<1-2 sentences>"
}`;
}

async function callClaude(apiKey: string, user: string): Promise<{ ok: boolean; parsed?: Record<string, unknown>; usage?: { input_tokens?: number; output_tokens?: number }; cost: number; latency: number; error?: string }> {
  const t0 = Date.now();
  const MAX_RETRIES = 3;
  let lastErr = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 400, temperature: 0, system: SYSTEM, messages: [{ role: "user", content: user }] }),
      });
      if (r.status === 429 || r.status >= 500) {
        lastErr = `HTTP ${r.status}`;
        if (attempt < MAX_RETRIES) {
          const ra = parseFloat(r.headers.get("retry-after") ?? "");
          const backoff = Number.isFinite(ra) ? Math.min(30000, ra * 1000) : Math.min(8000, 700 * 2 ** attempt) * (0.5 + Math.random());
          await new Promise(res => setTimeout(res, backoff));
          continue;
        }
        return { ok: false, cost: 0, latency: Date.now() - t0, error: `${lastErr}: ${(await r.text()).slice(0, 200)}` };
      }
      if (!r.ok) return { ok: false, cost: 0, latency: Date.now() - t0, error: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` };
      const data = await r.json();
      const text = data.content?.find((b: { type: string }) => b.type === "text")?.text ?? "";
      let parsed: Record<string, unknown> | undefined;
      try { parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "").trim()); }
      catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch { /* */ } } }
      const cost = ((data.usage?.input_tokens ?? 0) * COST_IN + (data.usage?.output_tokens ?? 0) * COST_OUT) / 1_000_000;
      // Fail-closed : JSON illisible → ok:false (une position en revue reste HOLD par sécurité).
      if (!parsed) return { ok: false, usage: data.usage, cost, latency: Date.now() - t0, error: "json_parse_failed" };
      return { ok: true, parsed, usage: data.usage, cost, latency: Date.now() - t0 };
    } catch (e) {
      lastErr = String((e as Error).message ?? e);
      if (attempt < MAX_RETRIES) { await new Promise(res => setTimeout(res, Math.min(8000, 700 * 2 ** attempt) * (0.5 + Math.random()))); continue; }
      return { ok: false, cost: 0, latency: Date.now() - t0, error: lastErr };
    }
  }
  return { ok: false, cost: 0, latency: Date.now() - t0, error: lastErr || "unknown" };
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "true";

  const fmpKey = Deno.env.get("FMP_API_KEY");
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!fmpKey || !anthropicKey || !supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  const marketOpen = await getMarketOpen();

  const { data: positions } = await supabase.from("positions")
    .select("id, ticker, signal_id, opened_at, entry_price, quantity, peak_price")
    .eq("status", "OPEN");
  if (!positions || positions.length === 0) {
    return jsonResponse({ ok: true, mode: dryRun ? "dry_run" : "live", reviewed: 0, note: "no_open_positions", duration_ms: Date.now() - t0 }, 200);
  }

  const results: Array<Record<string, unknown>> = [];
  let sold = 0, totalCost = 0;

  for (const pos of positions as PositionRow[]) {
    const currentPrice = await getCurrentPrice(pos.ticker, fmpKey);
    if (currentPrice === null) { results.push({ ticker: pos.ticker, skipped: "no_price" }); continue; }

    const returnPct = ((currentPrice - pos.entry_price) / pos.entry_price) * 100;
    const peakReturnPct = (((pos.peak_price ?? pos.entry_price) - pos.entry_price) / pos.entry_price) * 100;
    const daysHeld = Math.round((Date.now() - Date.parse(pos.opened_at)) / 86400000);

    // Contexte thèse : dernier signal du ticker
    const { data: sig } = await supabase.from("signals")
      .select("rationale, market_regime, score_c1_earnings, score_c2_momentum, score_c3_smart_money, score_c4_quality, score_c5_valuation, score_c6_sentiment")
      .eq("ticker", pos.ticker).order("created_at", { ascending: false }).limit(1).maybeSingle();

    const c = await callClaude(anthropicKey, userPrompt({
      ticker: pos.ticker, entry: pos.entry_price, current: currentPrice, returnPct, peakReturnPct, daysHeld,
      rationale: sig?.rationale ?? null,
      regime: sig?.market_regime ?? null,
      scores: {
        c1: sig?.score_c1_earnings ?? null, c2: sig?.score_c2_momentum ?? null, c3: sig?.score_c3_smart_money ?? null,
        c4: sig?.score_c4_quality ?? null, c5: sig?.score_c5_valuation ?? null, c6: sig?.score_c6_sentiment ?? null,
      },
    }));
    totalCost += c.cost;

    await supabase.from("agent_logs").insert({
      log_type: "position_review", ticker: pos.ticker,
      input_tokens: c.usage?.input_tokens ?? null, output_tokens: c.usage?.output_tokens ?? null,
      latency_ms: c.latency, cost_usd: c.cost, raw_output: c.parsed ?? null, error: c.error ?? null,
    });

    const decision = (c.parsed?.decision as string) ?? "HOLD";
    const reason = (c.parsed?.reason as string) ?? c.error ?? "";
    const thesis = (c.parsed?.thesis_status as string) ?? null;

    let action = "kept";
    if (decision === "SELL" && !dryRun && marketOpen) {
      const s = await sellAtMarket(supabase, pos, currentPrice, "thesis_review_sell");
      action = s.ok ? "SOLD" : `sell_failed:${s.error}`;
      if (s.ok) sold++;
    } else if (decision === "SELL") {
      action = dryRun ? "would_sell_dry_run" : "sell_pending_market_closed";
    }

    results.push({ ticker: pos.ticker, decision, thesis_status: thesis, returnPct: +returnPct.toFixed(2), daysHeld, action, reason });
    await sleep(1200);  // étaler les appels Claude
  }

  const status: "ok" | "partial_error" = results.some(r => String(r.action).startsWith("sell_failed")) ? "partial_error" : "ok";
  await supabase.from("system_heartbeats").insert({
    status, cycles_completed: 1, stocks_analyzed: positions.length,
    trades_executed: dryRun ? 0 : sold,
    notes: `review-positions ${dryRun ? "DRY_RUN" : "LIVE"} | reviewed=${positions.length} | sold=${sold} | cost=$${totalCost.toFixed(4)}`,
  });

  return jsonResponse({
    ok: status === "ok",
    mode: dryRun ? "dry_run" : "live",
    market_open: marketOpen,
    reviewed: positions.length,
    sold,
    cost_usd: +totalCost.toFixed(4),
    results,
    duration_ms: Date.now() - t0,
  }, 200);
});
