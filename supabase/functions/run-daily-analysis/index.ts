// ============================================================================
// Aether — run-daily-analysis v3 (sequential batching to avoid rate limits)
// ============================================================================
// Source : STRATEGY.md Section 4 + POLISH P-021 (pipeline timeout 28 mai)
//
// PROBLEM SOLVED : v2 lançait 15 stocks en parallèle = 105 appels Anthropic
// simultanés → rate limit 429 → 3-4 pipelines incomplets (Reviewer PENDING).
//
// SOLUTION : batches séquentiels de 5 stocks en parallèle. 3 batches × 5 =
// 15 stocks total. Chaque batch ≈ 35-45s. Total ≈ 100-130s, sous le timeout
// Supabase Edge Functions Pro (400s).
//
// Bonus : entre les batches, on respecte un soft delay (1s) pour étaler les
// requêtes Anthropic.
//
// Usage :
//   GET /functions/v1/run-daily-analysis (dry_run=true par défaut, limit=15)
//   GET /functions/v1/run-daily-analysis?dry_run=false&limit=10
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const DEFAULT_LIMIT = 15;
const HARD_CAP = 25;
const BATCH_SIZE = 3;          // v3 — réduit à 3 après obs 29 mai : batches de 5 → 3 PENDING orphans car ~70 RPM peak burst dépassait 50 RPM standard tier. 3 stocks parallèles = ~21 RPM peak, safe.
const BATCH_DELAY_MS = 2000;   // bumped à 2s pour étaler davantage

interface Candidate {
  ticker: string;
  sector: string;
  days_relative: number;
  freshness_mult: number;
  eps_surprise_pct: number | null;
  rotation_tier?: string;
}

interface PipelineResult {
  ticker: string;
  ok: boolean;
  step?: string;
  status?: number;
  signal_id?: string;
  conviction?: number;
  scores?: unknown;
  final_decision?: string;
  pipeline_stopped_at?: string;
  steps_summary?: unknown;
  duration_ms?: number;
  error?: string;
  sector?: string;
  days_relative?: number;
  eps_surprise_pct?: number | null;
  rotation_tier?: string;
}

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

async function runPipelineForTicker(
  supabaseUrl: string,
  c: Candidate,
  dryRun: boolean,
): Promise<PipelineResult> {
  const tStart = Date.now();
  try {
    // Step a: calculate-scores (3 passes Claude + persist)
    const csResp = await fetch(`${supabaseUrl}/functions/v1/calculate-scores?ticker=${c.ticker}`);
    if (!csResp.ok) {
      return {
        ticker: c.ticker, ok: false, step: "calculate-scores",
        status: csResp.status, error: (await csResp.text()).slice(0, 200),
        duration_ms: Date.now() - tStart,
      };
    }
    const cs = await csResp.json();
    if (!cs.ok || !cs.signal_id) {
      return {
        ticker: c.ticker, ok: false, step: "calculate-scores",
        error: cs.error ?? "no_signal_id", scores: cs.scores,
        duration_ms: Date.now() - tStart,
      };
    }

    // Step b: decide-and-execute (researchers + trader + reviewer + validate + execute)
    const deResp = await fetch(
      `${supabaseUrl}/functions/v1/decide-and-execute?signal_id=${cs.signal_id}&dry_run=${dryRun}`,
    );
    if (!deResp.ok) {
      return {
        ticker: c.ticker, ok: false, step: "decide-and-execute", status: deResp.status,
        signal_id: cs.signal_id, conviction: cs.conviction,
        error: (await deResp.text()).slice(0, 200),
        duration_ms: Date.now() - tStart,
      };
    }
    const de = await deResp.json();
    return {
      ticker: c.ticker, sector: c.sector, days_relative: c.days_relative,
      eps_surprise_pct: c.eps_surprise_pct, rotation_tier: c.rotation_tier,
      ok: true, signal_id: cs.signal_id, scores: cs.scores, conviction: cs.conviction,
      final_decision: de.final_decision, pipeline_stopped_at: de.pipeline_stopped_at,
      steps_summary: de.steps, duration_ms: Date.now() - tStart,
    };
  } catch (e) {
    return {
      ticker: c.ticker, ok: false, step: "exception",
      error: String((e as Error).message ?? e),
      duration_ms: Date.now() - tStart,
    };
  }
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") !== "false";
  const requestedLimit = parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10);
  const limit = Math.min(Math.max(1, requestedLimit || DEFAULT_LIMIT), HARD_CAP);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  // === 1. Fetch candidates (smart rotation logic in v2) ===
  const candResp = await fetch(`${supabaseUrl}/functions/v1/select-daily-candidates`);
  if (!candResp.ok) {
    return jsonResponse({
      ok: false, error: "select_candidates_failed",
      status: candResp.status, body: (await candResp.text()).slice(0, 300),
    }, 502);
  }
  const cand = await candResp.json();
  if (!cand.candidates || cand.candidates.length === 0) {
    await supabase.from("system_heartbeats").insert({
      status: "ok", cycles_completed: 0, stocks_analyzed: 0,
      notes: "run-daily-analysis: no candidates in catalyst window today",
    });
    return jsonResponse({
      ok: true, mode: dryRun ? "dry_run" : "live", no_candidates: true,
      window: cand.window, duration_ms: Date.now() - t0,
    }, 200);
  }

  const topCandidates = cand.candidates.slice(0, limit) as Candidate[];

  // AUDIT 23/06 : heartbeat de DÉBUT — garantit une trace même si la fonction
  // timeout avant la fin (le heartbeat final n'était parfois jamais écrit →
  // monitoring aveugle). Le watchdog s'appuie dessus pour confirmer le run.
  await supabase.from("system_heartbeats").insert({
    status: "ok",
    cycles_completed: 0,
    stocks_analyzed: topCandidates.length,
    notes: `run-daily-analysis ${dryRun ? "DRY_RUN" : "LIVE"} START | candidates=${topCandidates.length}`,
  });

  // === 2. SEQUENTIAL BATCHING (P-021 fix) ===
  // Batch of BATCH_SIZE in parallel, then await before next batch.
  // Avoids saturating Anthropic rate limits (50 RPM standard tier).
  const allResults: PipelineResult[] = [];
  const batchCount = Math.ceil(topCandidates.length / BATCH_SIZE);

  for (let b = 0; b < batchCount; b++) {
    const start = b * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, topCandidates.length);
    const batch = topCandidates.slice(start, end);

    const batchResults = await Promise.allSettled(
      batch.map(c => runPipelineForTicker(supabaseUrl, c, dryRun)),
    );

    for (let i = 0; i < batchResults.length; i++) {
      const r = batchResults[i];
      if (r.status === "fulfilled") {
        allResults.push(r.value);
      } else {
        allResults.push({
          ticker: batch[i].ticker, ok: false, step: "promise_rejected",
          error: String(r.reason),
        });
      }
    }

    // Soft delay entre batches (sauf après le dernier)
    if (b < batchCount - 1) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // === 3. Aggregate ===
  const successful = allResults.filter(r => r.ok);
  const errors = allResults.filter(r => !r.ok);
  const decisions = successful.reduce((acc, r) => {
    const d = r.final_decision ?? "unknown";
    acc[d] = (acc[d] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // === 4. Heartbeat ===
  const status: "ok" | "partial_error" = errors.length === 0 ? "ok" : "partial_error";
  const { data: hb, error: hbErr } = await supabase.from("system_heartbeats").insert({
    status,
    cycles_completed: 1,
    stocks_analyzed: allResults.length,
    trades_executed: dryRun ? 0 : successful.filter(r => r.final_decision === "BUY_EXECUTED" || r.final_decision === "SELL_EXECUTED").length,
    errors: errors.length > 0 ? errors.map(e => ({
      ticker: e.ticker, step: e.step ?? "?", error: e.error ?? "?",
    })) : null,
    notes: `run-daily-analysis ${dryRun ? "DRY_RUN" : "LIVE"} END | batches=${batchCount}×${BATCH_SIZE} | analyzed=${allResults.length}/${topCandidates.length} | decisions=${JSON.stringify(decisions)}`,
  }).select("id").single();
  if (hbErr) console.error("run-daily-analysis END heartbeat insert failed:", hbErr);

  return jsonResponse({
    ok: errors.length === 0,
    mode: dryRun ? "dry_run" : "LIVE_EXECUTION",
    heartbeat_id: hb?.id,
    batching: { size: BATCH_SIZE, count: batchCount, delay_ms_between: BATCH_DELAY_MS },
    candidates_window: cand.window,
    candidates_total_available: cand.earnings_in_window_for_our_watchlist,
    candidates_attempted: topCandidates.length,
    successful: successful.length,
    errors_count: errors.length,
    decisions_breakdown: decisions,
    rotation_summary: cand.counts,
    results: allResults,
    duration_ms: Date.now() - t0,
  }, 200);
});
