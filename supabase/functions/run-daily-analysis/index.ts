// ============================================================================
// Aether — run-daily-analysis Edge Function (Phase 4 step 16 — quotidien)
// ============================================================================
// Source : STRATEGY.md v2.7 Section 4 (scheduler block) + POLISH P-019
//
// Rôle : orchestrateur quotidien (lun-ven 11h UTC = 7h ET) :
//   1. Appel `select-daily-candidates` → top tickers fenêtre catalyseur
//   2. Pour chaque top candidat (cap V1 = 5 en parallèle pour fit timeout) :
//      - calculate-scores (3 passes Claude + conviction + persist signal)
//      - decide-and-execute (researchers + trader + reviewer + validate + execute)
//   3. Aggrégation : combien BUY, HOLD, REJECT, erreurs
//   4. Heartbeat partiel (l'eod-digest finalise)
//
// SECURITY : ?dry_run=true par défaut pour V1 (PAS d'ordre Alpaca réel).
// Pour passer en LIVE EXECUTION : explicitly ?dry_run=false.
//
// CONCURRENCY : top 5 en parallèle. Chaque chain = ~30-40s.
// Cap 5 pour rester ~60s total et ne pas saturer Anthropic rate limits.
// Pour aller au-delà : pg_cron multiples avec offsets, OU background tasks.
//
// Usage :
//   GET /functions/v1/run-daily-analysis (dry_run=true par défaut)
//   GET /functions/v1/run-daily-analysis?dry_run=false&limit=10
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const DEFAULT_LIMIT = 5;
const HARD_CAP = 15;  // V2 — bumped après observation : 25 en parallèle = trop (timeout 50s + anthropic rate limits). 15 = sweet spot empirique.

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") !== "false";  // default TRUE (safe)
  const requestedLimit = parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10);
  const limit = Math.min(Math.max(1, requestedLimit || DEFAULT_LIMIT), HARD_CAP);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  // 1. Fetch candidates
  const candResp = await fetch(`${supabaseUrl}/functions/v1/select-daily-candidates`);
  if (!candResp.ok) {
    return jsonResponse({ ok: false, error: "select_candidates_failed", status: candResp.status, body: (await candResp.text()).slice(0, 300) }, 502);
  }
  const cand = await candResp.json();
  if (!cand.candidates || cand.candidates.length === 0) {
    // Heartbeat
    await supabase.from("system_heartbeats").insert({
      status: "ok",
      cycles_completed: 0,
      stocks_analyzed: 0,
      notes: "run-daily-analysis: no candidates in catalyst window today",
    });
    return jsonResponse({
      ok: true,
      mode: dryRun ? "dry_run" : "live",
      no_candidates: true,
      window: cand.window,
      duration_ms: Date.now() - t0,
    }, 200);
  }

  const topCandidates = cand.candidates.slice(0, limit) as Array<{ ticker: string; sector: string; days_relative: number; freshness_mult: number; eps_surprise_pct: number | null }>;

  // 2. Run pipeline per ticker EN PARALLÈLE (cap = limit)
  const pipelineResults = await Promise.allSettled(
    topCandidates.map(async (c) => {
      const tStart = Date.now();
      // Step a: calculate-scores
      const csResp = await fetch(`${supabaseUrl}/functions/v1/calculate-scores?ticker=${c.ticker}`);
      if (!csResp.ok) {
        return { ticker: c.ticker, ok: false, step: "calculate-scores", status: csResp.status, error: (await csResp.text()).slice(0, 200), duration_ms: Date.now() - tStart };
      }
      const cs = await csResp.json();
      if (!cs.ok || !cs.signal_id) {
        return { ticker: c.ticker, ok: false, step: "calculate-scores", error: cs.error ?? "no_signal_id", scores: cs.scores, duration_ms: Date.now() - tStart };
      }
      const signalId = cs.signal_id;
      const conviction = cs.conviction;

      // Step b: decide-and-execute (avec dry_run flag)
      const deUrl = `${supabaseUrl}/functions/v1/decide-and-execute?signal_id=${signalId}&dry_run=${dryRun}`;
      const deResp = await fetch(deUrl);
      if (!deResp.ok) {
        return { ticker: c.ticker, ok: false, step: "decide-and-execute", status: deResp.status, signal_id: signalId, conviction, error: (await deResp.text()).slice(0, 200), duration_ms: Date.now() - tStart };
      }
      const de = await deResp.json();
      return {
        ticker: c.ticker,
        sector: c.sector,
        days_relative: c.days_relative,
        eps_surprise_pct: c.eps_surprise_pct,
        ok: true,
        signal_id: signalId,
        scores: cs.scores,
        conviction,
        final_decision: de.final_decision,
        pipeline_stopped_at: de.pipeline_stopped_at,
        steps_summary: de.steps,
        duration_ms: Date.now() - tStart,
      };
    }),
  );

  // 3. Aggregate
  const all = pipelineResults.map((r, i) => r.status === "fulfilled" ? r.value : { ticker: topCandidates[i].ticker, ok: false, step: "promise_rejected", error: String(r.reason) });
  const successful = all.filter(r => r.ok);
  const decisions = successful.reduce((acc, r) => {
    const d = (r as { final_decision?: string }).final_decision ?? "unknown";
    acc[d] = (acc[d] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const errors = all.filter(r => !r.ok);

  // 4. Heartbeat (intermédiaire — l'eod-digest finalisera)
  const status: "ok" | "partial_error" = errors.length === 0 ? "ok" : "partial_error";
  const { data: hb } = await supabase.from("system_heartbeats").insert({
    status,
    cycles_completed: 1,
    stocks_analyzed: all.length,
    trades_executed: 0,  // dry_run mode → no real trades
    errors: errors.length > 0 ? errors.map(e => ({ ticker: (e as { ticker: string }).ticker, error: (e as { error?: string }).error ?? "?" })) : null,
    notes: `run-daily-analysis ${dryRun ? "DRY_RUN" : "LIVE"} | analyzed=${all.length}/${topCandidates.length} | decisions=${JSON.stringify(decisions)}`,
  }).select("id").single();

  return jsonResponse({
    ok: errors.length === 0,
    mode: dryRun ? "dry_run" : "LIVE_EXECUTION",
    heartbeat_id: hb?.id,
    candidates_window: cand.window,
    candidates_total_available: cand.earnings_in_window_for_our_watchlist,
    candidates_attempted: topCandidates.length,
    successful: successful.length,
    errors_count: errors.length,
    decisions_breakdown: decisions,
    results: all,
    duration_ms: Date.now() - t0,
  }, 200);
});
