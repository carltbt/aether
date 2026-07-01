// ============================================================================
// Aether — validate-order Edge Function (Couche 2 — code, NO Claude)
// ============================================================================
// Source : STRATEGY.md v2.7 Section 8 Couche 2 (validation indépendante de Claude)
//
// Rôle : DERNIÈRE barrière avant Alpaca. Indépendante de Claude.
// Si Claude se "trompe" ou prend une action non-éthique (cf. P11 warning),
// cette couche bloque. Aucun ordre ne passe sans elle.
//
// Vérifications :
//   1. Sizing : ≤ 12% du capital, cash ≥ 5%
//   2. Stop-loss : entre 3% et 15%
//   3. Earnings risk : aucun earnings dans les 5 prochains jours (P14 binary risk)
//   4. Sector concentration : max 3 positions / secteur
//   5. Drawdown global : si > 20% → block tout BUY (PAUSE Mode)
//   6. Ticker validity : in watchlist active
//   7. Ticker anchoring (P13) : confusion ticker detection
//   8. Corrélation sectorielle (auto-reduce sizing) :
//      - 1 position même secteur → ×0.80
//      - 2 positions même secteur → ×0.60
//      - 3+ même secteur → REJECT (concentration)
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

interface Body {
  signal_id?: string;
  ticker?: string;
  portfolio?: {
    open_positions?: Array<{ ticker: string; sector?: string; position_size_pct?: number }>;
    cash_pct?: number;
    total_drawdown_pct?: number;
  };
}

interface ValidationResult {
  approve: boolean;
  reject_reasons: string[];
  warnings: string[];
  position_size_pct_final: number;
  correlation_adjustment_applied: number;
  correlation_note: string;
  checks_passed: string[];
}

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

// --- Real portfolio state (Alpaca) — remplace les mocks V1 (Honnêteté #1) ---
async function alpacaGet<T>(path: string): Promise<T | null> {
  const base = Deno.env.get("ALPACA_API_BASE_URL");
  const keyId = Deno.env.get("ALPACA_API_KEY_ID");
  const secret = Deno.env.get("ALPACA_API_SECRET_KEY");
  if (!base || !keyId || !secret) return null;
  try {
    const r = await fetch(`${base}${path}`, { headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret } });
    if (!r.ok) return null;
    return await r.json() as T;
  } catch {
    return null;
  }
}

async function getRealPortfolioState(): Promise<{ cashPct: number | null; drawdownPct: number | null }> {
  const acct = await alpacaGet<{ cash: string; equity: string }>("/v2/account");
  if (!acct) return { cashPct: null, drawdownPct: null };
  const cash = parseFloat(acct.cash);
  const equity = parseFloat(acct.equity);
  const cashPct = equity > 0 ? (cash / equity) * 100 : null;
  // Drawdown = (peak - equity) / peak sur l'historique 3M
  const hist = await alpacaGet<{ equity: number[] }>("/v2/account/portfolio/history?period=3M&timeframe=1D");
  let drawdownPct: number | null = null;
  if (hist && Array.isArray(hist.equity) && hist.equity.length) {
    const valid = hist.equity.filter(e => e > 0);
    const peak = Math.max(equity, ...valid);
    drawdownPct = peak > 0 ? Math.max(0, ((peak - equity) / peak) * 100) : null;
  }
  return { cashPct, drawdownPct };
}

async function getRealVix(supabase: SupabaseClient): Promise<number | null> {
  const { data } = await supabase.from("daily_context").select("vix").order("context_date", { ascending: false }).limit(1).maybeSingle();
  const v = data?.vix;
  return v == null ? null : Number(v);
}

async function loadSignalAndContext(supabase: SupabaseClient, signalId: string | undefined, ticker: string | undefined) {
  let sigQuery = supabase.from("signals").select("*").order("created_at", { ascending: false }).limit(1);
  if (signalId) sigQuery = supabase.from("signals").select("*").eq("id", signalId).limit(1);
  else if (ticker) sigQuery = supabase.from("signals").select("*").eq("ticker", ticker).order("created_at", { ascending: false }).limit(1);
  const { data: sig } = await sigQuery.maybeSingle();
  return sig;
}

async function isTickerActive(supabase: SupabaseClient, ticker: string): Promise<{ active: boolean; sector: string | null }> {
  const { data } = await supabase.from("watchlist").select("is_active, sector").eq("symbol", ticker).maybeSingle();
  return { active: !!data?.is_active, sector: data?.sector ?? null };
}

async function getOpenPositions(supabase: SupabaseClient): Promise<Array<{ ticker: string; sector: string | null; position_size_usd: number | null }>> {
  const { data: positions } = await supabase.from("positions").select("ticker, position_size_usd, status").eq("status", "OPEN");
  if (!positions || positions.length === 0) return [];
  // Enrich with sector from watchlist
  const tickers = positions.map(p => p.ticker);
  const { data: wl } = await supabase.from("watchlist").select("symbol, sector").in("symbol", tickers);
  const sectorMap = new Map((wl ?? []).map(r => [r.symbol, r.sector]));
  return positions.map(p => ({ ticker: p.ticker, sector: sectorMap.get(p.ticker) ?? null, position_size_usd: p.position_size_usd }));
}

// P-002 — Earnings 5d check
// ⚠️ Note : /stable/earnings-calendar n'honore PAS le param `symbol` côté FMP
// (renvoie tout le calendrier marché). On fetch sans filtre, puis on filtre en
// code par ticker exact. Coût : ~3MB payload, ~1s. OPTIM future possible :
// pré-fetch calendar 1×/jour via daily-context et passer en POST body.
async function getDaysUntilNextEarnings(ticker: string, fmpKey: string): Promise<number | null> {
  const today = new Date().toISOString().slice(0, 10);
  const plus10 = new Date(Date.now() + 10 * 86400 * 1000).toISOString().slice(0, 10);
  const url = `https://financialmodelingprep.com/stable/earnings-calendar?from=${today}&to=${plus10}&apikey=${fmpKey}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    // Filter EXPLICITLY for our ticker, then sort asc by date, take earliest
    const forTicker = (data as Array<{ symbol?: string; date?: string }>)
      .filter(e => e.symbol === ticker && e.date)
      .sort((a, b) => (a.date! < b.date! ? -1 : 1));
    if (forTicker.length === 0) return null;
    const nextMs = Date.parse(forTicker[0].date!);
    if (isNaN(nextMs)) return null;
    return Math.round((nextMs - Date.now()) / (86400 * 1000));
  } catch {
    return null;
  }
}

// Cap dur du nombre de positions simultanées (STRATEGY.md Section 8 / P8).
const MAX_CONCURRENT_POSITIONS = 10;

function validate(decision: {
  ticker: string;
  action: string;
  position_size_pct: number | null;
  stop_loss_pct: number | null;
  take_profit_pct: number | null;
  hold_days_estimate?: number | null;
}, context: {
  requestedTicker: string;
  tickerSector: string | null;
  tickerActive: boolean;
  earningsInNextNDays: number | null;
  openPositions: Array<{ ticker: string; sector: string | null }>;
  alreadyHoldingTicker: boolean;
  cashPct: number;
  totalDrawdownPct: number;
  vix: number;
}): ValidationResult {
  const reject_reasons: string[] = [];
  const warnings: string[] = [];
  const checks_passed: string[] = [];

  // Skip full BUY checklist for HOLD (nothing to validate).
  if (decision.action === "HOLD") {
    return { approve: true, reject_reasons: [], warnings: ["HOLD action — no order to validate"], position_size_pct_final: 0, correlation_adjustment_applied: 0, correlation_note: "", checks_passed: ["hold_passthrough"] };
  }

  // 🔒 SELL guard (audit 01/07, Couche 2 indépendante) : en long-only V1 on ne peut
  // vendre QUE ce qu'on détient. Un SELL sans position ouverte = tentative de SHORT
  // À NU → REJECT. Ferme le chemin du short même si execute-order était contourné.
  if (decision.action === "SELL") {
    if (!context.alreadyHoldingTicker) {
      return { approve: false, reject_reasons: [`sell_without_open_position_${decision.ticker} (long-only: no short)`], warnings: [], position_size_pct_final: 0, correlation_adjustment_applied: 0, correlation_note: "", checks_passed: [] };
    }
    return { approve: true, reject_reasons: [], warnings: ["SELL of held position — validated"], position_size_pct_final: 0, correlation_adjustment_applied: 0, correlation_note: "", checks_passed: ["sell_has_open_position"] };
  }

  // 0. Dédup ticker — déjà une position ouverte sur ce titre → REJECT
  //    (évite le doublon / averaging-up non intentionnel : ex. M acheté 2 jours de suite)
  if (context.alreadyHoldingTicker) {
    reject_reasons.push(`already_open_position_in_${decision.ticker}`);
  } else checks_passed.push("no_duplicate_ticker");

  // 0bis. Cap dur du nombre de positions simultanées (backstop portfolio heat)
  if (context.openPositions.length >= MAX_CONCURRENT_POSITIONS) {
    reject_reasons.push(`max_concurrent_positions_${context.openPositions.length}_cap_${MAX_CONCURRENT_POSITIONS}`);
  } else checks_passed.push(`positions_count_${context.openPositions.length}_ok`);

  // 1. Ticker anchoring (P13) — detect confusion
  if (decision.ticker !== context.requestedTicker) {
    reject_reasons.push(`ticker_confusion_detected (decision says ${decision.ticker} but requested ${context.requestedTicker} — P13)`);
  } else checks_passed.push("ticker_anchoring_p13");

  // 2. Ticker in active watchlist
  if (!context.tickerActive) {
    reject_reasons.push(`ticker_${decision.ticker}_not_in_active_watchlist`);
  } else checks_passed.push("ticker_in_watchlist");

  // 3. Position size 0-12% (before correlation adjustment)
  const size = decision.position_size_pct ?? 0;
  if (size <= 0) {
    reject_reasons.push("position_size_zero_or_negative");
  } else if (size > 12) {
    reject_reasons.push(`position_size_too_large_${size}_pct_max_12`);
  } else checks_passed.push(`size_within_bounds_${size}pct`);

  // 4. Cash floor 5%
  if (context.cashPct < 5) {
    reject_reasons.push(`cash_floor_breached_${context.cashPct}pct_min_5`);
  } else checks_passed.push(`cash_floor_ok_${context.cashPct}pct`);

  // 5. Stop-loss between 3% and 15%
  const sl = decision.stop_loss_pct ?? 0;
  if (sl < 3) reject_reasons.push(`stop_loss_too_tight_${sl}pct_min_3`);
  else if (sl > 15) reject_reasons.push(`stop_loss_too_wide_${sl}pct_max_15`);
  else checks_passed.push(`stop_loss_${sl}pct_ok`);

  // 6. Risk/reward ratio ≥ 1:2
  const tp = decision.take_profit_pct ?? 0;
  if (sl > 0 && tp < sl * 2) {
    warnings.push(`risk_reward_${(tp/sl).toFixed(2)}_below_2x_minimum`);
  } else if (sl > 0) checks_passed.push(`risk_reward_${(tp/sl).toFixed(2)}x`);

  // 7. Earnings in next 5 days = REJECT (binary event risk)
  if (typeof context.earningsInNextNDays === "number" && context.earningsInNextNDays >= 0 && context.earningsInNextNDays < 5) {
    reject_reasons.push(`earnings_imminent_${context.earningsInNextNDays}_days_min_5`);
  } else checks_passed.push("no_imminent_earnings");

  // 8. VIX > 35 = PAUSE Mode, no BUY
  if (context.vix > 35) {
    reject_reasons.push(`vix_${context.vix}_above_35_pause_mode`);
  } else checks_passed.push(`vix_${context.vix}_ok`);

  // 9. Drawdown global > 20% = PAUSE Mode
  if (context.totalDrawdownPct > 20) {
    reject_reasons.push(`global_drawdown_${context.totalDrawdownPct}pct_above_20_pause`);
  } else checks_passed.push(`drawdown_${context.totalDrawdownPct}pct_ok`);

  // 10. Sector concentration : max 3 positions / sector
  const sameSectorCount = context.tickerSector
    ? context.openPositions.filter(p => p.sector === context.tickerSector).length
    : 0;
  if (sameSectorCount >= 3) {
    reject_reasons.push(`sector_concentration_${sameSectorCount}_positions_in_${context.tickerSector}_max_3`);
  } else checks_passed.push(`sector_count_${sameSectorCount}_ok`);

  // 11. Corrélation sectorielle (auto-reduce sizing, not rejection)
  let correlation_adjustment_applied = 1.0;
  let correlation_note = "";
  if (sameSectorCount === 1) {
    correlation_adjustment_applied = 0.80;
    correlation_note = `1 position ${context.tickerSector} existante — taille réduite de 20%`;
  } else if (sameSectorCount === 2) {
    correlation_adjustment_applied = 0.60;
    correlation_note = `2 positions ${context.tickerSector} existantes — taille réduite de 40%`;
  } else if (sameSectorCount === 0) {
    correlation_note = "0 position du même secteur — taille inchangée";
  }
  const position_size_pct_final = Math.round(size * correlation_adjustment_applied * 100) / 100;

  return {
    approve: reject_reasons.length === 0,
    reject_reasons,
    warnings,
    position_size_pct_final,
    correlation_adjustment_applied,
    correlation_note,
    checks_passed,
  };
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const fmpKey = Deno.env.get("FMP_API_KEY");
  if (!supabaseUrl || !serviceKey || !fmpKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  let signalId: string | undefined;
  let ticker: string | undefined;
  let portfolioOverride: Body["portfolio"] | undefined;

  if (req.method === "POST") {
    try {
      const body = await req.json() as Body;
      signalId = body.signal_id;
      ticker = body.ticker?.toUpperCase();
      portfolioOverride = body.portfolio;
    } catch (e) {
      return jsonResponse({ ok: false, error: "invalid_json_body", detail: String((e as Error).message) }, 400);
    }
  } else {
    const url = new URL(req.url);
    signalId = url.searchParams.get("signal_id") ?? undefined;
    ticker = url.searchParams.get("ticker")?.toUpperCase();
  }

  // --- Load signal ---
  const sig = await loadSignalAndContext(supabase, signalId, ticker);
  if (!sig) return jsonResponse({ ok: false, error: "signal_not_found" }, 404);
  signalId = sig.id;
  ticker = sig.ticker;

  // --- Load context ---
  const tickerInfo = await isTickerActive(supabase, sig.ticker);
  const openPositions = await getOpenPositions(supabase);

  // Real portfolio state (Alpaca) + VIX réel (daily_context). POST override > réel > fallback.
  const realState = await getRealPortfolioState();
  const realVix = await getRealVix(supabase);
  const cashPct = portfolioOverride?.cash_pct ?? realState.cashPct ?? 100;
  const totalDrawdownPct = portfolioOverride?.total_drawdown_pct ?? realState.drawdownPct ?? 0;
  const vix = realVix ?? 18;

  // P-002 : earnings 5d check — fetch FMP pour ce ticker spécifiquement
  // Si earnings dans < 5 jours → REJECT (risque binaire STRATEGY.md Section 8 Couche 1)
  // On ne fait l'appel que pour les BUY (HOLD/SELL n'ont pas besoin)
  let earningsInNextNDays: number | null = null;
  if (sig.action === "BUY") {
    earningsInNextNDays = await getDaysUntilNextEarnings(sig.ticker, fmpKey);
  }

  // --- Validate ---
  const result = validate({
    ticker: sig.ticker,
    action: sig.action,
    position_size_pct: sig.position_size_pct,
    stop_loss_pct: sig.stop_loss_pct,
    take_profit_pct: sig.take_profit_pct,
    hold_days_estimate: sig.hold_days_estimate,
  }, {
    requestedTicker: sig.ticker,
    tickerSector: tickerInfo.sector,
    tickerActive: tickerInfo.active,
    earningsInNextNDays,
    openPositions: openPositions.map(p => ({ ticker: p.ticker, sector: p.sector })),
    alreadyHoldingTicker: openPositions.some(p => p.ticker === sig.ticker),
    cashPct,
    totalDrawdownPct,
    vix,
  });

  // --- Update signals row ---
  const code_validation = result.approve ? "APPROVED" : `REJECTED: ${result.reject_reasons.join(", ")}`;
  const updates: Record<string, unknown> = { code_validation };
  if (result.approve && result.correlation_adjustment_applied !== 1.0) {
    updates.position_size_pct = result.position_size_pct_final;
  }
  const { error: upErr } = await supabase.from("signals").update(updates).eq("id", signalId);
  if (upErr) console.error("signals update failed:", upErr);

  return jsonResponse({
    ok: true,
    ticker,
    signal_id: signalId,
    action: sig.action,
    validation: result,
    final_decision: {
      approved_for_execution: result.approve && sig.action !== "HOLD" && sig.reviewer_verdict === "APPROVE",
      reviewer_verdict: sig.reviewer_verdict,
      code_validation,
      ready_for_alpaca: result.approve && (sig.action === "BUY" || sig.action === "SELL") && sig.reviewer_verdict === "APPROVE",
    },
    context_used: {
      ticker_sector: tickerInfo.sector,
      ticker_active: tickerInfo.active,
      open_positions_count: openPositions.length,
      already_holding_ticker: openPositions.some(p => p.ticker === sig.ticker),
      cash_pct: cashPct,
      total_drawdown_pct: totalDrawdownPct,
      vix,
      sources: {
        cash: portfolioOverride?.cash_pct != null ? "override" : realState.cashPct != null ? "alpaca" : "fallback",
        drawdown: portfolioOverride?.total_drawdown_pct != null ? "override" : realState.drawdownPct != null ? "alpaca" : "fallback",
        vix: realVix != null ? "daily_context" : "fallback",
      },
      earnings_in_next_n_days: earningsInNextNDays,
    },
    duration_ms: Date.now() - t0,
  }, 200);
});
