-- Audit fix (Bloquant 3) — 2026-06-02
-- execute-order écrit signals.alpaca_order_id après soumission Alpaca, mais la
-- colonne n'existait que sur la table positions. Sans elle, l'UPDATE échouait
-- silencieusement (erreur PostgREST non capturée) → signals.executed jamais mis
-- à true → idempotence cassée (risque de double-ordre au run suivant).
-- Appliquée via MCP apply_migration (compte aether.trader.project@gmail.com).
ALTER TABLE public.signals ADD COLUMN IF NOT EXISTS alpaca_order_id text;
