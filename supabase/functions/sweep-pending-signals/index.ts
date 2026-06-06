// ============================================================================
// Aether — sweep-pending-signals Edge Function (rattrapage orphelins)
// ============================================================================
// PROBLÈME (Honnêteté #2) : run-daily-analysis traite les actions par batches.
// Si un batch tape le rate-limit Anthropic (429) ou le timeout Edge, le pipeline
// d'une action est coupé APRÈS le Trader mais AVANT le Reviewer → la ligne reste
// action='BUY', reviewer_verdict='PENDING'. Elle ne s'exécute jamais et personne
// ne la rattrape = trade manqué silencieux.
//
// SOLUTION : balayer les orphelins du JOUR (BUY + PENDING) et relancer
// decide-and-execute pour chacun (qui ré-exécute researchers→trader→reviewer→
// validate→execute avec des données fraîches). Séquentiel + délai pour rester
// sous le rate-limit. Idempotent : le dedup de validate-order empêche un doublon
// si la position a finalement été ouverte entre-temps.
//
// Garde-fous :
//   - LOOKBACK_HOURS=6  → ne rattrape QUE les orphelins du jour (pas les thèses
//     périmées d'hier).
//   - MIN_AGE_MIN=10    → ne touche pas un run encore en cours.
//
// Cron : 45 14 * * 1-5 (45 min après l'analyse de 14:00 UTC, marché ouvert).
// Usage manuel : GET ?dry_run=true pour simuler, ?lookback_hours=N.
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const LOOKBACK_HOURS = 6;
const MIN_AGE_MIN = 10;
const DELAY_MS = 1500;

function jsonResponse(b: unknown, s: number) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

interface Orphan { id: string; ticker: string; conviction: number | null; created_at: string; }

async function postDiscord(text: string) {
  const url = Deno.env.get("DISCORD_WEBHOOK_URL");
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
  } catch { /* best-effort */ }
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "true";
  const lookbackHours = parseInt(url.searchParams.get("lookback_hours") ?? String(LOOKBACK_HOURS), 10) || LOOKBACK_HOURS;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  const sinceIso = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();
  const beforeIso = new Date(Date.now() - MIN_AGE_MIN * 60 * 1000).toISOString();

  // --- Trouver les orphelins : BUY laissé en PENDING par un run tronqué ---
  const { data: orphansData, error: qErr } = await supabase
    .from("signals")
    .select("id, ticker, conviction, created_at")
    .eq("action", "BUY")
    .eq("reviewer_verdict", "PENDING")
    .gte("created_at", sinceIso)
    .lt("created_at", beforeIso)
    .order("created_at", { ascending: true });

  if (qErr) return jsonResponse({ ok: false, error: "query_failed", detail: qErr.message }, 500);
  const orphans = (orphansData ?? []) as Orphan[];

  if (orphans.length === 0) {
    return jsonResponse({
      ok: true, mode: dryRun ? "dry_run" : "live", orphans_found: 0,
      note: "no orphan BUY/PENDING in window", window_hours: lookbackHours, duration_ms: Date.now() - t0,
    }, 200);
  }

  // --- Relancer decide-and-execute pour chaque orphelin (séquentiel) ---
  const results: Array<Record<string, unknown>> = [];
  for (const o of orphans) {
    try {
      const r = await fetch(
        `${supabaseUrl}/functions/v1/decide-and-execute?signal_id=${o.id}&dry_run=${dryRun}`,
      );
      const d = await r.json().catch(() => null) as Record<string, unknown> | null;
      results.push({
        ticker: o.ticker, signal_id: o.id, http_ok: r.ok,
        final_decision: d?.final_decision, pipeline_stopped_at: d?.pipeline_stopped_at,
        reason: d?.reason,
      });
    } catch (e) {
      results.push({ ticker: o.ticker, signal_id: o.id, http_ok: false, error: String((e as Error).message ?? e) });
    }
    await sleep(DELAY_MS);
  }

  // --- Recompter les orphelins restants (échecs de rattrapage) ---
  const { count: remaining } = await supabase
    .from("signals")
    .select("id", { count: "exact", head: true })
    .eq("action", "BUY")
    .eq("reviewer_verdict", "PENDING")
    .gte("created_at", sinceIso)
    .lt("created_at", beforeIso);

  const rescued = results.filter(r => r.http_ok && r.final_decision && r.final_decision !== "HOLD").length;
  const stillPending = remaining ?? 0;
  const status: "ok" | "partial_error" = stillPending === 0 ? "ok" : "partial_error";

  // --- Heartbeat ---
  await supabase.from("system_heartbeats").insert({
    status,
    cycles_completed: 1,
    stocks_analyzed: orphans.length,
    trades_executed: dryRun ? 0 : rescued,
    errors: stillPending > 0 ? [{ step: "sweep", error: `${stillPending}_orphans_still_pending` }] : null,
    notes: `sweep-pending-signals ${dryRun ? "DRY_RUN" : "LIVE"} | found=${orphans.length} | rescued=${rescued} | still_pending=${stillPending}`,
  });

  // --- Alerte si rattrapage incomplet ---
  if (stillPending > 0 && !dryRun) {
    await postDiscord(`⚠️ Aether sweep: ${stillPending} orphelin(s) BUY/PENDING non rattrapé(s) — investiguer le pipeline.`);
  }

  return jsonResponse({
    ok: status === "ok",
    mode: dryRun ? "dry_run" : "live",
    orphans_found: orphans.length,
    rescued,
    still_pending: stillPending,
    window_hours: lookbackHours,
    results,
    duration_ms: Date.now() - t0,
  }, 200);
});
