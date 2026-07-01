// ============================================================================
// Aether — snapshot-features Edge Function (as-of feature store, LLM-free)
// ============================================================================
// Stocke CHAQUE JOUR, pour toute la watchlist active, les features point-in-time
// qui révisent/décaient et ne sont PAS reconstructibles depuis l'OHLC historique
// (fondamentaux, scores, DCF, valorisation) + le prix d'ancrage. raw jsonb =
// capture maximale (réponses FMP brutes). But : dataset as-of propre pour
// backtester l'edge dans ~6 mois sans look-ahead.
//
// Pas de LLM → quasi gratuit. ~4 appels FMP / ticker, par batches.
// Usage : GET /functions/v1/snapshot-features?limit=400&offset=0
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CHUNK = 8;
const BATCH_DELAY_MS = 3500;   // throttle FMP : 8 tickers × 6 calls / 3.5s ≈ 14 req/s (sous le rate-limit Premium)
const FMP = "https://financialmodelingprep.com/stable";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fmpArr(path: string, symbol: string, key: string): Promise<unknown[]> {
  try {
    const r = await fetch(`${FMP}/${path}?symbol=${symbol}&apikey=${key}`);
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}
function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return typeof n === "number" && !isNaN(n) ? n : null;
}
// ROE dérivé = résultat net/action ÷ capitaux propres/action (fraction, ex. 0.126).
// null si capitaux propres ≤ 0 (ROE non significatif en equity négative).
function roeFrom(nips: number | null, seps: number | null): number | null {
  if (nips === null || seps === null || seps <= 0) return null;
  return Math.round((nips / seps) * 10000) / 10000;
}

async function fmpOne(path: string, symbol: string, key: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${FMP}/${path}?symbol=${symbol}&apikey=${key}`);
    if (!r.ok) return null;
    const d = await r.json();
    const row = Array.isArray(d) ? d[0] : d;
    return (row && typeof row === "object") ? row as Record<string, unknown> : null;
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") ?? "500", 10) || 500;
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10) || 0;

  const fmpKey = Deno.env.get("FMP_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!fmpKey || !supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: wl, error: wlErr } = await supabase
    .from("watchlist").select("symbol, sector").eq("is_active", true)
    .order("symbol").range(offset, offset + limit - 1);
  if (wlErr) return jsonResponse({ ok: false, error: "watchlist_failed", detail: wlErr.message }, 500);
  const universe = wl ?? [];
  if (universe.length === 0) return jsonResponse({ ok: true, note: "empty_universe", offset }, 200);

  const today = new Date().toISOString().slice(0, 10);
  const rows: Record<string, unknown>[] = [];
  let okCount = 0, failCount = 0;

  for (let c = 0; c < universe.length; c += CHUNK) {
    const chunk = universe.slice(c, c + CHUNK);
    await Promise.all(chunk.map(async (w) => {
      const sym = w.symbol as string;
      const [q, fs, dcf, rt, insider, grades] = await Promise.all([
        fmpOne("quote", sym, fmpKey),
        fmpOne("financial-scores", sym, fmpKey),
        fmpOne("discounted-cash-flow", sym, fmpKey),
        fmpOne("ratios-ttm", sym, fmpKey),
        fmpArr("insider-trading/search", sym, fmpKey),   // C3 smart money (as-of)
        fmpArr("grades-historical", sym, fmpKey),         // C1/C6 upgrades-downgrades (as-of)
      ]);
      if (!q && !fs && !dcf && !rt) { failCount++; return; }
      okCount++;

      const price = num(q?.price);
      const dcfVal = num(dcf?.dcf);
      const dcfPrice = num(dcf?.["Stock Price"]) ?? price;
      const dcfUpside = (dcfVal !== null && dcfPrice && dcfPrice > 0) ? ((dcfVal - dcfPrice) / dcfPrice) * 100 : null;

      rows.push({
        snapshot_date: today,
        ticker: sym,
        sector: w.sector ?? null,
        price,
        volume: num(q?.volume),
        market_cap: num(q?.marketCap),
        pe: num(q?.pe) ?? num(rt?.priceToEarningsRatioTTM),
        dcf: dcfVal,
        dcf_upside_pct: dcfUpside !== null ? Math.round(dcfUpside * 100) / 100 : null,
        altman_z: num(fs?.altmanZScore),
        piotroski: num(fs?.piotroskiScore),
        ev_ebitda: num(rt?.enterpriseValueMultipleTTM) ?? num(rt?.evToEBITDATTM) ?? num(rt?.enterpriseValueOverEBITDATTM),
        pb: num(rt?.priceToBookRatioTTM) ?? num(rt?.pbRatioTTM),
        // ROE : ratios-ttm n'expose PAS returnOnEquityTTM (champ absent → 100% NULL avant
        // le fix 01/07). On dérive depuis deux champs présents : BPA / capitaux propres/action.
        roe: roeFrom(num(rt?.netIncomePerShareTTM), num(rt?.shareholdersEquityPerShareTTM)),
        net_margin: num(rt?.netProfitMarginTTM),
        year_high: num(q?.yearHigh),
        year_low: num(q?.yearLow),
        raw: { quote: q, scores: fs, dcf, ratios: rt, insider: insider.slice(0, 15), grades: grades.slice(0, 15) },
      });
    }));
    if (c + CHUNK < universe.length) await sleep(BATCH_DELAY_MS);  // throttle entre batches
  }

  // Upsert en masse (idempotent par (snapshot_date, ticker))
  let upserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const { error } = await supabase.from("feature_snapshots").upsert(batch, { onConflict: "snapshot_date,ticker" });
    if (error) console.error("upsert batch failed:", error.message);
    else upserted += batch.length;
  }

  await supabase.from("system_heartbeats").insert({
    status: failCount > okCount ? "partial_error" : "ok",
    cycles_completed: 1, stocks_analyzed: universe.length,
    notes: `snapshot-features | date=${today} | universe=${universe.length} | ok=${okCount} fail=${failCount} | upserted=${upserted}`,
  });

  return jsonResponse({
    ok: true, snapshot_date: today,
    universe: universe.length, fetched_ok: okCount, fetched_fail: failCount, upserted,
    offset, limit, duration_ms: Date.now() - t0,
  }, 200);
});
