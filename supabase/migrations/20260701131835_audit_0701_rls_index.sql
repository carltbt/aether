-- Remédiation audit complet 01/07 (partie schéma — appliquée via MCP apply_migration).
-- 1. feature_snapshots : policy admin canonique (cohérence RLS avec les 9 autres tables).
CREATE POLICY admin_full_access ON public.feature_snapshots
  FOR ALL USING ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com');
-- 2. FK non indexée relevée par l'advisor : shadow_positions.signal_id.
CREATE INDEX IF NOT EXISTS idx_shadow_signal_id ON public.shadow_positions (signal_id);

-- Companion ops appliquées le même jour via execute_sql (idempotentes, notées ici pour repro) :
--   • Cron aether-update-positions ré-planifié '*/30 13-20' → '*/30 13-21' (couvre la clôture EST/hiver).
--     SELECT cron.schedule('aether-update-positions','*/30 13-21 * * 1-5',
--       $$ SELECT net.http_get(url := 'https://rhqtjzlwkjwetneqdvkv.supabase.co/functions/v1/update-positions'); $$);
--   • Backfill feature_snapshots.roe (champ FMP returnOnEquityTTM absent → dérivé) :
--     UPDATE feature_snapshots SET roe = round((raw->'ratios'->>'netIncomePerShareTTM')::numeric
--       / NULLIF((raw->'ratios'->>'shareholdersEquityPerShareTTM')::numeric,0), 4)
--     WHERE roe IS NULL AND (raw->'ratios'->>'shareholdersEquityPerShareTTM')::numeric > 0;
