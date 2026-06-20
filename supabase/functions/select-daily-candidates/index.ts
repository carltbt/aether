// ============================================================================
// Aether — select-daily-candidates v2 (smart rotation)
// ============================================================================
// Source : POLISH P-019 + observation 28 mai (mêmes tickers analysés chaque jour)
//
// Rôle : pré-filtre la watchlist par fenêtre catalyseur earnings ET applique
// une rotation intelligente :
//   - PROMOTE : BUY candidates de la veille (conv ≥ 60) → re-analysés pour suivre l'évolution
//   - COOLDOWN : ticker conv < 40 récemment → skip 7 jours (chances faibles d'amélioration rapide)
//   - DEMOTE : ticker conv 40-59 récemment → priorité réduite (recheck dans 3-4 jours)
//   - FRESH : tickers jamais analysés dans la fenêtre → priorité standard
//
// Result : la liste change chaque jour naturellement + intelligemment.
//
// Output : 15 candidats (sweet spot avec batching run-daily-analysis v3).
// Usage : GET /functions/v1/select-daily-candidates
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FMP_BASE = "https://financialmodelingprep.com";

const LOOKBACK_DAYS = 10;     // PEAD window past
const LOOKAHEAD_DAYS = 5;     // risk window future
const MAX_CANDIDATES = 15;    // matched to run-daily-analysis batching (3 batches × 5)
const HISTORY_DAYS = 14;      // signals lookback for rotation logic

// Cooldown rules
const COOLDOWN_DAYS_POOR = 7;       // conv < 40 → skip 7d
const DEMOTE_DAYS_MEDIOCRE = 3;     // conv 40-59 → demote priority for 3d
const REANALYZE_DAILY_BUYS = true;  // conv ≥ 60 → always re-analyze (track winners/value traps)

interface EarningsEntry {
  symbol?: string;
  date?: string;
  epsActual?: number | null;
  epsEstimated?: number | null;
}

interface WatchlistEntry {
  symbol: string;
  sector: string | null;
  market_cap: number | null;
}

interface LastAnalysis {
  ticker: string;
  best_conviction: number;
  last_analyzed_at: string;  // ISO
  days_since_analyzed: number;
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
  eps_surprise_pct: number | null;
  // Rotation metadata
  last_conviction: number | null;
  days_since_analyzed: number | null;
  rotation_tier: "winner" | "fresh" | "promising" | "demoted" | "cooldown";
  priority_score: number;  // higher = analyzed first
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86400 * 1000).toISOString().slice(0, 10);
}

function freshnessMultiplier(daysSinceEarnings: number): number {
  if (daysSinceEarnings < 0) return 0;
  if (daysSinceEarnings <= 3) return 1.00;
  if (daysSinceEarnings <= 7) return 0.83;
  if (daysSinceEarnings <= 12) return 0.55;
  if (daysSinceEarnings <= 21) return 0.27;
  return 0.10;
}

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async () => {
  const t0 = Date.now();
  const fmpKey = Deno.env.get("FMP_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!fmpKey || !supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  // === 1. Active watchlist ===
  const { data: wlRows, error: wlErr } = await supabase
    .from("watchlist")
    .select("symbol, sector, market_cap")
    .eq("is_active", true);
  if (wlErr) return jsonResponse({ ok: false, error: "watchlist_query_failed", detail: wlErr.message }, 500);
  if (!wlRows || wlRows.length === 0) return jsonResponse({ ok: false, error: "empty_watchlist" }, 404);
  const watchlistMap = new Map<string, WatchlistEntry>(
    wlRows.map((r) => [r.symbol, { symbol: r.symbol, sector: r.sector, market_cap: r.market_cap }]),
  );

  // P3 — exclure les tickers déjà détenus : le pipeline BUY ne peut pas les
  // racheter (dedup) et ils sont gérés par review-positions (sortie LLM) +
  // update-positions (prix). Économise ~7 appels Claude/jour/ticker détenu.
  const { data: openPosRows } = await supabase.from("positions").select("ticker").eq("status", "OPEN");
  const heldTickers = new Set((openPosRows ?? []).map((p) => p.ticker));

  // === 2. Past analyses (last 14d) for rotation logic ===
  const historyCutoff = new Date(Date.now() - HISTORY_DAYS * 86400 * 1000).toISOString();
  const { data: pastSignals } = await supabase
    .from("signals")
    .select("ticker, conviction, created_at")
    .gte("created_at", historyCutoff);
  // Build per-ticker map: best conviction + most recent timestamp
  const analysisMap = new Map<string, LastAnalysis>();
  const now = Date.now();
  for (const s of pastSignals ?? []) {
    const existing = analysisMap.get(s.ticker);
    const sigMs = Date.parse(s.created_at);
    const daysAgo = Math.round((now - sigMs) / (86400 * 1000));
    if (!existing) {
      analysisMap.set(s.ticker, {
        ticker: s.ticker,
        best_conviction: s.conviction,
        last_analyzed_at: s.created_at,
        days_since_analyzed: daysAgo,
      });
    } else {
      // Keep latest timestamp AND highest conviction (could be from different rows)
      if (sigMs > Date.parse(existing.last_analyzed_at)) {
        existing.last_analyzed_at = s.created_at;
        existing.days_since_analyzed = daysAgo;
      }
      if (s.conviction > existing.best_conviction) {
        existing.best_conviction = s.conviction;
      }
    }
  }

  // === 3. Earnings calendar fetch ===
  const from = isoDaysFromNow(-LOOKBACK_DAYS);
  const to = isoDaysFromNow(LOOKAHEAD_DAYS);
  const calUrl = `${FMP_BASE}/stable/earnings-calendar?from=${from}&to=${to}&apikey=${fmpKey}`;
  const calResp = await fetch(calUrl);
  if (!calResp.ok) {
    return jsonResponse({ ok: false, error: `fmp_calendar_http_${calResp.status}`, body: (await calResp.text()).slice(0, 300) }, 502);
  }
  const calData = await calResp.json();
  if (!Array.isArray(calData)) {
    return jsonResponse({ ok: false, error: "fmp_calendar_not_array" }, 502);
  }

  // === 4. Build candidates + apply rotation logic ===
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

    // Rotation tier determination
    const lastA = analysisMap.get(e.symbol);
    let tier: Candidate["rotation_tier"];
    let priority_score: number;

    const baseScore = freshness * 100 + Math.min(Math.abs(surprisePct ?? 0), 100);

    if (!lastA) {
      // Never analyzed in window → FRESH, standard priority
      tier = "fresh";
      priority_score = baseScore + 50;  // small boost for novelty
    } else if (lastA.best_conviction >= 60 && REANALYZE_DAILY_BUYS) {
      // BUY candidate → re-analyze daily to track evolution (winner or value trap?)
      tier = "winner";
      priority_score = baseScore + 200;  // strong boost — these are actionable
    } else if (lastA.best_conviction < 40 && lastA.days_since_analyzed < COOLDOWN_DAYS_POOR) {
      // Poor performer, still in cooldown → SKIP
      tier = "cooldown";
      priority_score = -1;  // marker for skip
    } else if (lastA.best_conviction >= 40 && lastA.best_conviction < 60 && lastA.days_since_analyzed < DEMOTE_DAYS_MEDIOCRE) {
      // Mediocre recent score → demote priority (recheck in 3-4d)
      tier = "demoted";
      priority_score = baseScore - 100;  // strong demotion
    } else {
      // Out of cooldown / demote window → FRESH-like
      tier = "promising";
      priority_score = baseScore;
    }

    candidates.push({
      ticker: e.symbol,
      sector: wl.sector,
      market_cap: wl.market_cap,
      earnings_date: e.date,
      days_relative: days,
      is_past: isPast,
      is_imminent: !isPast && days <= 5,
      freshness_mult: freshness,
      eps_surprise_pct: surprisePct,
      last_conviction: lastA?.best_conviction ?? null,
      days_since_analyzed: lastA?.days_since_analyzed ?? null,
      rotation_tier: tier,
      priority_score,
    });
  }

  // === 5. Filter cooldown out + sort by priority_score desc ===
  const eligible = candidates.filter(c => c.rotation_tier !== "cooldown");
  eligible.sort((a, b) => b.priority_score - a.priority_score);

  // === 5bis. δ — MOMENTUM COMPLEMENT (POLISH P-019 part 2) ===
  // Si la fenêtre catalyseur ne remplit pas le cap, compléter avec des tickers
  // qui ont eu un C2 ≥ 7 historique (momentum/breakout setups Strat-LLM S2/S3),
  // mais qui ne sont PAS déjà dans eligible et pas en cooldown.
  let momentumComplement: Candidate[] = [];
  if (eligible.length < MAX_CANDIDATES) {
    const slotsLeft = MAX_CANDIDATES - eligible.length;
    const eligibleTickers = new Set(eligible.map(e => e.ticker));

    // Find tickers with C2 ≥ 7 in past 14 days, not already in eligible
    const { data: momentumSignals } = await supabase
      .from("signals")
      .select("ticker, score_c2_momentum, created_at")
      .gte("created_at", historyCutoff)
      .gte("score_c2_momentum", 7)
      .order("created_at", { ascending: false });

    if (momentumSignals && momentumSignals.length > 0) {
      // Dédupliquer par ticker, garder la plus récente
      const seen = new Set<string>();
      for (const s of momentumSignals) {
        if (seen.has(s.ticker) || eligibleTickers.has(s.ticker)) continue;
        const wl = watchlistMap.get(s.ticker);
        if (!wl) continue;  // doit être dans la watchlist active
        const lastA = analysisMap.get(s.ticker);
        // Skip si récemment analysé avec score faible (cooldown logique inverse)
        if (lastA && lastA.best_conviction < 40 && lastA.days_since_analyzed < COOLDOWN_DAYS_POOR) continue;
        seen.add(s.ticker);

        momentumComplement.push({
          ticker: s.ticker,
          sector: wl.sector,
          market_cap: wl.market_cap,
          earnings_date: "N/A (momentum candidate)",
          days_relative: 999,  // marqueur pour "hors fenêtre earnings"
          is_past: false,
          is_imminent: false,
          freshness_mult: 0,  // pas de PEAD signal
          eps_surprise_pct: null,
          last_conviction: s.score_c2_momentum,  // C2 historique comme proxy
          days_since_analyzed: Math.round((now - Date.parse(s.created_at)) / (86400 * 1000)),
          rotation_tier: "fresh",  // tagué "momentum" via earnings_date "N/A"
          priority_score: 80 + (s.score_c2_momentum * 5),  // 80-130 range (compete avec catalyst window low-tier)
        });
        if (momentumComplement.length >= slotsLeft) break;
      }
    }
    momentumComplement.sort((a, b) => b.priority_score - a.priority_score);
  }

  // Combine eligible (catalyst) + momentum complement, MINUS les tickers détenus (P3)
  const combined = [...eligible, ...momentumComplement].filter(c => !heldTickers.has(c.ticker));
  const top = combined.slice(0, MAX_CANDIDATES);

  // Counts for observability
  const counts = {
    total_in_catalyst_window: candidates.length,
    held_excluded: [...eligible, ...momentumComplement].filter(c => heldTickers.has(c.ticker)).length,
    cooldown_skipped: candidates.filter(c => c.rotation_tier === "cooldown").length,
    winners_promoted: top.filter(c => c.rotation_tier === "winner").length,
    fresh_catalyst: top.filter(c => c.rotation_tier === "fresh" && c.earnings_date !== "N/A (momentum candidate)").length,
    promising: top.filter(c => c.rotation_tier === "promising").length,
    demoted: top.filter(c => c.rotation_tier === "demoted").length,
    momentum_complement: top.filter(c => c.earnings_date === "N/A (momentum candidate)").length,
    with_eps_surprise: top.filter(c => c.eps_surprise_pct !== null).length,
  };

  return jsonResponse({
    ok: true,
    duration_ms: Date.now() - t0,
    window: { from, to, lookback_days: LOOKBACK_DAYS, lookahead_days: LOOKAHEAD_DAYS },
    watchlist_active_size: wlRows.length,
    fmp_calendar_entries: calData.length,
    earnings_in_window_for_our_watchlist: candidates.length,
    returned: top.length,
    cap: MAX_CANDIDATES,
    rotation_rules: {
      reanalyze_buys_daily: REANALYZE_DAILY_BUYS,
      cooldown_days_poor_conv: COOLDOWN_DAYS_POOR,
      demote_days_mediocre_conv: DEMOTE_DAYS_MEDIOCRE,
    },
    counts,
    by_sector: top.reduce((acc, c) => {
      const s = c.sector ?? "Unknown";
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    candidates: top,
  }, 200);
});
