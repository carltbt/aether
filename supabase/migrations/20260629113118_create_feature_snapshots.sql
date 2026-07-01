-- As-of feature store (29/06) : snapshot quotidien LLM-free de toute la watchlist,
-- pour backtester l'edge dans ~6 mois sans look-ahead. On fige les features qui
-- révisent/décaient et ne sont PAS reconstructibles depuis l'OHLC historique
-- (fondamentaux, scores, DCF, valorisation, insider, grades) + le prix d'ancrage.
-- raw jsonb = capture maximale (réponses FMP brutes). Appliqué via MCP.
CREATE TABLE IF NOT EXISTS public.feature_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date date NOT NULL,
  ticker text NOT NULL,
  sector text,
  price numeric,
  volume numeric,
  market_cap numeric,
  pe numeric,
  dcf numeric,
  dcf_upside_pct numeric,
  altman_z numeric,
  piotroski int,
  ev_ebitda numeric,
  pb numeric,
  roe numeric,
  net_margin numeric,
  year_high numeric,
  year_low numeric,
  raw jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE (snapshot_date, ticker)
);
CREATE INDEX IF NOT EXISTS idx_feature_snapshots_ticker_date ON public.feature_snapshots (ticker, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_feature_snapshots_date ON public.feature_snapshots (snapshot_date DESC);
ALTER TABLE public.feature_snapshots ENABLE ROW LEVEL SECURITY;

-- Cron : snapshot quotidien post-clôture (22:00 UTC, jours de bourse). Idempotent par nom.
SELECT cron.schedule(
  'aether-snapshot-features',
  '0 22 * * 1-5',
  $$ SELECT net.http_get(url := 'https://rhqtjzlwkjwetneqdvkv.supabase.co/functions/v1/snapshot-features?limit=500', timeout_milliseconds := 280000); $$
);
