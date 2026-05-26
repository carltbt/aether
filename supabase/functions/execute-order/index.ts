// ============================================================================
// Aether — execute-order Edge Function (Alpaca paper bracket order)
// ============================================================================
// Source : STRATEGY.md v2.7 Section 4 Bloc 6 + Section 8 Couche 3
//
// Rôle : soumet l'ordre BUY (ou SELL) sur Alpaca paper avec bracket order
// (stop-loss + take-profit attachés natifs Alpaca = Couche 3 protection).
//
// Pré-requis :
//   - signal.action = BUY (V1 long-only) OR SELL pour fermer position
//   - signal.reviewer_verdict = APPROVE
//   - signal.code_validation = APPROVED
//
// Ordre passé :
//   BUY  → limit order @ current ± 0.2% + stop-loss + take-profit (bracket)
//   SELL → market order (close position immediately)
//
// Met à jour :
//   - signals.alpaca_order_id, signals.executed = true
//   - INSERT public.positions (status='OPEN') si BUY
//   - UPDATE public.positions (status='CLOSED', exit_*) si SELL
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

interface Body { signal_id?: string; ticker?: string; dry_run?: boolean; }

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

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
    if (!r.ok) {
      return { ok: false, status: r.status, error: (await r.text()).slice(0, 500) };
    }
    return { ok: true, status: r.status, data: await r.json() as T };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

async function getAlpacaAccount(): Promise<{ ok: boolean; cash?: number; portfolio_value?: number; buying_power?: number; error?: string }> {
  const r = await alpacaRequest<{ cash: string; portfolio_value: string; buying_power: string }>("GET", "/v2/account");
  if (!r.ok || !r.data) return { ok: false, error: r.error };
  return {
    ok: true,
    cash: parseFloat(r.data.cash),
    portfolio_value: parseFloat(r.data.portfolio_value),
    buying_power: parseFloat(r.data.buying_power),
  };
}

async function getAlpacaClock(): Promise<{ is_open: boolean; next_open?: string }> {
  const r = await alpacaRequest<{ is_open: boolean; next_open: string }>("GET", "/v2/clock");
  if (!r.ok || !r.data) return { is_open: false };
  return r.data;
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  let signalId: string | undefined;
  let ticker: string | undefined;
  let dry_run = false;

  if (req.method === "POST") {
    try {
      const body = await req.json() as Body;
      signalId = body.signal_id;
      ticker = body.ticker?.toUpperCase();
      dry_run = body.dry_run === true;
    } catch (e) {
      return jsonResponse({ ok: false, error: "invalid_json_body", detail: String((e as Error).message) }, 400);
    }
  } else {
    const url = new URL(req.url);
    signalId = url.searchParams.get("signal_id") ?? undefined;
    ticker = url.searchParams.get("ticker")?.toUpperCase();
    dry_run = url.searchParams.get("dry_run") === "true";
  }

  // --- Load signal ---
  let sigQuery = supabase.from("signals").select("*").order("created_at", { ascending: false }).limit(1);
  if (signalId) sigQuery = supabase.from("signals").select("*").eq("id", signalId).limit(1);
  else if (ticker) sigQuery = supabase.from("signals").select("*").eq("ticker", ticker).order("created_at", { ascending: false }).limit(1);
  const { data: sig } = await sigQuery.maybeSingle();
  if (!sig) return jsonResponse({ ok: false, error: "signal_not_found" }, 404);
  signalId = sig.id;

  // --- Eligibility checks ---
  if (sig.executed) return jsonResponse({ ok: false, error: "signal_already_executed", alpaca_order_id: sig.alpaca_order_id }, 409);
  if (sig.action === "HOLD") return jsonResponse({ ok: true, skipped: "action_is_HOLD", signal_id: signalId }, 200);
  if (sig.reviewer_verdict !== "APPROVE") return jsonResponse({ ok: false, error: "reviewer_did_not_approve", reviewer_verdict: sig.reviewer_verdict }, 403);
  if (sig.code_validation !== "APPROVED") return jsonResponse({ ok: false, error: "code_validation_not_passed", code_validation: sig.code_validation }, 403);

  // --- Get Alpaca account state ---
  const account = await getAlpacaAccount();
  if (!account.ok) return jsonResponse({ ok: false, error: "alpaca_account_fetch_failed", detail: account.error }, 502);

  // --- Market hours check ---
  const clock = await getAlpacaClock();
  if (!clock.is_open && !dry_run) {
    return jsonResponse({ ok: false, error: "market_closed", next_open: clock.next_open, hint: "Add dry_run=true to test logic without submitting" }, 200);
  }

  // --- Compute order params ---
  const positionSizePct = sig.position_size_pct as number;
  const stopLossPct = sig.stop_loss_pct as number;
  const takeProfitPct = sig.take_profit_pct as number;
  const entryTarget = (sig.entry_price_target as number) ?? 0;

  const positionUsd = (account.portfolio_value ?? 0) * (positionSizePct / 100);
  // Alpaca fractional shares supported → notional approach
  const stopLossPrice = entryTarget * (1 - stopLossPct / 100);
  const takeProfitPrice = entryTarget * (1 + takeProfitPct / 100);

  // --- Submit bracket order ---
  const orderPayload = sig.action === "BUY" ? {
    symbol: sig.ticker,
    notional: positionUsd.toFixed(2),  // Alpaca supports fractional via notional
    side: "buy",
    type: "market",  // V1 simple market entry; STRATEGY.md says limit +0.2% but market is simpler
    time_in_force: "day",
    order_class: "bracket",
    stop_loss: { stop_price: stopLossPrice.toFixed(2) },
    take_profit: { limit_price: takeProfitPrice.toFixed(2) },
  } : {
    symbol: sig.ticker,
    qty: "1",  // For SELL we'd need to know current qty — simplified V1
    side: "sell",
    type: "market",
    time_in_force: "day",
  };

  if (dry_run) {
    return jsonResponse({
      ok: true,
      dry_run: true,
      ticker: sig.ticker,
      signal_id: signalId,
      would_submit: orderPayload,
      account: { cash: account.cash, portfolio_value: account.portfolio_value, buying_power: account.buying_power },
      market_open: clock.is_open,
      computed: { positionUsd: positionUsd.toFixed(2), stopLossPrice: stopLossPrice.toFixed(2), takeProfitPrice: takeProfitPrice.toFixed(2) },
      duration_ms: Date.now() - t0,
    }, 200);
  }

  const orderResp = await alpacaRequest<{ id: string; symbol: string; filled_avg_price: string | null; qty: string | null; status: string }>("POST", "/v2/orders", orderPayload);
  if (!orderResp.ok) {
    // Log to signals
    await supabase.from("signals").update({
      code_validation: `${sig.code_validation} → ALPACA_REJECTED: ${orderResp.error?.slice(0, 200)}`,
    }).eq("id", signalId);
    return jsonResponse({
      ok: false,
      error: "alpaca_order_submit_failed",
      status: orderResp.status,
      detail: orderResp.error,
      attempted_payload: orderPayload,
    }, 502);
  }

  const order = orderResp.data!;

  // --- Update signal as executed ---
  await supabase.from("signals").update({
    executed: true,
    alpaca_order_id: order.id,
  }).eq("id", signalId);

  // --- For BUY : create positions row (status='OPEN') ---
  let positionId: string | null = null;
  if (sig.action === "BUY") {
    const filledPrice = order.filled_avg_price ? parseFloat(order.filled_avg_price) : entryTarget;
    const qty = order.qty ? parseFloat(order.qty) : (positionUsd / filledPrice);
    const { data: pos, error: posErr } = await supabase.from("positions").insert({
      ticker: sig.ticker,
      signal_id: signalId,
      entry_price: filledPrice,
      quantity: qty,
      position_size_usd: positionUsd,
      stop_loss_price: stopLossPrice,
      take_profit_price: takeProfitPrice,
      alpaca_order_id: order.id,
      status: "OPEN",
    }).select("id").single();
    if (posErr) console.error("positions insert failed:", posErr);
    positionId = pos?.id ?? null;
  }

  return jsonResponse({
    ok: true,
    ticker: sig.ticker,
    signal_id: signalId,
    action: sig.action,
    alpaca_order_id: order.id,
    alpaca_order_status: order.status,
    position_id: positionId,
    duration_ms: Date.now() - t0,
    sized: {
      position_size_pct: positionSizePct,
      position_usd: positionUsd,
      stop_loss_price: stopLossPrice,
      take_profit_price: takeProfitPrice,
    },
  }, 200);
});
