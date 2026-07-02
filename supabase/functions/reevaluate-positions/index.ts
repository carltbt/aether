// ============================================================================
// Aether — reevaluate-positions Edge Function (P-006 — re-éval hebdo des positions)
// ============================================================================
// Source : STRATEGY.md v2.7 Section 8.5 (réévaluation hebdomadaire des positions).
//
// Rôle : chaque dimanche, pour CHAQUE position OPEN, re-score les clusters (via
// run-analysis-passes, sans persister de signal) → conviction fraîche 0-100 →
// palier : < 40 = thèse dégradée (à sortir) / 40-59 = surveiller / ≥ 60 = tenir.
//
// Sûreté : cette fonction NE VEND PAS elle-même (pas de nouveau chemin de sortie
// à risque d'oversell). Elle stocke reeval_conviction sur la position + ALERTE
// (Discord + heartbeat) sur les positions < 40. La SORTIE réelle reste gérée par
// review-positions (revue LLM quotidienne, durcie no-oversell) et update-positions
// (règles prix), qui disposent désormais de la conviction dégradée.
//
// Cron : 0 23 * * 0 (dimanche 23:00 UTC, avant la semaine).
// Usage manuel : GET /functions/v1/reevaluate-positions
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

// Poids par défaut (STRATEGY.md Section 5) + renormalisation des clusters manquants
// (identique à calculate-scores).
const W: Record<string, number> = { c1: 0.25, c2: 0.20, c3: 0.20, c4: 0.15, c5: 0.10, c6: 0.10 };
function computeConviction(scores: Record<string, number | null> | undefined): number | null {
  if (!scores) return null;
  let raw = 0, eff = 0;
  for (const k of Object.keys(W)) {
    const s = scores[k];
    if (typeof s === "number") { raw += s * W[k]; eff += W[k]; }
  }
  return eff > 0 ? Math.round((raw / eff) * 10) : null;
}

async function postDiscord(text: string) {
  const url = Deno.env.get("DISCORD_WEBHOOK_URL");
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text }) });
  } catch { /* best-effort */ }
}

Deno.serve(async () => {
  const t0 = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: open } = await supabase.from("positions").select("id, ticker, signal_id").eq("status", "OPEN");
  if (!open || open.length === 0) return jsonResponse({ ok: true, note: "no_open_positions", duration_ms: Date.now() - t0 }, 200);

  const results: Array<Record<string, unknown>> = [];
  const decayed: Array<{ ticker: string; conviction: number; entry: number | null }> = [];

  for (const p of open) {
    const ticker = p.ticker as string;
    // Re-score (run-analysis-passes ne persiste PAS de signal → pas de pollution).
    let reeval: number | null = null;
    try {
      const r = await fetch(`${supabaseUrl}/functions/v1/run-analysis-passes?ticker=${ticker}`, { headers: { "Authorization": `Bearer ${anonKey}` } });
      if (r.ok) { const d = await r.json(); reeval = computeConviction(d.scores); }
    } catch (e) { console.error("reeval fetch failed:", ticker, (e as Error).message); }

    // Conviction d'entrée (via signal_id — les tickers tenus sont exclus de l'univers,
    // donc le signal lié EST bien celui d'entrée).
    let entryConv: number | null = null;
    if (p.signal_id) {
      const { data: sig } = await supabase.from("signals").select("conviction").eq("id", p.signal_id).maybeSingle();
      entryConv = (sig?.conviction as number | null) ?? null;
    }

    await supabase.from("positions").update({ reeval_conviction: reeval, reeval_at: new Date().toISOString() }).eq("id", p.id);
    results.push({ ticker, entry_conviction: entryConv, reeval_conviction: reeval, tier: reeval === null ? "unknown" : reeval < 40 ? "EXIT(<40)" : reeval < 60 ? "watch(40-59)" : "hold(>=60)" });
    if (typeof reeval === "number" && reeval < 40) decayed.push({ ticker, conviction: reeval, entry: entryConv });
  }

  await supabase.from("system_heartbeats").insert({
    status: decayed.length ? "partial_error" : "ok",
    cycles_completed: 1, stocks_analyzed: open.length,
    notes: `reevaluate-positions | ${open.length} positions | decayed(<40)=${decayed.length}${decayed.length ? " : " + decayed.map(d => `${d.ticker}=${d.conviction}`).join(", ") : ""}`,
  });

  if (decayed.length > 0) {
    await postDiscord(`🔁 **Aether P-006** — position(s) à conviction < 40 (thèse dégradée) : ${decayed.map(d => `${d.ticker} ${d.conviction} (entrée ${d.entry ?? "?"})`).join(", ")}. review-positions tranchera la sortie.`);
  }

  return jsonResponse({ ok: true, positions: open.length, decayed_count: decayed.length, decayed, results, duration_ms: Date.now() - t0 }, 200);
});
