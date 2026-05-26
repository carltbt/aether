// ============================================================================
// Aether — update-positions Edge Function (P-004 + P-005)
// ============================================================================
// Source : STRATEGY.md v2.7 Section 8 Couche 2 + Section 8.5 réévaluation rapide
//
// Rôle : vérification rapide TOUTES LES 4H des positions ouvertes.
// Zéro appel Claude. Logique pure : prix vs stops + trailing.
//
// PRIORITÉS (ordre d'évaluation strict) :
//   0. Gap overnight (P-004) : si current_price < stop_loss → market SELL immédiat
//   1. Take-profit atteint → SELL
//   2. Stop-loss intraday → SELL (mais Alpaca bracket gère déjà via les legs)
//   3. Trailing stop tiered (P-005) : update stop_loss_price si profit %  ≥ seuils
//   4. Earnings dans < 3 jours ET position en PROFIT → SELL (lock)
//   5. Durée ≥ 21 jours → SELL (signal PEAD expiré)
//
// Note Alpaca : on garde le bracket order original comme "outer protection"
// au prix initial. Le trailing stop est géré côté nous via update-positions
// (4h cadence). Acceptable pour V1 paper trading.
//
// Usage : GET /functions/v1/update-positions
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

interface PositionRow {
  id: string;
  ticker: string;
  signal_id: string | null;
  opened_at: string;
  entry_price: number;
  quantity: number;
  position_size_usd: number | null;
  stop_loss_price: number | null;
  take_profit_price: number | null;
  alpaca_order_id: string | null;
  status: string;
}

interface AlpacaQuote {
  trade?: { p?: number };  // last trade price
}

interface Event {
  ticker: string;
  position_id: string;
  rule: string;
  detail: Record<string, unknown>;
}

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

// --- Alpaca helpers --------------------------------------------------------

async function alpacaRequest<T>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status?: number; data?: T; error?: string }> {
  const base = Deno.env.get("ALPACA_API_BASE_URL")!;
  const keyId = Deno.env.get("ALPACA_API_KEY_ID")!;
  const secret = Deno.env.get("ALPACA_API_SECRET_KEY")!;
  try {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: {
        "APCA-API-KEY-ID": keyId,
        "APCA-API-SECRET-KEY": secret,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) return { ok: false, status: r.status, error: (await r.text()).slice(0, 500) };
    return { ok: true, status: r.status, data: await r.json() as T };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

async function getMarketOpen(): Promise<boolean> {
  const r = await alpacaRequest<{ is_open: boolean }>("GET", "/v2/clock");
  return !!r.data?.is_open;
}

// --- Price fetching --------------------------------------------------------
// On utilise FMP /stable/quote pour le prix actuel — Alpaca data API nécessite
// un abonnement séparé sur le free tier. Pour V1 paper, FMP suffit (quote = real-time).

async function getCurrentPrice(ticker: string, fmpKey: string): Promise<number | null> {
  try {
    const r = await fetch(`https://financialmodelingprep.com/stable/quote?symbol=${ticker}&apikey=${fmpKey}`);
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return data[0].price ?? null;
  } catch {
    return null;
  }
}

// --- Earnings check (reused from validate-order P-002) ---

async function getDaysUntilNextEarnings(ticker: string, fmpKey: string): Promise<number | null> {
  const today = new Date().toISOString().slice(0, 10);
  const plus10 = new Date(Date.now() + 10 * 86400 * 1000).toISOString().slice(0, 10);
  const url = `https://financialmodelingprep.com/stable/earnings-calendar?from=${today}&to=${plus10}&apikey=${fmpKey}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) return null;
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

// --- Trailing stop tiers (STRATEGY.md Section 8 Couche 2) ---
// returnPct ≥ 20 → stop à entry +12% (lock +12)
// returnPct ≥ 15 → stop à entry +7%
// returnPct ≥ 8  → stop à entry +2% (break-even+)
// returnPct < 8  → pas de trailing, garde stop initial

function computeTrailedStopPct(returnPct: number): number | null {
  if (returnPct >= 20) return 12;
  if (returnPct >= 15) return 7;
  if (returnPct >= 8) return 2;
  return null;
}

// --- Sell at market ---

async function sellAtMarket(supabase: SupabaseClient, pos: PositionRow, currentPrice: number, exitReason: string): Promise<{ ok: boolean; error?: string }> {
  // 1. Submit market sell on Alpaca
  const orderResp = await alpacaRequest<{ id: string; status: string }>("POST", "/v2/orders", {
    symbol: pos.ticker,
    qty: String(pos.quantity),
    side: "sell",
    type: "market",
    time_in_force: "day",
  });
  if (!orderResp.ok) {
    console.error(`Alpaca sell failed for ${pos.ticker}:`, orderResp.error);
    return { ok: false, error: orderResp.error };
  }

  // 2. Update positions row (CLOSED)
  const pnl_usd = (currentPrice - pos.entry_price) * pos.quantity;
  const pnl_pct = ((currentPrice - pos.entry_price) / pos.entry_price) * 100;
  const opened = Date.parse(pos.opened_at);
  const holdDays = Math.round((Date.now() - opened) / (86400 * 1000));

  const { error: upErr } = await supabase.from("positions").update({
    status: "CLOSED",
    exit_price: currentPrice,
    closed_at: new Date().toISOString(),
    exit_reason: exitReason,
    pnl_usd,
    pnl_pct,
    hold_days: holdDays,
  }).eq("id", pos.id);
  if (upErr) console.error(`positions CLOSED update failed for ${pos.id}:`, upErr);

  // 3. Update signals row si possible (executed sell tracked)
  if (pos.signal_id) {
    await supabase.from("signals").update({ executed: true }).eq("id", pos.signal_id);
  }

  return { ok: true };
}

// --- Main handler ---

Deno.serve(async () => {
  const t0 = Date.now();
  const fmpKey = Deno.env.get("FMP_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!fmpKey || !supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  // Market status (skip si fermé sauf gap-overnight check qu'on fait quand même)
  const marketOpen = await getMarketOpen();

  // Fetch all OPEN positions
  const { data: positions, error: posErr } = await supabase
    .from("positions")
    .select("*")
    .eq("status", "OPEN");
  if (posErr) return jsonResponse({ ok: false, error: "positions_query_failed", detail: posErr.message }, 500);

  if (!positions || positions.length === 0) {
    return jsonResponse({
      ok: true,
      market_open: marketOpen,
      positions_checked: 0,
      events: [],
      note: "no_open_positions",
      duration_ms: Date.now() - t0,
    }, 200);
  }

  const events: Event[] = [];

  for (const pos of positions as PositionRow[]) {
    // Skip si données incomplètes
    if (!pos.stop_loss_price || !pos.entry_price || !pos.quantity) {
      events.push({ ticker: pos.ticker, position_id: pos.id, rule: "skipped_incomplete_data", detail: {} });
      continue;
    }

    const currentPrice = await getCurrentPrice(pos.ticker, fmpKey);
    if (currentPrice === null) {
      events.push({ ticker: pos.ticker, position_id: pos.id, rule: "skipped_no_price", detail: {} });
      continue;
    }

    const returnPct = ((currentPrice - pos.entry_price) / pos.entry_price) * 100;

    // === PRIORITY 0 : Gap overnight ===
    // Si prix actuel sous stop-loss → SELL au marché immédiatement, peu importe si market open
    // (le bracket Alpaca aurait dû déclencher, mais s'il y a un gap il n'a pas pu)
    if (currentPrice < pos.stop_loss_price) {
      if (marketOpen) {
        const sellR = await sellAtMarket(supabase, pos, currentPrice, "gap_overnight");
        events.push({
          ticker: pos.ticker,
          position_id: pos.id,
          rule: "gap_overnight_exit",
          detail: { currentPrice, stop_loss_price: pos.stop_loss_price, returnPct, sell_ok: sellR.ok, sell_error: sellR.error },
        });
      } else {
        events.push({
          ticker: pos.ticker,
          position_id: pos.id,
          rule: "gap_overnight_PENDING_market_closed",
          detail: { currentPrice, stop_loss_price: pos.stop_loss_price, returnPct, will_sell_at_open: true },
        });
      }
      continue;  // Skip toutes les autres règles
    }

    // === PRIORITY 1 : Take-profit ===
    if (pos.take_profit_price && currentPrice >= pos.take_profit_price) {
      if (marketOpen) {
        const sellR = await sellAtMarket(supabase, pos, currentPrice, "take_profit");
        events.push({
          ticker: pos.ticker, position_id: pos.id, rule: "take_profit_exit",
          detail: { currentPrice, take_profit_price: pos.take_profit_price, returnPct, sell_ok: sellR.ok, sell_error: sellR.error },
        });
      } else {
        events.push({ ticker: pos.ticker, position_id: pos.id, rule: "take_profit_pending_market_closed", detail: { currentPrice } });
      }
      continue;
    }

    // === PRIORITY 3 : Trailing stop tiered (P-005) ===
    const newStopPct = computeTrailedStopPct(returnPct);
    if (newStopPct !== null) {
      const newStopPrice = pos.entry_price * (1 + newStopPct / 100);
      if (newStopPrice > pos.stop_loss_price) {
        const { error: stopErr } = await supabase.from("positions").update({
          stop_loss_price: newStopPrice,
        }).eq("id", pos.id);
        events.push({
          ticker: pos.ticker, position_id: pos.id, rule: "trailing_stop_updated",
          detail: { from: pos.stop_loss_price, to: newStopPrice, new_stop_pct: newStopPct, returnPct, db_ok: !stopErr },
        });
        // Note V1 : on n'update PAS l'ordre Alpaca bracket. Le bracket original
        // garde sa protection au stop initial. update-positions fait office de
        // "trailing stop" via les checks 4h. À industrialiser plus tard.
      }
    }

    // === PRIORITY 4 : Earnings imminent + profit → lock ===
    const daysUntilEarnings = await getDaysUntilNextEarnings(pos.ticker, fmpKey);
    if (typeof daysUntilEarnings === "number" && daysUntilEarnings >= 0 && daysUntilEarnings < 3) {
      if (returnPct > 0) {
        if (marketOpen) {
          const sellR = await sellAtMarket(supabase, pos, currentPrice, "earnings_profit_lock");
          events.push({
            ticker: pos.ticker, position_id: pos.id, rule: "earnings_profit_lock_exit",
            detail: { days_until_earnings: daysUntilEarnings, returnPct, sell_ok: sellR.ok, sell_error: sellR.error },
          });
          continue;
        } else {
          events.push({
            ticker: pos.ticker, position_id: pos.id, rule: "earnings_profit_lock_pending_market_closed",
            detail: { days_until_earnings: daysUntilEarnings, returnPct },
          });
        }
      } else {
        // Position en perte avant earnings : HOLD (stop-loss protège, ne pas cristalliser)
        events.push({
          ticker: pos.ticker, position_id: pos.id, rule: "earnings_hold_in_loss",
          detail: { days_until_earnings: daysUntilEarnings, returnPct, note: "STRATEGY.md : ne pas cristalliser perte avant event" },
        });
      }
    }

    // === PRIORITY 5 : Hold duration > 21 days → exit ===
    const opened = Date.parse(pos.opened_at);
    const holdDays = Math.round((Date.now() - opened) / (86400 * 1000));
    if (holdDays > 21) {
      if (marketOpen) {
        const sellR = await sellAtMarket(supabase, pos, currentPrice, "timeout_21d");
        events.push({
          ticker: pos.ticker, position_id: pos.id, rule: "duration_timeout_exit",
          detail: { hold_days: holdDays, returnPct, sell_ok: sellR.ok, sell_error: sellR.error },
        });
      } else {
        events.push({ ticker: pos.ticker, position_id: pos.id, rule: "duration_timeout_pending_market_closed", detail: { hold_days: holdDays } });
      }
    } else if (events.findIndex(e => e.position_id === pos.id) === -1) {
      // Aucune règle déclenchée pour cette position → log comme "held"
      events.push({
        ticker: pos.ticker, position_id: pos.id, rule: "held_no_action",
        detail: { returnPct, currentPrice, stop_loss_price: pos.stop_loss_price, hold_days: holdDays },
      });
    }
  }

  return jsonResponse({
    ok: true,
    market_open: marketOpen,
    positions_checked: positions.length,
    events_count: events.length,
    events,
    duration_ms: Date.now() - t0,
  }, 200);
});
