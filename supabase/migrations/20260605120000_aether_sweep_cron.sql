-- P2 fix (Honnêteté #2) — 2026-06-05
-- Cron de rattrapage des orphelins : signals BUY laissés en reviewer_verdict=PENDING
-- par un pipeline tronqué (429 / timeout). Tourne 45 min après l'analyse de 14:00 UTC.
-- Appliqué via MCP (cron.schedule est idempotent par nom de job).
SELECT cron.schedule(
  'aether-sweep-pending',
  '45 14 * * 1-5',
  $$
  SELECT net.http_get(
    url := 'https://rhqtjzlwkjwetneqdvkv.supabase.co/functions/v1/sweep-pending-signals'
  );
  $$
);
