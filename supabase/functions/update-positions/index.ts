// ============================================================================
// Aether — update-positions v2 (protection des gains renforcée)
// ============================================================================
// Source : STRATEGY.md Section 8 + diagnostic 18/06 (gains rendus, stop non
// appliqué en continu).
//
// CHANGEMENTS v2 :
//   P0 — cadence : appelé toutes les 30 min en séance (cron */30 13-20).
//        + cancel des ordres Alpaca ouverts AVANT toute vente manuelle (évite
//          l'oversell si un leg bracket subsiste).
//        + reporte les ordres Alpaca ouverts par symbole (diagnostic bracket).
//   P1 — trailing PLUS FIN (lock dès +4%), règle GIVE-BACK (sortie si on rend
//        la moitié du pic de gain), hold max 21j → 10j (demi-vie PEAD ~6-7j),
//        suivi du peak_price.
//
// Priorités d'évaluation :
//   0. Stop (current ≤ stop_loss_price) → SELL
//   1. Take-profit (current ≥ take_profit_price) → SELL
//   2. Give-back (peak ≥ +5% ET current ≤ 50% du pic) → SELL  ← NOUVEAU
//   3. Trailing stop fin → relève stop_loss_price
//   4. Earnings < 3j ET profit → SELL (lock)
//   5. Hold ≥ 10j → SELL (PEAD expiré)
//
// Usage : GET /functions/v1/update-positions
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// AUDIT 2026-06-23 : timeout en JOURS DE BOURSE (pas calendaires). 8 td ≈ demi-vie
// PEAD (Sidhu et al. P6 : IC J1=0.119 → J10=0.065). Avant: 10 "jours" ambigus.
const MAX_HOLD_TRADING_DAYS = 8;
const GIVEBACK_MIN_PEAK_PCT = 5;   // give-back ne s'active qu'au-delà de +5% de pic
const GIVEBACK_FRACTION = 0.5;     // sortie si on retombe sous 50% du pic de gain

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
  peak_price: number | null;
  alpaca_order_id: string | null;
  status: string;
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

// Jours de bourse (Lun-Ven) entre deux instants — ignore les fériés (sur-compte de
// ~1 sur une fenêtre de détention, acceptable).
function tradingDaysBetween(startMs: number, endMs: number): number {
  let count = 0;
  const d = new Date(startMs); d.setUTCHours(0, 0, 0, 0);
  const end = new Date(endMs); end.setUTCHours(0, 0, 0, 0);
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) count++;
  }
  return count;
}

// --- Alpaca helpers --------------------------------------------------------

function alpacaHeaders() {
  return {
    "APCA-API-KEY-ID": Deno.env.get("ALPACA_API_KEY_ID")!,
    "APCA-API-SECRET-KEY": Deno.env.get("ALPACA_API_SECRET_KEY")!,
    "Content-Type": "application/json",
  };
}

async function alpacaRequest<T>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status?: number; data?: T; error?: string }> {
  const base = Deno.env.get("ALPACA_API_BASE_URL")!;
  try {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: alpacaHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) return { ok: false, status: r.status, error: (await r.text()).slice(0, 500) };
    const text = await r.text();
    return { ok: true, status: r.status, data: text ? JSON.parse(text) as T : undefined };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

async function getMarketOpen(): Promise<boolean> {
  const r = await alpacaRequest<{ is_open: boolean }>("GET", "/v2/clock");
  return !!r.data?.is_open;
}

interface AlpacaOrder { id: string; symbol: string; }
async function getOpenOrders(): Promise<AlpacaOrder[]> {
  const r = await alpacaRequest<AlpacaOrder[]>("GET", "/v2/orders?status=open&limit=500");
  return Array.isArray(r.data) ? r.data : [];
}

// Annule les ordres Alpaca ouverts d'un symbole (legs bracket résiduels) avant
// une vente manuelle → évite l'oversell. Retourne le nb annulé.
async function cancelOrdersForSymbol(openOrders: AlpacaOrder[], ticker: string): Promise<number> {
  const mine = openOrders.filter(o => o.symbol === ticker);
  let n = 0;
  for (const o of mine) {
    const d = await alpacaRequest("DELETE", `/v2/orders/${o.id}`);
    if (d.ok) n++;
  }
  return n;
}

// --- Price (FMP) ------------------------------------------------------------

// AUDIT 2026-06-23 : on lit aussi dayHigh (deja dans la reponse FMP, 0 appel en plus)
// pour alimenter le peak tracking → reactive le give-back (auparavant inerte car le
// peak ne montait jamais au-dessus de l'entree).
async function getCurrentPrice(ticker: string, fmpKey: string): Promise<{ price: number; dayHigh: number } | null> {
  try {
    const r = await fetch(`https://financialmodelingprep.com/stable/quote?symbol=${ticker}&apikey=${fmpKey}`);
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0 || typeof data[0].price !== "number") return null;
    const price = data[0].price as number;
    const dayHigh = typeof data[0].dayHigh === "number" ? data[0].dayHigh as number : price;
    return { price, dayHigh };
  } catch {
    return null;
  }
}

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

// --- Trailing tiers (P1 — plus fins qu'en v1) ---
// +18% → lock +12% | +12% → +7% | +7% → +3% | +4% → break-even+0.5% | sinon rien
function computeTrailedStopPct(returnPct: number): number | null {
  if (returnPct >= 18) return 12;
  if (returnPct >= 12) return 7;
  if (returnPct >= 7) return 3;
  if (returnPct >= 4) return 0.5;
  return null;
}

async function closeDb(supabase: SupabaseClient, pos: PositionRow, currentPrice: number, reason: string) {
  const pnl_usd = (currentPrice - pos.entry_price) * pos.quantity;
  const pnl_pct = ((currentPrice - pos.entry_price) / pos.entry_price) * 100;
  const holdDays = tradingDaysBetween(Date.parse(pos.opened_at), Date.now());
  const { error: upErr } = await supabase.from("positions").update({
    status: "CLOSED", exit_price: currentPrice, closed_at: new Date().toISOString(),
    exit_reason: reason, pnl_usd, pnl_pct, hold_days: holdDays,
  }).eq("id", pos.id);
  if (upErr) console.error(`positions CLOSED update failed for ${pos.id}:`, upErr);
  if (pos.signal_id) await supabase.from("signals").update({ executed: true }).eq("id", pos.signal_id);
}

// AUDIT 25/06 : ne JAMAIS survendre. Le bracket GTC peut avoir déjà clôturé la
// position (TP/stop filled) avant ce check → on lit la qty RÉELLE Alpaca. Si 0,
// on réconcilie la DB sans nouvel ordre (sinon vente en double → SHORT, cf KBH).
async function sellAtMarket(
  supabase: SupabaseClient, pos: PositionRow, currentPrice: number, exitReason: string, openOrders: AlpacaOrder[],
): Promise<{ ok: boolean; error?: string; canceled: number; reconciled?: boolean }> {
  const real = await alpacaRequest<{ qty: string }>("GET", `/v2/positions/${pos.ticker}`);
  const realQty = real.ok && real.data ? Math.abs(parseFloat(real.data.qty)) : 0;
  const canceled = await cancelOrdersForSymbol(openOrders, pos.ticker);

  if (realQty < 1) {
    await closeDb(supabase, pos, currentPrice, `${exitReason}_reconciled`);
    return { ok: true, canceled, reconciled: true };
  }

  const sellQty = Math.min(realQty, pos.quantity);  // jamais plus que ce qu'on détient
  const orderResp = await alpacaRequest<{ id: string; status: string }>("POST", "/v2/orders", {
    symbol: pos.ticker, qty: String(sellQty), side: "sell", type: "market", time_in_force: "day",
  });
  if (!orderResp.ok) {
    console.error(`Alpaca sell failed for ${pos.ticker}:`, orderResp.error);
    return { ok: false, error: orderResp.error, canceled };
  }
  await closeDb(supabase, pos, currentPrice, exitReason);
  return { ok: true, canceled };
}

// --- Main ---
Deno.serve(async () => {
  const t0 = Date.now();
  const fmpKey = Deno.env.get("FMP_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!fmpKey || !supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  const marketOpen = await getMarketOpen();
  const openOrders = await getOpenOrders();           // pour cancel + diagnostic bracket

  const { data: positions, error: posErr } = await supabase.from("positions").select("*").eq("status", "OPEN");
  if (posErr) return jsonResponse({ ok: false, error: "positions_query_failed", detail: posErr.message }, 500);
  if (!positions || positions.length === 0) {
    return jsonResponse({ ok: true, market_open: marketOpen, positions_checked: 0, alpaca_open_orders: openOrders.length, events: [], note: "no_open_positions", duration_ms: Date.now() - t0 }, 200);
  }

  const events: Event[] = [];

  for (const pos of positions as PositionRow[]) {
    if (!pos.stop_loss_price || !pos.entry_price || !pos.quantity) {
      events.push({ ticker: pos.ticker, position_id: pos.id, rule: "skipped_incomplete_data", detail: {} });
      continue;
    }
    const quote = await getCurrentPrice(pos.ticker, fmpKey);
    if (quote === null) {
      events.push({ ticker: pos.ticker, position_id: pos.id, rule: "skipped_no_price", detail: {} });
      continue;
    }
    const currentPrice = quote.price;

    const returnPct = ((currentPrice - pos.entry_price) / pos.entry_price) * 100;
    const ordersForSym = openOrders.filter(o => o.symbol === pos.ticker).length;

    // --- Suivi du peak (inclut dayHigh → give-back enfin actif) ---
    const prevPeak = pos.peak_price ?? pos.entry_price;
    const newPeak = Math.max(prevPeak, currentPrice, quote.dayHigh);
    if (newPeak > prevPeak) {
      await supabase.from("positions").update({ peak_price: newPeak }).eq("id", pos.id);
    }
    const peakReturnPct = ((newPeak - pos.entry_price) / pos.entry_price) * 100;

    // === 0. Stop ===
    if (currentPrice <= pos.stop_loss_price) {
      if (marketOpen) {
        const s = await sellAtMarket(supabase, pos, currentPrice, "stop_loss_hit", openOrders);
        events.push({ ticker: pos.ticker, position_id: pos.id, rule: "stop_exit", detail: { currentPrice, stop: pos.stop_loss_price, returnPct, sell_ok: s.ok, canceled_legs: s.canceled, alpaca_open_orders: ordersForSym } });
      } else {
        events.push({ ticker: pos.ticker, position_id: pos.id, rule: "stop_pending_market_closed", detail: { currentPrice, stop: pos.stop_loss_price, returnPct } });
      }
      continue;
    }

    // === 1. Take-profit ===
    if (pos.take_profit_price && currentPrice >= pos.take_profit_price) {
      if (marketOpen) {
        const s = await sellAtMarket(supabase, pos, currentPrice, "take_profit", openOrders);
        events.push({ ticker: pos.ticker, position_id: pos.id, rule: "take_profit_exit", detail: { currentPrice, tp: pos.take_profit_price, returnPct, sell_ok: s.ok, canceled_legs: s.canceled } });
      } else {
        events.push({ ticker: pos.ticker, position_id: pos.id, rule: "take_profit_pending_market_closed", detail: { currentPrice } });
      }
      continue;
    }

    // === 2. Give-back (NOUVEAU) : on rend la moitié du pic de gain ===
    if (peakReturnPct >= GIVEBACK_MIN_PEAK_PCT && returnPct <= peakReturnPct * GIVEBACK_FRACTION) {
      if (marketOpen) {
        const s = await sellAtMarket(supabase, pos, currentPrice, "giveback", openOrders);
        events.push({ ticker: pos.ticker, position_id: pos.id, rule: "giveback_exit", detail: { returnPct: +returnPct.toFixed(2), peakReturnPct: +peakReturnPct.toFixed(2), threshold: +(peakReturnPct * GIVEBACK_FRACTION).toFixed(2), sell_ok: s.ok, canceled_legs: s.canceled } });
      } else {
        events.push({ ticker: pos.ticker, position_id: pos.id, rule: "giveback_pending_market_closed", detail: { returnPct: +returnPct.toFixed(2), peakReturnPct: +peakReturnPct.toFixed(2) } });
      }
      continue;
    }

    // === 3. Trailing stop fin ===
    const newStopPct = computeTrailedStopPct(returnPct);
    if (newStopPct !== null) {
      const newStopPrice = pos.entry_price * (1 + newStopPct / 100);
      if (newStopPrice > pos.stop_loss_price) {
        const { error: stopErr } = await supabase.from("positions").update({ stop_loss_price: newStopPrice }).eq("id", pos.id);
        events.push({ ticker: pos.ticker, position_id: pos.id, rule: "trailing_stop_updated", detail: { from: pos.stop_loss_price, to: +newStopPrice.toFixed(2), new_stop_pct: newStopPct, returnPct: +returnPct.toFixed(2), db_ok: !stopErr } });
      }
    }

    // === 4. Earnings imminent + profit → lock ===
    const daysUntilEarnings = await getDaysUntilNextEarnings(pos.ticker, fmpKey);
    if (typeof daysUntilEarnings === "number" && daysUntilEarnings >= 0 && daysUntilEarnings < 3) {
      if (returnPct > 0 && marketOpen) {
        const s = await sellAtMarket(supabase, pos, currentPrice, "earnings_profit_lock", openOrders);
        events.push({ ticker: pos.ticker, position_id: pos.id, rule: "earnings_profit_lock_exit", detail: { days_until_earnings: daysUntilEarnings, returnPct: +returnPct.toFixed(2), sell_ok: s.ok } });
        continue;
      } else {
        events.push({ ticker: pos.ticker, position_id: pos.id, rule: returnPct > 0 ? "earnings_lock_pending_market_closed" : "earnings_hold_in_loss", detail: { days_until_earnings: daysUntilEarnings, returnPct: +returnPct.toFixed(2) } });
      }
    }

    // === 5. Hold ≥ 8 jours de BOURSE → exit (PEAD expiré) ===
    const tradingDays = tradingDaysBetween(Date.parse(pos.opened_at), Date.now());
    const calDays = Math.round((Date.now() - Date.parse(pos.opened_at)) / (86400 * 1000));
    if (tradingDays >= MAX_HOLD_TRADING_DAYS) {
      if (marketOpen) {
        const s = await sellAtMarket(supabase, pos, currentPrice, "timeout_8td", openOrders);
        events.push({ ticker: pos.ticker, position_id: pos.id, rule: "duration_timeout_exit", detail: { trading_days: tradingDays, cal_days: calDays, returnPct: +returnPct.toFixed(2), sell_ok: s.ok } });
      } else {
        events.push({ ticker: pos.ticker, position_id: pos.id, rule: "duration_timeout_pending_market_closed", detail: { trading_days: tradingDays, cal_days: calDays } });
      }
    } else if (events.findIndex(e => e.position_id === pos.id) === -1) {
      events.push({ ticker: pos.ticker, position_id: pos.id, rule: "held_no_action", detail: { returnPct: +returnPct.toFixed(2), peakReturnPct: +peakReturnPct.toFixed(2), currentPrice, stop: pos.stop_loss_price, trading_days: tradingDays, alpaca_open_orders: ordersForSym } });
    }
  }

  return jsonResponse({
    ok: true,
    market_open: marketOpen,
    positions_checked: positions.length,
    alpaca_open_orders_total: openOrders.length,
    events_count: events.length,
    events,
    duration_ms: Date.now() - t0,
  }, 200);
});
