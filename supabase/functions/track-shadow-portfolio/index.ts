// ============================================================================
// Aether — track-shadow-portfolio Edge Function (α — empirical Reviewer validation)
// ============================================================================
// Source : feedback 28 mai — "Reviewer reject everything, est-il trop strict?"
//
// Rôle (2-en-1) :
//   1. **ENTRY** : pour chaque signal Trader=BUY dans les dernières 24h non
//      encore tracké en shadow → INSERT shadow_position au prix courant
//      (qu'il ait été REJECT ou APPROVE par Reviewer)
//   2. **EXIT** : pour chaque shadow_position OPEN → check prix actuel et
//      applique mêmes règles que update-positions (stop, take_profit, trailing,
//      earnings imminent, 21d timeout)
//
// Output : tableau d'events (entries/exits/no-ops). Après quelques semaines,
// query `shadow_positions` permet de comparer PnL shadow (tout BUY proposé)
// vs réel (seulement BUY Approved par Reviewer).
//
// Schedulé : on appelle ce endpoint via cron (lun-ven 11h15 UTC, juste après
// daily-analysis 11h, ET 13/17/21h pour exits, comme update-positions).
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

interface SignalRow {
  id: string;
  ticker: string;
  action: string;
  conviction: number;
  position_size_pct: number | null;
  entry_price_target: number | null;
  stop_loss_pct: number | null;
  take_profit_pct: number | null;
  reviewer_verdict: string | null;
  created_at: string;
}

interface ShadowPosition {
  id: string;
  ticker: string;
  signal_id: string | null;
  opened_at: string;
  entry_price: number;
  quantity: number;
  stop_loss_price: number | null;
  take_profit_price: number | null;
  was_reviewer_approved: boolean;
}

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

async function getCurrentPrice(ticker: string, fmpKey: string): Promise<number | null> {
  try {
    const r = await fetch(`https://financialmodelingprep.com/stable/quote?symbol=${ticker}&apikey=${fmpKey}`);
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return data[0].price ?? null;
  } catch { return null; }
}

async function getDaysUntilNextEarnings(ticker: string, fmpKey: string): Promise<number | null> {
  const today = new Date().toISOString().slice(0, 10);
  const plus10 = new Date(Date.now() + 10 * 86400 * 1000).toISOString().slice(0, 10);
  try {
    const r = await fetch(`https://financialmodelingprep.com/stable/earnings-calendar?from=${today}&to=${plus10}&apikey=${fmpKey}`);
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
  } catch { return null; }
}

function computeTrailedStopPct(returnPct: number): number | null {
  if (returnPct >= 20) return 12;
  if (returnPct >= 15) return 7;
  if (returnPct >= 8) return 2;
  return null;
}

// === ENTRY PHASE : open shadow positions for recent Trader=BUY signals ===
async function openNewShadowPositions(supabase: SupabaseClient, fmpKey: string) {
  const cutoff24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  // Get BUY signals from past 24h QUI ONT ÉTÉ REVUS (audit D-005) : on exclut les
  // PENDING/EXPIRED (jamais arrivés au Reviewer) — sinon ils polluent le bucket
  // « rejected » et faussent le verdict « le Reviewer est-il trop strict ? ».
  const { data: recentBuys } = await supabase
    .from("signals")
    .select("*")
    .eq("action", "BUY")
    .in("reviewer_verdict", ["APPROVE", "REJECT"])
    .gte("created_at", cutoff24h);

  if (!recentBuys || recentBuys.length === 0) {
    return { entries: [], reason: "no_buy_signals_24h" };
  }

  // Filter out ones already in shadow (open or recently closed for same signal_id)
  const signalIds = recentBuys.map(s => s.id);
  const { data: existingShadow } = await supabase
    .from("shadow_positions")
    .select("signal_id")
    .in("signal_id", signalIds);
  const alreadyTracked = new Set((existingShadow ?? []).map(s => s.signal_id));

  const toOpen = (recentBuys as SignalRow[]).filter(s => !alreadyTracked.has(s.id));

  const entries: Array<Record<string, unknown>> = [];
  // FMP quotes can be fetched in batch but for V1 simplicity, sequential
  for (const sig of toOpen) {
    const price = await getCurrentPrice(sig.ticker, fmpKey);
    if (price === null) {
      entries.push({ ticker: sig.ticker, signal_id: sig.id, skipped: "no_price_available" });
      continue;
    }

    // Compute size assuming $100K shadow portfolio
    const portfolioValue = 100_000;
    const sizeUsd = portfolioValue * ((sig.position_size_pct ?? 5) / 100);
    const quantity = Math.floor(sizeUsd / price);
    if (quantity <= 0) {
      entries.push({ ticker: sig.ticker, signal_id: sig.id, skipped: "quantity_zero" });
      continue;
    }

    const stopLossPrice = price * (1 - (sig.stop_loss_pct ?? 7) / 100);
    const takeProfitPrice = price * (1 + (sig.take_profit_pct ?? 15) / 100);

    // Check si déjà une position OPEN sur ce ticker (unique index l'empêcherait sinon)
    const { data: existingOpen } = await supabase
      .from("shadow_positions")
      .select("id")
      .eq("ticker", sig.ticker)
      .eq("status", "OPEN")
      .maybeSingle();
    if (existingOpen) {
      entries.push({ ticker: sig.ticker, signal_id: sig.id, skipped: "shadow_already_open" });
      continue;
    }

    const { data: inserted, error: insErr } = await supabase.from("shadow_positions").insert({
      ticker: sig.ticker,
      signal_id: sig.id,
      entry_price: price,
      quantity,
      position_size_usd: sizeUsd,
      stop_loss_price: stopLossPrice,
      take_profit_price: takeProfitPrice,
      status: "OPEN",
      was_reviewer_approved: sig.reviewer_verdict === "APPROVE",
      trader_conviction: sig.conviction,
      trader_action: sig.action,
      reviewer_verdict: sig.reviewer_verdict,
    }).select("id").single();

    if (insErr) {
      entries.push({ ticker: sig.ticker, signal_id: sig.id, error: insErr.message });
    } else {
      entries.push({
        ticker: sig.ticker, signal_id: sig.id, shadow_id: inserted?.id,
        entry_price: price, quantity, size_usd: sizeUsd,
        stop_loss_price: stopLossPrice, take_profit_price: takeProfitPrice,
        was_reviewer_approved: sig.reviewer_verdict === "APPROVE",
      });
    }
  }

  return { entries, candidates_evaluated: toOpen.length };
}

// === EXIT PHASE : apply update-positions rules to shadow OPEN positions ===
async function evaluateOpenShadowPositions(supabase: SupabaseClient, fmpKey: string) {
  const { data: openShadow } = await supabase
    .from("shadow_positions")
    .select("*")
    .eq("status", "OPEN");
  if (!openShadow || openShadow.length === 0) {
    return { exits: [], no_open_shadows: true };
  }

  const exits: Array<Record<string, unknown>> = [];
  for (const pos of openShadow as ShadowPosition[]) {
    const currentPrice = await getCurrentPrice(pos.ticker, fmpKey);
    if (currentPrice === null) {
      exits.push({ ticker: pos.ticker, shadow_id: pos.id, skipped: "no_price" });
      continue;
    }
    const returnPct = ((currentPrice - pos.entry_price) / pos.entry_price) * 100;

    let exitReason: string | null = null;

    // PRIORITY 0 : gap overnight / stop hit
    if (pos.stop_loss_price && currentPrice < pos.stop_loss_price) {
      exitReason = "stop_loss_hit";
    }
    // PRIORITY 1 : take-profit
    else if (pos.take_profit_price && currentPrice >= pos.take_profit_price) {
      exitReason = "take_profit_hit";
    }
    // PRIORITY 3 : trailing stop (update only, no exit)
    else {
      const newStopPct = computeTrailedStopPct(returnPct);
      if (newStopPct !== null) {
        const newStopPrice = pos.entry_price * (1 + newStopPct / 100);
        if (pos.stop_loss_price === null || newStopPrice > pos.stop_loss_price) {
          await supabase.from("shadow_positions").update({ stop_loss_price: newStopPrice }).eq("id", pos.id);
          exits.push({
            ticker: pos.ticker, shadow_id: pos.id, action: "trailing_stop_updated",
            from: pos.stop_loss_price, to: newStopPrice, returnPct,
          });
        }
      }

      // PRIORITY 4 : earnings imminent + profit
      const daysUntil = await getDaysUntilNextEarnings(pos.ticker, fmpKey);
      if (typeof daysUntil === "number" && daysUntil >= 0 && daysUntil < 3 && returnPct > 0) {
        exitReason = "earnings_profit_lock";
      }

      // PRIORITY 5 : 21d timeout
      const heldDays = Math.round((Date.now() - Date.parse(pos.opened_at)) / (86400 * 1000));
      if (!exitReason && heldDays > 21) {
        exitReason = "timeout_21d";
      }
    }

    if (exitReason) {
      const pnl_usd = (currentPrice - pos.entry_price) * pos.quantity;
      const pnl_pct = ((currentPrice - pos.entry_price) / pos.entry_price) * 100;
      const heldDays = Math.round((Date.now() - Date.parse(pos.opened_at)) / (86400 * 1000));
      await supabase.from("shadow_positions").update({
        status: "CLOSED",
        exit_price: currentPrice,
        closed_at: new Date().toISOString(),
        exit_reason: exitReason,
        pnl_usd, pnl_pct, hold_days: heldDays,
      }).eq("id", pos.id);
      exits.push({
        ticker: pos.ticker, shadow_id: pos.id, action: "CLOSED",
        exit_reason: exitReason, exit_price: currentPrice, pnl_pct, pnl_usd, hold_days: heldDays,
      });
    } else if (!exits.find(e => e.shadow_id === pos.id)) {
      exits.push({
        ticker: pos.ticker, shadow_id: pos.id, action: "held",
        currentPrice, returnPct: Math.round(returnPct * 100) / 100,
      });
    }
  }

  return { exits };
}

Deno.serve(async () => {
  const t0 = Date.now();
  const fmpKey = Deno.env.get("FMP_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!fmpKey || !supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  const entryResult = await openNewShadowPositions(supabase, fmpKey);
  const exitResult = await evaluateOpenShadowPositions(supabase, fmpKey);

  // Aggregate stats for response
  const { data: allShadows } = await supabase
    .from("shadow_positions")
    .select("status, pnl_usd, pnl_pct, was_reviewer_approved, reviewer_verdict");
  const allOpen = (allShadows ?? []).filter(s => s.status === "OPEN").length;
  const allClosed = (allShadows ?? []).filter(s => s.status === "CLOSED").length;
  const totalPnlUsd = (allShadows ?? []).reduce((sum, s) => sum + Number(s.pnl_usd ?? 0), 0);
  const approvedPnlUsd = (allShadows ?? []).filter(s => s.was_reviewer_approved).reduce((sum, s) => sum + Number(s.pnl_usd ?? 0), 0);
  // Bucket « rejected » sur le vrai verdict REJECT (pas !approved, qui incluait PENDING/EXPIRED).
  const rejectedPnlUsd = (allShadows ?? []).filter(s => s.reviewer_verdict === "REJECT").reduce((sum, s) => sum + Number(s.pnl_usd ?? 0), 0);

  return jsonResponse({
    ok: true,
    duration_ms: Date.now() - t0,
    entries: entryResult,
    exits: exitResult,
    aggregate: {
      total_shadows_ever: (allShadows ?? []).length,
      open_now: allOpen,
      closed: allClosed,
      total_pnl_usd: totalPnlUsd,
      reviewer_approved_pnl_usd: approvedPnlUsd,   // PnL des trades qui auraient été REAL
      reviewer_rejected_pnl_usd: rejectedPnlUsd,    // PnL des trades que Reviewer a bloqué
      reviewer_correctness_signal: rejectedPnlUsd < 0 ? "Reviewer was right (rejected losers)" : rejectedPnlUsd > approvedPnlUsd ? "Reviewer was too strict (rejected winners)" : "neutral",
    },
  }, 200);
});
