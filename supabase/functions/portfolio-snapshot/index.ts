// ============================================================================
// Aether — portfolio-snapshot Edge Function
// ============================================================================
// Rôle : agréger en un seul appel toute la PERFORMANCE pour le dashboard.
//   1. Alpaca /v2/account            → equity, cash, P&L total vs baseline
//   2. Alpaca /v2/positions          → positions ouvertes + unrealized P&L (live)
//   3. Alpaca portfolio/history      → courbe d'équité (timeseries)
//   4. positions (CLOSED)            → métriques réalisées (win rate, profit factor)
//   5. shadow_positions              → valeur empirique du Reviewer (approved vs rejected)
//
// Lecture seule. Aucun secret renvoyé. verify_jwt=false (dashboard server-side).
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const BASELINE = 100000; // capital initial Alpaca paper

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function alpaca<T>(path: string): Promise<T | null> {
  const base = Deno.env.get("ALPACA_API_BASE_URL");
  const keyId = Deno.env.get("ALPACA_API_KEY_ID");
  const secret = Deno.env.get("ALPACA_API_SECRET_KEY");
  if (!base || !keyId || !secret) return null;
  try {
    const r = await fetch(`${base}${path}`, {
      headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret },
    });
    if (!r.ok) return null;
    return await r.json() as T;
  } catch {
    return null;
  }
}

interface AlpacaAccount { equity: string; last_equity: string; cash: string; buying_power: string; }
interface AlpacaPosition {
  symbol: string; qty: string; avg_entry_price: string; current_price: string;
  market_value: string; unrealized_pl: string; unrealized_plpc: string; cost_basis: string;
}
interface AlpacaHistory { timestamp: number[]; equity: number[]; base_value: number; }

Deno.serve(async () => {
  const t0 = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  // --- 1+2+3 : Alpaca en parallèle ---
  const [acct, positions, history] = await Promise.all([
    alpaca<AlpacaAccount>("/v2/account"),
    alpaca<AlpacaPosition[]>("/v2/positions"),
    alpaca<AlpacaHistory>("/v2/account/portfolio/history?period=1M&timeframe=1D&extended_hours=true"),
  ]);

  const equity = acct ? parseFloat(acct.equity) : null;
  const lastEquity = acct ? parseFloat(acct.last_equity) : null;
  const cash = acct ? parseFloat(acct.cash) : null;
  const buyingPower = acct ? parseFloat(acct.buying_power) : null;

  const account = {
    alpaca_ok: !!acct,
    equity,
    cash,
    buying_power: buyingPower,
    baseline: BASELINE,
    total_pnl_usd: equity !== null ? equity - BASELINE : null,
    total_pnl_pct: equity !== null ? ((equity - BASELINE) / BASELINE) * 100 : null,
    today_pnl_usd: equity !== null && lastEquity !== null ? equity - lastEquity : null,
    today_pnl_pct: equity !== null && lastEquity ? ((equity - lastEquity) / lastEquity) * 100 : null,
  };

  const openPositions = (positions ?? []).map(p => ({
    ticker: p.symbol,
    qty: parseFloat(p.qty),
    avg_entry: parseFloat(p.avg_entry_price),
    current_price: parseFloat(p.current_price),
    market_value: parseFloat(p.market_value),
    unrealized_pl: parseFloat(p.unrealized_pl),
    unrealized_plpc: parseFloat(p.unrealized_plpc) * 100,
  }));

  // Courbe d'équité — on ne garde que les points où le compte a une valeur
  const equityCurve = history && Array.isArray(history.timestamp)
    ? history.timestamp.map((ts, i) => ({
        date: new Date(ts * 1000).toISOString().slice(0, 10),
        equity: history.equity[i],
        pnl: history.equity[i] - BASELINE,
      })).filter(pt => pt.equity > 0)
    : [];

  // --- 4 : Métriques réalisées (positions CLOSED réelles) ---
  const { data: closed } = await supabase
    .from("positions")
    .select("pnl_usd, pnl_pct, hold_days")
    .eq("status", "CLOSED");
  const closedRows = (closed ?? []).filter(r => r.pnl_usd !== null);
  const wins = closedRows.filter(r => Number(r.pnl_usd) > 0);
  const losses = closedRows.filter(r => Number(r.pnl_usd) <= 0);
  const sumWins = wins.reduce((s, r) => s + Number(r.pnl_usd), 0);
  const sumLosses = Math.abs(losses.reduce((s, r) => s + Number(r.pnl_usd), 0));
  const realized = {
    closed_count: closedRows.length,
    realized_pnl_usd: closedRows.reduce((s, r) => s + Number(r.pnl_usd), 0),
    wins: wins.length,
    losses: losses.length,
    win_rate: closedRows.length ? (wins.length / closedRows.length) * 100 : null,
    avg_win: wins.length ? sumWins / wins.length : null,
    avg_loss: losses.length ? -sumLosses / losses.length : null,
    profit_factor: sumLosses > 0 ? sumWins / sumLosses : null,
  };

  // --- 5 : Valeur empirique du Reviewer (shadow_positions) ---
  const { data: shadow } = await supabase
    .from("shadow_positions")
    .select("status, was_reviewer_approved, reviewer_verdict, pnl_usd");
  const sh = shadow ?? [];
  const closedShadow = sh.filter(s => s.status === "CLOSED" && s.pnl_usd !== null);
  const approvedClosed = closedShadow.filter(s => s.was_reviewer_approved);
  const rejectedClosed = closedShadow.filter(s => s.reviewer_verdict === "REJECT");
  const pendingClosed = closedShadow.filter(s => !s.was_reviewer_approved && s.reviewer_verdict !== "REJECT");
  const sumPnl = (arr: typeof closedShadow) => arr.reduce((s, r) => s + Number(r.pnl_usd), 0);
  const reviewerValue = {
    approved_closed_count: approvedClosed.length,
    approved_closed_pnl: sumPnl(approvedClosed),
    rejected_closed_count: rejectedClosed.length,
    rejected_closed_pnl: sumPnl(rejectedClosed),   // négatif = le Reviewer a évité des pertes
    pending_orphan_count: pendingClosed.length,
    pending_orphan_pnl: sumPnl(pendingClosed),
  };

  return jsonResponse({
    ok: true,
    account,
    open_positions: openPositions,
    open_count: openPositions.length,
    equity_curve: equityCurve,
    realized,
    reviewer_value: reviewerValue,
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - t0,
  }, 200);
});
