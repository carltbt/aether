-- P0/P1/P2 (diagnostic 18/06) — 2026-06-20 — appliqué via MCP (cron.schedule idempotent par nom).
-- 1. update-positions : cadence 1×/séance → toutes les 30 min en séance (protection des stops).
SELECT cron.schedule(
  'aether-update-positions',
  '*/30 13-20 * * 1-5',
  $$ SELECT net.http_get(url := 'https://rhqtjzlwkjwetneqdvkv.supabase.co/functions/v1/update-positions'); $$
);
-- 2. review-positions (P2) : revue LLM quotidienne des positions tenues (sortie si thèse cassée).
SELECT cron.schedule(
  'aether-review-positions',
  '15 15 * * 1-5',
  $$ SELECT net.http_get(url := 'https://rhqtjzlwkjwetneqdvkv.supabase.co/functions/v1/review-positions'); $$
);
