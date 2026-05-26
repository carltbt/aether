-- ============================================================================
-- Aether — activation pg_cron + pg_net pour Phase 4 scheduler
-- ============================================================================
-- pg_cron : exécuter des jobs schedulés en SQL (daily-analysis, position-update, etc.)
-- pg_net  : appels HTTP async depuis SQL (pour invoquer nos Edge Functions depuis cron)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
