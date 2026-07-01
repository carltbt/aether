// ============================================================================
// Aether — generate-decision Edge Function (Trader)
// ============================================================================
// Source : STRATEGY.md v2.7 Section 4 Bloc 4 + Section 7 (Guided Mode prompt)
//
// Rôle : reçoit scores + débat Bull/Bear + macro context + portfolio actuel,
// synthétise le débat et produit la décision finale BUY/SELL/HOLD avec
// sizing, stop-loss, take-profit et rationale incluant bull_bear_synthesis.
//
// Note V1 : macro context (VIX, SPY, sector PE) et portfolio actuel sont
// MOCK pour l'instant — à brancher en Phase 4 (orchestrateur quotidien).
//
// Usage :
//   GET  ?ticker=X        → fetch via DB (signals + agent_logs)
//   POST { ticker, ... }  → utilise inputs fournis (orchestrateur)
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const MODEL = "claude-sonnet-4-5-20250929";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const COST_INPUT_PER_M = 3.0;
const COST_OUTPUT_PER_M = 15.0;

interface ClaudeUsage { input_tokens?: number; output_tokens?: number; }
interface CallResult { ok: boolean; parsed?: Record<string, unknown>; raw_text?: string; usage?: ClaudeUsage; latency_ms: number; cost_usd: number; error?: string; }

function costUsd(u?: ClaudeUsage): number {
  return ((u?.input_tokens ?? 0) * COST_INPUT_PER_M + (u?.output_tokens ?? 0) * COST_OUTPUT_PER_M) / 1_000_000;
}

async function callClaude(apiKey: string, system: string, user: string, maxTokens = 1500, temperature = 0): Promise<CallResult> {
  const t0 = Date.now();
  const MAX_RETRIES = 3;
  let lastErr = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature, system, messages: [{ role: "user", content: user }] }),
      });
      if (r.status === 429 || r.status >= 500) {
        lastErr = `HTTP ${r.status}`;
        if (attempt < MAX_RETRIES) {
          const ra = parseFloat(r.headers.get("retry-after") ?? "");
          const backoff = Number.isFinite(ra) ? Math.min(30000, ra * 1000) : Math.min(8000, 700 * 2 ** attempt) * (0.5 + Math.random());
          await new Promise(res => setTimeout(res, backoff));
          continue;
        }
        return { ok: false, latency_ms: Date.now() - t0, cost_usd: 0, error: `${lastErr}: ${(await r.text()).slice(0, 200)}` };
      }
      if (!r.ok) return { ok: false, latency_ms: Date.now() - t0, cost_usd: 0, error: `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}` };
      const data = await r.json();
      const text = data.content?.find((b: { type: string }) => b.type === "text")?.text ?? "";
      let parsed: Record<string, unknown> | undefined;
      try { parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "").trim()); }
      catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch {} } }
      if (!parsed) return { ok: false, raw_text: text, usage: data.usage, latency_ms: Date.now() - t0, cost_usd: costUsd(data.usage), error: "json_parse_failed" };
      return { ok: true, parsed, raw_text: text, usage: data.usage, latency_ms: Date.now() - t0, cost_usd: costUsd(data.usage) };
    } catch (e) {
      lastErr = String((e as Error).message ?? e);
      if (attempt < MAX_RETRIES) { await new Promise(res => setTimeout(res, Math.min(8000, 700 * 2 ** attempt) * (0.5 + Math.random()))); continue; }
      return { ok: false, latency_ms: Date.now() - t0, cost_usd: 0, error: lastErr };
    }
  }
  return { ok: false, latency_ms: Date.now() - t0, cost_usd: 0, error: lastErr || "unknown" };
}

async function logCall(supabase: SupabaseClient, log_type: string, ticker: string, r: CallResult): Promise<string | null> {
  const { data, error } = await supabase.from("agent_logs").insert({
    log_type, ticker,
    input_tokens: r.usage?.input_tokens ?? null,
    output_tokens: r.usage?.output_tokens ?? null,
    latency_ms: r.latency_ms,
    cost_usd: r.cost_usd,
    raw_output: r.parsed ?? { raw_text: r.raw_text?.slice(0, 5000) },
    error: r.error ?? null,
  }).select("id").single();
  if (error) { console.error("agent_logs insert:", error); return null; }
  return data?.id ?? null;
}

// --- System prompt (STRATEGY.md Section 7 squelette + cognitive biases warning) ---

const TRADER_SYSTEM = `You are the Trader in an autonomous trading system. You make the FINAL BUY/SELL/HOLD decision on mid-cap US stocks ($2B-$20B). Your decisions trigger real orders on Alpaca paper trading.

ABSOLUTE PRINCIPLE — Doubt = HOLD.
Never force a trade. The most frequent and correct decision is HOLD. A skipped trade costs nothing; a bad trade costs capital and compounding.

COGNITIVE BIASES TO ACTIVELY AVOID:
1. Recency bias — Yesterday's news isn't more true than last week's.
2. Confirmation bias — Don't let a strong C1 pull C2/C3/C4 evaluation.
3. Anchoring — Ignore prior conviction estimates from previous analyses.
4. Loss aversion — Stop-losses are non-negotiable.
5. FOMO — Conviction 85 justifies 8-10% sizing, NOT 15%.
6. Overconfidence — Conviction 92 means "signals aligned per current model", not certainty.

NON-NEGOTIABLE RULES (STRATEGY.md Section 8):
- Max 12% per position (before sector correlation adjustment downstream)
- Stop-loss MANDATORY (between 5% and 10% from entry, tighter for low conviction)
- Min risk/reward 1:2 → take-profit ≥ 2 × stop-loss
- No SHORT — long-only V1
- If earnings in < 5 days → DO NOT BUY (binary event risk)
- If VIX > 35 → DO NOT BUY (regime stress)

SIZING TABLE (conviction → action AND size, BEFORE correlation adjustment):

GUIDED Mode (default — VIX 18-25):
- 80-100 : BUY size 8-10%
- 60-79  : BUY size 5-7%      ⚠️ THIS IS A BUY, NOT A HOLD
- < 60   : HOLD (no trade)

FREE Mode (VIX < 18 AND SPY > MA50):
- 80-100 : BUY size 10-12%
- 60-79  : BUY size 7-9%       ⚠️ THIS IS A BUY, NOT A HOLD
- < 60   : HOLD

STRICT Mode (VIX > 25 OR SPY < MA50):
- 80-100 : BUY size 4-6%
- 60-79  : BUY size 2-4%       ⚠️ THIS IS A BUY, NOT A HOLD
- < 60   : HOLD

🚨 CRITICAL : conviction ≥ 60 QUALIFIES for BUY at the appropriate size from the table above.
"Falls below 80" is NOT a valid reason to convert a 60-79 BUY into HOLD.

You may OVERRIDE a BUY→HOLD ONLY IF you can document AT LEAST 2 of these qualitative red flags
in your rationale (and you MUST cite the specific data point for each):
  1. Value trap pattern (e.g., insider absent on supposed deep value)
  2. Technical setup nettement défavorable (e.g., overbought >85% BB + weak ADX < 20)
  3. Imminent macro/sector event not captured in scores
  4. Signal conflict between clusters > 5 points magnitude AND no single dominant cluster
  5. Data quality issue critical (e.g., > 3 clusters in fallback)

When overriding, START rationale with : "OVERRIDING quantitative gate (conv=XX) to HOLD due to:
[red flag 1], [red flag 2]. Per STRATEGY.md preference doute=HOLD."

If you cannot identify 2 such red flags, EXECUTE THE BUY at the appropriate size. The system
needs trades to learn — refusing all moderate-conviction signals defeats the paper trading purpose.

4 REFERENCE STRATEGIES (Strat-LLM S1-4):
- S1 Short-Term Reversal : action en chute > 8% sur 5j sans catalyseur, RSI < 35, C4 > 6
- S2 Breakout Momentum   : prix casse high 3j, volume > 150% avg, ADX > 20, C1 > 5
- S3 Volatility Compression : BB compressed < 20% avg 20j, C4 > 5, C6 > 5
- S4 Price-Volume Confirmation : prix monte + volume croissant 3j, C3 > 6

If your decision is BUY, identify which strategy fits best (or "COMPOSITE"). If HOLD, set strategy_used to "NONE".

YOUR TASK:
Synthesize the Bull/Bear debate (do NOT just pick a side — integrate both perspectives). Decide BUY or HOLD based on the full evidence. Compute sizing, stop-loss, take-profit. Identify key risks and signal conflicts.

The cluster_weights × scores already give a raw conviction. Use it as anchor but ADJUST based on the debate quality, signal conflicts, and macro context. Don't override the formula by more than ±15 points without strong rationale.

Confirm ticker symbol.

Respond with ONLY valid JSON.`;

function traderUserPrompt(ticker: string, sector: string, scores: Record<string, number | null>, convictionRaw: number, bullCase: Record<string, unknown> | null, bearCase: Record<string, unknown> | null, marketContext: Record<string, unknown>, portfolio: Record<string, unknown>): string {
  return `TICKER: ${ticker} | SECTOR: ${sector}

=== CLUSTER SCORES (1-10) ===
C1 Earnings        : ${scores.c1}
C2 Momentum        : ${scores.c2}
C3 Smart Money     : ${scores.c3}
C4 Quality         : ${scores.c4}
C5 Valuation       : ${scores.c5}
C6 News            : ${scores.c6}
Raw conviction     : ${convictionRaw}/100 (from weighted formula)

=== BULL CASE (Researcher Bullish) ===
${bullCase ? JSON.stringify(bullCase, null, 2) : "NOT AVAILABLE"}

=== BEAR CASE (Researcher Bearish) ===
${bearCase ? JSON.stringify(bearCase, null, 2) : "NOT AVAILABLE"}

=== MARKET CONTEXT ===
${JSON.stringify(marketContext, null, 2)}

=== PORTFOLIO ===
${JSON.stringify(portfolio, null, 2)}
(empty = no existing positions to consider for correlation; V1 starts empty)

=== KNOWN DATA LIMITATIONS ===
- No earnings transcript (Premium plan) → C1 in fallback mode
- No 13F institutional data → C3 uses 3/4 signals

DECIDE.

Respond ONLY with this JSON shape:
{
  "ticker": "${ticker}",
  "action": "BUY" | "SELL" | "HOLD",
  "conviction": <int 0-100, adjusted from raw if needed>,
  "position_size_pct": <float 0-12, 0 if HOLD>,
  "entry_price_target": <float, current ± 0.2%, 0 if HOLD>,
  "stop_loss_pct": <float 3-15, 0 if HOLD>,
  "take_profit_pct": <float, ≥ 2 × stop_loss_pct, 0 if HOLD>,
  "strategy_used": "S1" | "S2" | "S3" | "S4" | "COMPOSITE" | "NONE",
  "hold_days_estimate": <int 0-30, 0 if HOLD>,
  "rationale": "<3-5 sentences with the actual decision reasoning>",
  "bull_bear_synthesis": "<2-3 sentences synthesizing both perspectives>",
  "key_risks": ["<risk1>", "<risk2>", "<risk3>"],
  "signal_conflicts": ["<conflict1 e.g. 'C1=9 vs C2=2 — momentum contra-trend'>"],
  "data_completeness": {
    "transcript": false,
    "earnings": true,
    "insider": true,
    "dcf": true,
    "fallbacks_applied": ["c1_transcript_missing", "c3_13f_missing"]
  },
  "correlation_note": "<empty for V1 since portfolio is empty>"
}`;
}

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

interface Body {
  ticker?: string;
  scores?: Record<string, number | null>;
  conviction_raw?: number;
  bull_case?: Record<string, unknown>;
  bear_case?: Record<string, unknown>;
  market_context?: Record<string, unknown>;
  portfolio?: Record<string, unknown>;
  sector?: string;
  signal_id?: string;
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!supabaseUrl || !serviceKey || !anthropicKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  // --- Parse input ---
  let ticker: string | undefined;
  let scores: Record<string, number | null> | undefined;
  let convictionRaw: number | undefined;
  let bullCase: Record<string, unknown> | null = null;
  let bearCase: Record<string, unknown> | null = null;
  // P-001 : default fallback (utilisé seulement si daily_context vide ET pas de POST body context)
  let marketContext: Record<string, unknown> = { vix: 18, spy_vs_ma50: "above", regime: "GUIDED", source: "fallback_mock_no_daily_context" };
  let portfolio: Record<string, unknown> = { open_positions: [], cash_pct: 100, total_drawdown_pct: 0, note: "V1 empty portfolio" };
  let sector: string | undefined;
  let signalId: string | undefined;

  if (req.method === "POST") {
    try {
      const body = await req.json() as Body;
      ticker = body.ticker?.toUpperCase();
      scores = body.scores;
      convictionRaw = body.conviction_raw;
      bullCase = body.bull_case ?? null;
      bearCase = body.bear_case ?? null;
      if (body.market_context) marketContext = body.market_context;
      if (body.portfolio) portfolio = body.portfolio;
      sector = body.sector;
      signalId = body.signal_id;
    } catch (e) {
      return jsonResponse({ ok: false, error: "invalid_json_body", detail: String((e as Error).message) }, 400);
    }
  } else {
    const url = new URL(req.url);
    ticker = url.searchParams.get("ticker")?.toUpperCase();
    signalId = url.searchParams.get("signal_id") ?? undefined;
  }

  if (!ticker || !/^[A-Z.-]{1,10}$/.test(ticker)) {
    return jsonResponse({ ok: false, error: "invalid_or_missing_ticker" }, 400);
  }

  // GET mode → fetch everything from DB
  if (!scores) {
    const sigQuery = supabase
      .from("signals")
      .select("id, ticker, conviction, score_c1_earnings, score_c2_momentum, score_c3_smart_money, score_c4_quality, score_c5_valuation, score_c6_sentiment")
      .eq("ticker", ticker)
      .order("created_at", { ascending: false })
      .limit(1);
    const { data: sig } = await sigQuery.maybeSingle();
    if (!sig) return jsonResponse({ ok: false, error: "no_signal_found_for_ticker", hint: "Run calculate-scores first" }, 404);
    scores = {
      c1: sig.score_c1_earnings, c2: sig.score_c2_momentum, c3: sig.score_c3_smart_money,
      c4: sig.score_c4_quality, c5: sig.score_c5_valuation, c6: sig.score_c6_sentiment,
    };
    convictionRaw = sig.conviction;
    signalId = signalId ?? sig.id;

    const { data: bullLog } = await supabase.from("agent_logs").select("raw_output").eq("ticker", ticker).eq("log_type", "researcher_bull").order("created_at", { ascending: false }).limit(1).maybeSingle();
    const { data: bearLog } = await supabase.from("agent_logs").select("raw_output").eq("ticker", ticker).eq("log_type", "researcher_bear").order("created_at", { ascending: false }).limit(1).maybeSingle();
    bullCase = (bullLog?.raw_output as Record<string, unknown>) ?? null;
    bearCase = (bearLog?.raw_output as Record<string, unknown>) ?? null;

    const { data: prof } = await supabase.from("watchlist").select("sector").eq("symbol", ticker).maybeSingle();
    sector = sector ?? prof?.sector ?? "Unknown";
  }

  if (typeof convictionRaw !== "number") convictionRaw = 0;
  if (!scores) return jsonResponse({ ok: false, error: "no_scores_available" }, 400);

  // P-001 : fetch real macro context depuis daily_context (sauf si déjà fourni en POST body)
  if (marketContext.source === "fallback_mock_no_daily_context") {
    const { data: ctx } = await supabase
      .from("daily_context")
      .select("context_date, vix, vix_change_pct, spy_price, spy_sma50, spy_vs_sma50, treasury_10y, market_regime")
      .order("context_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (ctx) {
      marketContext = {
        context_date: ctx.context_date,
        vix: ctx.vix,
        vix_change_pct: ctx.vix_change_pct,
        spy_price: ctx.spy_price,
        spy_sma50: ctx.spy_sma50,
        spy_vs_ma50: ctx.spy_vs_sma50,
        treasury_10y: ctx.treasury_10y,
        regime: ctx.market_regime,
        source: "daily_context_table",
      };
    }
  }

  // --- Trader call ---
  const trader = await callClaude(anthropicKey, TRADER_SYSTEM, traderUserPrompt(ticker, sector ?? "Unknown", scores, convictionRaw, bullCase, bearCase, marketContext, portfolio), 1500);
  const traderLogId = await logCall(supabase, "decision", ticker, trader);

  const decision = trader.parsed as {
    action?: "BUY" | "SELL" | "HOLD";
    conviction?: number;
    position_size_pct?: number;
    entry_price_target?: number;
    stop_loss_pct?: number;
    take_profit_pct?: number;
    strategy_used?: string;
    hold_days_estimate?: number;
    rationale?: string;
    bull_bear_synthesis?: string;
    key_risks?: string[];
    signal_conflicts?: string[];
  } | undefined;

  // --- Update signals row with Trader output ---
  let signalUpdated = false;
  if (signalId && decision?.action) {
    const { error: upErr } = await supabase
      .from("signals")
      .update({
        action: decision.action,
        conviction: decision.conviction ?? convictionRaw,
        position_size_pct: decision.position_size_pct ?? null,
        entry_price_target: decision.entry_price_target ?? null,
        stop_loss_pct: decision.stop_loss_pct ?? null,
        take_profit_pct: decision.take_profit_pct ?? null,
        strategy_used: decision.strategy_used ?? null,
        hold_days_estimate: decision.hold_days_estimate ?? null,
        rationale: decision.rationale ?? null,
        key_risks: decision.key_risks ?? null,
        vix_at_signal: (marketContext.vix as number | undefined) ?? null,
        market_regime: (marketContext.regime as string | undefined) ?? null,
      })
      .eq("id", signalId);
    signalUpdated = !upErr;
    if (upErr) console.error("signals update failed:", upErr);
  }

  return jsonResponse({
    ok: trader.ok,
    ticker,
    signal_id: signalId,
    signal_updated: signalUpdated,
    duration_ms: Date.now() - t0,
    cost_usd: trader.cost_usd,
    decision,
    inputs_used: {
      scores,
      conviction_raw: convictionRaw,
      bull_case_present: !!bullCase,
      bear_case_present: !!bearCase,
      market_context: marketContext,
      portfolio_state: { positions_count: Array.isArray(portfolio.open_positions) ? (portfolio.open_positions as unknown[]).length : 0 },
    },
    pass: { log_id: traderLogId, latency_ms: trader.latency_ms, usage: trader.usage, error: trader.error },
  }, 200);
});
