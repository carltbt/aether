// ============================================================================
// Aether — backtest-entry Edge Function (backtest v1 — couche ENTRÉE)
// ============================================================================
// LE déblocage structurel (audit) : mesurer si l'ENTRÉE a un edge, point-in-time,
// sans look-ahead. v1 = couche PRIX uniquement (proxy de C2 / Strat-LLM S2) :
//   - signal breakout momentum calculable jour par jour avec données ≤ t
//   - entrée à la clôture de t+1 (on agit le lendemain, comme le système réel)
//   - replay des règles de sortie live (stop/trailing/give-back/timeout)
//   - comparé au rendement d'une entrée ALÉATOIRE même horizon (mesure de l'edge)
//
// LIMITES ASSUMÉES :
//   - prix seulement (les clusters fondamentaux C1/C3/C4/C5/C6 ne sont pas "as-of"
//     côté FMP → look-ahead ⇒ exclus de ce v1).
//   - univers = watchlist ACTUELLE (biais de survie) — capé à 40 tickers.
//   - stop/TP fixes (8/18%) au lieu du sizing LLM par signal.
//   - OHLC journalier (stop supposé touché avant TP, conservateur).
//
// Usage : GET /functions/v1/backtest-entry?limit=40&days=370
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number; }

const STOP_PCT = 8, TP_PCT = 18, MAX_HOLD_TD = 8, GB_MIN = 5, GB_FRAC = 0.5;

function trailPct(ret: number): number | null {
  if (ret >= 18) return 12; if (ret >= 12) return 7; if (ret >= 7) return 3; if (ret >= 4) return 0.5; return null;
}
function mean(a: number[]): number { return a.reduce((x, y) => x + y, 0) / (a.length || 1); }

// Replay des sorties à partir de l'index d'entrée (entry = close de startIdx).
function replayExit(bars: Bar[], startIdx: number): { exitIdx: number; pnlPct: number; reason: string; holdTd: number } {
  const entry = bars[startIdx].close;
  let stop = entry * (1 - STOP_PCT / 100);
  const tp = entry * (1 + TP_PCT / 100);
  let peak = entry;
  for (let j = startIdx + 1; j < bars.length; j++) {
    const b = bars[j]; const held = j - startIdx;
    if (b.low <= stop) return { exitIdx: j, pnlPct: ((stop - entry) / entry) * 100, reason: "stop", holdTd: held };
    if (b.high >= tp) return { exitIdx: j, pnlPct: ((tp - entry) / entry) * 100, reason: "take_profit", holdTd: held };
    peak = Math.max(peak, b.high);
    const peakRet = ((peak - entry) / entry) * 100;
    const ret = ((b.close - entry) / entry) * 100;
    if (peakRet >= GB_MIN && ret <= peakRet * GB_FRAC) return { exitIdx: j, pnlPct: ret, reason: "giveback", holdTd: held };
    const np = trailPct(ret); if (np !== null) { const ns = entry * (1 + np / 100); if (ns > stop) stop = ns; }
    if (held >= MAX_HOLD_TD) return { exitIdx: j, pnlPct: ret, reason: "timeout", holdTd: held };
  }
  const last = bars[bars.length - 1];
  return { exitIdx: bars.length - 1, pnlPct: ((last.close - entry) / entry) * 100, reason: "open_end", holdTd: bars.length - 1 - startIdx };
}

async function fetchBars(ticker: string, fromDate: string, fmpKey: string): Promise<Bar[]> {
  const url = `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${ticker}&from=${fromDate}&to=${new Date().toISOString().slice(0, 10)}&apikey=${fmpKey}`;
  try {
    const r = await fetch(url); if (!r.ok) return [];
    const d = await r.json();
    const arr: Array<Record<string, number | string>> = Array.isArray(d) ? d : ((d as { historical?: [] })?.historical ?? []);
    return arr
      .filter(x => x.date && typeof x.high === "number" && typeof x.low === "number" && typeof x.close === "number")
      .map(x => ({ date: x.date as string, open: Number(x.open ?? x.close), high: x.high as number, low: x.low as number, close: x.close as number, volume: Number(x.volume ?? 0) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch { return []; }
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "40", 10) || 40, 60);
  const days = parseInt(url.searchParams.get("days") ?? "370", 10) || 370;
  const fmpKey = Deno.env.get("FMP_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!fmpKey || !supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: wl } = await supabase.from("watchlist").select("symbol").eq("is_active", true).limit(limit);
  const tickers = (wl ?? []).map(w => w.symbol as string);
  if (tickers.length === 0) return jsonResponse({ ok: false, error: "empty_watchlist" }, 404);

  const fromDate = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);

  const trades: Array<{ ticker: string; entryDate: string; pnlPct: number; reason: string; holdTd: number }> = [];
  const baselineFwd: number[] = []; // rendement d'une entrée aléatoire, horizon MAX_HOLD_TD
  let tickersUsed = 0;

  for (const tk of tickers) {
    const bars = await fetchBars(tk, fromDate, fmpKey);
    if (bars.length < 70) continue;
    tickersUsed++;

    // baseline : rendement forward MAX_HOLD_TD pour chaque jour (échantillon 1/3)
    for (let i = 50; i < bars.length - MAX_HOLD_TD; i += 3) {
      baselineFwd.push(((bars[i + MAX_HOLD_TD].close - bars[i].close) / bars[i].close) * 100);
    }

    // scan breakout momentum, sans look-ahead
    let i = 50;
    while (i < bars.length - 2) {
      const sma50 = mean(bars.slice(i - 49, i + 1).map(b => b.close));
      const prior20High = Math.max(...bars.slice(i - 20, i).map(b => b.high));
      const avgVol20 = mean(bars.slice(i - 20, i).map(b => b.volume));
      const breakout = bars[i].close > prior20High && bars[i].close > sma50 && bars[i].volume > 1.2 * avgVol20;
      if (breakout) {
        const entryIdx = i + 1; // entrée à la clôture du lendemain
        const ex = replayExit(bars, entryIdx);
        trades.push({ ticker: tk, entryDate: bars[entryIdx].date, pnlPct: ex.pnlPct, reason: ex.reason, holdTd: ex.holdTd });
        i = ex.exitIdx + 1; // pas de chevauchement : reprend après la sortie
      } else {
        i++;
      }
    }
  }

  const pnls = trades.map(t => t.pnlPct);
  const wins = pnls.filter(x => x > 0); const losses = pnls.filter(x => x <= 0);
  const sumWin = wins.reduce((a, b) => a + b, 0); const sumLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const reasons = trades.reduce((acc, t) => { acc[t.reason] = (acc[t.reason] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  const avgTrade = mean(pnls);
  const baseAvg = mean(baselineFwd);

  return jsonResponse({
    ok: true,
    note: "Backtest ENTRÉE v1 — couche prix (breakout momentum) point-in-time + sorties live, vs entrée aléatoire. Voir limites.",
    universe: { requested: limit, usable_tickers: tickersUsed, period_days: days, from: fromDate },
    entry_rule: "close > plus-haut 20j ET > SMA50 ET volume > 1.2× moy20",
    strategy: {
      trades: trades.length,
      avg_trade_pct: +avgTrade.toFixed(3),
      total_pct: +pnls.reduce((a, b) => a + b, 0).toFixed(1),
      win_rate: +((wins.length / (pnls.length || 1)) * 100).toFixed(1),
      profit_factor: sumLoss > 0 ? +(sumWin / sumLoss).toFixed(2) : null,
      avg_hold_td: +mean(trades.map(t => t.holdTd)).toFixed(1),
      exits: reasons,
    },
    baseline_random_entry: {
      horizon_td: MAX_HOLD_TD,
      samples: baselineFwd.length,
      avg_fwd_return_pct: +baseAvg.toFixed(3),
    },
    edge_vs_random_pct: +(avgTrade - baseAvg).toFixed(3),
    caveats: [
      "Prix seulement (pas de fondamentaux as-of).",
      "Watchlist actuelle = biais de survie.",
      "Stop/TP fixes 8/18%, OHLC journalier.",
      "Échantillon à juger sur le nombre de trades ci-dessus.",
    ],
    duration_ms: Date.now() - t0,
  }, 200);
});
