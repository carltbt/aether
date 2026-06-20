-- P1 (diagnostic 18/06) — 2026-06-20
-- Suivi du pic de prix par position : nécessaire au trailing stop fin et à la
-- règle give-back (sortie si on rend la moitié du pic de gain) d'update-positions v2.
-- Appliqué via MCP apply_migration.
ALTER TABLE public.positions ADD COLUMN IF NOT EXISTS peak_price numeric;
UPDATE public.positions SET peak_price = entry_price WHERE peak_price IS NULL;
