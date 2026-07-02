-- P-006 (audit D-005c) : conviction ré-évaluée hebdo stockée sur la position.
ALTER TABLE public.positions
  ADD COLUMN IF NOT EXISTS reeval_conviction integer,
  ADD COLUMN IF NOT EXISTS reeval_at timestamptz;

-- Cron : re-éval hebdo des positions (dimanche 23:00 UTC). Appliqué via execute_sql,
-- noté ici pour repro. Idempotent par nom.
--   SELECT cron.schedule('aether-reevaluate-positions', '0 23 * * 0',
--     $$ SELECT net.http_get(url := 'https://rhqtjzlwkjwetneqdvkv.supabase.co/functions/v1/reevaluate-positions', timeout_milliseconds := 180000); $$);
