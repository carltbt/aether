// ============================================================================
// Aether — run-strategy-loop Edge Function (Phase 4 step 18 — Strategy Agent hebdo)
// ============================================================================
// Source : STRATEGY.md v2.7 Section 9 + Section 8.5 cold start (P-007)
//
// Rôle : dimanche soir (20h ET = lundi 1h UTC), réflexion stratégique :
//   - Cold start (sem 1-4) : poids fixes, pas d'ajustement → INSERT default row avec cold_start flag
//   - Sem 5+ ET ≥ 8 trades fermés ET ≥ 3 semaines data : appel Claude pour ajuster cluster_weights
//
// Output : nouvelle row dans `strategies` table avec poids semaine à venir.
//
// Usage : GET /functions/v1/run-strategy-loop (one-shot, ou via pg_cron)
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const MODEL = "claude-sonnet-4-5-20250929";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const COST_INPUT_PER_M = 3.0;
const COST_OUTPUT_PER_M = 15.0;

// Cold start gates (STRATEGY.md Section 8.5)
const MIN_TRADES_FOR_ADJUSTMENT = 8;
const MIN_WEEKS_FOR_ADJUSTMENT = 3;

// Default weights (STRATEGY.md Section 5)
const DEFAULT_WEIGHTS = { c1: 0.25, c2: 0.20, c3: 0.20, c4: 0.15, c5: 0.10, c6: 0.10 };

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

function isoWeek(d = new Date()): number {
  // ISO week number — utilisé comme week_number
  const target = new Date(d.valueOf());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7);
  }
  return 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
}

interface ClaudeUsage { input_tokens?: number; output_tokens?: number; }

async function callClaude(apiKey: string, system: string, user: string, maxTokens = 1000): Promise<{ ok: boolean; parsed?: Record<string, unknown>; raw?: string; cost_usd: number; usage?: ClaudeUsage; error?: string }> {
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature: 0, system, messages: [{ role: "user", content: user }] }),
    });
    if (!r.ok) return { ok: false, cost_usd: 0, error: `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}` };
    const data = await r.json();
    const text = data.content?.find((b: { type: string }) => b.type === "text")?.text ?? "";
    let parsed: Record<string, unknown> | undefined;
    try { parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "").trim()); }
    catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch {} } }
    const u = data.usage;
    const cost = ((u?.input_tokens ?? 0) * COST_INPUT_PER_M + (u?.output_tokens ?? 0) * COST_OUTPUT_PER_M) / 1_000_000;
    return { ok: true, parsed, raw: text, cost_usd: cost, usage: u };
  } catch (e) {
    return { ok: false, cost_usd: 0, error: String((e as Error).message ?? e) };
  }
}

const STRATEGY_SYSTEM = `You are the Strategy Agent of an autonomous trading system. Once a week (Sunday night), you reflect on performance and adjust the cluster weights for the coming week.

CRITICAL RULES:
- Cluster weights must sum to EXACTLY 1.00 (validated programmatically).
- Stay within ±5% of current weights per cluster (gradual evolution, not whiplash).
- Reference the actual data provided — don't make up trends.
- If data is sparse (< 8 closed trades), DO NOT adjust — return current weights with a note.

DEFAULT WEIGHTS (STRATEGY.md Section 5):
- c1 Earnings Catalyst : 0.25
- c2 Price Momentum    : 0.20
- c3 Smart Money       : 0.20
- c4 Quality Gate      : 0.15
- c5 Valuation         : 0.10
- c6 News Sentiment    : 0.10

ADJUSTMENT HEURISTICS :
- If a cluster has high IC (correlation between score and realized return) → increase weight slightly
- If a cluster has near-zero or negative IC → decrease weight slightly
- Market regime evolution matters : in STRICT mode periods, C4 + C5 should not have leading weight
- Sector rotation : if recent winners cluster in one sector, note it but DON'T overweight that sector specifically (weights are cross-sectional)

Respond with ONLY valid JSON.`;

async function fetchPerformanceData(supabase: SupabaseClient) {
  // 1. Last 10 strategies
  const { data: strategies } = await supabase
    .from("strategies")
    .select("week_number, created_at, cluster_weights, market_regime, strategy_text, portfolio_return_pct, alpha_pct")
    .order("week_number", { ascending: false })
    .limit(10);

  // 2. Closed positions count + P&L
  const { data: closed } = await supabase
    .from("positions")
    .select("ticker, entry_price, exit_price, pnl_usd, pnl_pct, hold_days, exit_reason, closed_at, signal_id")
    .eq("status", "CLOSED")
    .order("closed_at", { ascending: false })
    .limit(50);

  const closedCount = (closed ?? []).length;

  // 3. Signals with conviction → realized return (for IC calculation later)
  // Lookup signal scores for each closed position
  const signalIds = (closed ?? []).map(p => p.signal_id).filter(Boolean);
  const { data: signals } = signalIds.length > 0
    ? await supabase
        .from("signals")
        .select("id, conviction, score_c1_earnings, score_c2_momentum, score_c3_smart_money, score_c4_quality, score_c5_valuation, score_c6_sentiment")
        .in("id", signalIds)
    : { data: [] };

  return { strategies: strategies ?? [], closed: closed ?? [], signals: signals ?? [], closedCount };
}

Deno.serve(async () => {
  const t0 = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!supabaseUrl || !serviceKey || !anthropicKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  const currentWeek = isoWeek();
  const nextWeek = currentWeek + 1;

  // 1. Fetch performance data
  const { strategies, closed, signals, closedCount } = await fetchPerformanceData(supabase);

  // 2. Determine current regime
  const { data: dailyCtx } = await supabase
    .from("daily_context")
    .select("market_regime, vix, spy_vs_sma50")
    .order("context_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const currentRegime = dailyCtx?.market_regime ?? "GUIDED";

  // 3. Cold start check (P-007) — sem 1-4 OU < 8 closed trades OU < 3 weeks data
  const weeksOfData = strategies.length;
  const coldStart = weeksOfData < MIN_WEEKS_FOR_ADJUSTMENT || closedCount < MIN_TRADES_FOR_ADJUSTMENT;

  if (coldStart) {
    // INSERT cold start row with default weights
    const { data: inserted, error: insErr } = await supabase
      .from("strategies")
      .insert({
        week_number: nextWeek,
        cluster_weights: DEFAULT_WEIGHTS,
        preferred_strategies: ["S1", "S2", "S3", "S4"],
        sector_bias: [],
        risk_adjustment: 1.0,
        strategy_text: `Cold start week ${nextWeek}: default weights (closed_trades=${closedCount} < ${MIN_TRADES_FOR_ADJUSTMENT} OR weeks_data=${weeksOfData} < ${MIN_WEEKS_FOR_ADJUSTMENT}). No Claude adjustment yet. Current regime: ${currentRegime}.`,
        rationale: `Cold start protocol active per STRATEGY.md Section 8.5 + POLISH P-007. Adjustments blocked until ≥8 closed trades and ≥3 weeks of historical strategies. Currently: ${closedCount} closed, ${weeksOfData} prior weeks.`,
      })
      .select("id, week_number")
      .single();
    if (insErr) return jsonResponse({ ok: false, error: "cold_start_insert_failed", detail: insErr.message }, 500);

    return jsonResponse({
      ok: true,
      mode: "cold_start",
      week_number: nextWeek,
      strategy_id: inserted?.id,
      reasons: {
        weeks_of_data: weeksOfData,
        min_weeks_required: MIN_WEEKS_FOR_ADJUSTMENT,
        closed_trades: closedCount,
        min_trades_required: MIN_TRADES_FOR_ADJUSTMENT,
        adjustments_blocked: true,
      },
      weights_applied: DEFAULT_WEIGHTS,
      regime: currentRegime,
      duration_ms: Date.now() - t0,
      cost_usd: 0,
    }, 200);
  }

  // 4. Sem 5+ : appel Claude pour ajuster (logique NF-Score)
  const prevWeights = (strategies[0].cluster_weights as Record<string, number>) ?? DEFAULT_WEIGHTS;

  // Compute simple IC proxy : for each cluster, correlation between score and pnl_pct
  // (V1 approximation — proper IC requires more sophisticated stat)
  const icProxy: Record<string, number> = { c1: 0, c2: 0, c3: 0, c4: 0, c5: 0, c6: 0 };
  const matched = closed.filter(p => p.signal_id).map(p => {
    const sig = signals.find(s => s.id === p.signal_id);
    return sig ? { pnl: p.pnl_pct, scores: sig } : null;
  }).filter(Boolean);
  if (matched.length >= 5) {
    // Simple corr each cluster vs pnl
    for (const key of ["c1", "c2", "c3", "c4", "c5", "c6"] as const) {
      const scoreKey = `score_${key === "c1" ? "c1_earnings" : key === "c2" ? "c2_momentum" : key === "c3" ? "c3_smart_money" : key === "c4" ? "c4_quality" : key === "c5" ? "c5_valuation" : "c6_sentiment"}` as keyof typeof matched[0]["scores"];
      const xs = matched.map(m => Number(m!.scores[scoreKey])).filter(x => !isNaN(x));
      const ys = matched.map(m => Number(m!.pnl)).filter(y => !isNaN(y));
      if (xs.length !== ys.length || xs.length < 5) continue;
      const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
      const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
      let num = 0, denX = 0, denY = 0;
      for (let i = 0; i < xs.length; i++) {
        num += (xs[i] - meanX) * (ys[i] - meanY);
        denX += (xs[i] - meanX) ** 2;
        denY += (ys[i] - meanY) ** 2;
      }
      icProxy[key] = denX > 0 && denY > 0 ? num / Math.sqrt(denX * denY) : 0;
    }
  }

  const claudeUserPrompt = `=== CURRENT WEEK ===
Week: ${currentWeek} | Next week: ${nextWeek}
Current regime: ${currentRegime}
VIX: ${dailyCtx?.vix ?? "?"}, SPY vs SMA50: ${dailyCtx?.spy_vs_sma50 ?? "?"}

=== PERFORMANCE DATA ===
Closed trades total: ${closedCount}
Recent strategies (last ${strategies.length}):
${strategies.map(s => `  Week ${s.week_number}: weights=${JSON.stringify(s.cluster_weights)}, return=${s.portfolio_return_pct ?? "?"}%`).join("\n")}

=== IC PROXY (simple correlation cluster_score vs realized pnl_pct, n=${matched.length}) ===
${JSON.stringify(icProxy, null, 2)}

=== PREVIOUS WEIGHTS ===
${JSON.stringify(prevWeights, null, 2)}

Propose new cluster_weights for week ${nextWeek}. Respect the ±5% drift cap per cluster vs previous weights. Sum to 1.00 EXACTLY.

Respond ONLY with this JSON shape:
{
  "cluster_weights": { "c1": <float>, "c2": <float>, "c3": <float>, "c4": <float>, "c5": <float>, "c6": <float> },
  "preferred_strategies": ["S1|S2|S3|S4"],
  "sector_bias": ["Sector1", "Sector2"],
  "risk_adjustment": <float 0.5-1.5>,
  "strategy_text": "<5-7 sentences narrative for the Trader>",
  "rationale": "<3-5 sentences explaining the weight changes>"
}`;

  const claudeResp = await callClaude(anthropicKey, STRATEGY_SYSTEM, claudeUserPrompt, 1200);

  // 5. Validate weights sum
  const newWeights = claudeResp.parsed?.cluster_weights as Record<string, number> | undefined;
  if (!newWeights) {
    return jsonResponse({ ok: false, error: "claude_did_not_return_weights", raw: claudeResp.raw?.slice(0, 500), cost: claudeResp.cost_usd }, 500);
  }
  const sum = Object.values(newWeights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1.0) > 0.01) {
    return jsonResponse({ ok: false, error: "weights_sum_invalid", sum, weights: newWeights, cost: claudeResp.cost_usd }, 500);
  }

  // 6. INSERT new strategy
  const { data: inserted, error: insErr } = await supabase
    .from("strategies")
    .insert({
      week_number: nextWeek,
      cluster_weights: newWeights,
      preferred_strategies: claudeResp.parsed?.preferred_strategies ?? null,
      sector_bias: claudeResp.parsed?.sector_bias ?? null,
      risk_adjustment: claudeResp.parsed?.risk_adjustment ?? 1.0,
      strategy_text: claudeResp.parsed?.strategy_text ?? null,
      rationale: claudeResp.parsed?.rationale ?? null,
    })
    .select("id, week_number")
    .single();
  if (insErr) return jsonResponse({ ok: false, error: "strategy_insert_failed", detail: insErr.message }, 500);

  // 7. Log Claude call
  await supabase.from("agent_logs").insert({
    log_type: "strategy_loop",
    input_tokens: claudeResp.usage?.input_tokens ?? null,
    output_tokens: claudeResp.usage?.output_tokens ?? null,
    cost_usd: claudeResp.cost_usd,
    raw_output: claudeResp.parsed,
    error: claudeResp.error ?? null,
  });

  return jsonResponse({
    ok: true,
    mode: "adjustment_applied",
    week_number: nextWeek,
    strategy_id: inserted?.id,
    previous_weights: prevWeights,
    new_weights: newWeights,
    weights_sum: sum,
    regime: currentRegime,
    closed_trades: closedCount,
    ic_proxy: icProxy,
    duration_ms: Date.now() - t0,
    cost_usd: claudeResp.cost_usd,
  }, 200);
});
