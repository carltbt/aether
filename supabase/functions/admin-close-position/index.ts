// ============================================================================
// Aether — admin-close-position (utilitaire de réconciliation)
// ============================================================================
// Solde une position Alpaca (long → sell, short → buy-to-cover). Sert à nettoyer
// un artefact (ex. short KBH issu d'un ancien oversell). Ordre market day :
// s'exécute de suite si le marché est ouvert, sinon mis en file pour l'ouverture.
// Usage : GET ?symbol=KBH
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

async function alpaca<T>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status?: number; data?: T; error?: string }> {
  const base = Deno.env.get("ALPACA_API_BASE_URL")!;
  try {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: {
        "APCA-API-KEY-ID": Deno.env.get("ALPACA_API_KEY_ID")!,
        "APCA-API-SECRET-KEY": Deno.env.get("ALPACA_API_SECRET_KEY")!,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) return { ok: false, status: r.status, error: (await r.text()).slice(0, 400) };
    const text = await r.text();
    return { ok: true, status: r.status, data: text ? JSON.parse(text) as T : undefined };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

Deno.serve(async (req: Request) => {
  const symbol = new URL(req.url).searchParams.get("symbol")?.toUpperCase();
  if (!symbol) return jsonResponse({ ok: false, error: "missing_symbol" }, 400);

  const pos = await alpaca<{ qty: string; side: string }>("GET", `/v2/positions/${symbol}`);
  // Audit 01/07 : SEUL un 404 = réellement à plat. Une erreur transitoire (401/403/500/réseau)
  // ne doit PAS être rapportée « à plat » (pour un outil d'un-shorting, ça laisserait un short découvert).
  if (!pos.ok) {
    if (pos.status === 404) return jsonResponse({ ok: true, symbol, note: "no_position (déjà à plat)" }, 200);
    return jsonResponse({ ok: false, symbol, error: "alpaca_position_lookup_failed", status: pos.status, detail: pos.error }, 502);
  }
  if (!pos.data) return jsonResponse({ ok: true, symbol, note: "no_position" }, 200);

  const signedQty = parseFloat(pos.data.qty);
  const absQty = Math.abs(signedQty);
  if (absQty < 1) return jsonResponse({ ok: true, symbol, note: "qty < 1" }, 200);

  const side = signedQty < 0 ? "buy" : "sell";  // short → buy-to-cover
  const order = await alpaca<{ id: string; status: string }>("POST", "/v2/orders", {
    symbol, qty: String(absQty), side, type: "market", time_in_force: "day",
  });

  // Trace DB (audit 01/07) : sans ça la clôture manuelle était invisible (ops-watchdog/EOD/PnL)
  // et la ligne positions restait OPEN indéfiniment. Best-effort, ne bloque pas la réponse.
  if (order.ok) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (supabaseUrl && serviceKey) {
      try {
        const supabase = createClient(supabaseUrl, serviceKey);
        await supabase.from("positions").update({ status: "CLOSED", exit_reason: "admin_manual_close", closed_at: new Date().toISOString() })
          .eq("ticker", symbol).eq("status", "OPEN");
        await supabase.from("system_heartbeats").insert({ status: "ok", cycles_completed: 0, stocks_analyzed: 0,
          notes: `admin-close-position | ${symbol} | ${side} ${absQty} | order=${order.data?.id ?? "?"}` });
      } catch (e) { console.error("admin-close DB trace failed:", (e as Error).message); }
    }
  }

  return jsonResponse({
    ok: order.ok,
    symbol,
    position_qty: signedQty,
    action: `${side} ${absQty}`,
    order_id: order.data?.id,
    order_status: order.data?.status,
    error: order.error,
    note: order.ok ? "Ordre soumis + trace DB (position marquée CLOSED)." : "Échec — réessayer marché ouvert.",
  }, 200);
});
