// ============================================================================
// Aether — run-screener Edge Function
// ============================================================================
// Source : STRATEGY.md v2.7 Section 2 (Univers) + Section 13 Phase 1 / Étape 4
//
// Rôle : peupler/rafraîchir la table watchlist depuis le screener FMP.
//
// Logique :
//   1. Appelle FMP /stable/company-screener avec les 6 filtres de Section 2
//   2. Calcule diff vs current watchlist (added / updated / removed)
//   3. Upsert les nouveaux + actifs (préserve added_at)
//   4. Marque is_active=false ceux qui ne matchent plus
//   5. Retourne récap pour le dashboard / monitoring
//
// Exécuté manuellement pour l'instant. Sera planifié via pg_cron en Phase 4
// (dimanche 19h ET = lundi 0h UTC, cf. STRATEGY.md Section 4 scheduler block).
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// --- Filtres STRATEGY.md Section 2 ----------------------------------------
const SCREENER_PARAMS = {
  marketCapMoreThan: 2_000_000_000,    // 2B USD
  marketCapLowerThan: 20_000_000_000,  // 20B USD
  volumeMoreThan: 500_000,             // 500K shares/jour
  betaMoreThan: 0.7,
  betaLowerThan: 1.8,
  exchange: "NYSE,NASDAQ",
  // FMP utilise "Consumer Cyclical" pour ce que GICS nomme "Consumer Discretionary"
  sector: "Technology,Healthcare,Industrials,Consumer Cyclical",
  country: "US",
  isActivelyTrading: true,
  isEtf: false,
  isFund: false,
  limit: 1000,
};

interface FmpScreenerRow {
  symbol: string;
  companyName?: string;
  marketCap?: number;
  sector?: string;
  industry?: string;
  beta?: number;
  price?: number;
  volume?: number;
  exchange?: string;
  exchangeShortName?: string;
  country?: string;
  isActivelyTrading?: boolean;
  isEtf?: boolean;
  isFund?: boolean;
}

async function fetchScreener(apiKey: string): Promise<FmpScreenerRow[]> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(SCREENER_PARAMS)) {
    params.set(k, String(v));
  }
  params.set("apikey", apiKey);

  const url = `https://financialmodelingprep.com/stable/company-screener?${params.toString()}`;
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`FMP screener returned ${r.status}: ${(await r.text()).slice(0, 500)}`);
  }
  const data = await r.json();
  if (!Array.isArray(data)) {
    throw new Error(`FMP screener returned non-array: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

Deno.serve(async () => {
  const t0 = Date.now();

  const fmpKey = Deno.env.get("FMP_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!fmpKey || !supabaseUrl || !serviceKey) {
    return jsonResponse(
      { ok: false, error: "missing_env_vars", required: ["FMP_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] },
      500,
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // === 1. Fetch FMP screener ===
    const screened = await fetchScreener(fmpKey);
    if (screened.length === 0) {
      // Safety : ne PAS marquer la watchlist comme inactive sur un résultat vide
      // (peut être une glitch FMP transiente). On échoue explicitement.
      return jsonResponse({ ok: false, error: "empty_screener_result", duration_ms: Date.now() - t0 }, 500);
    }

    // Sanity check — STRATEGY.md attend ~150-200. Hors fourchette = à investiguer.
    const sanity_warning =
      screened.length < 50 ? "LOW: <50 results, filters may be too tight" :
      screened.length > 500 ? "HIGH: >500 results, filters may be too loose" :
      null;

    // === 2. Build rows pour upsert ===
    const rows = screened
      .filter(s => s.symbol)
      .map(s => ({
        symbol: s.symbol,
        name: s.companyName ?? null,
        sector: s.sector ?? null,
        market_cap: s.marketCap ?? null,
        avg_volume: s.volume ?? null,
        beta: s.beta ?? null,
        is_active: true,
        // added_at non spécifié → DEFAULT NOW() pour nouvelles rows,
        // préservé pour rows existantes (upsert ne touche que les fields fournis)
      }));

    // === 3. Diff vs current active set ===
    const { data: currentActiveData, error: selectErr } = await supabase
      .from("watchlist")
      .select("symbol")
      .eq("is_active", true);
    if (selectErr) throw selectErr;

    const currentSet = new Set((currentActiveData ?? []).map(r => r.symbol));
    const newSet = new Set(rows.map(r => r.symbol));

    const toRemove = [...currentSet].filter(s => !newSet.has(s));
    const added = rows.filter(r => !currentSet.has(r.symbol)).length;
    const updated = rows.length - added;

    // === 4. Mark removed first ===
    if (toRemove.length > 0) {
      const { error: removeErr } = await supabase
        .from("watchlist")
        .update({ is_active: false })
        .in("symbol", toRemove);
      if (removeErr) throw removeErr;
    }

    // === 5. Upsert new + updated (re-actives any previously removed that came back) ===
    const { error: upsertErr } = await supabase
      .from("watchlist")
      .upsert(rows, { onConflict: "symbol" });
    if (upsertErr) throw upsertErr;

    return jsonResponse(
      {
        ok: true,
        total_screened: screened.length,
        total_active_now: rows.length,
        added,
        updated,
        removed: toRemove.length,
        sanity_warning,
        sample_first_5: rows.slice(0, 5).map(r => ({
          symbol: r.symbol,
          name: r.name,
          sector: r.sector,
          market_cap: r.market_cap,
        })),
        duration_ms: Date.now() - t0,
      },
      200,
    );
  } catch (e) {
    return jsonResponse(
      { ok: false, error: String((e as Error).message ?? e), duration_ms: Date.now() - t0 },
      500,
    );
  }
});
