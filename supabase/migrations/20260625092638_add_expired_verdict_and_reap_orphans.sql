-- Audit 2026-06-25 — état terminal EXPIRED pour les orphelins BUY/PENDING jamais
-- rattrapés (thèse périmée). Appliqué via MCP apply_migration.
ALTER TABLE public.signals DROP CONSTRAINT signals_reviewer_verdict_check;
ALTER TABLE public.signals ADD CONSTRAINT signals_reviewer_verdict_check
  CHECK (reviewer_verdict = ANY (ARRAY['APPROVE'::text, 'REJECT'::text, 'PENDING'::text, 'EXPIRED'::text]));

UPDATE public.signals SET reviewer_verdict='EXPIRED'
WHERE action='BUY' AND reviewer_verdict='PENDING' AND created_at < NOW() - INTERVAL '24 hours';
