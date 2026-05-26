-- ============================================================================
-- Aether — passage des policies RLS à la forme canonique Supabase
-- Source : Supabase docs RLS performance
--   https://supabase.com/docs/guides/database/postgres/row-level-security
--   #call-functions-with-select
-- ============================================================================
-- Migration précédente : (SELECT auth.jwt() ->> 'email')  → fonctionne mais
--                        ne matche pas le pattern attendu par le linter.
-- Forme canonique     : (SELECT auth.jwt()) ->> 'email'   → SELECT autour de
--                        l'appel de fonction uniquement, opération JSON après.
-- ============================================================================

DROP POLICY "admin_full_access" ON public.watchlist;
CREATE POLICY "admin_full_access" ON public.watchlist
  FOR ALL TO authenticated
  USING      ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com')
  WITH CHECK ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com');

DROP POLICY "admin_full_access" ON public.signals;
CREATE POLICY "admin_full_access" ON public.signals
  FOR ALL TO authenticated
  USING      ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com')
  WITH CHECK ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com');

DROP POLICY "admin_full_access" ON public.positions;
CREATE POLICY "admin_full_access" ON public.positions
  FOR ALL TO authenticated
  USING      ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com')
  WITH CHECK ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com');

DROP POLICY "admin_full_access" ON public.strategies;
CREATE POLICY "admin_full_access" ON public.strategies
  FOR ALL TO authenticated
  USING      ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com')
  WITH CHECK ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com');

DROP POLICY "admin_full_access" ON public.agent_logs;
CREATE POLICY "admin_full_access" ON public.agent_logs
  FOR ALL TO authenticated
  USING      ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com')
  WITH CHECK ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com');

DROP POLICY "admin_full_access" ON public.portfolio_snapshots;
CREATE POLICY "admin_full_access" ON public.portfolio_snapshots
  FOR ALL TO authenticated
  USING      ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com')
  WITH CHECK ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com');

DROP POLICY "admin_full_access" ON public.system_heartbeats;
CREATE POLICY "admin_full_access" ON public.system_heartbeats
  FOR ALL TO authenticated
  USING      ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com')
  WITH CHECK ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com');
