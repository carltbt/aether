// ============================================================================
// Aether — admin-rearm-stops Edge Function (remédiation audit 01/07)
// ============================================================================
// L'audit a trouvé des positions Alpaca SANS leg stop actif (les OCO stop legs
// avaient disparu — il ne restait que la jambe take-profit). update-positions
// fournit un stop LOGICIEL (check toutes les 30 min), mais aucune protection
// native/overnight/gap. Cette fonction ré-arme un OCO propre (TP + stop) pour
// toute position OPEN dépourvue de leg stop, en lisant la qty RÉELLE Alpaca.
//
// Sûr par construction : ne fait qu'AJOUTER une protection (sell stop/TP). Ne
// touche pas aux positions déjà protégées. Idempotent.
// Usage : GET/POST /functions/v1/admin-rearm-stops   (dry_run=true pour simuler)
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

async function alpaca<T>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status?: number; data?: T; error?: string }> {
  const base = Deno.env.get("ALPACA_API_BASE_URL")!;
  const keyId = Deno.env.get("ALPACA_API_KEY_ID")!;
  const secret = Deno.env.get("ALPACA_API_SECRET_KEY")!;
  try {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, status: r.status, error: text.slice(0, 400) };
    return { ok: true, status: r.status, data: text ? JSON.parse(text) as T : undefined };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "true";
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: positions } = await supabase.from("positions")
    .select("ticker, quantity, stop_loss_price, take_profit_price").eq("status", "OPEN");
  if (!positions || positions.length === 0) return jsonResponse({ ok: true, note: "no_open_positions" }, 200);

  type OrderT = { id: string; symbol: string; type: string; order_class?: string; legs?: Array<{ type?: string; stop_price?: string }> };
  const openOrders = (await alpaca<OrderT[]>("GET", "/v2/orders?status=open&nested=true&limit=500")).data ?? [];

  // Inspection : dump brut des ordres ouverts (pour vérifier la présence des legs stop).
  if (url.searchParams.get("inspect") === "true") {
    return jsonResponse({ ok: true, open_orders: openOrders }, 200);
  }

  // Protège si stop, ou OCO/bracket (jambe stop nichée dans legs).
  const isProtective = (o: OrderT) =>
    /stop/i.test(String(o.type ?? "")) ||
    ["oco", "bracket", "otoco", "oto"].includes(String(o.order_class ?? "")) ||
    (o.legs ?? []).some(l => /stop/i.test(String(l?.type ?? "")));

  const actions: Array<Record<string, unknown>> = [];
  for (const p of positions) {
    const t = p.ticker as string;
    const real = await alpaca<{ qty: string }>("GET", `/v2/positions/${t}`);
    const realQty = real.ok && real.data ? Math.abs(parseFloat(real.data.qty)) : 0;
    const symOrders = openOrders.filter(o => o.symbol === t);
    const hasStop = symOrders.some(isProtective);

    if (realQty < 1) { actions.push({ ticker: t, action: "skip_no_position" }); continue; }
    if (hasStop) { actions.push({ ticker: t, action: "already_protected" }); continue; }

    const stop = Number(p.stop_loss_price);
    const tp = Number(p.take_profit_price);
    if (!stop || stop <= 0) { actions.push({ ticker: t, action: "skip_no_stop_price_in_db" }); continue; }

    if (dryRun) {
      actions.push({ ticker: t, action: "would_rearm", qty: realQty, stop, tp, cancel_orders: symOrders.map(o => o.id) });
      continue;
    }

    // Annule les legs orphelins (TP seule) puis pose un OCO propre (TP + stop) GTC.
    for (const o of symOrders) await alpaca("DELETE", `/v2/orders/${o.id}`);
    const ocoPayload: Record<string, unknown> = {
      symbol: t, qty: String(realQty), side: "sell", type: "limit",
      time_in_force: "gtc", order_class: "oco",
      take_profit: { limit_price: tp.toFixed(2) },
      stop_loss: { stop_price: stop.toFixed(2) },
    };
    const resp = await alpaca<{ id: string; status: string }>("POST", "/v2/orders", ocoPayload);
    actions.push({ ticker: t, action: resp.ok ? "rearmed_oco" : "rearm_failed", qty: realQty, stop, tp, error: resp.error, order_id: resp.ok ? resp.data?.id : undefined });
  }

  return jsonResponse({ ok: true, dry_run: dryRun, actions, duration_ms: Date.now() - t0 }, 200);
});
