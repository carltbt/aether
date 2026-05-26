// ============================================================================
// Aether — calculate-scores Edge Function
// ============================================================================
// Source : STRATEGY.md v2.7 Section 5 (conviction formula) + Section 8.5 cold start
//
// Rôle : compose les 6 scores cluster en conviction (0-100) + persiste dans
// la table `signals`. Préliminaire — le Trader (Phase 3) raffinera l'action
// et le sizing.
//
// Cold start (S1-4) : poids fixes par défaut (25/20/20/15/10/10).
// S5+ : récupère les poids de la dernière `strategies` row (boucle dimanche).
//
// Modes :
//   GET ?ticker=INCY              → fetch scores via run-analysis-passes interne
//   POST body { ticker, scores }  → utilise scores fournis (orchestrateur)
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// --- Constants -------------------------------------------------------------
const DEFAULT_WEIGHTS: Weights = {
  c1: 0.25, c2: 0.20, c3: 0.20, c4: 0.15, c5: 0.10, c6: 0.10,
};
const CONVICTION_BUY_THRESHOLD = 60;  // STRATEGY.md Section 8 sizing table

// --- Types -----------------------------------------------------------------
interface Scores {
  c1: number | null; c2: number | null; c3: number | null;
  c4: number | null; c5: number | null; c6: number | null;
}
interface Weights {
  c1: number; c2: number; c3: number;
  c4: number; c5: number; c6: number;
}

// --- Helpers ---------------------------------------------------------------
async function getCurrentWeights(supabase: SupabaseClient): Promise<{ weights: Weights; source: string }> {
  const { data, error } = await supabase
    .from("strategies")
    .select("week_number, cluster_weights")
    .order("week_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data?.cluster_weights) {
    return { weights: DEFAULT_WEIGHTS, source: "default (cold start S1-4 or no strategy persisted yet)" };
  }
  const w = data.cluster_weights as Weights;
  const sum = (w.c1 ?? 0) + (w.c2 ?? 0) + (w.c3 ?? 0) + (w.c4 ?? 0) + (w.c5 ?? 0) + (w.c6 ?? 0);
  if (Math.abs(sum - 1.0) > 0.01) {
    return { weights: DEFAULT_WEIGHTS, source: `default (strategies.week_${data.week_number} weights sum ${sum.toFixed(3)} ≠ 1.00, rejected)` };
  }
  return { weights: w, source: `strategies.week_${data.week_number}` };
}

function computeConviction(scores: Scores, weights: Weights): { conviction: number; missing: string[]; raw_weighted: number; effective_weight: number } {
  const missing: string[] = [];
  let raw_weighted = 0;
  let effective_weight = 0;
  const pairs: Array<[keyof Scores, keyof Weights]> = [
    ["c1", "c1"], ["c2", "c2"], ["c3", "c3"],
    ["c4", "c4"], ["c5", "c5"], ["c6", "c6"],
  ];
  for (const [s, w] of pairs) {
    const score = scores[s];
    if (typeof score !== "number") { missing.push(s); continue; }
    raw_weighted += score * weights[w];
    effective_weight += weights[w];
  }
  if (effective_weight === 0) return { conviction: 0, missing, raw_weighted: 0, effective_weight: 0 };
  // Renormalisation si certains scores manquent (effective_weight < 1.0)
  const conviction = Math.round((raw_weighted / effective_weight) * 10);
  return { conviction, missing, raw_weighted, effective_weight };
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- Main handler ----------------------------------------------------------
Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const url = new URL(req.url);
  const tickerQuery = url.searchParams.get("ticker")?.toUpperCase();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  // === 1. Récupérer les scores : soit du POST body, soit via run-analysis-passes ===
  let ticker: string | undefined;
  let scores: Scores | undefined;
  let analysisRationale: string | null = null;
  let analysisCost = 0;
  let analysisFromInternal = false;

  if (req.method === "POST") {
    try {
      const body = await req.json();
      ticker = body.ticker?.toUpperCase();
      scores = body.scores;
      analysisRationale = body.rationale ?? body.passes?.pass3_fundamentals?.parsed?.rationale ?? null;
    } catch (e) {
      return jsonResponse({ ok: false, error: "invalid_json_body", detail: String((e as Error).message) }, 400);
    }
  } else {
    ticker = tickerQuery;
  }

  if (!ticker || !/^[A-Z.-]{1,10}$/.test(ticker)) {
    return jsonResponse({ ok: false, error: "invalid_or_missing_ticker", hint: "?ticker=INCY OR POST { ticker, scores }" }, 400);
  }

  // GET mode → run-analysis-passes interne
  if (!scores) {
    const analysisStart = Date.now();
    const resp = await fetch(`${supabaseUrl}/functions/v1/run-analysis-passes?ticker=${ticker}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${serviceKey}` },
    });
    if (!resp.ok) {
      return jsonResponse({ ok: false, error: "run_analysis_passes_http_error", status: resp.status, body: (await resp.text()).slice(0, 500) }, 502);
    }
    const result = await resp.json();
    if (!result.ok) {
      return jsonResponse({ ok: false, error: "run_analysis_passes_returned_error", detail: result }, 502);
    }
    scores = result.scores;
    analysisRationale = result.passes?.pass3_fundamentals?.parsed?.rationale ?? null;
    analysisCost = result.cost_usd ?? 0;
    analysisFromInternal = true;
    void analysisStart;
  }

  // === 2. Récupérer les poids actuels ===
  const { weights, source: weights_source } = await getCurrentWeights(supabase);

  // === 3. Calculer la conviction ===
  const { conviction, missing, raw_weighted, effective_weight } = computeConviction(scores!, weights);

  // Si > 3 clusters manquent → HOLD automatique (STRATEGY.md "gestion des données manquantes")
  if (missing.length > 3) {
    return jsonResponse({
      ok: false,
      error: "too_many_missing_scores",
      missing,
      scores,
      hint: "STRATEGY.md : > 3 clusters missing → HOLD automatique, analyse incomplète",
    }, 200);
  }

  // === 4. Déterminer action préliminaire ===
  // V1 : seuil 60 → BUY préliminaire (le Trader Phase 3 raffinera le sizing).
  // SELL nécessite logique séparée (positions ouvertes) → pas géré ici.
  const action: "BUY" | "HOLD" = conviction >= CONVICTION_BUY_THRESHOLD ? "BUY" : "HOLD";

  // === 5. Persister dans `signals` ===
  const { data: signal, error: signalErr } = await supabase
    .from("signals")
    .insert({
      ticker,
      action,
      conviction,
      score_c1_earnings: scores!.c1,
      score_c2_momentum: scores!.c2,
      score_c3_smart_money: scores!.c3,
      score_c4_quality: scores!.c4,
      score_c5_valuation: scores!.c5,
      score_c6_sentiment: scores!.c6,
      reviewer_verdict: "PENDING",
      executed: false,
      rationale: analysisRationale,
      // Champs Phase 3 (Trader/Reviewer) à compléter plus tard :
      // strategy_used, position_size_pct, stop_loss_pct, take_profit_pct,
      // entry_price_target, key_risks, hold_days_estimate, vix_at_signal, market_regime
    })
    .select("id, created_at")
    .single();

  if (signalErr) {
    return jsonResponse({ ok: false, error: "signal_insert_failed", detail: signalErr.message, scores, conviction }, 500);
  }

  return jsonResponse({
    ok: true,
    ticker,
    signal_id: signal?.id,
    created_at: signal?.created_at,
    conviction,
    action,
    threshold: CONVICTION_BUY_THRESHOLD,
    above_threshold: conviction >= CONVICTION_BUY_THRESHOLD,
    scores,
    missing_scores: missing,
    weights_used: weights,
    weights_source,
    raw_weighted,
    effective_weight,
    renormalized: effective_weight < 0.99,
    analysis_source: analysisFromInternal ? "internal_run_analysis_passes" : "post_body",
    analysis_cost_usd: analysisCost,
    duration_ms: Date.now() - t0,
  }, 200);
});
