// ============================================================================
// Aether — select-daily-candidates Edge Function
// ============================================================================
// Source : POLISH.md P-019 + observation empirique 5 tickers tous HOLD
//
// Rôle : pre-filter la watchlist active par "fenêtre catalyseur" earnings.
// Ne renvoie que les tickers qui ont publié earnings dans les 10 derniers
// jours OU vont publier dans les 5 prochains jours. Trie pour prioriser
// les meilleurs candidats PEAD (post-earnings drift max signal).
//
// Sans ce filtre, daily-analysis analyserait 20-30 stocks random dont
// ~80% donneront HOLD au gate conviction (C1 plombé hors fenêtre).
//
// Output : liste cappée à 30 tickers, sortée par priorité d'analyse.
// Usage : GET /functions/v1/select-daily-candidates
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FMP_BASE = "https://financialmodelingprep.com";

// Fenêtre catalyseur : PEAD fort jusqu'à J+10 post-earnings (Sidhu et al. — half-life 6-7j),
// + filtre risque pour earnings imminents (les BUY < J+5 sont rejetés par validate-order P-002,
// mais on les analyse quand même pour préparer la décision SELL si position déjà ouverte)
const LOOKBACK_DAYS = 10;
const LOOKAHEAD_DAYS = 5;
const MAX_CANDIDATES = 30;

interface EarningsEntry {
  symbol?: string;
  date?: string;
  epsActual?: number | null;
  epsEstimated?: number | null;
  revenueActual?: number | null;
  revenueEstimated?: number | null;
}

interface WatchlistEntry {
  symbol: string;
  sector: string | null;
  market_cap: number | null;
}

interface Candidate {
  ticker: string;
  sector: string | null;
  market_cap: number | null;
  earnings_date: string;
  days_relative: number;
  is_past: boolean;
  is_imminent: boolean;
  freshness_mult: number;
  eps_actual: number | null;
  eps_estimated: number | null;
  eps_surprise_pct: number | null;
  priority_rank: number;
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86400 * 1000).toISOString().slice(0, 10);
}

// Reproduit la freshness curve Sidhu et al. utilisée dans run-analysis-passes Pass 3
function freshnessMultiplier(daysSinceEarnings: number): number {
  if (daysSinceEarnings < 0) return 0;  // Future earnings — no PEAD signal yet
  if (daysSinceEarnings <= 3) return 1.00;
  if (daysSinceEarnings <= 7) return 0.83;
  if (daysSinceEarnings <= 12) return 0.55;
  if (daysSinceEarnings <= 21) return 0.27;
  return 0.10;
}

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), {
    status: s,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async () => {
  const t0 = Date.now();
  const fmpKey = Deno.env.get("FMP_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!fmpKey || !supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  // 1. Active watchlist
  const { data: wlRows, error: wlErr } = await supabase
    .from("watchlist")
    .select("symbol, sector, market_cap")
    .eq("is_active", true);
  if (wlErr) return jsonResponse({ ok: false, error: "watchlist_query_failed", detail: wlErr.message }, 500);
  if (!wlRows || wlRows.length === 0) return jsonResponse({ ok: false, error: "empty_watchlist", hint: "Run run-screener first" }, 404);

  const watchlistMap = new Map<string, WatchlistEntry>(
    wlRows.map((r) => [r.symbol, { symbol: r.symbol, sector: r.sector, market_cap: r.market_cap }]),
  );

  // 2. Earnings calendar — fenêtre [today - LOOKBACK, today + LOOKAHEAD]
  const from = isoDaysFromNow(-LOOKBACK_DAYS);
  const to = isoDaysFromNow(LOOKAHEAD_DAYS);
  const calUrl = `${FMP_BASE}/stable/earnings-calendar?from=${from}&to=${to}&apikey=${fmpKey}`;
  const calResp = await fetch(calUrl);
  if (!calResp.ok) {
    return jsonResponse({ ok: false, error: `fmp_calendar_http_${calResp.status}`, body: (await calResp.text()).slice(0, 300) }, 502);
  }
  const calData = await calResp.json();
  if (!Array.isArray(calData)) {
    return jsonResponse({ ok: false, error: "fmp_calendar_not_array", sample: JSON.stringify(calData).slice(0, 200) }, 502);
  }

  // 3. Filter pour les tickers de notre watchlist active
  const now = Date.now();
  const candidates: Candidate[] = [];
  for (const e of calData as EarningsEntry[]) {
    if (!e.symbol || !e.date) continue;
    const wl = watchlistMap.get(e.symbol);
    if (!wl) continue;
    const earningsMs = Date.parse(e.date);
    if (isNaN(earningsMs)) continue;
    const days = Math.round((earningsMs - now) / (86400 * 1000));
    const isPast = days < 0;
    const daysSince = isPast ? Math.abs(days) : -1;
    const freshness = freshnessMultiplier(daysSince);

    const surprisePct = (typeof e.epsActual === "number" && typeof e.epsEstimated === "number" && e.epsEstimated !== 0)
      ? ((e.epsActual - e.epsEstimated) / Math.abs(e.epsEstimated)) * 100
      : null;

    candidates.push({
      ticker: e.symbol,
      sector: wl.sector,
      market_cap: wl.market_cap,
      earnings_date: e.date,
      days_relative: days,
      is_past: isPast,
      is_imminent: !isPast && days <= 5,
      freshness_mult: freshness,
      eps_actual: e.epsActual ?? null,
      eps_estimated: e.epsEstimated ?? null,
      eps_surprise_pct: surprisePct,
      priority_rank: 0,  // computed below
    });
  }

  // 4. Sort by priority :
  //    - Past earnings, freshness ×1.00 (J-0 to J-3) → top
  //    - Past earnings, freshness ×0.83 (J-4 to J-7) → next
  //    - Past earnings, freshness ×0.55 (J-8 to J-10) → next
  //    - Upcoming earnings (J+0 to J+5) → moins prioritaire (risque binaire, pas catalyseur)
  candidates.sort((a, b) => {
    // Past earnings always before upcoming
    if (a.is_past && !b.is_past) return -1;
    if (!a.is_past && b.is_past) return 1;
    if (a.is_past && b.is_past) {
      // Among past : highest freshness first
      if (a.freshness_mult !== b.freshness_mult) return b.freshness_mult - a.freshness_mult;
      // Tiebreak : largest EPS surprise first (most informative)
      const aSurp = Math.abs(a.eps_surprise_pct ?? 0);
      const bSurp = Math.abs(b.eps_surprise_pct ?? 0);
      return bSurp - aSurp;
    }
    // Among upcoming : soonest first (more urgent risk assessment)
    return a.days_relative - b.days_relative;
  });

  // Assign priority_rank (1-based)
  candidates.forEach((c, i) => { c.priority_rank = i + 1; });

  const top = candidates.slice(0, MAX_CANDIDATES);

  return jsonResponse({
    ok: true,
    duration_ms: Date.now() - t0,
    window: { from, to, lookback_days: LOOKBACK_DAYS, lookahead_days: LOOKAHEAD_DAYS },
    watchlist_active_size: wlRows.length,
    fmp_calendar_entries: calData.length,
    earnings_in_window_for_our_watchlist: candidates.length,
    returned: top.length,
    cap: MAX_CANDIDATES,
    counts: {
      past_J_minus_3_or_less: top.filter(c => c.is_past && c.freshness_mult === 1.0).length,
      past_J_minus_4_to_7: top.filter(c => c.is_past && c.freshness_mult === 0.83).length,
      past_J_minus_8_to_12: top.filter(c => c.is_past && c.freshness_mult === 0.55).length,
      past_J_minus_13_to_21: top.filter(c => c.is_past && c.freshness_mult === 0.27).length,
      upcoming_imminent_J_plus_0_to_5: top.filter(c => c.is_imminent).length,
      with_eps_surprise_data: top.filter(c => c.eps_surprise_pct !== null).length,
    },
    by_sector: top.reduce((acc, c) => {
      const s = c.sector ?? "Unknown";
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    candidates: top,
  }, 200);
});
