// ============================================================================
// Aether — run-researchers Edge Function (Bull + Bear in parallel)
// ============================================================================
// Source : STRATEGY.md v2.7 Section 4 Bloc 3.5 (P14 TradingAgents architecture)
//
// Rôle : 2 appels Claude indépendants et parallélisables :
//   - Bull Researcher  : meilleur argument POUR BUY (isolé)
//   - Bear Researcher  : meilleur argument CONTRE BUY (isolé)
// Aucun des deux ne voit la réponse de l'autre. Le Trader (étape suivante)
// synthétise le débat — c'est ça qui évite l'anchoring bias.
//
// Usage :
//   GET  ?ticker=X    → fetch dernières passes depuis agent_logs
//   POST { ticker, scores, pass_rationales } → utilise les inputs fournis
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

async function callClaude(apiKey: string, system: string, user: string, maxTokens = 600, temperature = 0): Promise<CallResult> {
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

// --- Prompts (P14 architecture, isolation guaranteed by separate API calls) ---

const BULL_SYSTEM = `You are a Bullish Researcher in an autonomous trading system. Your single role is to build the STRONGEST possible case FOR buying the ticker.

CRITICAL ROLE RULES:
- Confirm ticker symbol at start and end of output.
- DO NOT be balanced or hedge. You are the BUY advocate. A separate Bearish Researcher argues the opposite. The Trader synthesizes both.
- Build 3 distinct, data-grounded arguments. Cite specific scores, indicators, or rationale points from inputs.
- 150 WORDS MAX in bull_report. Concise, persuasive.
- confidence_buy (1-10): how strong is the bullish case overall, given the inputs?

Respond with ONLY valid JSON.`;

const BEAR_SYSTEM = `You are a Bearish Researcher in an autonomous trading system. Your single role is to build the STRONGEST possible case AGAINST buying the ticker (HOLD or SELL).

CRITICAL ROLE RULES:
- Confirm ticker symbol at start and end of output.
- DO NOT be balanced or hedge. You are the RISK advocate. A separate Bullish Researcher argues the opposite. The Trader synthesizes both.
- Identify 3 distinct risks/red flags, each grounded in specific data.
- 150 WORDS MAX in bear_report. Concise, focused on what could go wrong.
- risk_score (1-10): how strong is the bearish case overall, given the inputs?

Respond with ONLY valid JSON.`;

function buildResearcherInput(ticker: string, scores: Record<string, number | null>, rationales: Record<string, string | null>): string {
  return `TICKER: ${ticker}

CLUSTER SCORES (1-10 each):
- C1 Earnings Catalyst : ${scores.c1}
- C2 Price Momentum    : ${scores.c2}
- C3 Smart Money       : ${scores.c3}
- C4 Quality Gate      : ${scores.c4}
- C5 Valuation         : ${scores.c5}
- C6 News Sentiment    : ${scores.c6}

PASS 1 (Technical) rationale:
${rationales.pass1 ?? "(not available)"}

PASS 2 (Sentiment) rationale:
${rationales.pass2 ?? "(not available)"}

PASS 3 (Fundamentals) rationale:
${rationales.pass3 ?? "(not available)"}

KNOWN LIMITATIONS:
- No earnings transcript (Premium plan, see DEVIATIONS D-001) — C1 is in fallback mode
- No 13F institutional data — C3 uses only 3/4 signals`;
}

function bullUserPrompt(ticker: string, input: string): string {
  return `${input}

Build the BUY case. Respond ONLY with JSON shape:
{
  "ticker": "${ticker}",
  "confidence_buy": <int 1-10>,
  "bull_arguments": ["<arg1 with specific data>", "<arg2>", "<arg3>"],
  "bull_report": "<150 words max, persuasive>"
}`;
}

function bearUserPrompt(ticker: string, input: string): string {
  return `${input}

Build the case AGAINST BUY (HOLD or SELL preferred). Respond ONLY with JSON shape:
{
  "ticker": "${ticker}",
  "risk_score": <int 1-10>,
  "bear_arguments": ["<arg1 with specific data>", "<arg2>", "<arg3>"],
  "bear_report": "<150 words max, focused on what could go wrong>"
}`;
}

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const url = new URL(req.url);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!supabaseUrl || !serviceKey || !anthropicKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  // --- Récupération des inputs : POST body OU fetch agent_logs par ticker ---
  let ticker: string | undefined;
  let scores: Record<string, number | null> | undefined;
  let rationales: Record<string, string | null> = { pass1: null, pass2: null, pass3: null };

  if (req.method === "POST") {
    try {
      const body = await req.json();
      ticker = body.ticker?.toUpperCase();
      scores = body.scores;
      rationales = {
        pass1: body.rationales?.pass1 ?? null,
        pass2: body.rationales?.pass2 ?? null,
        pass3: body.rationales?.pass3 ?? null,
      };
    } catch (e) {
      return jsonResponse({ ok: false, error: "invalid_json_body", detail: String((e as Error).message) }, 400);
    }
  } else {
    ticker = url.searchParams.get("ticker")?.toUpperCase();
  }

  if (!ticker || !/^[A-Z.-]{1,10}$/.test(ticker)) {
    return jsonResponse({ ok: false, error: "invalid_or_missing_ticker", hint: "?ticker=INCY OR POST { ticker, scores, rationales }" }, 400);
  }

  // GET mode : fetch latest scores + 3 pass rationales from agent_logs + signals
  if (!scores) {
    // Latest signal for ticker → gets scores
    const { data: sig } = await supabase
      .from("signals")
      .select("score_c1_earnings, score_c2_momentum, score_c3_smart_money, score_c4_quality, score_c5_valuation, score_c6_sentiment")
      .eq("ticker", ticker)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!sig) return jsonResponse({ ok: false, error: "no_signal_found_for_ticker", hint: "Run calculate-scores first OR provide scores in POST body" }, 404);
    scores = {
      c1: sig.score_c1_earnings, c2: sig.score_c2_momentum, c3: sig.score_c3_smart_money,
      c4: sig.score_c4_quality, c5: sig.score_c5_valuation, c6: sig.score_c6_sentiment,
    };

    // Latest 3 pass rationales from agent_logs
    for (const pass of ["analysis_pass1", "analysis_pass2", "analysis_pass3"] as const) {
      const { data: log } = await supabase
        .from("agent_logs")
        .select("raw_output")
        .eq("ticker", ticker)
        .eq("log_type", pass)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const r = log?.raw_output as { rationale?: string } | undefined;
      const key = pass.replace("analysis_", "");
      rationales[key] = r?.rationale ?? null;
    }
  }

  // --- Bull + Bear en PARALLÈLE (isolation programmatique : 2 appels API séparés) ---
  const input = buildResearcherInput(ticker, scores!, rationales);
  const [bull, bear] = await Promise.all([
    callClaude(anthropicKey, BULL_SYSTEM, bullUserPrompt(ticker, input), 600),
    callClaude(anthropicKey, BEAR_SYSTEM, bearUserPrompt(ticker, input), 600),
  ]);

  const [bullLogId, bearLogId] = await Promise.all([
    logCall(supabase, "researcher_bull", ticker, bull),
    logCall(supabase, "researcher_bear", ticker, bear),
  ]);

  return jsonResponse({
    ok: bull.ok && bear.ok,
    ticker,
    duration_ms: Date.now() - t0,
    cost_usd: bull.cost_usd + bear.cost_usd,
    bull_case: {
      ok: bull.ok,
      log_id: bullLogId,
      latency_ms: bull.latency_ms,
      cost_usd: bull.cost_usd,
      parsed: bull.parsed,
      error: bull.error,
    },
    bear_case: {
      ok: bear.ok,
      log_id: bearLogId,
      latency_ms: bear.latency_ms,
      cost_usd: bear.cost_usd,
      parsed: bear.parsed,
      error: bear.error,
    },
    inputs_used: {
      scores,
      rationales_available: { pass1: !!rationales.pass1, pass2: !!rationales.pass2, pass3: !!rationales.pass3 },
    },
  }, 200);
});
