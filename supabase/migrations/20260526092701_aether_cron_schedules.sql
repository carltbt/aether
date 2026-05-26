-- ============================================================================
-- Aether — pg_cron schedules (Phase 4 step 16+)
-- ============================================================================
-- Source : STRATEGY.md v2.7 Section 4 scheduler block
--
-- Schedules :
--   1. fetch-daily-context   : lun-ven 10h30 UTC (30 min avant analyse)
--   2. run-daily-analysis    : lun-ven 11h00 UTC ⚠️ DRY_RUN par défaut
--   3. update-positions      : lun-ven 13h/17h/21h UTC (toutes les 4h)
--   4. run-eod-digest        : lun-ven 20h15 UTC
--   5. run-screener          : dim 0h UTC
--   6. run-strategy-loop     : dim 1h UTC
--
-- Tous utilisent net.http_get / net.http_post (pg_net).
-- Fonctions verify_jwt=false → pas d'auth header requis.
-- ============================================================================

-- 1. fetch-daily-context — lun-ven 10h30 UTC
SELECT cron.schedule(
  'aether-fetch-daily-context',
  '30 10 * * 1-5',
  $$
  SELECT net.http_get(
    url := 'https://rhqtjzlwkjwetneqdvkv.supabase.co/functions/v1/fetch-daily-context'
  );
  $$
);

-- 2. run-daily-analysis — lun-ven 11h00 UTC, DRY_RUN par défaut (V1 safety)
SELECT cron.schedule(
  'aether-daily-analysis',
  '0 11 * * 1-5',
  $$
  SELECT net.http_get(
    url := 'https://rhqtjzlwkjwetneqdvkv.supabase.co/functions/v1/run-daily-analysis?dry_run=true&limit=10'
  );
  $$
);

-- 3. update-positions — lun-ven 13h/17h/21h UTC (3x dans la journée trading)
SELECT cron.schedule(
  'aether-update-positions',
  '0 13,17,21 * * 1-5',
  $$
  SELECT net.http_get(
    url := 'https://rhqtjzlwkjwetneqdvkv.supabase.co/functions/v1/update-positions'
  );
  $$
);

-- 4. run-eod-digest — lun-ven 20h15 UTC (16h15 ET, après clôture)
SELECT cron.schedule(
  'aether-eod-digest',
  '15 20 * * 1-5',
  $$
  SELECT net.http_get(
    url := 'https://rhqtjzlwkjwetneqdvkv.supabase.co/functions/v1/run-eod-digest'
  );
  $$
);

-- 5. run-screener — dim 0h UTC (samedi 20h ET / dim minuit ET)
SELECT cron.schedule(
  'aether-screener',
  '0 0 * * 0',
  $$
  SELECT net.http_get(
    url := 'https://rhqtjzlwkjwetneqdvkv.supabase.co/functions/v1/run-screener'
  );
  $$
);

-- 6. run-strategy-loop — dim 1h UTC (1h après screener)
SELECT cron.schedule(
  'aether-strategy-loop',
  '0 1 * * 0',
  $$
  SELECT net.http_get(
    url := 'https://rhqtjzlwkjwetneqdvkv.supabase.co/functions/v1/run-strategy-loop'
  );
  $$
);
