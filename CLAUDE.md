## 🔒 Supabase project lock
Projet : Aether
Supabase project_ref : rhqtjzlwkjwetneqdvkv
Email : aether.trader.project@gmail.com

Avant tout appel MCP Supabase : vérifier project_id = rhqtjzlwkjwetneqdvkv
Si le dossier courant n'est pas ~/Documents/GitHub/aether → STOP
Ne jamais utiliser hrqtfoeglzclgdkvbyyt (c'est InvestIQ)

## 📖 Source de vérité
- **[NEXT_SESSION.md](NEXT_SESSION.md)** — 👉 **OUVRIR EN PREMIER À LA REPRISE.** Plan d'attaque pour la session en cours : warm-up, cleanup, polish prioritaire, premier paper trading. Mis à jour à la fin de chaque session.
- **[STRATEGY.md](STRATEGY.md)** — v2.7, document final, 1888 lignes. C'est LA bible du système. Tout choix d'implémentation doit s'y référer. Ne jamais s'en écarter sans documenter dans DEVIATIONS.md.
- **[DEVIATIONS.md](DEVIATIONS.md)** — toute déviation vs STRATEGY.md (raison + impact + critère de réévaluation). À CONSULTER avant tout choix qui touche les clusters/endpoints.
- **[POLISH.md](POLISH.md)** — 18 améliorations différées (P-001 à P-018). À CONSULTER avant Phase 4 et avant tout vrai paper trading. Trois bloquants (P-001 macro context, P-002 earnings calendar, P-003 temperature pinning).
- **[docs/papers/](docs/papers/)** — 18 papers académiques référencés P1-P18 dans STRATEGY.md.

## 🎯 Vision condensée
Système de trading algo entièrement autonome, 1 admin, Claude Sonnet = décisionnaire. Univers : mid-caps US ($2B–$20B, NYSE/NASDAQ, Tech/Healthcare/Industrials/Consumer Disc). Pipeline 7 appels Claude/stock : 3 analystes (passes technique/sentiment/fondamentaux) → 2 researchers Bull/Bear isolés → Trader Guided Mode → Reviewer 3 perspectives. 6 clusters de scoring pondérés (C1 Earnings 25% / C2 Momentum 20% / C3 Smart Money 20% / C4 Quality 15% / C5 Valuation 10% / C6 News 10%). 3 couches de validation risque. Exécution Alpaca paper puis live.

## 🏗️ Stack figée
FMP API (Premium) + Claude Sonnet (Anthropic API) + Alpaca (paper) + Supabase (DB + pg_cron + Edge Functions) + Next.js sur Vercel + magic link auth.

## 🛠 Outillage Supabase pour Aether
**MCP uniquement, pas de CLI.** Le binaire `supabase` du Mac est réservé au compte `tabetcarl@icloud.com` (projets InvestIQ, Web Agency, Naano). Pour Aether (compte `aether.trader.project@gmail.com`), toutes les opérations passent par le serveur MCP `supabase-aether` configuré dans `.mcp.json` :
- `apply_migration` au lieu de `supabase db push`
- `execute_sql` au lieu de `supabase db query`
- `deploy_edge_function` au lieu de `supabase functions deploy`
- `get_advisors`, `list_tables`, `list_migrations`, etc.

Les fichiers `supabase/migrations/*.sql` sont **toujours créés** pour l'historique git, mais appliqués via MCP. Après chaque `apply_migration`, renommer le fichier local avec le timestamp réel retourné par `list_migrations` (sinon drift potentiel).

## 🚦 Règles d'or runtime
- Doute = HOLD. Jamais forcer un trade.
- Jamais fine-tuner Claude sur données financières (5 confirmations dans STRATEGY.md).
- Jamais soumettre OHLCV bruts au LLM — indicateurs pré-calculés uniquement.
- Toujours utiliser `transactionDate` (jamais `filingDate`) pour la recency insider.
- C4/C5 = bloqueurs en STRICT Mode, jamais générateurs de BUY (Quant Winter).
- Validation code (Couche 2) indépendante de Claude — aucun ordre ne passe sans elle.
