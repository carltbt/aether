// ============================================================================
// Aether — collect-stock-data Edge Function
// ============================================================================
// Source : STRATEGY.md v2.7 Section 6 (Mapping FMP → clusters)
//
// Rôle : pour UN ticker donné, fetch en parallèle TOUS les endpoints FMP
// nécessaires aux 6 clusters de scoring + cluster contextuel earnings/insider.
// Retourne un JSON structuré par cluster, prêt à être consommé par les 3
// passes d'analyse Claude (Étape 7).
//
// Tolérance aux échecs : chaque endpoint est isolé. Un 404/500 sur un endpoint
// remplit fetch_errors mais ne fait pas planter la fonction. La layer scoring
// décide des fallbacks via data_completeness.
//
// Usage : GET /functions/v1/collect-stock-data?ticker=INCY
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FMP_BASE = "https://financialmodelingprep.com";

// ---------- Helpers ---------------------------------------------------------

interface FmpResult<T = unknown> {
  ok: boolean;
  data?: T;
  status?: number;
  error?: string;
  endpoint: string;
}

async function fmpFetch<T = unknown>(
  path: string,
  apiKey: string,
  params: Record<string, string | number | boolean> = {},
): Promise<FmpResult<T>> {
  const urlParams = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) urlParams.set(k, String(v));
  urlParams.set("apikey", apiKey);
  const url = `${FMP_BASE}${path}?${urlParams.toString()}`;
  const endpoint = `${path}?${[...urlParams.keys()].filter(k => k !== "apikey").map(k => `${k}=${urlParams.get(k)}`).join("&")}`;

  try {
    const r = await fetch(url);
    if (!r.ok) {
      return { ok: false, status: r.status, error: (await r.text()).slice(0, 200), endpoint };
    }
    const data = await r.json() as T;
    return { ok: true, data, endpoint };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e), endpoint };
  }
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
}
function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------- Cluster-specific fetchers --------------------------------------

async function fetchProfile(t: string, key: string) {
  // Profile pour avoir sector exact, beta, mcap actuel
  return fmpFetch(`/stable/profile`, key, { symbol: t });
}

async function fetchQuote(t: string, key: string) {
  return fmpFetch(`/stable/quote`, key, { symbol: t });
}

// === C2 — Technicals ===
// MACD et Bollinger Bands sont CALCULÉS LOCALEMENT depuis l'OHLCV.
// Raisons : FMP /api/v3/ est deprecated, /stable/ n'expose pas ces indicateurs,
// et un calcul local est déterministe + zéro coût/quota supplémentaire.
async function fetchC2(t: string, key: string) {
  const tf = { timeframe: "1day", from: isoDaysAgo(90), to: isoToday() };
  const [ohlcv, rsi, sma20, sma50, adx] = await Promise.all([
    // 90 jours d'historique pour avoir assez de profondeur pour EMA26 + signal9 = 35+ samples
    fmpFetch(`/stable/historical-price-eod/full`, key, { symbol: t, from: isoDaysAgo(90), to: isoToday() }),
    fmpFetch(`/stable/technical-indicators/rsi`, key, { symbol: t, periodLength: 14, ...tf }),
    fmpFetch(`/stable/technical-indicators/sma`, key, { symbol: t, periodLength: 20, ...tf }),
    fmpFetch(`/stable/technical-indicators/sma`, key, { symbol: t, periodLength: 50, ...tf }),
    fmpFetch(`/stable/technical-indicators/adx`, key, { symbol: t, periodLength: 14, ...tf }),
  ]);
  return { ohlcv, rsi, sma20, sma50, adx };
}

// --- Indicateurs calculés localement depuis l'OHLCV ---
function extractCloses(ohlcvData: unknown): number[] {
  // Gère 2 shapes possibles FMP : array direct OU { historical: [...] }
  let arr: Array<{ date?: string; close?: number }> = [];
  if (Array.isArray(ohlcvData)) arr = ohlcvData as typeof arr;
  else if (ohlcvData && typeof ohlcvData === "object" && "historical" in ohlcvData) {
    arr = (ohlcvData as { historical: typeof arr }).historical ?? [];
  }
  // Tri chronologique ascendant (le plus ancien en premier)
  const sorted = arr
    .filter(d => typeof d.close === "number" && d.date)
    .sort((a, b) => (a.date! < b.date! ? -1 : 1));
  return sorted.map(d => d.close as number);
}

function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function computeMacd(closes: number[]) {
  if (closes.length < 35) return null;  // 26 (long EMA) + 9 (signal) - 1
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = ema(macdLine, 9);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  const i = closes.length - 1;
  return {
    macd: macdLine[i],
    signal: signalLine[i],
    histogram: histogram[i],
    bullish_cross_recent: macdLine[i] > signalLine[i] && macdLine[i - 1] <= signalLine[i - 1],
    bearish_cross_recent: macdLine[i] < signalLine[i] && macdLine[i - 1] >= signalLine[i - 1],
  };
}

function computeBollinger(closes: number[], period = 20, mult = 2) {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  const mean = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((acc, c) => acc + (c - mean) ** 2, 0) / period;
  const stddev = Math.sqrt(variance);
  const upper = mean + mult * stddev;
  const lower = mean - mult * stddev;
  const current = closes[closes.length - 1];
  return {
    middle: mean,
    upper,
    lower,
    width_pct: ((upper - lower) / mean) * 100,
    current_position: (current - lower) / (upper - lower),  // 0=on lower, 1=on upper
    is_compressed: ((upper - lower) / mean) < 0.10,  // proxy Strat-LLM S3 compression < 10%
  };
}

// === C6 — News (sentiment computed per-article downstream, cf. Anic P8) ===
async function fetchC6(t: string, key: string) {
  const [news, sec_8k] = await Promise.all([
    fmpFetch(`/stable/news/stock`, key, { symbols: t, from: isoDaysAgo(7), limit: 10 }),
    fmpFetch(`/stable/sec-filings-8k`, key, { symbol: t, from: isoDaysAgo(30), to: isoToday() }),
  ]);
  return { news, sec_8k };
}

// === C1 — Earnings (transcript skipped — Premium plan, DEVIATIONS.md D-001) ===
// On utilise /stable/earnings qui inclut past + upcoming avec epsActual/epsEstimated
// (les "surprises" se calculent ensuite côté scoring).
async function fetchC1(t: string, key: string) {
  const [earnings_history, calendar_future, price_target] = await Promise.all([
    fmpFetch(`/stable/earnings`, key, { symbol: t, limit: 8 }),
    fmpFetch(`/stable/earnings-calendar`, key, { symbol: t, from: isoToday(), to: isoDaysAgo(-60) }),
    fmpFetch(`/stable/price-target-summary`, key, { symbol: t }),
  ]);
  return {
    earnings_history,
    calendar_future,
    price_target,
    transcript: { ok: false, endpoint: "/stable/earning-call-transcript", error: "ULTIMATE_PLAN_REQUIRED_see_DEVIATIONS.md_D-001" },
  };
}

// === C3 — Smart Money (13F skipped — Premium plan) ===
async function fetchC3(t: string, key: string) {
  const [insider_stats, insider_search, senate, house] = await Promise.all([
    fmpFetch(`/stable/insider-trading/statistics`, key, { symbol: t }),
    fmpFetch(`/stable/insider-trading/search`, key, { symbol: t, limit: 50 }),
    fmpFetch(`/stable/senate-latest`, key, { symbol: t }),
    fmpFetch(`/stable/house-latest`, key, { symbol: t }),
  ]);
  return {
    insider_stats,
    insider_search,
    senate,
    house,
    institutional_13f: { ok: false, endpoint: "/stable/institutional-ownership", error: "ULTIMATE_PLAN_REQUIRED_see_DEVIATIONS.md_D-001" },
  };
}

// === C4 — Quality ===
async function fetchC4(t: string, key: string) {
  const [scores, cash_flow, balance_sheet, income] = await Promise.all([
    fmpFetch(`/stable/financial-scores`, key, { symbol: t }),
    fmpFetch(`/stable/cash-flow-statement`, key, { symbol: t, limit: 5 }),
    fmpFetch(`/stable/balance-sheet-statement`, key, { symbol: t, limit: 5 }),
    fmpFetch(`/stable/income-statement`, key, { symbol: t, limit: 5 }),
  ]);
  return { scores, cash_flow, balance_sheet, income };
}

// === C5 — Valuation ===
async function fetchC5(t: string, key: string, sector?: string) {
  const calls: Promise<FmpResult>[] = [
    fmpFetch(`/stable/discounted-cash-flow`, key, { symbol: t }),
    fmpFetch(`/stable/key-metrics-ttm`, key, { symbol: t }),
    fmpFetch(`/stable/ratios-ttm`, key, { symbol: t }),
  ];
  if (sector) {
    calls.push(fmpFetch(`/stable/sector-pe-snapshot`, key, { sector, date: isoToday() }));
  }
  const [dcf, key_metrics, ratios, sector_pe] = await Promise.all(calls);
  return { dcf, key_metrics, ratios, sector_pe: sector_pe ?? null };
}

// ---------- Main orchestrator ----------------------------------------------

function buildCompleteness(allClusters: Record<string, Record<string, FmpResult>>) {
  // Pour chaque cluster, % d'endpoints qui ont répondu OK
  const summary: Record<string, { ok_count: number; total: number; missing: string[] }> = {};
  for (const [cluster, endpoints] of Object.entries(allClusters)) {
    const total = Object.keys(endpoints).length;
    const missing: string[] = [];
    let ok_count = 0;
    for (const [name, result] of Object.entries(endpoints)) {
      if (result.ok) ok_count++;
      else missing.push(name);
    }
    summary[cluster] = { ok_count, total, missing };
  }
  return summary;
}

function collectErrors(allClusters: Record<string, Record<string, FmpResult>>) {
  const errors: Array<{ cluster: string; field: string; endpoint: string; status?: number; error: string }> = [];
  for (const [cluster, endpoints] of Object.entries(allClusters)) {
    for (const [field, result] of Object.entries(endpoints)) {
      if (!result.ok) {
        errors.push({
          cluster,
          field,
          endpoint: result.endpoint,
          status: result.status,
          error: result.error ?? "unknown_error",
        });
      }
    }
  }
  return errors;
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const url = new URL(req.url);
  const ticker = url.searchParams.get("ticker")?.toUpperCase();

  if (!ticker || !/^[A-Z.-]{1,10}$/.test(ticker)) {
    return new Response(
      JSON.stringify({ ok: false, error: "invalid_ticker_param", hint: "?ticker=INCY" }, null, 2),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const fmpKey = Deno.env.get("FMP_API_KEY");
  if (!fmpKey) {
    return new Response(
      JSON.stringify({ ok: false, error: "missing_fmp_api_key" }, null, 2),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // === Pass 1 : profile + quote (séquentiel pour récupérer sector pour C5) ===
  const profile = await fetchProfile(ticker, fmpKey);
  const profileData = profile.ok && Array.isArray(profile.data) ? profile.data[0] as { sector?: string } : null;
  const sector = profileData?.sector;

  // === Pass 2 : tous les clusters en parallèle ===
  const [quote, c1, c2, c3, c4, c5] = await Promise.all([
    fetchQuote(ticker, fmpKey),
    fetchC1(ticker, fmpKey),
    fetchC2(ticker, fmpKey),
    fetchC3(ticker, fmpKey),
    fetchC4(ticker, fmpKey),
    fetchC5(ticker, fmpKey, sector),
  ]);
  const c6 = await fetchC6(ticker, fmpKey);

  const allClusters = {
    meta: { profile, quote },
    C1_earnings: c1,
    C2_technicals: c2,
    C3_smart_money: c3,
    C4_quality: c4,
    C5_valuation: c5,
    C6_news: c6,
  };

  const data_completeness = buildCompleteness(allClusters as never);
  const fetch_errors = collectErrors(allClusters as never);

  // Présentation finale : on garde uniquement les .data des fetches OK,
  // pour ne pas alourdir le JSON avec les wrappers FmpResult.
  function unwrap(cluster: Record<string, FmpResult>) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cluster)) {
      out[k] = v.ok ? v.data : null;
    }
    return out;
  }

  // Compute MACD + Bollinger localement depuis l'OHLCV de C2
  const c2Unwrapped = unwrap(allClusters.C2_technicals);
  const closes = extractCloses(c2Unwrapped.ohlcv);
  const computed = {
    n_closes: closes.length,
    macd: computeMacd(closes),
    bollinger: computeBollinger(closes),
  };

  return new Response(
    JSON.stringify(
      {
        ok: fetch_errors.length === 0,
        ticker,
        fetched_at: new Date().toISOString(),
        duration_ms: Date.now() - t0,
        sector_detected: sector ?? null,
        data_completeness,
        fetch_errors,
        data: {
          meta: unwrap(allClusters.meta),
          C1_earnings: unwrap(allClusters.C1_earnings),
          C2_technicals: { ...c2Unwrapped, computed },
          C3_smart_money: unwrap(allClusters.C3_smart_money),
          C4_quality: unwrap(allClusters.C4_quality),
          C5_valuation: unwrap(allClusters.C5_valuation),
          C6_news: unwrap(allClusters.C6_news),
        },
      },
      null,
      2,
    ),
    {
      status: fetch_errors.length === 0 ? 200 : 207, // 207 = multi-status (partial)
      headers: { "Content-Type": "application/json" },
    },
  );
});
