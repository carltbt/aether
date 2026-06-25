// ============================================================================
// Aether — ops-watchdog Edge Function (P2 observabilité — diagnostic 23/06)
// ============================================================================
// PROBLÈME : "monitoring aveugle". run-daily-analysis n'écrivait pas de heartbeat
// certains jours alors qu'il tournait → on ne savait pas s'il s'exécutait.
//
// SOLUTION : une fonction qui, en fin de séance, vérifie que TOUT a tourné et
// que l'état est sain, et ALERTE (Discord) sinon. Les fonctions écrivent
// désormais des heartbeats START/END ; le watchdog les contrôle.
//
// Contrôles (jours de bourse seulement — gate = ligne daily_context du jour) :
//   1. run-daily-analysis a-t-il un heartbeat aujourd'hui ?
//   2. review-positions a-t-il tourné ?
//   3. orphelins BUY/PENDING > 24h ? (devrait être 0)
//   4. bracket sanity : positions ouvertes mais 0 ordre Alpaca = stops absents 🚨
//
// Cron : 45 16 * * 1-5 (après analysis 14:00 / sweep 14:45 / review 15:15).
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

async function postDiscord(text: string) {
  const url = Deno.env.get("DISCORD_WEBHOOK_URL");
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text }) });
  } catch { /* best-effort */ }
}

async function alpacaGet<T>(path: string): Promise<T | null> {
  const base = Deno.env.get("ALPACA_API_BASE_URL");
  const keyId = Deno.env.get("ALPACA_API_KEY_ID");
  const secret = Deno.env.get("ALPACA_API_SECRET_KEY");
  if (!base || !keyId || !secret) return null;
  try {
    const r = await fetch(`${base}${path}`, { headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret } });
    if (!r.ok) return null;
    return await r.json() as T;
  } catch {
    return null;
  }
}

Deno.serve(async () => {
  const t0 = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  const todayStr = new Date().toISOString().slice(0, 10);
  const dow = new Date().getUTCDay();
  const isWeekday = dow >= 1 && dow <= 5;

  // Gate jour de bourse : présence d'une ligne daily_context du jour (proxy interne,
  // pas besoin de l'Alpaca clock). Pas de daily_context un jour ouvré = alerte.
  const { data: ctxToday } = await supabase
    .from("daily_context").select("context_date").eq("context_date", todayStr).maybeSingle();
  const hasContext = !!ctxToday;

  if (!isWeekday) {
    return jsonResponse({ ok: true, skipped: "weekend", date: todayStr, duration_ms: Date.now() - t0 }, 200);
  }

  const alerts: string[] = [];
  if (!hasContext) alerts.push("⚠️ daily_context manquant aujourd'hui (fetch-daily-context KO ?)");

  // 1+2. Heartbeats du jour
  const { data: hbToday } = await supabase
    .from("system_heartbeats").select("notes").gte("recorded_at", `${todayStr}T00:00:00Z`);
  const notes = (hbToday ?? []).map(h => String(h.notes ?? ""));
  const ranAnalysis = notes.some(n => n.startsWith("run-daily-analysis"));
  const ranReview = notes.some(n => n.startsWith("review-positions"));
  if (!ranAnalysis) alerts.push("🔴 run-daily-analysis : AUCUN heartbeat aujourd'hui");
  if (!ranReview) alerts.push("🟠 review-positions : aucun heartbeat aujourd'hui");

  // 3. Orphelins BUY/PENDING > 24h
  const { count: orphanCount } = await supabase
    .from("signals").select("id", { count: "exact", head: true })
    .eq("action", "BUY").eq("reviewer_verdict", "PENDING")
    .lt("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  if ((orphanCount ?? 0) > 0) alerts.push(`🟠 ${orphanCount} orphelin(s) BUY/PENDING > 24h`);

  // 4. Bracket sanity (Alpaca) : positions ouvertes mais 0 ordre ouvert = stops absents
  const positions = await alpacaGet<Array<{ symbol: string }>>("/v2/positions");
  const orders = await alpacaGet<Array<{ id: string }>>("/v2/orders?status=open&limit=500");
  const posCount = Array.isArray(positions) ? positions.length : null;
  const ordCount = Array.isArray(orders) ? orders.length : null;
  if (posCount !== null && ordCount !== null && posCount > 0 && ordCount === 0) {
    alerts.push(`🔴 ${posCount} position(s) Alpaca mais 0 ordre ouvert = brackets/stops ABSENTS`);
  }

  const status: "ok" | "partial_error" = alerts.length === 0 ? "ok" : "partial_error";

  await supabase.from("system_heartbeats").insert({
    status, cycles_completed: 1, stocks_analyzed: 0,
    notes: `ops-watchdog ${status} | analysis=${ranAnalysis} review=${ranReview} ctx=${hasContext} orphans=${orphanCount ?? "?"} pos=${posCount ?? "?"} orders=${ordCount ?? "?"}${alerts.length ? " | ALERTS: " + alerts.join(" ; ") : ""}`,
  });

  if (alerts.length > 0) {
    await postDiscord(`🐕 **Aether watchdog** (${todayStr})\n${alerts.join("\n")}`);
  }

  return jsonResponse({
    ok: status === "ok",
    date: todayStr,
    checks: { has_context: hasContext, ran_analysis: ranAnalysis, ran_review: ranReview, orphans_over_24h: orphanCount ?? null, alpaca_positions: posCount, alpaca_open_orders: ordCount },
    alerts,
    duration_ms: Date.now() - t0,
  }, 200);
});
