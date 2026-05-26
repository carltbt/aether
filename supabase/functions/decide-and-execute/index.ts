// ============================================================================
// Aether — decide-and-execute Edge Function (Phase 3 orchestrator)
// ============================================================================
// Source : STRATEGY.md v2.7 Section 4 — pipeline complet post-scoring
//
// Rôle : prend un signal_id (issu de calculate-scores) et orchestre les
// 5 étapes Phase 3 :
//   1. Si conviction < 60 → DONE (signal reste HOLD, pas d'exécution)
//   2. run-researchers (Bull + Bear parallel)
//   3. generate-decision (Trader Guided Mode)
//   4. review-decision (Reviewer 3 perspectives)
//   5. validate-order (Couche 2 code)
//   6. execute-order (Alpaca bracket) si tout APPROVE
//
// Usage : POST { signal_id } OR GET ?signal_id=X
// Optional : dry_run=true pour stopper avant l'envoi Alpaca
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

interface Body { signal_id?: string; ticker?: string; dry_run?: boolean; }

const CONVICTION_BUY_THRESHOLD = 60;

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

async function callInternal(supabaseUrl: string, fn: string, body?: unknown): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  try {
    const r = await fetch(`${supabaseUrl}/functions/v1/${fn}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data: data ?? undefined };
  } catch (e) {
    return { ok: false, status: 0, error: String((e as Error).message ?? e) };
  }
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  let signalId: string | undefined;
  let ticker: string | undefined;
  let dry_run = false;

  if (req.method === "POST") {
    try {
      const body = await req.json() as Body;
      signalId = body.signal_id;
      ticker = body.ticker?.toUpperCase();
      dry_run = body.dry_run === true;
    } catch (e) {
      return jsonResponse({ ok: false, error: "invalid_json_body" }, 400);
    }
  } else {
    const url = new URL(req.url);
    signalId = url.searchParams.get("signal_id") ?? undefined;
    ticker = url.searchParams.get("ticker")?.toUpperCase();
    dry_run = url.searchParams.get("dry_run") === "true";
  }

  // --- Load signal ---
  let sigQuery = supabase.from("signals").select("*").order("created_at", { ascending: false }).limit(1);
  if (signalId) sigQuery = supabase.from("signals").select("*").eq("id", signalId).limit(1);
  else if (ticker) sigQuery = supabase.from("signals").select("*").eq("ticker", ticker).order("created_at", { ascending: false }).limit(1);
  const { data: sig } = await sigQuery.maybeSingle();
  if (!sig) return jsonResponse({ ok: false, error: "signal_not_found", hint: "Run calculate-scores first" }, 404);
  signalId = sig.id;
  ticker = sig.ticker;

  const steps: Record<string, unknown> = {};

  // --- STEP 1 : Gate sur conviction ---
  if (sig.conviction < CONVICTION_BUY_THRESHOLD) {
    return jsonResponse({
      ok: true,
      ticker,
      signal_id: signalId,
      final_decision: "HOLD",
      reason: `conviction_${sig.conviction}_below_threshold_${CONVICTION_BUY_THRESHOLD}`,
      pipeline_stopped_at: "step_1_conviction_gate",
      duration_ms: Date.now() - t0,
    }, 200);
  }

  // --- STEP 2 : Researchers (Bull + Bear parallel) ---
  const researchers = await callInternal(supabaseUrl!, `run-researchers?ticker=${ticker}`);
  steps.step2_researchers = {
    ok: researchers.ok,
    status: researchers.status,
    error: researchers.error,
    bull_log_id: (researchers.data as { bull_case?: { log_id?: string } })?.bull_case?.log_id,
    bear_log_id: (researchers.data as { bear_case?: { log_id?: string } })?.bear_case?.log_id,
  };
  if (!researchers.ok) {
    return jsonResponse({ ok: false, ticker, signal_id: signalId, pipeline_stopped_at: "step_2_researchers", steps, duration_ms: Date.now() - t0 }, 502);
  }

  // --- STEP 3 : Trader (generate-decision) ---
  const trader = await callInternal(supabaseUrl!, `generate-decision?ticker=${ticker}&signal_id=${signalId}`);
  steps.step3_trader = {
    ok: trader.ok,
    status: trader.status,
    error: trader.error,
    action: (trader.data as { decision?: { action?: string } })?.decision?.action,
    conviction_adjusted: (trader.data as { decision?: { conviction?: number } })?.decision?.conviction,
    strategy_used: (trader.data as { decision?: { strategy_used?: string } })?.decision?.strategy_used,
  };
  if (!trader.ok) {
    return jsonResponse({ ok: false, ticker, signal_id: signalId, pipeline_stopped_at: "step_3_trader", steps, duration_ms: Date.now() - t0 }, 502);
  }

  const traderAction = (trader.data as { decision?: { action?: string } })?.decision?.action;
  if (traderAction === "HOLD") {
    return jsonResponse({
      ok: true,
      ticker,
      signal_id: signalId,
      final_decision: "HOLD",
      reason: "trader_chose_HOLD_despite_conviction_above_threshold",
      pipeline_stopped_at: "step_3_trader",
      steps,
      duration_ms: Date.now() - t0,
    }, 200);
  }

  // --- STEP 4 : Reviewer ---
  const reviewer = await callInternal(supabaseUrl!, `review-decision?signal_id=${signalId}`);
  steps.step4_reviewer = {
    ok: reviewer.ok,
    status: reviewer.status,
    error: reviewer.error,
    verdict: (reviewer.data as { review?: { verdict?: string } })?.review?.verdict,
    size_adjustment_pct: (reviewer.data as { review?: { size_adjustment_pct?: number } })?.review?.size_adjustment_pct,
    blocking_issues: (reviewer.data as { review?: { blocking_issues?: string[] } })?.review?.blocking_issues,
  };
  if (!reviewer.ok) {
    return jsonResponse({ ok: false, ticker, signal_id: signalId, pipeline_stopped_at: "step_4_reviewer", steps, duration_ms: Date.now() - t0 }, 502);
  }

  const reviewerVerdict = (reviewer.data as { review?: { verdict?: string } })?.review?.verdict;
  if (reviewerVerdict !== "APPROVE") {
    return jsonResponse({
      ok: true,
      ticker,
      signal_id: signalId,
      final_decision: "HOLD",
      reason: `reviewer_${reviewerVerdict}`,
      pipeline_stopped_at: "step_4_reviewer",
      steps,
      duration_ms: Date.now() - t0,
    }, 200);
  }

  // --- STEP 5 : Code validation (Couche 2) ---
  const validation = await callInternal(supabaseUrl!, `validate-order?signal_id=${signalId}`);
  steps.step5_validation = {
    ok: validation.ok,
    status: validation.status,
    approve: (validation.data as { validation?: { approve?: boolean } })?.validation?.approve,
    reject_reasons: (validation.data as { validation?: { reject_reasons?: string[] } })?.validation?.reject_reasons,
    correlation_note: (validation.data as { validation?: { correlation_note?: string } })?.validation?.correlation_note,
    position_size_pct_final: (validation.data as { validation?: { position_size_pct_final?: number } })?.validation?.position_size_pct_final,
  };
  if (!validation.ok || !(validation.data as { validation?: { approve?: boolean } })?.validation?.approve) {
    return jsonResponse({
      ok: true,
      ticker,
      signal_id: signalId,
      final_decision: "HOLD",
      reason: "code_validation_rejected",
      pipeline_stopped_at: "step_5_validation",
      steps,
      duration_ms: Date.now() - t0,
    }, 200);
  }

  // --- STEP 6 : Execute (Alpaca) ---
  const execution = await callInternal(supabaseUrl!, `execute-order`, { signal_id: signalId, dry_run });
  steps.step6_execution = {
    ok: execution.ok,
    status: execution.status,
    error: execution.error,
    alpaca_order_id: (execution.data as { alpaca_order_id?: string })?.alpaca_order_id,
    position_id: (execution.data as { position_id?: string })?.position_id,
    dry_run,
    skipped: (execution.data as { skipped?: string })?.skipped,
  };

  return jsonResponse({
    ok: execution.ok,
    ticker,
    signal_id: signalId,
    final_decision: traderAction,
    pipeline_completed: execution.ok,
    dry_run,
    steps,
    duration_ms: Date.now() - t0,
  }, 200);
});
