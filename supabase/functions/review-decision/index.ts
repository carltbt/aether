// ============================================================================
// Aether — review-decision Edge Function (Reviewer 3-perspectives)
// ============================================================================
// Source : STRATEGY.md v2.7 Section 7 (Pattern multi-agent — Étape 4)
//
// Rôle : appel UNIQUE qui intègre 3 sous-perspectives risque :
//   - Conservateur : quels risques justifient un blocage ?
//   - Neutre       : la conviction est-elle justifiée par les signaux ?
//   - Agressif     : y a-t-il une opportunité sous-exploitée ?
// Output : APPROVE / REJECT + ajustement taille position recommandé (±20%)
//
// Règle de convergence (P9 + P14) : un BUY n'est exécuté que si
// Trader→BUY ET Reviewer→APPROVE. En désaccord → HOLD systématique.
// Un SELL est exécuté même si Reviewer→HOLD (protection asymétrique).
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

async function callClaude(apiKey: string, system: string, user: string, maxTokens = 1000, temperature = 0): Promise<CallResult> {
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

const REVIEWER_SYSTEM = `You are the Reviewer — the final risk gate before order execution in an autonomous trading system.

You MUST evaluate the Trader's decision from THREE risk perspectives in a single output, then synthesize into one verdict.

CRITICAL RULES:
- Confirm ticker symbol.
- Use the 3 perspectives below independently, then SYNTHESIZE into final verdict.
- For SELL decisions: lean toward APPROVE (asymmetric protection per P14).

🚨 BUY DECISION CONSENSUS RULES (recalibrated v2 — observation 28 mai : 100% REJECT rate over 4 days was too strict, blocking actionable BUYs at conv 60-72) :
  - 3/3 perspectives REJECT → REJECT (clear consensus veto)
  - 2/3 perspectives REJECT → REJECT (majority veto)
  - 1/3 perspectives REJECT + 2/3 APPROVE-or-NEUTRAL → APPROVE with size_adjustment_pct = -15% (dampen risk from the 1 concerning perspective, but execute since majority sees opportunity)
  - 0/3 perspectives REJECT → APPROVE full size (or +5-10% if Aggressive sees upside)

⚠️ EXCEPTIONS qui forcent REJECT regardless of vote count (escape hatches for clear danger) :
  - Conviction > 90% relies on a single cluster ≥ 9 while 2+ clusters ≤ 3 (signals isolated, not aligned)
  - Data completeness severely degraded (> 3 clusters missing or in fallback)
  - Trader rationale claims something the scores don't support (factual hallucination)
  - Imminent earnings (< 5 days) detected late — Trader should have caught, validate-order will, but flag

- Can recommend size_adjustment_pct ±20% from Trader's position_size_pct.

THE 3 PERSPECTIVES TO EVALUATE:

1. CONSERVATIVE — "Do the risks OUTWEIGH the setup, or are they present-but-manageable?"
   Hunt for risks: signal conflicts the Trader minimized, missing data optimistically interpreted, event exposure ignored, fundamental weakness masked by momentum, valuation stretched beyond justification.
   ⚠️ CRITICAL: finding a risk is NOT automatically a REJECT vote. Grade your stance HONESTLY:
   - REJECT only if the risks are severe enough that you would REFUSE this trade outright.
   - NEUTRAL if real risks exist but are mitigated, priced in, or offset by the setup's strengths.
   - APPROVE if the downside is limited / well-contained relative to the opportunity.
   A perspective that always REJECTs is useless — most tradeable setups carry SOME risk.

2. NEUTRAL — "Is the conviction value supported by the actual evidence?"
   Audit: does the conviction match what scores + debate would naturally produce? Did Trader override formula by >15 points without clear justification? Is sizing proportional to conviction per STRATEGY.md table?

3. AGGRESSIVE — "Is there an under-exploited opportunity here, or is this a trap?"
   Examine: is the Trader being TOO cautious (HOLD when BUY justified)? Is the position size too small for the conviction level? Is there a strategy fit (S1-S4) the Trader missed?

After evaluating all 3, output ONE verdict: APPROVE / REJECT.

Respond with ONLY valid JSON.`;

function reviewerUserPrompt(decision: Record<string, unknown>, scores: Record<string, number | null>, portfolio: Record<string, unknown>): string {
  return `=== TRADER DECISION TO REVIEW ===
${JSON.stringify(decision, null, 2)}

=== SCORES (for verification of conviction logic) ===
${JSON.stringify(scores, null, 2)}

=== PORTFOLIO STATE ===
${JSON.stringify(portfolio, null, 2)}

Review from the 3 perspectives, synthesize, and emit verdict.

Respond ONLY with this JSON shape:
{
  "ticker": "${(decision.ticker as string) ?? "?"}",
  "verdict": "APPROVE" | "REJECT",
  "size_adjustment_pct": <float -20 to +20, 0 if no change>,
  "perspectives": {
    "conservative": { "stance": "APPROVE|NEUTRAL|REJECT", "key_concern": "<1 sentence>" },
    "neutral":      { "stance": "APPROVE|NEUTRAL|REJECT", "key_concern": "<1 sentence>" },
    "aggressive":   { "stance": "APPROVE|NEUTRAL|REJECT", "key_concern": "<1 sentence>" }
  },
  "synthesis": "<2-3 sentences integrating the 3 perspectives into the verdict>",
  "blocking_issues": ["<issue1 if REJECT, empty array if APPROVE>"]
}`;
}

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

interface Body {
  signal_id?: string;
  ticker?: string;
  decision?: Record<string, unknown>;
  scores?: Record<string, number | null>;
  portfolio?: Record<string, unknown>;
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!supabaseUrl || !serviceKey || !anthropicKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  let signalId: string | undefined;
  let ticker: string | undefined;
  let decision: Record<string, unknown> | undefined;
  let scores: Record<string, number | null> | undefined;
  let portfolio: Record<string, unknown> = { open_positions: [], cash_pct: 100, note: "V1 empty portfolio" };

  if (req.method === "POST") {
    try {
      const body = await req.json() as Body;
      signalId = body.signal_id;
      ticker = body.ticker?.toUpperCase();
      decision = body.decision;
      scores = body.scores;
      if (body.portfolio) portfolio = body.portfolio;
    } catch (e) {
      return jsonResponse({ ok: false, error: "invalid_json_body", detail: String((e as Error).message) }, 400);
    }
  } else {
    const url = new URL(req.url);
    signalId = url.searchParams.get("signal_id") ?? undefined;
    ticker = url.searchParams.get("ticker")?.toUpperCase();
  }

  // Fetch decision from DB if needed
  if (!decision || !scores) {
    let sigQuery = supabase
      .from("signals")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1);
    if (signalId) sigQuery = supabase.from("signals").select("*").eq("id", signalId).limit(1);
    else if (ticker) sigQuery = supabase.from("signals").select("*").eq("ticker", ticker).order("created_at", { ascending: false }).limit(1);
    const { data: sig } = await sigQuery.maybeSingle();
    if (!sig) return jsonResponse({ ok: false, error: "no_signal_found", hint: "Run generate-decision first OR provide via POST" }, 404);
    signalId = signalId ?? sig.id;
    ticker = ticker ?? sig.ticker;
    decision = {
      ticker: sig.ticker,
      action: sig.action,
      conviction: sig.conviction,
      position_size_pct: sig.position_size_pct,
      entry_price_target: sig.entry_price_target,
      stop_loss_pct: sig.stop_loss_pct,
      take_profit_pct: sig.take_profit_pct,
      strategy_used: sig.strategy_used,
      hold_days_estimate: sig.hold_days_estimate,
      rationale: sig.rationale,
      key_risks: sig.key_risks,
    };
    scores = {
      c1: sig.score_c1_earnings, c2: sig.score_c2_momentum, c3: sig.score_c3_smart_money,
      c4: sig.score_c4_quality, c5: sig.score_c5_valuation, c6: sig.score_c6_sentiment,
    };
  }

  if (!ticker) return jsonResponse({ ok: false, error: "ticker_required" }, 400);

  // --- Reviewer call ---
  const reviewer = await callClaude(anthropicKey, REVIEWER_SYSTEM, reviewerUserPrompt(decision!, scores!, portfolio), 1000);
  const reviewerLogId = await logCall(supabase, "reviewer", ticker, reviewer);

  const review = reviewer.parsed as {
    verdict?: "APPROVE" | "REJECT";
    size_adjustment_pct?: number;
    blocking_issues?: string[];
    synthesis?: string;
    perspectives?: {
      conservative?: { stance?: string };
      neutral?: { stance?: string };
      aggressive?: { stance?: string };
    };
  } | undefined;

  // 🔒 VETO DÉTERMINISTE (audit 01/07) — STRATEGY.md qualifie le veto 2/3-REJECT de
  // NON-NÉGOCIABLE. Avant, seul le champ `verdict` libre du modèle était lu : un
  // APPROVE émis alors que 2/3 des perspectives disent REJECT (auto-incohérence LLM
  // documentée) passait sans filet. On compte donc les stances en code et on FORCE
  // REJECT si ≥2 REJECT. Gardé aux BUY uniquement (SELL = protection asymétrique P14).
  let veto_applied = false;
  let reject_votes = 0;
  if (review && String(decision?.action).toUpperCase() === "BUY") {
    const stances = [review.perspectives?.conservative?.stance, review.perspectives?.neutral?.stance, review.perspectives?.aggressive?.stance];
    reject_votes = stances.filter(s => String(s ?? "").toUpperCase() === "REJECT").length;
    if (reject_votes >= 2 && review.verdict !== "REJECT") {
      review.verdict = "REJECT";
      veto_applied = true;
      review.blocking_issues = [...(review.blocking_issues ?? []), `deterministic_veto_${reject_votes}_of_3_perspectives_REJECT`];
    }
  }

  // --- Update signals row with reviewer_verdict ---
  let signalUpdated = false;
  if (signalId && review?.verdict) {
    const updates: Record<string, unknown> = {
      reviewer_verdict: review.verdict,
    };
    // Apply size adjustment if APPROVE
    if (review.verdict === "APPROVE" && typeof review.size_adjustment_pct === "number" && Math.abs(review.size_adjustment_pct) > 0) {
      const currentSize = decision!.position_size_pct as number | undefined;
      if (typeof currentSize === "number") {
        const newSize = currentSize * (1 + review.size_adjustment_pct / 100);
        updates.position_size_pct = Math.max(0, Math.min(12, newSize));
      }
    }
    const { error: upErr } = await supabase.from("signals").update(updates).eq("id", signalId);
    signalUpdated = !upErr;
    if (upErr) console.error("signals update failed:", upErr);
  }

  return jsonResponse({
    ok: reviewer.ok,
    ticker,
    signal_id: signalId,
    signal_updated: signalUpdated,
    duration_ms: Date.now() - t0,
    cost_usd: reviewer.cost_usd,
    review,
    deterministic_veto: { applied: veto_applied, reject_votes },
    pass: { log_id: reviewerLogId, latency_ms: reviewer.latency_ms, usage: reviewer.usage, error: reviewer.error },
  }, 200);
});
