// ============================================================================
// Aether — backtest-exits Edge Function (backtest v1 — couche SORTIE)
// ============================================================================
// PRIORITÉ STRUCTURELLE (audit) : valider les paramètres de sortie sur historique
// plutôt qu'à l'aveugle. Ici on rejoue les RÈGLES DE SORTIE (stop / trailing /
// give-back / timeout) sur l'OHLC journalier réel (FMP) à partir des entrées
// qu'on a réellement prises, et on compare une grille de paramètres.
//
// LIMITES (honnêtes) : OHLC journalier (ordre intra-jour inconnu → on suppose le
// stop touché avant le TP, conservateur). Ne backteste PAS l'ENTRÉE (le scoring
// point-in-time est le chantier suivant). Échantillon = nos trades réels.
//
// Usage : GET /functions/v1/backtest-exits
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

interface Trade { ticker: string; entryDate: string; entry: number; stopPct: number; tpPct: number; }
interface Bar { date: string; high: number; low: number; close: number; }
interface Combo { name: string; minPeak: number; frac: number; maxHold: number; trailing: boolean; }

const COMBOS: Combo[] = [
  { name: "ACTUEL (gb50/hold8)", minPeak: 5, frac: 0.5, maxHold: 8, trailing: true },
  { name: "giveback 40%", minPeak: 5, frac: 0.4, maxHold: 8, trailing: true },
  { name: "giveback 60%", minPeak: 5, frac: 0.6, maxHold: 8, trailing: true },
  { name: "sans giveback", minPeak: 999, frac: 0.5, maxHold: 8, trailing: true },
  { name: "sans trailing", minPeak: 5, frac: 0.5, maxHold: 8, trailing: false },
  { name: "hold 6 td", minPeak: 5, frac: 0.5, maxHold: 6, trailing: true },
  { name: "hold 12 td", minPeak: 5, frac: 0.5, maxHold: 12, trailing: true },
];

function trailPct(ret: number): number | null {
  if (ret >= 18) return 12;
  if (ret >= 12) return 7;
  if (ret >= 7) return 3;
  if (ret >= 4) return 0.5;
  return null;
}

function replay(bars: Bar[], t: Trade, p: Combo): { reason: string; pnlPct: number; holdTd: number } {
  let stop = t.entry * (1 - t.stopPct / 100);
  const tp = t.entry * (1 + t.tpPct / 100);
  let peak = t.entry;
  let i = 0;
  for (const b of bars) {
    i++;
    if (b.low <= stop) return { reason: "stop", pnlPct: ((stop - t.entry) / t.entry) * 100, holdTd: i };
    if (b.high >= tp) return { reason: "take_profit", pnlPct: ((tp - t.entry) / t.entry) * 100, holdTd: i };
    peak = Math.max(peak, b.high);
    const peakRet = ((peak - t.entry) / t.entry) * 100;
    const ret = ((b.close - t.entry) / t.entry) * 100;
    if (peakRet >= p.minPeak && ret <= peakRet * p.frac) return { reason: "giveback", pnlPct: ret, holdTd: i };
    if (p.trailing) { const np = trailPct(ret); if (np !== null) { const ns = t.entry * (1 + np / 100); if (ns > stop) stop = ns; } }
    if (i >= p.maxHold) return { reason: "timeout", pnlPct: ret, holdTd: i };
  }
  const last = bars[bars.length - 1];
  return { reason: "open_end", pnlPct: last ? ((last.close - t.entry) / t.entry) * 100 : 0, holdTd: i };
}

async function fetchBars(ticker: string, fromDate: string, fmpKey: string): Promise<Bar[]> {
  const to = new Date(Date.parse(fromDate) + 45 * 86400 * 1000).toISOString().slice(0, 10);
  const url = `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${ticker}&from=${fromDate}&to=${to}&apikey=${fmpKey}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const d = await r.json();
    const arr: Array<{ date?: string; high?: number; low?: number; close?: number }> =
      Array.isArray(d) ? d : (d?.historical ?? []);
    return arr
      .filter(x => x.date && typeof x.high === "number" && typeof x.low === "number" && typeof x.close === "number")
      .map(x => ({ date: x.date!, high: x.high!, low: x.low!, close: x.close! }))
      .filter(b => b.date > fromDate)               // jours APRÈS l'entrée
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch { return []; }
}

Deno.serve(async () => {
  const t0 = Date.now();
  const fmpKey = Deno.env.get("FMP_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!fmpKey || !supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  // Entrées = nos positions réelles (entry + stop/tp d'origine via le signal)
  const { data: positions } = await supabase
    .from("positions")
    .select("ticker, entry_price, opened_at, signal_id")
    .order("opened_at", { ascending: true });
  if (!positions || positions.length === 0) return jsonResponse({ ok: true, note: "no_positions" }, 200);

  const sigIds = positions.map(p => p.signal_id).filter(Boolean);
  const { data: sigs } = sigIds.length
    ? await supabase.from("signals").select("id, stop_loss_pct, take_profit_pct").in("id", sigIds)
    : { data: [] };
  const sigMap = new Map((sigs ?? []).map(s => [s.id, s]));

  const trades: Trade[] = [];
  for (const p of positions) {
    const s = p.signal_id ? sigMap.get(p.signal_id) : null;
    trades.push({
      ticker: p.ticker,
      entryDate: (p.opened_at as string).slice(0, 10),
      entry: Number(p.entry_price),
      stopPct: Number(s?.stop_loss_pct ?? 8),
      tpPct: Number(s?.take_profit_pct ?? 18),
    });
  }

  // OHLC par ticker (1 fetch / ticker, réutilisé pour tous les combos)
  // NB : on prend les barres depuis la PREMIÈRE entrée du ticker ; chaque trade
  // filtre ensuite les barres > sa propre date d'entrée.
  const uniq = [...new Set(trades.map(t => t.ticker))];
  const barsByTicker = new Map<string, Bar[]>();
  for (const tk of uniq) {
    const firstDate = trades.filter(t => t.ticker === tk).map(t => t.entryDate).sort()[0];
    barsByTicker.set(tk, await fetchBars(tk, firstDate, fmpKey));
  }

  const usable = trades.filter(t => (barsByTicker.get(t.ticker)?.length ?? 0) > 0);

  // Grille
  const results = COMBOS.map(combo => {
    const perTrade = usable.map(t => {
      const allBars = barsByTicker.get(t.ticker) ?? [];
      const bars = allBars.filter(b => b.date > t.entryDate);
      const r = replay(bars, t, combo);
      return { ticker: t.ticker, entryDate: t.entryDate, ...r };
    });
    const pnls = perTrade.map(r => r.pnlPct);
    const wins = pnls.filter(x => x > 0);
    const losses = pnls.filter(x => x <= 0);
    const sumWin = wins.reduce((a, b) => a + b, 0);
    const sumLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    const reasons = perTrade.reduce((acc, r) => { acc[r.reason] = (acc[r.reason] ?? 0) + 1; return acc; }, {} as Record<string, number>);
    return {
      combo: combo.name,
      avg_pnl_pct: +(pnls.reduce((a, b) => a + b, 0) / (pnls.length || 1)).toFixed(2),
      total_pnl_pct: +pnls.reduce((a, b) => a + b, 0).toFixed(2),
      win_rate: +((wins.length / (pnls.length || 1)) * 100).toFixed(1),
      profit_factor: sumLoss > 0 ? +(sumWin / sumLoss).toFixed(2) : null,
      avg_hold_td: +(perTrade.reduce((a, r) => a + r.holdTd, 0) / (perTrade.length || 1)).toFixed(1),
      exits: reasons,
    };
  }).sort((a, b) => b.avg_pnl_pct - a.avg_pnl_pct);

  // Détail trade-par-trade sous les params ACTUELS
  const current = COMBOS[0];
  const detail = usable.map(t => {
    const bars = (barsByTicker.get(t.ticker) ?? []).filter(b => b.date > t.entryDate);
    const r = replay(bars, t, current);
    return { ticker: t.ticker, entry: t.entry, entryDate: t.entryDate, exit_reason: r.reason, pnl_pct: +r.pnlPct.toFixed(2), hold_td: r.holdTd, bars: bars.length };
  });

  return jsonResponse({
    ok: true,
    note: "Backtest des RÈGLES DE SORTIE sur OHLC réel (FMP). N'inclut pas l'entrée.",
    trades_total: trades.length,
    trades_usable: usable.length,
    grid: results,
    detail_current_params: detail,
    duration_ms: Date.now() - t0,
  }, 200);
});
