// ============================================================================
// Aether — fetch-daily-context Edge Function (P-001)
// ============================================================================
// Source : STRATEGY.md v2.7 Section 7 (régimes FREE/GUIDED/STRICT/PAUSE)
//
// Rôle : 1×/jour, fetch :
//   - VIX (FMP /stable/quote?symbol=^VIX)
//   - SPY current + 60d history → compute SMA50 locally
//   - Treasury 10Y rate
// Compute regime per STRATEGY.md table, upsert dans public.daily_context.
//
// Régime mapping :
//   VIX < 18 ET SPY > MA50 → FREE
//   VIX 18-25              → GUIDED
//   VIX > 25 OU SPY < MA50 → STRICT
//   VIX > 35               → PAUSE
//
// Usage : GET /functions/v1/fetch-daily-context (one-shot manual ou via cron)
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FMP_BASE = "https://financialmodelingprep.com";

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

function isoDaysAgo(d: number): string {
  return new Date(Date.now() - d * 86400 * 1000).toISOString().slice(0, 10);
}
function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

async function fmpGet<T>(path: string, params: Record<string, string | number>, key: string): Promise<{ ok: boolean; data?: T; error?: string }> {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) usp.set(k, String(v));
  usp.set("apikey", key);
  try {
    const r = await fetch(`${FMP_BASE}${path}?${usp.toString()}`);
    if (!r.ok) return { ok: false, error: `${r.status}: ${(await r.text()).slice(0, 200)}` };
    return { ok: true, data: await r.json() as T };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

// Jour de bourse ? via le calendrier Alpaca (gère week-ends ET fériés US). Fallback
// permissif si Alpaca indispo (ne bloque pas le fetch).
async function isTradingDay(): Promise<boolean> {
  const base = Deno.env.get("ALPACA_API_BASE_URL");
  const keyId = Deno.env.get("ALPACA_API_KEY_ID");
  const secret = Deno.env.get("ALPACA_API_SECRET_KEY");
  if (!base || !keyId || !secret) return true;
  try {
    const today = isoToday();
    const r = await fetch(`${base}/v2/calendar?start=${today}&end=${today}`, { headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret } });
    if (!r.ok) return true;
    const d = await r.json();
    return Array.isArray(d) && d.length > 0;
  } catch { return true; }
}

type Regime = "FREE" | "GUIDED" | "STRICT" | "PAUSE";
// Hystérésis (diagnostic 26/06) : bande tampon ±1 pt VIX pour éviter le flip-flop
// FREE↔GUIDED↔STRICT jour à jour (whiplash de sizing). Le seuil d'ENTRÉE dans un
// régime est plus strict que celui de SORTIE.
function computeRegime(vix: number | null, spyVsSma50: "above" | "below" | "unknown", prev: Regime | null): Regime {
  if (typeof vix !== "number") return "GUIDED";
  if (vix > 35) return "PAUSE";
  const strictThresh = prev === "STRICT" ? 24 : 25;   // entrer >25, sortir <24
  if (vix > strictThresh || spyVsSma50 === "below") return "STRICT";
  const freeThresh = prev === "FREE" ? 18 : 17;        // entrer <17, rester <18
  if (vix < freeThresh && spyVsSma50 === "above") return "FREE";
  return "GUIDED";
}

function computeSma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  return window.reduce((a, b) => a + b, 0) / period;
}

function extractCloses(historical: unknown): number[] {
  let arr: Array<{ date?: string; close?: number }> = [];
  if (Array.isArray(historical)) arr = historical as typeof arr;
  else if (historical && typeof historical === "object" && "historical" in historical) {
    arr = (historical as { historical: typeof arr }).historical ?? [];
  }
  return arr
    .filter(d => typeof d.close === "number" && d.date)
    .sort((a, b) => (a.date! < b.date! ? -1 : 1))
    .map(d => d.close as number);
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const forced = new URL(req.url).searchParams.get("force") === "true";
  const fmpKey = Deno.env.get("FMP_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!fmpKey || !supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  // Staleness guard (audit D-005) : un jour NON boursier (week-end/férié), FMP renvoie la
  // clôture de la veille → écrire cette ligne périmée fausserait le régime (et donc le
  // sizing) via l'hystérésis. On skip l'upsert (contournable via ?force=true).
  if (!forced && !(await isTradingDay())) {
    return jsonResponse({ ok: true, skipped: "non_trading_day", date: isoToday(), note: "Pas d'upsert (jour non boursier) — évite un contexte périmé." }, 200);
  }

  const errors: Record<string, string> = {};
  const raw: Record<string, unknown> = {};

  // --- Fetch parallèle : VIX quote, SPY quote, SPY 60d history, treasury rates ---
  const [vixR, spyQuoteR, spyHistR, treasuryR] = await Promise.all([
    fmpGet<Array<{ price?: number; changePercentage?: number; changesPercentage?: number }>>(`/stable/quote`, { symbol: "^VIX" }, fmpKey),
    fmpGet<Array<{ price?: number }>>(`/stable/quote`, { symbol: "SPY" }, fmpKey),
    fmpGet<unknown>(`/stable/historical-price-eod/full`, { symbol: "SPY", from: isoDaysAgo(80), to: isoToday() }, fmpKey),
    fmpGet<Array<{ year10?: number; date?: string }>>(`/stable/treasury-rates`, { from: isoDaysAgo(7), to: isoToday() }, fmpKey),
  ]);

  // VIX
  let vix: number | null = null;
  let vixChange: number | null = null;
  if (vixR.ok && Array.isArray(vixR.data) && vixR.data.length > 0) {
    vix = vixR.data[0].price ?? null;
    vixChange = vixR.data[0].changePercentage ?? vixR.data[0].changesPercentage ?? null;
    raw.vix = vixR.data[0];
  } else errors.vix = vixR.error ?? "no_data";

  // SPY price
  let spyPrice: number | null = null;
  if (spyQuoteR.ok && Array.isArray(spyQuoteR.data) && spyQuoteR.data.length > 0) {
    spyPrice = spyQuoteR.data[0].price ?? null;
    raw.spy_quote = spyQuoteR.data[0];
  } else errors.spy_quote = spyQuoteR.error ?? "no_data";

  // SPY SMA50 (compute from 60-80 day history)
  let spySma50: number | null = null;
  if (spyHistR.ok) {
    const closes = extractCloses(spyHistR.data);
    raw.spy_history_n_closes = closes.length;
    spySma50 = computeSma(closes, 50);
  } else errors.spy_history = spyHistR.error ?? "no_data";

  const spyVsSma50: "above" | "below" | "unknown" =
    (typeof spyPrice === "number" && typeof spySma50 === "number")
      ? (spyPrice > spySma50 ? "above" : "below")
      : "unknown";

  // Treasury 10Y (latest in window)
  let treasury10y: number | null = null;
  if (treasuryR.ok && Array.isArray(treasuryR.data) && treasuryR.data.length > 0) {
    const sorted = treasuryR.data
      .filter(r => r.date)
      .sort((a, b) => (a.date! < b.date! ? 1 : -1));  // desc
    treasury10y = sorted[0]?.year10 ?? null;
    raw.treasury = sorted[0];
  } else errors.treasury = treasuryR.error ?? "no_data";

  // --- Compute regime (avec hystérésis sur le régime de la veille) ---
  const { data: prevCtx } = await supabase
    .from("daily_context").select("market_regime")
    .lt("context_date", isoToday())
    .order("context_date", { ascending: false }).limit(1).maybeSingle();
  const prevRegime = (prevCtx?.market_regime ?? null) as Regime | null;
  const regime = computeRegime(vix, spyVsSma50, prevRegime);

  // --- Upsert daily_context (1 row par date) ---
  const today = isoToday();
  const { data: upserted, error: upErr } = await supabase
    .from("daily_context")
    .upsert({
      context_date: today,
      fetched_at: new Date().toISOString(),
      vix,
      vix_change_pct: vixChange,
      spy_price: spyPrice,
      spy_sma50: spySma50,
      spy_vs_sma50: spyVsSma50,
      treasury_10y: treasury10y,
      market_regime: regime,
      raw_data: raw,
      errors: Object.keys(errors).length > 0 ? errors : null,
    }, { onConflict: "context_date" })
    .select("id, context_date, market_regime")
    .single();

  if (upErr) return jsonResponse({ ok: false, error: "upsert_failed", detail: upErr.message }, 500);

  return jsonResponse({
    ok: true,
    duration_ms: Date.now() - t0,
    context_id: upserted?.id,
    context_date: today,
    market_regime: regime,
    snapshot: {
      vix,
      vix_change_pct: vixChange,
      spy_price: spyPrice,
      spy_sma50: spySma50,
      spy_vs_sma50: spyVsSma50,
      treasury_10y: treasury10y,
    },
    regime_logic: {
      pause_trigger: typeof vix === "number" && vix > 35,
      strict_trigger: typeof vix === "number" && (vix > 25 || spyVsSma50 === "below"),
      free_trigger: typeof vix === "number" && vix < 18 && spyVsSma50 === "above",
      fallback_guided: true,
    },
    errors: Object.keys(errors).length > 0 ? errors : null,
  }, 200);
});
