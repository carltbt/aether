-- ============================================================================
-- Aether — daily_context table (P-001 macro context)
-- ============================================================================
-- 1 row par jour avec VIX, SPY/SMA50, treasury 10Y + regime FREE/GUIDED/STRICT/PAUSE
-- Fetched par Edge Function fetch-daily-context (1×/jour via cron Phase 4)
-- Consommé par generate-decision pour ne plus utiliser le mock { vix:18, regime:"GUIDED" }
-- ============================================================================

CREATE TABLE public.daily_context (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  context_date    DATE NOT NULL UNIQUE,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  vix             NUMERIC,
  vix_change_pct  NUMERIC,
  spy_price       NUMERIC,
  spy_sma50       NUMERIC,
  spy_vs_sma50    TEXT CHECK (spy_vs_sma50 IN ('above', 'below', 'unknown')),
  treasury_10y    NUMERIC,
  market_regime   TEXT NOT NULL CHECK (market_regime IN ('FREE', 'GUIDED', 'STRICT', 'PAUSE')),
  raw_data        JSONB,
  errors          JSONB
);

CREATE INDEX idx_daily_context_date ON public.daily_context (context_date DESC);

-- RLS — pattern admin unique (cohérent avec les 7 autres tables)
ALTER TABLE public.daily_context ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_full_access" ON public.daily_context
  FOR ALL TO authenticated
  USING      ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com')
  WITH CHECK ((SELECT auth.jwt()) ->> 'email' = 'aether.trader.project@gmail.com');
