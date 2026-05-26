-- ============================================================================
-- Aether — optimisation RLS perf + index FK manquant
-- Source : Supabase advisor (auth_rls_initplan WARN + unindexed_foreign_keys)
-- ============================================================================
-- Fixes appliqués :
--   1. Index sur positions.signal_id (couvre la FK, accélère les DELETE/UPDATE)
--   2. Réécriture des 7 policies RLS avec (SELECT auth.jwt()) pour que
--      PostgreSQL n'évalue le JWT qu'une fois par query, pas une fois par row.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Index FK manquant
-- ----------------------------------------------------------------------------
CREATE INDEX idx_positions_signal_id ON public.positions (signal_id);


-- ----------------------------------------------------------------------------
-- 2. Recréer les 7 policies RLS avec (SELECT auth.jwt())
-- ----------------------------------------------------------------------------
-- Pattern initPlan : remplacer  auth.jwt() ->> 'email'
--               par  (SELECT auth.jwt() ->> 'email')
-- → PostgreSQL planifie l'auth check comme un initPlan exécuté une seule fois,
--   pas comme une expression ré-évaluée pour chaque row scannée.

DROP POLICY "admin_full_access" ON public.watchlist;
CREATE POLICY "admin_full_access" ON public.watchlist
  FOR ALL TO authenticated
  USING      ((SELECT auth.jwt() ->> 'email') = 'aether.trader.project@gmail.com')
  WITH CHECK ((SELECT auth.jwt() ->> 'email') = 'aether.trader.project@gmail.com');

DROP POLICY "admin_full_access" ON public.signals;
CREATE POLICY "admin_full_access" ON public.signals
  FOR ALL TO authenticated
  USING      ((SELECT auth.jwt() ->> 'email') = 'aether.trader.project@gmail.com')
  WITH CHECK ((SELECT auth.jwt() ->> 'email') = 'aether.trader.project@gmail.com');

DROP POLICY "admin_full_access" ON public.positions;
CREATE POLICY "admin_full_access" ON public.positions
  FOR ALL TO authenticated
  USING      ((SELECT auth.jwt() ->> 'email') = 'aether.trader.project@gmail.com')
  WITH CHECK ((SELECT auth.jwt() ->> 'email') = 'aether.trader.project@gmail.com');

DROP POLICY "admin_full_access" ON public.strategies;
CREATE POLICY "admin_full_access" ON public.strategies
  FOR ALL TO authenticated
  USING      ((SELECT auth.jwt() ->> 'email') = 'aether.trader.project@gmail.com')
  WITH CHECK ((SELECT auth.jwt() ->> 'email') = 'aether.trader.project@gmail.com');

DROP POLICY "admin_full_access" ON public.agent_logs;
CREATE POLICY "admin_full_access" ON public.agent_logs
  FOR ALL TO authenticated
  USING      ((SELECT auth.jwt() ->> 'email') = 'aether.trader.project@gmail.com')
  WITH CHECK ((SELECT auth.jwt() ->> 'email') = 'aether.trader.project@gmail.com');

DROP POLICY "admin_full_access" ON public.portfolio_snapshots;
CREATE POLICY "admin_full_access" ON public.portfolio_snapshots
  FOR ALL TO authenticated
  USING      ((SELECT auth.jwt() ->> 'email') = 'aether.trader.project@gmail.com')
  WITH CHECK ((SELECT auth.jwt() ->> 'email') = 'aether.trader.project@gmail.com');

DROP POLICY "admin_full_access" ON public.system_heartbeats;
CREATE POLICY "admin_full_access" ON public.system_heartbeats
  FOR ALL TO authenticated
  USING      ((SELECT auth.jwt() ->> 'email') = 'aether.trader.project@gmail.com')
  WITH CHECK ((SELECT auth.jwt() ->> 'email') = 'aether.trader.project@gmail.com');
