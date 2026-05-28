-- ============================================================================
-- Aether — shadow_positions table (α — what would have happened)
-- ============================================================================
-- Track les "trades fantômes" : pour chaque signal Trader=BUY (même si Reviewer
-- REJECT), on simule l'entrée comme si on avait exécuté + on track exits selon
-- mêmes règles que update-positions. Permet de mesurer empiriquement si le
-- Reviewer est trop strict ou correct.
-- ============================================================================

CREATE TABLE public.shadow_positions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker              TEXT NOT NULL,
  signal_id           UUID REFERENCES public.signals(id) ON DELETE SET NULL,
  opened_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at           TIMESTAMPTZ,
  entry_price         NUMERIC NOT NULL,
  exit_price          NUMERIC,
  quantity            NUMERIC NOT NULL,
  position_size_usd   NUMERIC,
  stop_loss_price     NUMERIC,
  take_profit_price   NUMERIC,
  status              TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  exit_reason         TEXT,
  pnl_usd             NUMERIC,
  pnl_pct             NUMERIC,
  hold_days           INTEGER,
  -- Métadonnées pour comparer vs réalité
  was_reviewer_approved BOOLEAN NOT NULL,  -- true = aurait été exécuté en live, false = bloqué par Reviewer
  trader_conviction     INTEGER,
  trader_action         TEXT,
  reviewer_verdict      TEXT
);

CREATE INDEX idx_shadow_status ON public.shadow_positions (status, ticker);
CREATE INDEX idx_shadow_open ON public.shadow_positions (opened_at DESC) WHERE status = 'OPEN';
CREATE INDEX idx_shadow_closed ON public.shadow_positions (closed_at DESC) WHERE status = 'CLOSED';
CREATE UNIQUE INDEX idx_shadow_one_open_per_ticker ON public.shadow_positions (ticker) WHERE status = 'OPEN';

ALTER TABLE public.shadow_positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_full_access" ON public.shadow_positions
  FOR ALL TO authenticated
  USING      ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com')
  WITH CHECK ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com');
