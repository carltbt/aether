-- ============================================================================
-- Aether — initial schema (Phase 1 / Étape 1)
-- Source : STRATEGY.md v2.7, Section 10
-- 7 tables + indexes + RLS (pattern admin unique)
-- ============================================================================
-- Note : cette migration n'inclut PAS les routines pg_cron (Section 4).
-- Elles viendront en Phase 4 du build une fois les Edge Functions déployées.
-- pg_cron doit également être activé au niveau du projet Supabase (Dashboard
-- → Database → Extensions) avant de pouvoir CREATE EXTENSION pg_cron.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. watchlist — univers de stocks (rebuild chaque dimanche par run_screener)
-- ----------------------------------------------------------------------------
CREATE TABLE public.watchlist (
  symbol      TEXT PRIMARY KEY,
  name        TEXT,
  sector      TEXT,
  market_cap  BIGINT,
  avg_volume  BIGINT,
  beta        NUMERIC,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX idx_watchlist_active ON public.watchlist (is_active) WHERE is_active = TRUE;
CREATE INDEX idx_watchlist_sector ON public.watchlist (sector);


-- ----------------------------------------------------------------------------
-- 2. signals — décisions générées par le pipeline Claude (7 appels/stock)
-- ----------------------------------------------------------------------------
CREATE TABLE public.signals (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ticker               TEXT NOT NULL,
  action               TEXT NOT NULL CHECK (action IN ('BUY', 'SELL', 'HOLD')),
  conviction           INTEGER CHECK (conviction BETWEEN 0 AND 100),
  position_size_pct    NUMERIC,
  entry_price_target   NUMERIC,
  stop_loss_pct        NUMERIC,
  take_profit_pct      NUMERIC,
  strategy_used        TEXT,
  rationale            TEXT,
  key_risks            JSONB,
  hold_days_estimate   INTEGER,
  -- Scores détaillés (6 clusters)
  score_c1_earnings    NUMERIC,
  score_c2_momentum    NUMERIC,
  score_c3_smart_money NUMERIC,
  score_c4_quality     NUMERIC,
  score_c5_valuation   NUMERIC,
  score_c6_sentiment   NUMERIC,
  -- Contexte macro au moment du signal
  vix_at_signal        NUMERIC,
  market_regime        TEXT,
  -- Validation pipeline
  reviewer_verdict     TEXT CHECK (reviewer_verdict IN ('APPROVE', 'REJECT', 'PENDING')),
  code_validation      TEXT,
  executed             BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_signals_created        ON public.signals (created_at DESC);
CREATE INDEX idx_signals_ticker_created ON public.signals (ticker, created_at DESC);
CREATE INDEX idx_signals_action         ON public.signals (action, created_at DESC);
CREATE INDEX idx_signals_unexecuted     ON public.signals (created_at DESC) WHERE executed = FALSE;


-- ----------------------------------------------------------------------------
-- 3. positions — positions Alpaca (mémoire des trades ouverts/fermés)
-- ----------------------------------------------------------------------------
CREATE TABLE public.positions (
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
  alpaca_order_id     TEXT,
  status              TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
  exit_reason         TEXT,  -- 'stop_loss' | 'take_profit' | 'signal' | 'timeout' | 'manual' | 'gap_overnight'
  pnl_usd             NUMERIC,
  pnl_pct             NUMERIC,
  hold_days           INTEGER
);

CREATE INDEX idx_positions_status ON public.positions (status, ticker);
CREATE INDEX idx_positions_open   ON public.positions (opened_at DESC) WHERE status = 'OPEN';
CREATE INDEX idx_positions_closed ON public.positions (closed_at DESC) WHERE status = 'CLOSED';
CREATE INDEX idx_positions_ticker ON public.positions (ticker, opened_at DESC);


-- ----------------------------------------------------------------------------
-- 4. strategies — stratégie hebdomadaire (Strategy Loop du dimanche)
-- ----------------------------------------------------------------------------
CREATE TABLE public.strategies (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_number           INTEGER NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cluster_weights       JSONB NOT NULL,
  preferred_strategies  JSONB,
  sector_bias           JSONB,
  risk_adjustment       NUMERIC NOT NULL DEFAULT 1.0,
  strategy_text         TEXT,
  rationale             TEXT,
  -- Performance associée à la semaine
  portfolio_return_pct  NUMERIC,
  universe_return_pct   NUMERIC,
  alpha_pct             NUMERIC
);

CREATE UNIQUE INDEX idx_strategies_week    ON public.strategies (week_number);
CREATE INDEX        idx_strategies_created ON public.strategies (created_at DESC);


-- ----------------------------------------------------------------------------
-- 5. agent_logs — trace de chaque appel Claude (coût, latence, output)
-- ----------------------------------------------------------------------------
CREATE TABLE public.agent_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  log_type       TEXT NOT NULL,  -- 'analysis_pass1' | 'analysis_pass2' | 'analysis_pass3'
                                 -- | 'researcher_bull' | 'researcher_bear'
                                 -- | 'decision' | 'reviewer' | 'strategy_loop'
  ticker         TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  latency_ms     INTEGER,
  cost_usd       NUMERIC,
  raw_output     JSONB,
  error          TEXT
);

CREATE INDEX idx_agent_logs_created     ON public.agent_logs (created_at DESC);
CREATE INDEX idx_agent_logs_ticker_type ON public.agent_logs (ticker, log_type, created_at DESC);
CREATE INDEX idx_agent_logs_type        ON public.agent_logs (log_type, created_at DESC);
CREATE INDEX idx_agent_logs_errors      ON public.agent_logs (created_at DESC) WHERE error IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 6. portfolio_snapshots — snapshot quotidien (dashboard P&L + Sharpe glissant)
-- ----------------------------------------------------------------------------
CREATE TABLE public.portfolio_snapshots (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date         DATE NOT NULL,
  total_value_usd       NUMERIC NOT NULL,
  cash_usd              NUMERIC,
  positions_value_usd   NUMERIC,
  daily_return_pct      NUMERIC,
  cumulative_return_pct NUMERIC,
  sharpe_ratio          NUMERIC,
  max_drawdown_pct      NUMERIC,
  open_positions        INTEGER
);

CREATE UNIQUE INDEX idx_snapshots_date ON public.portfolio_snapshots (snapshot_date DESC);


-- ----------------------------------------------------------------------------
-- 7. system_heartbeats — monitoring uptime (alerte si != 'ok' à 17h30 ET)
-- ----------------------------------------------------------------------------
CREATE TABLE public.system_heartbeats (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status             TEXT NOT NULL CHECK (status IN ('ok', 'skipped_market_closed', 'partial_error', 'full_error')),
  cycles_completed   INTEGER NOT NULL DEFAULT 0,
  trades_executed    INTEGER NOT NULL DEFAULT 0,
  stocks_analyzed    INTEGER NOT NULL DEFAULT 0,
  errors             JSONB,
  notes              TEXT
);

CREATE INDEX idx_heartbeats_recorded ON public.system_heartbeats (recorded_at DESC);
CREATE INDEX idx_heartbeats_problems ON public.system_heartbeats (recorded_at DESC) WHERE status <> 'ok';


-- ============================================================================
-- Row Level Security — pattern admin unique (Section 11 — magic link 1 user)
-- ============================================================================
-- Stratégie :
--   - RLS activée sur les 7 tables
--   - Seul l'email admin a accès via magic link (auth.jwt() ->> 'email')
--   - Les Edge Functions utilisent service_role → bypass RLS automatique
--   - Aucun autre rôle (anon, authenticated avec autre email) n'a accès
-- ============================================================================

ALTER TABLE public.watchlist           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signals             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.positions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strategies          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_heartbeats   ENABLE ROW LEVEL SECURITY;

-- Policies : full access (ALL) restreint à l'email admin
CREATE POLICY "admin_full_access" ON public.watchlist
  FOR ALL TO authenticated
  USING      (auth.jwt() ->> 'email' = 'aether.trader.project@gmail.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'aether.trader.project@gmail.com');

CREATE POLICY "admin_full_access" ON public.signals
  FOR ALL TO authenticated
  USING      (auth.jwt() ->> 'email' = 'aether.trader.project@gmail.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'aether.trader.project@gmail.com');

CREATE POLICY "admin_full_access" ON public.positions
  FOR ALL TO authenticated
  USING      (auth.jwt() ->> 'email' = 'aether.trader.project@gmail.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'aether.trader.project@gmail.com');

CREATE POLICY "admin_full_access" ON public.strategies
  FOR ALL TO authenticated
  USING      (auth.jwt() ->> 'email' = 'aether.trader.project@gmail.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'aether.trader.project@gmail.com');

CREATE POLICY "admin_full_access" ON public.agent_logs
  FOR ALL TO authenticated
  USING      (auth.jwt() ->> 'email' = 'aether.trader.project@gmail.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'aether.trader.project@gmail.com');

CREATE POLICY "admin_full_access" ON public.portfolio_snapshots
  FOR ALL TO authenticated
  USING      (auth.jwt() ->> 'email' = 'aether.trader.project@gmail.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'aether.trader.project@gmail.com');

CREATE POLICY "admin_full_access" ON public.system_heartbeats
  FOR ALL TO authenticated
  USING      (auth.jwt() ->> 'email' = 'aether.trader.project@gmail.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'aether.trader.project@gmail.com');
