// ============================================================================
// Aether — run-analysis-passes Edge Function
// ============================================================================
// Source : STRATEGY.md v2.7 Section 4 Bloc 2 + Section 5 + DEVIATIONS.md D-001
//
// Rôle : pour un ticker, exécute les 3 passes Claude Sonnet séquentielles :
//   - Pass 1 (TECHNICAL)    → score C2 + C2 utilisé pour context-priming Pass 2
//   - Pass 2 (SENTIMENT)    → score C6 (context-priming actif si C2 ≥ 7)
//   - Pass 3 (FUNDAMENTALS) → scores C1, C3, C4, C5 (C1 en fallback, pas de transcript)
//
// Logging : chaque appel Claude logué dans public.agent_logs.
// Modèle : pinned sur claude-sonnet-4-5-20250929 pour variance stable.
//
// Usage : GET /functions/v1/run-analysis-passes?ticker=INCY
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// --- Constants -------------------------------------------------------------
// ε — TIERED MODELS (POLISH ε) :
// Pass 1 (technical) + Pass 2 (sentiment) = analyses déterministes pures →
//   Haiku 4.5 suffit ($1/$5 per M), 3× moins cher.
// Pass 3 (fundamentals) = raisonnement complexe multi-clusters → Sonnet 4.5.
const MODEL_HAIKU = "claude-haiku-4-5-20251001";   // Pass 1 + 2
const MODEL_SONNET = "claude-sonnet-4-5-20250929"; // Pass 3
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Pricing
const COST_HAIKU_INPUT_PER_M = 1.0;
const COST_HAIKU_OUTPUT_PER_M = 5.0;
const COST_SONNET_INPUT_PER_M = 3.0;
const COST_SONNET_OUTPUT_PER_M = 15.0;

// --- Types -----------------------------------------------------------------
interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
}
interface ClaudeResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: ClaudeUsage;
  model?: string;
  stop_reason?: string;
}
interface CallResult {
  ok: boolean;
  parsed?: Record<string, unknown>;
  raw_text?: string;
  usage?: ClaudeUsage;
  latency_ms: number;
  cost_usd: number;
  error?: string;
}

// --- Helpers ---------------------------------------------------------------
function costUsd(usage: ClaudeUsage | undefined, model: string): number {
  const inp = usage?.input_tokens ?? 0;
  const out = usage?.output_tokens ?? 0;
  const isHaiku = model.includes("haiku");
  const inP = isHaiku ? COST_HAIKU_INPUT_PER_M : COST_SONNET_INPUT_PER_M;
  const outP = isHaiku ? COST_HAIKU_OUTPUT_PER_M : COST_SONNET_OUTPUT_PER_M;
  return (inp * inP + out * outP) / 1_000_000;
}

async function callClaude(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 1024,
  temperature = 0,           // P-003 — déterministe pour reproductibilité
  model = MODEL_SONNET,      // ε — Pass 1+2 override avec MODEL_HAIKU
): Promise<CallResult> {
  const t0 = Date.now();
  // Audit 01/07 : retry/backoff sur 429/5xx (un 429 sur pass3 droppait le ticker
  // en silence, non rattrapable) + fail-closed sur JSON illisible (HTTP 200 mais
  // parse KO → ok:false plutôt qu'une dégradation muette en HOLD/null).
  const MAX_RETRIES = 3;
  let lastErr = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      if (r.status === 429 || r.status >= 500) {
        lastErr = `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
        if (attempt < MAX_RETRIES) {
          const ra = parseFloat(r.headers.get("retry-after") ?? "");
          const backoff = Number.isFinite(ra) ? Math.min(30000, ra * 1000)
            : Math.min(8000, 700 * 2 ** attempt) * (0.5 + Math.random());
          await new Promise(res => setTimeout(res, backoff));
          continue;
        }
        return { ok: false, latency_ms: Date.now() - t0, cost_usd: 0, error: lastErr };
      }
      if (!r.ok) {
        return { ok: false, latency_ms: Date.now() - t0, cost_usd: 0, error: `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}` };
      }
      const data = await r.json() as ClaudeResponse;
      const text = data.content?.find(b => b.type === "text")?.text ?? "";
      let parsed: Record<string, unknown> | undefined;
      try {
        const cleaned = text.replace(/^```json\s*|\s*```$/g, "").trim();
        parsed = JSON.parse(cleaned);
      } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) { try { parsed = JSON.parse(match[0]); } catch { /* keep undefined */ } }
      }
      if (!parsed) {
        return { ok: false, raw_text: text, usage: data.usage, latency_ms: Date.now() - t0, cost_usd: costUsd(data.usage, model), error: "json_parse_failed" };
      }
      return { ok: true, parsed, raw_text: text, usage: data.usage, latency_ms: Date.now() - t0, cost_usd: costUsd(data.usage, model) };
    } catch (e) {
      lastErr = String((e as Error).message ?? e);
      if (attempt < MAX_RETRIES) {
        await new Promise(res => setTimeout(res, Math.min(8000, 700 * 2 ** attempt) * (0.5 + Math.random())));
        continue;
      }
      return { ok: false, latency_ms: Date.now() - t0, cost_usd: 0, error: lastErr };
    }
  }
  return { ok: false, latency_ms: Date.now() - t0, cost_usd: 0, error: lastErr || "unknown" };
}

// Table de fraîcheur C1 (déterministe, code — plus dans la tête du LLM). jours depuis earnings.
function freshnessMult(days: number | null): number {
  if (days === null) return 0.10;
  if (days <= 3) return 1.00;
  if (days <= 7) return 0.83;
  if (days <= 12) return 0.55;
  if (days <= 21) return 0.27;
  return 0.10;
}

async function logCall(
  supabase: SupabaseClient,
  log_type: string,
  ticker: string,
  result: CallResult,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("agent_logs")
    .insert({
      log_type,
      ticker,
      input_tokens: result.usage?.input_tokens ?? null,
      output_tokens: result.usage?.output_tokens ?? null,
      latency_ms: result.latency_ms,
      cost_usd: result.cost_usd,
      raw_output: result.parsed ?? { raw_text: result.raw_text?.slice(0, 5000) },
      error: result.error ?? null,
    })
    .select("id")
    .single();
  if (error) {
    console.error("agent_logs insert failed:", error);
    return null;
  }
  return data?.id ?? null;
}

// --- Data extractors -------------------------------------------------------

function safe<T = unknown>(v: unknown, path: string[], fallback: T): T {
  let cur: unknown = v;
  for (const k of path) {
    if (cur && typeof cur === "object" && k in (cur as object)) {
      cur = (cur as Record<string, unknown>)[k];
    } else return fallback;
  }
  return (cur ?? fallback) as T;
}

function firstOf<T = unknown>(v: unknown, fallback?: T): T | undefined {
  if (Array.isArray(v) && v.length > 0) return v[0] as T;
  return fallback;
}

interface Collected {
  data: {
    meta: { profile?: unknown; quote?: unknown };
    C1_earnings: Record<string, unknown>;
    C2_technicals: Record<string, unknown>;
    C3_smart_money: Record<string, unknown>;
    C4_quality: Record<string, unknown>;
    C5_valuation: Record<string, unknown>;
    C6_news: Record<string, unknown>;
  };
  sector_detected?: string;
}

function prepTechnical(c: Collected, ticker: string): string {
  const quote = firstOf<Record<string, unknown>>(c.data.meta.quote);
  const price = quote?.price ?? "unknown";
  const change_pct = quote?.changesPercentage ?? quote?.changePercentage ?? "?";
  const rsiArr = c.data.C2_technicals.rsi as Array<{ rsi?: number }> | null;
  const rsi = rsiArr?.[0]?.rsi ?? null;
  const sma20Arr = c.data.C2_technicals.sma20 as Array<{ sma?: number }> | null;
  const sma20 = sma20Arr?.[0]?.sma ?? null;
  const sma50Arr = c.data.C2_technicals.sma50 as Array<{ sma?: number }> | null;
  const sma50 = sma50Arr?.[0]?.sma ?? null;
  const adxArr = c.data.C2_technicals.adx as Array<{ adx?: number }> | null;
  const adx = adxArr?.[0]?.adx ?? null;
  const computed = c.data.C2_technicals.computed as {
    macd?: { macd: number; signal: number; histogram: number; bullish_cross_recent: boolean; bearish_cross_recent: boolean };
    bollinger?: { middle: number; upper: number; lower: number; width_pct: number; current_position: number; is_compressed: boolean };
    n_closes?: number;
  } | undefined;

  const priceVsSma20 = (typeof price === "number" && typeof sma20 === "number") ? (price > sma20 ? "ABOVE" : "BELOW") : "?";
  const priceVsSma50 = (typeof price === "number" && typeof sma50 === "number") ? (price > sma50 ? "ABOVE" : "BELOW") : "?";
  const adxStrength = typeof adx === "number" ? (adx > 25 ? "strong trend" : adx > 20 ? "moderate trend" : "weak/no trend") : "?";
  const macdCross = computed?.macd?.bullish_cross_recent ? "BULLISH cross today" : computed?.macd?.bearish_cross_recent ? "BEARISH cross today" : "no recent cross";

  return `TICKER: ${ticker}
CURRENT PRICE: $${price} (${change_pct}% today)

PRE-COMPUTED INDICATORS (90d history, ${computed?.n_closes ?? "?"} trading days):
- RSI 14: ${rsi}
- MACD: line=${computed?.macd?.macd?.toFixed(3) ?? "?"}, signal=${computed?.macd?.signal?.toFixed(3) ?? "?"}, histogram=${computed?.macd?.histogram?.toFixed(3) ?? "?"} (${macdCross})
- SMA 20: $${sma20}
- SMA 50: $${sma50}
- Price ${priceVsSma20} SMA20, ${priceVsSma50} SMA50
- ADX 14: ${adx} (${adxStrength})
- Bollinger 20: middle $${computed?.bollinger?.middle?.toFixed(2) ?? "?"}, upper $${computed?.bollinger?.upper?.toFixed(2) ?? "?"}, lower $${computed?.bollinger?.lower?.toFixed(2) ?? "?"}, width ${computed?.bollinger?.width_pct?.toFixed(2) ?? "?"}% ${computed?.bollinger?.is_compressed ? "(COMPRESSED — Strat-LLM S3 setup candidate)" : ""}
- Bollinger position: ${((computed?.bollinger?.current_position ?? 0) * 100).toFixed(0)}% (0%=on lower band, 100%=on upper)`;
}

function prepSentiment(c: Collected, ticker: string, c2Score: number | null): { userPrompt: string; contextPriming: boolean; window_hours: number; n_articles: number } {
  const contextPriming = c2Score !== null && c2Score >= 7;
  const allNews = Array.isArray(c.data.C6_news.news) ? c.data.C6_news.news as Array<{ publishedDate?: string; title?: string; text?: string }> : [];
  const nowMs = Date.now();
  const within24h = allNews.filter(a => {
    if (!a.publishedDate) return false;
    return (nowMs - Date.parse(a.publishedDate)) < 24 * 3600 * 1000;
  });
  const window_hours = within24h.length >= 3 ? 24 : 48;
  const articles = (window_hours === 24 ? within24h : allNews.filter(a => a.publishedDate && (nowMs - Date.parse(a.publishedDate)) < 48 * 3600 * 1000)).slice(0, 5);

  const filings = Array.isArray(c.data.C6_news.sec_8k) ? c.data.C6_news.sec_8k as Array<{ filingDate?: string; formType?: string; linkText?: string }> : [];
  const upcoming = Array.isArray(c.data.C1_earnings.calendar_future) ? (c.data.C1_earnings.calendar_future as Array<{ date?: string }>)[0] : null;
  const daysUntil = upcoming?.date ? Math.round((Date.parse(upcoming.date) - nowMs) / (86400 * 1000)) : null;

  const articlesText = articles.length > 0
    ? articles.map((a, i) => `[${i+1}] ${a.publishedDate ?? "?"} — "${a.title ?? "no title"}"\n    ${(a.text ?? "").slice(0, 350)}`).join("\n\n")
    : "No articles in window.";

  const filingsText = filings.length > 0
    ? filings.slice(0, 5).map(f => `- ${f.filingDate}: ${f.formType ?? "8-K"} — ${(f.linkText ?? "").slice(0, 150)}`).join("\n")
    : "None";

  const userPrompt = `${contextPriming
    ? `MOMENTUM CONTEXT: This stock has STRONG momentum (C2=${c2Score}/10). Evaluate whether news of the last ${window_hours}h CONFIRM or INVALIDATE trend continuation. Question is NOT "are news positive in absolute" but "do they support trend continuation?".`
    : `Standard sentiment analysis — evaluate news tone in absolute terms.`}

TICKER: ${ticker}

NEWS WINDOW: ${window_hours}h (${articles.length} articles)

ARTICLES:
${articlesText}

8-K FILINGS (last 30 days, ${filings.length} total):
${filingsText}

UPCOMING EARNINGS: ${daysUntil !== null ? `Next earnings in ${daysUntil} days (${upcoming?.date})` : "No upcoming earnings in next 60 days"}`;

  return { userPrompt, contextPriming, window_hours, n_articles: articles.length };
}

function prepFundamentals(c: Collected, ticker: string, sector: string | undefined): string {
  // Financial scores (Piotroski + Altman + components)
  const scoresArr = c.data.C4_quality.scores as Array<Record<string, unknown>> | null;
  const fs = scoresArr?.[0] ?? {};
  const piotroski = fs.piotroskiScore ?? fs.piotroski_score ?? "n/a";
  const altman = fs.altmanZScore ?? fs.altman_z_score ?? "n/a";

  const cashflowArr = c.data.C4_quality.cash_flow as Array<Record<string, unknown>> | null;
  const cf0 = cashflowArr?.[0] ?? {};
  const cf1 = cashflowArr?.[1] ?? {};
  const cfo = cf0.operatingCashFlow ?? "n/a";
  const capex = cf0.capitalExpenditure ?? "n/a";
  const capex_prev = cf1.capitalExpenditure ?? null;
  const capexYoY = (typeof capex === "number" && typeof capex_prev === "number" && capex_prev !== 0)
    ? `${(((capex - capex_prev) / Math.abs(capex_prev)) * 100).toFixed(1)}%` : "n/a";

  const incomeArr = c.data.C4_quality.income as Array<Record<string, unknown>> | null;
  const ni0 = incomeArr?.[0] ?? {};
  const netIncome = ni0.netIncome ?? "n/a";
  const grossProfit = ni0.grossProfit ?? "n/a";

  // EQOFFER detection via cash flow (proceeds from stock issuance)
  // Le commonStock du balance sheet = par value, pas shares outstanding → unreliable
  const stockIssuance = cf0.commonStockIssued ?? cf0.proceedsFromIssuanceOfCommonStock ?? 0;
  const equityOffer = (typeof stockIssuance === "number" && stockIssuance > 50_000_000)
    ? `YES — stock issuance $${(stockIssuance / 1e6).toFixed(0)}M (negative per Piotroski EQOFFER)`
    : "no significant equity offering";

  // Earnings history → compute surprises
  const earnings = c.data.C1_earnings.earnings_history as Array<{ date?: string; epsActual?: number; epsEstimated?: number }> | null;
  const earningsLines = Array.isArray(earnings) && earnings.length > 0
    ? earnings.slice(0, 4).map((e, i) => {
        const surprise = (typeof e.epsActual === "number" && typeof e.epsEstimated === "number" && e.epsEstimated !== 0)
          ? `${(((e.epsActual - e.epsEstimated) / Math.abs(e.epsEstimated)) * 100).toFixed(1)}%` : "n/a";
        return `Q-${i+1} (${e.date}): actual=${e.epsActual ?? "?"}, est=${e.epsEstimated ?? "?"} → surprise ${surprise}`;
      }).join("\n")
    : "No earnings history available";

  const lastEarnDate = earnings?.find(e => e.date && new Date(e.date) < new Date())?.date;
  const daysSinceEarnings = lastEarnDate ? Math.round((Date.now() - Date.parse(lastEarnDate)) / (86400 * 1000)) : null;

  // Price target summary
  const ptArr = c.data.C1_earnings.price_target as Array<Record<string, unknown>> | null;
  const pt = ptArr?.[0] ?? {};
  const targetAvg = pt.lastMonthAvgPriceTarget ?? pt.allTimeAvgPriceTarget ?? "n/a";
  const targetHigh = pt.lastMonthAvgPriceTargetTop ?? "n/a";

  // Insider activity — distinguer open-market (purchases/sales) vs all (acquired/disposed incl. option grants)
  const insStatsArr = c.data.C3_smart_money.insider_stats as Array<Record<string, unknown>> | null;
  const insStats = insStatsArr?.[0] ?? {};
  const openMarketBuys = insStats.totalPurchases ?? "n/a";
  const openMarketSells = insStats.totalSales ?? "n/a";
  const allAcquired = insStats.acquiredTransactions ?? "n/a";
  const allDisposed = insStats.disposedTransactions ?? "n/a";
  const acquiredDisposedRatio = insStats.acquiredDisposedRatio ?? "n/a";

  const insSearch = c.data.C3_smart_money.insider_search as Array<Record<string, unknown>> | null;
  const recentInsiders = Array.isArray(insSearch)
    ? insSearch.slice(0, 8).map(t => {
        const tdate = t.transactionDate ?? "?";
        const fdate = t.filingDate ?? "?";
        const delay = (tdate !== "?" && fdate !== "?") ? Math.round((Date.parse(String(fdate)) - Date.parse(String(tdate))) / (86400 * 1000)) : null;
        const delayFlag = delay !== null && delay > 5 ? ` ⚠️ filed ${delay}d late (P15 stale)` : "";
        return `- TRANDATE ${tdate}: ${t.transactionType ?? "?"} ${t.reportingName ?? "?"} (${t.typeOfOwner ?? "?"})${delayFlag}`;
      }).join("\n")
    : "No recent transactions";

  // Congress
  const senate = Array.isArray(c.data.C3_smart_money.senate) ? c.data.C3_smart_money.senate as Array<Record<string, unknown>> : [];
  const house = Array.isArray(c.data.C3_smart_money.house) ? c.data.C3_smart_money.house as Array<Record<string, unknown>> : [];
  const congress = [...senate, ...house].slice(0, 5);
  const congressText = congress.length > 0
    ? congress.map(c => `- ${c.transactionDate ?? c.dateRecieved ?? "?"} ${c.firstName ?? ""} ${c.lastName ?? ""}: ${c.type ?? "?"} ${c.amount ?? "?"}`).join("\n")
    : "No recent congressional activity";

  // DCF + valuation — FMP utilise "Stock Price" avec ESPACE (pas underscore/camelCase)
  const dcfArr = c.data.C5_valuation.dcf as Array<Record<string, unknown>> | null;
  const dcfRow = dcfArr?.[0] ?? {};
  const dcfValue = dcfRow.dcf ?? "n/a";
  const dcfCurrentPrice = dcfRow["Stock Price"] ?? dcfRow.stockPrice ?? "n/a";
  // DCF sanitize (audit 01/07) : l'endpoint FMP renvoie ~1/3 de valeurs aberrantes
  // (upside de -533% à +1136%). On invalide dcf ≤ 0 et |upside| > 100% → 'n/a'.
  const dcfUpsideNum = (typeof dcfValue === "number" && dcfValue > 0 && typeof dcfCurrentPrice === "number" && dcfCurrentPrice > 0)
    ? ((dcfValue - dcfCurrentPrice) / dcfCurrentPrice) * 100 : null;
  const dcfUpside = (dcfUpsideNum !== null && Math.abs(dcfUpsideNum) <= 100)
    ? `${dcfUpsideNum.toFixed(1)}%` : "n/a (DCF FMP non fiable — ignorer)";

  // EV/EBITDA : le champ km.evToEBITDATTM N'EXISTE PAS chez FMP (comme le bug roe).
  // Le vrai champ est enterpriseValueMultipleTTM, présent dans ratios-ttm (déjà collecté).
  const kmArr = c.data.C5_valuation.key_metrics as Array<Record<string, unknown>> | null;
  const km = kmArr?.[0] ?? {};
  const ratiosArr = c.data.C5_valuation.ratios as Array<Record<string, unknown>> | null;
  const rt = ratiosArr?.[0] ?? {};
  const evEbitda = rt.enterpriseValueMultipleTTM ?? km.evToEBITDA ?? km.evToEBITDATTM ?? "n/a";
  const fcfYield = km.freeCashFlowYieldTTM ?? "n/a";
  const earningsYield = km.earningsYieldTTM ?? "n/a";
  const roce = km.returnOnCapitalEmployedTTM ?? km.returnOnInvestedCapitalTTM ?? "n/a";

  const sectorPeArr = c.data.C5_valuation.sector_pe as Array<Record<string, unknown>> | null;
  const sectorPe = sectorPeArr?.[0]?.pe ?? "n/a";

  return `TICKER: ${ticker} | SECTOR: ${sector ?? "unknown"}

=== C4 QUALITY (Piotroski + Altman + components) ===
Piotroski F-Score: ${piotroski}/9
Altman Z-Score: ${altman} (>2.99 safe, 1.81-2.99 gray, <1.81 distress)
Operating Cash Flow: ${cfo}
Net Income: ${netIncome}
CFO vs Net Income: ${(typeof cfo === "number" && typeof netIncome === "number") ? (cfo > netIncome ? "CFO > NI (clean — no accrual manipulation)" : "CFO < NI ⚠️ accrual signal (Sloan, P18)") : "n/a"}
CapEx YoY: ${capexYoY} (positive ≥10% = bonus, drop ≥20% = penalty per P9)
Equity offering: ${equityOffer}

=== C1 EARNINGS HISTORY (fallback mode — no transcript, DEVIATIONS D-001) ===
${earningsLines}
Days since last earnings: ${daysSinceEarnings ?? "?"}
FRESHNESS multiplier to apply:
  ≤3d: ×1.00 | 4-7d: ×0.83 | 8-12d: ×0.55 | 13-21d: ×0.27 | >21d: ×0.10

=== C1 ANALYST UPGRADES (price target summary) ===
Avg target (last month): $${targetAvg} | High target: $${targetHigh}

=== C3 SMART MONEY (3/4 signals — 13F unavailable Premium) ===
Insider stats 3mo:
- Open-market : purchases=${openMarketBuys}, sales=${openMarketSells}  ← signal le plus propre
- All txn      : acquired=${allAcquired}, disposed=${allDisposed}, ratio=${acquiredDisposedRatio}  ← inclut option grants (bruit)
Recent insider transactions (by TRANDATE per P15):
${recentInsiders}

Congress trades (last entries):
${congressText}

=== C5 VALUATION ===
DCF intrinsic value: $${dcfValue} vs current $${dcfCurrentPrice} → upside ${dcfUpside}
EV/EBITDA TTM: ${evEbitda} (sector PE proxy: ${sectorPe})
FCF yield TTM: ${fcfYield}
Earnings yield TTM: ${earningsYield}  ← proxy Acquirer's Multiple (P12)
Return on capital TTM: ${roce}`;
}

// --- System prompts (constant) ---------------------------------------------

const PASS1_SYSTEM = `You are a technical analyst evaluating mid-cap US stocks for a swing trading system (3-21 day holds).

CRITICAL RULES:
- Work ONLY from pre-computed indicators provided. NEVER process raw OHLCV tables (Xie et al. 2023).
- Confirm the ticker symbol in your output.
- The decision-maker downstream prefers HOLD over forcing trades. Be honest about ambiguity.

MOMENTUM SCORING (C2, 1-10):
- 9-10: price > SMA20 > SMA50 AND RSI 50-65 AND ADX > 25 (clean strong uptrend)
- 7-8 : price > SMA20 AND RSI 45-70 AND ADX > 20 (decent trend)
- 5-6 : price between SMAs, RSI 40-60 (neutral)
- 3-4 : price < SMA20, RSI < 45 (weak)
- 1-2 : price < SMA50 AND RSI < 35 AND ADX strong bearish (downtrend)
- PENALTY -2 if RSI > 75 (overbought)
- BONUS +1 if Bollinger compressed AND price near upper band (S3 setup)
- BONUS +1 if MACD bullish cross today

VOLATILITY/SETUP QUALITY (1-10): is the price action clean and tradeable, or messy?

Respond with ONLY valid JSON (no markdown, no preamble).`;

const PASS2_SYSTEM = `You are a financial news sentiment analyst evaluating mid-cap US stocks for a swing trading system.

CRITICAL RULES:
- Confirm the ticker symbol in your output.
- Avoid recency bias: an article from yesterday is not more true than from last week.
- Prefer concise reasoning (Anic et al. 2025 — simple prompts beat complex ones).

SENTIMENT SCORING (C6, 1-10):
- 9-10: dominantly positive tone, no anxious/sad language in 8-K filings
- 7-8 : moderately positive
- 5-6 : neutral
- 3-4 : modest negativity, anxiety markers present
- 1-2 : strongly negative, dominant sad/distressed language
- BONUS +1 if 8-K positive event (M&A accretive, raised guidance, buyback)
- PENALTY -2 if 8-K negative event (lawsuit, restatement, lowered guidance)
- BONUS +1 if context-priming active AND news confirm momentum continuation

LIWC dimensions (Medya et al. 2022, weights to consider):
- Negative emotion → strong negative signal
- Sadness → strongest negative signal
- Positive emotion → positive signal
- Anxiety → moderate negative
- IGNORE: certainty, anger, insight (not predictive)

NEWS IMPACT (1-10): how material are the events covered, beyond just tone?

Respond with ONLY valid JSON (no markdown, no preamble).`;

const PASS3_SYSTEM = `You are a fundamental analyst evaluating mid-cap US stocks ($2B-$20B) for a swing trading system.

CRITICAL RULES:
- Confirm the ticker symbol in your output.
- Score the 4 clusters INDEPENDENTLY (no confirmation bias — do not let one strong signal pull the others).
- Acknowledge the 80-89% positive earnings surprise base rate. Do NOT default to bullish — balanced analysis matters.
- The decision-maker downstream prefers HOLD over forcing trades.

C1 EARNINGS CATALYST (FALLBACK MODE — no transcript available, see DEVIATIONS.md D-001):
Formula: C1_final = (eps_score × 0.60 + upgrades_score × 0.40) × freshness_multiplier
- eps_score from latest EPS surprise:
  > +10% AND recent → 9-10 | +5-10% AND recent → 7-8 | +2-5% → 5-6 | ±2% → 4 | -2 to -5% → 2-3 | <-5% → 1
- upgrades_score from price target trends post-earnings
- freshness_mult provided in user data

C3 SMART MONEY (3/4 signals — 13F unavailable):
- CEO/CFO buy >$100K in last 30d → 9-10
- Clustered buys (3+ insiders within 2 weeks) → 10
- Congress healthcare/tech buy < 45d → 8-9
- Recent insider buys, no sells → 6-7
- No notable activity → 5
- Significant insider sells → 2-3
- PENALTY -1 if CEO/CFO buy filed > 5d late (P15 stale signal)

C4 QUALITY (DEFENSIVE FILTER ONLY per P12 — never alpha generator):
- F-Score ≥ 8 AND Altman > 3.0 → 9-10
- F-Score 6-7 AND Altman ≥ 2.675 → 7-8
- F-Score 5 AND Altman gray zone → 5-6
- F-Score ≤ 2 OR Altman < 1.81 → 1-2
- PENALTY -1 if CFO < Net Income (accruals signal, Sloan)
- PENALTY -1 if recent equity offering (EQOFFER)
- BONUS +1 if CapEx YoY ≥ 10% AND sector in {Technology, Industrials}

C5 VALUATION:
- DCF upside > 40% AND PE < sector → 9-10
- DCF upside 20-40% → 7-8
- DCF upside 10-20% → 6-7
- DCF downside > 20% → 1-2
- If DCF upside is "n/a" (unreliable/negative FMP DCF), IGNORE DCF entirely and score C5 on EV/EBITDA + earnings yield + FCF yield vs sector only. A missing DCF is NOT a negative.
- BONUS +1 if EV/EBITDA below sector median
- BONUS +2 if EV/EBITDA < 50% of sector median (deep value)

Respond with ONLY valid JSON (no markdown, no preamble).`;

// --- User prompt templates -------------------------------------------------

function pass1UserPrompt(ticker: string, indicators: string): string {
  return `${indicators}

Score this stock on:
1. Momentum (C2, 1-10)
2. Volatility/setup quality (1-10)

Respond ONLY with this JSON shape:
{
  "ticker": "${ticker}",
  "score_c2_momentum": <int 1-10>,
  "score_volatility": <int 1-10>,
  "setup_detected": "<S1 reversal | S2 breakout | S3 compression | S4 confirmation | none>",
  "rationale": "<2-3 sentences referencing specific indicators>",
  "key_risks": ["<risk1>", "<risk2>"]
}`;
}

function pass2UserPrompt(ticker: string, sentimentBlock: string): string {
  return `${sentimentBlock}

Score this stock on:
1. News sentiment (C6, 1-10)
2. News impact magnitude (1-10)

Respond ONLY with this JSON shape:
{
  "ticker": "${ticker}",
  "score_c6_sentiment": <int 1-10>,
  "score_news_impact": <int 1-10>,
  "dominant_themes": ["<theme1>", "<theme2>"],
  "rationale": "<2-3 sentences>",
  "key_risks": ["<risk1>"]
}`;
}

function pass3UserPrompt(ticker: string, fundamentalsBlock: string): string {
  return `${fundamentalsBlock}

Score this stock INDEPENDENTLY on the 4 clusters below (no confirmation bias).

Respond ONLY with this JSON shape:
{
  "ticker": "${ticker}",
  "score_c1_earnings": <int 1-10>,
  "score_c3_smart_money": <int 1-10>,
  "score_c4_quality": <int 1-10>,
  "score_c5_valuation": <int 1-10>,
  "c1_fallback_details": {
    "eps_score": <int 1-10>,
    "upgrades_score": <int 1-10>,
    "freshness_mult": <float 0.10-1.00>,
    "days_since_earnings": <int>
  },
  "contrarian_signal": <bool — true if negative EPS but other strong positives>,
  "rationale": "<3-4 sentences integrating all 4 clusters>",
  "key_risks": ["<risk1>", "<risk2>"]
}`;
}

// --- Main handler ----------------------------------------------------------

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const url = new URL(req.url);
  const ticker = url.searchParams.get("ticker")?.toUpperCase();

  if (!ticker || !/^[A-Z.-]{1,10}$/.test(ticker)) {
    return new Response(JSON.stringify({ ok: false, error: "invalid_ticker_param", hint: "?ticker=INCY" }, null, 2),
      { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!anthropicKey || !supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ ok: false, error: "missing_env_vars" }, null, 2),
      { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // === Step 1: collect-stock-data (internal call) ===
  // Note : on utilise ANON_KEY (JWT legacy) pour l'auth inter-functions,
  // pas SERVICE_ROLE_KEY (nouveau format sb_secret_* non reconnu par verify_jwt).
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const collectStart = Date.now();
  const collectResp = await fetch(`${supabaseUrl}/functions/v1/collect-stock-data?ticker=${ticker}`, {
    headers: { "Authorization": `Bearer ${anonKey}` },
  });
  const collected = await collectResp.json() as Collected & { sector_detected?: string; data_completeness?: unknown; fetch_errors?: unknown[] };
  const collectMs = Date.now() - collectStart;

  if (!collected.data) {
    return new Response(JSON.stringify({ ok: false, error: "collect_stock_data_failed", collected }, null, 2),
      { status: 502, headers: { "Content-Type": "application/json" } });
  }

  const sector = collected.sector_detected;

  // === Step 2: Pass 1 — TECHNICAL ===
  const technicalBlock = prepTechnical(collected, ticker);
  const pass1 = await callClaude(anthropicKey, PASS1_SYSTEM, pass1UserPrompt(ticker, technicalBlock), 800, 0, MODEL_HAIKU);
  const pass1LogId = await logCall(supabase, "analysis_pass1", ticker, pass1);
  const c2Score = (pass1.parsed?.score_c2_momentum as number | undefined) ?? null;

  // === Step 3: Pass 2 — SENTIMENT (with context-priming if C2 ≥ 7) ===
  const sentPrep = prepSentiment(collected, ticker, c2Score);
  const pass2 = await callClaude(anthropicKey, PASS2_SYSTEM, pass2UserPrompt(ticker, sentPrep.userPrompt), 800, 0, MODEL_HAIKU);
  const pass2LogId = await logCall(supabase, "analysis_pass2", ticker, pass2);

  // === Step 4: Pass 3 — FUNDAMENTALS ===
  const fundBlock = prepFundamentals(collected, ticker, sector);
  const pass3 = await callClaude(anthropicKey, PASS3_SYSTEM, pass3UserPrompt(ticker, fundBlock), 1200);
  const pass3LogId = await logCall(supabase, "analysis_pass3", ticker, pass3);

  // === Step 5: Aggregate scores ===
  // C1 RECALCULÉ DÉTERMINISTE en code (audit 01/07) : le LLM émettait un c1 final
  // arithmétiquement faux et non-reproductible (×2-6 à temp=0). On garde son jugement
  // (eps_score, upgrades_score, days) mais on applique la formule + la fraîcheur en code.
  const c1d = pass3.parsed?.c1_fallback_details as { eps_score?: number; upgrades_score?: number; days_since_earnings?: number } | undefined;
  let c1Final: number | null = (pass3.parsed?.score_c1_earnings as number | undefined) ?? null;
  if (c1d && typeof c1d.eps_score === "number" && typeof c1d.upgrades_score === "number") {
    const days = typeof c1d.days_since_earnings === "number" ? c1d.days_since_earnings : null;
    const raw = (c1d.eps_score * 0.6 + c1d.upgrades_score * 0.4) * freshnessMult(days);
    c1Final = Math.max(1, Math.min(10, Math.round(raw)));
  }

  const scores = {
    c1: c1Final,
    c2: pass1.parsed?.score_c2_momentum ?? null,
    c3: pass3.parsed?.score_c3_smart_money ?? null,
    c4: pass3.parsed?.score_c4_quality ?? null,
    c5: pass3.parsed?.score_c5_valuation ?? null,
    c6: pass2.parsed?.score_c6_sentiment ?? null,
  };

  const total_cost_usd = pass1.cost_usd + pass2.cost_usd + pass3.cost_usd;

  return new Response(JSON.stringify({
    ok: pass1.ok && pass2.ok && pass3.ok,
    ticker,
    sector,
    duration_ms: Date.now() - t0,
    cost_usd: total_cost_usd,
    collected: {
      duration_ms: collectMs,
      data_completeness: collected.data_completeness,
      fetch_errors: collected.fetch_errors,
    },
    scores,
    fallbacks_applied: [
      "c1_transcript_missing (Premium plan, DEVIATIONS D-001)",
      "c3_13f_missing (Premium plan, DEVIATIONS D-001)",
    ],
    context_priming_active: sentPrep.contextPriming,
    news_window_used: `${sentPrep.window_hours}h (${sentPrep.n_articles} articles)`,
    passes: {
      pass1_technical: {
        ok: pass1.ok,
        latency_ms: pass1.latency_ms,
        cost_usd: pass1.cost_usd,
        usage: pass1.usage,
        log_id: pass1LogId,
        parsed: pass1.parsed,
        error: pass1.error,
      },
      pass2_sentiment: {
        ok: pass2.ok,
        latency_ms: pass2.latency_ms,
        cost_usd: pass2.cost_usd,
        usage: pass2.usage,
        log_id: pass2LogId,
        parsed: pass2.parsed,
        error: pass2.error,
      },
      pass3_fundamentals: {
        ok: pass3.ok,
        latency_ms: pass3.latency_ms,
        cost_usd: pass3.cost_usd,
        usage: pass3.usage,
        log_id: pass3LogId,
        parsed: pass3.parsed,
        error: pass3.error,
      },
    },
  }, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
