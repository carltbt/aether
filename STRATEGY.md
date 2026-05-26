# STRATEGY.md — AI Trading System Bible
**Version** : 2.7 — Document final, prêt pour le build
**Dernière mise à jour** : v2.7 — D4/D8 fermés (NON), D14 fermé (pg_cron + Edge Functions), D6 trigger défini, D2/D13 ouverts jusqu'aux données paper trading
**Statut** : Document vivant — rien n'est encore construit

---

## Table des matières

1. [Vision & objectifs](#1-vision--objectifs)
2. [Univers cible](#2-univers-cible)
3. [Stack technique](#3-stack-technique)
4. [Architecture du système](#4-architecture-du-système)
5. [Les 6 clusters de scoring](#5-les-6-clusters-de-scoring)
6. [Mapping FMP → clusters](#6-mapping-fmp--clusters)
7. [Configuration Claude Sonnet](#7-configuration-claude-sonnet)
8. [Règles de gestion du risque](#8-règles-de-gestion-du-risque)
9. [Boucle de stratégie hebdomadaire](#9-boucle-de-stratégie-hebdomadaire)
10. [Schéma Supabase](#10-schéma-supabase)
11. [Dashboard — spécifications](#11-dashboard--spécifications)
12. [Plan de backtesting](#12-plan-de-backtesting)
13. [Ordre de build](#13-ordre-de-build)
14. [Décisions ouvertes](#14-décisions-ouvertes)
15. [Changelog papers](#15-changelog-papers)

---

## 1. Vision & objectifs

### Ce qu'on construit
Un système de trading algorithmique **entièrement automatisé**, privé (1 seul utilisateur admin), où Claude Sonnet est le décisionnaire. Le système analyse un univers d'actions US mid-cap, génère des signaux BUY/SELL/HOLD, exécute les ordres via Alpaca, et apprend de ses décisions semaine après semaine.

### Ce que ce n'est pas
- Pas un produit public
- Pas un chatbot financier
- Pas un backtest statique
- Pas un système de day trading

### Objectifs de performance
| Métrique | Cible | Source |
|---|---|---|
| Annualized Return | > 25% | TradExpert : 49.79% (backtesting 2023) |
| Sharpe Ratio | > 2.0 | TradExpert : 5.01 (backtesting 2023) |
| Max Drawdown | < 15% | Strat-LLM : 11.66% (GPT-5.4 Strict 2025) |
| Win Rate | > 45% | StockBench : attention au high win-rate trap |
| Sortino Ratio | > 0.03 | StockBench : Kimi-K2 à 0.042 (données live) |

> **Mise en garde** : Les chiffres TradExpert sont issus d'un backtesting 2023 (marché haussier). Les données live StockBench (2025) sont plus conservatrices. Nos cibles réalistes en live : AR 15-25%, Sharpe 1.5-2.5, MDD < 15%.

### Horizon de trading
**Swing trading** : positions tenues 3 à 21 jours. Pas de day trading, pas de buy-and-hold long terme.

---

## 2. Univers cible

### Segment choisi : Mid-caps US
**Pourquoi les mid-caps et non les mega-caps :**
- Les mega-caps (AAPL, MSFT, GOOGL) sont suivies par 100+ analystes — le marché intègre l'information quasi-instantanément, les anomalies (PEAD, insider signal) sont marginales
- Les mid-caps ($2B–$20B) ont 5 à 20 analystes — suffisamment couvertes pour avoir toutes nos données FMP, mais imparfaitement efficientes pour que nos signaux créent de l'alpha
- D'après Lakonishok & Lee (2001) : signal insider **12x plus fort** sur mid-caps vs mega-caps
- PEAD (Post-Earnings Announcement Drift) dure 6 semaines sur mid-caps vs 1-2 jours sur mega-caps
- **F-Score (Piotroski) invalide sur large-caps US** : Gimeno et al. (P10) montrent que le F-Score produit -4.81% d'excess return annuel sur les S&P 500 companies (trop suivies par les analystes). Sur mid-caps sous-suivies, le signal reste prédictif — **valide notre univers cible**.

**Pourquoi pas les small/micro-caps :**
- Données FMP insuffisantes (peu de couverture analyst, pas d'insider stats)
- Risque de liquidité sur Alpaca (slippage, spread élevé)
- Manipulables (pump & dump), signaux bruités

### Paramètres du screener FMP (univers de base)
```
market_cap_min    : 2,000,000,000   (2B USD)
market_cap_max    : 20,000,000,000  (20B USD)
volume_min        : 500,000         (500K shares/jour)
beta_min          : 0.7
beta_max          : 1.8
exchange          : NYSE, NASDAQ
sector            : Technology, Healthcare, Industrials, Consumer Discretionary
```

**Secteurs inclus :**
- **Technology** (excl. GAFAM) : earnings surprises fréquents, news dense, momentum fort
- **Healthcare large** (excl. pure biotech) : Congressional trades actifs, insider signal fort
- **Industrials** : PEAD bien documenté, Piotroski très efficace, moins concurrencé
- **Consumer Discretionary** : momentum fort, sentiment news lisible

**Secteurs exclus :**
- Utilities : trop défensif, momentum faible, signal PEAD inexistant
- Pure biotech : événements binaires (FDA), essentiellement aléatoires pour notre système
- Pure Energy : macro commodity override tous nos signaux
- Financials (banques, assurance) : métriques de valorisation différentes, DCF non applicable
- Meme stocks : social sentiment override, pas d'ancrage fondamental

### Taille du portefeuille
- **Universe de candidats** : 150–200 stocks après screener
- **Analysés par cycle** : 20–30 stocks (top scoring du screener)
- **Positions simultanées** : 8–12 stocks maximum

> **Source** : StockBench montre que les performances se dégradent au-delà de 20 stocks. Le sweet spot est 10–20 pour les LLM agents. Anic et al. (P8) confirment : portefeuille 25 stocks → Sharpe ~1.3 vs 100 stocks → Sharpe ~1.0. L'edge LLM est **maximal sur un petit nombre de signaux haute-conviction**.

---

## 3. Stack technique

### Décisions finales

| Composant | Choix | Justification |
|---|---|---|
| Données marché | FMP API (Premium) | OHLCV, news, insider, congress, earnings, DCF, Piotroski — tout en un |
| Cerveau IA | Claude Sonnet (via Anthropic API) | Raisonneur natif, Guided Mode optimal (Strat-LLM), variance faible |
| Accès données | FMP MCP | URL directe dans l'appel API Anthropic, zéro wrapper à écrire |
| Broker | Alpaca | Paper trading gratuit, API simple, fractional shares, US stocks |
| Base de données | Supabase | Temps réel natif, Edge Functions, pg_cron intégré, TypeScript natif |
| Scheduler | Supabase pg_cron | Déclenchement planifié sans service externe |
| Frontend | Next.js sur Vercel | Déploiement 1 clic, SSE streaming natif |
| Auth | Supabase magic link (1 user) | Privé admin uniquement, pas d'auth complexe |

### Configuration FMP MCP
```javascript
mcp_servers: [
  {
    type: 'url',
    url: `https://financialmodelingprep.com/mcp?apikey=${FMP_API_KEY}`,
    name: 'fmp'
  }
]
```

### Quotas FMP
- Plan Premium : 750 req/min
- Chaque appel MCP = 1 appel REST classique dans le quota
- Budget estimé par cycle d'analyse (20 stocks) : ~200 appels

---

## 4. Architecture du système

### Vue d'ensemble des 9 blocs

```
[FMP API] → [Screener hebdo] → [Analyse multi-passes Claude] → [Scoring 6 clusters]
     → [Débat Bull/Bear Researchers] → [Décision finale Trader Guided Mode]
     → [Validation risque 3 couches] → [Alpaca exécution]
     → [Supabase stockage] → [Dashboard Vercel] → [Strategy loop dimanche]
```

> **⚠️ Protocole de communication structuré (P14 — TradingAgents)** : Chaque agent du pipeline passe son output sous forme de **rapport structuré compact** à l'agent suivant. Ne jamais enchaîner des conversations brutes entre agents — le "telephone effect" (dégradation d'information sur de longs historiques) est documenté comme un échec majeur des systèmes multi-agents non structurés. Dans notre système : chaque passe produit un rapport JSON structuré → le scoring extrait les champs clés → les Researchers reçoivent uniquement les scores + synthèses structurées, pas les conversations brutes.

### Bloc 1 — Données (FMP MCP)
Appelé à chaque cycle d'analyse. Voir Section 6 pour le mapping détaillé.

### Bloc 2 — Analyse multi-passes Claude Sonnet
**Inspiration** : TradExpert (4 expert LLMs) + 3S-Trader (agents spécialisés)
**Notre implémentation** : 3 passes séquentielles avec un seul Claude Sonnet

```
Passe 1 — Rapport technique
  Input  : OHLCV 4 semaines + RSI + MACD + SMA20/50 + ADX + Bollinger
  Output : Rapport structuré + score momentum (1-10) + score volatilité (1-10)

Passe 2 — Rapport sentiment
  Input  : 5 news articles (24h primaire, 48h secondaire) + news-sentiment score FMP
           + earnings calendar + score C2 momentum (pour context-priming si C2 ≥ 7)
  Output : Rapport structuré + score sentiment (1-10) + score impact news (1-10)

Passe 3 — Rapport fondamentaux
  Input  : Piotroski F-Score + Altman Z-Score + DCF upside + earnings surprise
           + insider stats + congressional trades + institutional ownership delta
  Output : Rapport structuré + score qualité (1-10) + score smart money (1-10)
           + score valuation (1-10) + score earnings catalyst (1-10)
```

> **⚠️ Format d'input Passe 1 — règle critique (P13)** : Ne jamais soumettre les données OHLCV brutes (tableaux de prix numériques) comme input principal à Claude. Xie et al. (2023) montrent que ChatGPT zero-shot échoue à extraire des patterns prédictifs de tableaux OHLCV bruts, sous-performant même la régression logistique. Claude doit recevoir les **indicateurs pré-calculés** (RSI, MACD, niveaux de croisement SMA, force ADX, compression Bollinger) présentés en format narratif structuré — *pas* des colonnes de prix brutes à scanner. Les données OHLCV brutes servent uniquement à calculer ces indicateurs en amont du prompt, pas comme input LLM direct.

> **⚠️ Confusion de ticker (P13 — Case Study)** : Dans les exemples d'erreur du paper, ChatGPT confond le ticker analysé ($unh) avec un autre ($ppl) dans sa réponse. Chaque prompt Claude doit ancrer le ticker en début ET en fin d'instruction. Le rationale JSON de sortie doit systématiquement répéter le ticker pour permettre une vérification programmatique avant exécution Alpaca.

### Bloc 3 — Scoring multi-dimensionnel (6 clusters)
Voir Section 5 pour le détail complet.

### Bloc 3.5 — Researcher Team (Bull/Bear Debate)
**Source** : TradingAgents (P14) — équipe de recherche avec perspectives opposées **avant** la décision finale.

**Pourquoi ce bloc est critique** : Dans notre ancien pipeline (Trader → Reviewer), le Reviewer voyait la conclusion du Trader et était naturellement ancré par elle. TradingAgents documente qu'un débat contradictoire *avant* la décision finale produit des décisions plus robustes et mieux équilibrées. Le Trader synthétise un débat, pas une recommandation unique.

```
Researcher Bullish — Appel Claude indépendant :
  Input  : Scores C1-C6 + synthèses structurées des passes 1+2+3 (rapports compacts)
  Rôle   : "Construis le meilleur argument POUR un BUY sur {TICKER}. Sois
            exhaustif sur les signaux positifs. Ne sois pas équilibré — ton
            rôle est d'être l'avocat du BUY."
  Output : Rapport bullish structuré (150 mots max) + 3 arguments clés + score confiance BUY (1-10)

Researcher Bearish — Appel Claude indépendant (ne voit PAS le rapport Bullish) :
  Input  : Scores C1-C6 + synthèses structurées des passes 1+2+3 (mêmes inputs)
  Rôle   : "Construis le meilleur argument CONTRE un BUY sur {TICKER}. Identifie
            tous les risques, signaux négatifs, et raisons de HOLD/SELL. Ne sois
            pas équilibré — ton rôle est d'être l'avocat du risque."
  Output : Rapport bearish structuré (150 mots max) + 3 contre-arguments + score risque (1-10)
```

**Règle d'isolation** : Les deux Researchers reçoivent exactement les mêmes inputs et ne voient JAMAIS la réponse de l'autre avant de produire leur rapport. L'isolation est garantie programmatiquement — deux appels API séparés sans contexte partagé.

**Output du Bloc 3.5** :
```json
{
  "bull_case": { "arguments": [...], "confidence_buy": 7 },
  "bear_case": { "counter_arguments": [...], "risk_score": 6 }
}
```

### Bloc 4 — Décision finale (Guided Mode)
Claude (Trader) reçoit les 6 scores + la stratégie courante + le contexte macro **+ le débat Bull/Bear du Bloc 3.5**.
Le Trader synthétise les deux perspectives et décide en connaissance de cause.
Output : `{ action: "BUY|SELL|HOLD", ticker, conviction: 0-100, position_size_pct, rationale, stop_loss_pct, bull_bear_synthesis: "..." }`

### Bloc 5 — Validation risque (3 couches)
```
Couche 1 — Règles dans le prompt (voir Section 8)
Couche 2 — Validation code avant envoi à Alpaca
Couche 3 — Protections natives Alpaca (stop-loss, bracket orders)
```

### Bloc 6 — Exécution Alpaca
- BUY → limit order au cours actuel + **0.2%** (mid-caps ont des spreads 0.2-0.4% — 0.1% risque de ne jamais être exécuté)
- SELL → limit order au cours actuel - 0.2%
- Stop-loss → bracket order automatique

### Bloc 7 — Supabase (mémoire du système)
Voir Section 10 pour le schéma complet.

### Bloc 8 — Dashboard Vercel
Voir Section 11 pour les spécifications.

### Bloc 9 — Boucle de stratégie hebdomadaire
Voir Section 9 pour le détail.

### Scheduler — pg_cron
```sql
-- Analyse quotidienne (jours de marché, 11h UTC = 7h ET)
SELECT cron.schedule('daily-analysis', '0 11 * * 1-5', 'SELECT run_daily_analysis()');

-- Mise à jour positions (toutes les 4h pendant les heures de marché)
SELECT cron.schedule('position-update', '0 13,17,21 * * 1-5', 'SELECT update_positions()');

-- Boucle stratégie (dimanche 20h ET = lundi 1h UTC)
SELECT cron.schedule('strategy-loop', '0 1 * * 0', 'SELECT run_strategy_loop()');

-- Screener universe (dimanche 19h ET = lundi 0h UTC)
SELECT cron.schedule('screener', '0 0 * * 0', 'SELECT run_screener()');

-- Digest email + heartbeat (16h15 ET = 20h15 UTC, jours de marché)
SELECT cron.schedule('eod-digest', '15 20 * * 1-5', 'SELECT run_eod_digest()');
```

**⚠️ Règle MARKET STATUS CHECK (MindStudio article — première action de chaque cycle) :**
```typescript
// À appeler EN TOUT DÉBUT de run_daily_analysis() et update_positions()
async function checkMarketOpen(): Promise<boolean> {
  const clock = await alpaca.get('/v2/clock');
  if (!clock.is_open) {
    // Jour férié US non-weekend (ex: Thanksgiving, MLK Day, Juneteenth)
    // pg_cron tourne quand même — on exit proprement sans analyser
    await logSystemEvent('market_closed', { reason: 'holiday_or_early_close', timestamp: clock.timestamp });
    await writeHeartbeat('skipped_market_closed');
    return false;
  }
  return true;
}
```

**⚠️ Critère "DONE" par routine (évite les boucles infinies d'appels Claude) :**
```
run_daily_analysis()  → DONE quand : tous les tickers actifs de la watchlist ont été scorés
                         ET toutes les décisions BUY/SELL/HOLD ont été générées et validées
                         Pas de boucle "chercher encore plus d'info" — une passe, un verdict.

update_positions()    → DONE quand : prix vérifié sur toutes les positions ouvertes
                         ET trailing stops mis à jour si nécessaire
                         ET gap overnight détecté et traité si applicable

run_strategy_loop()   → DONE quand : strategy_text de la semaine suivante est écrit
                         ET cluster_weights validés (somme = 1.0)
                         ET stockés dans la table strategies

run_eod_digest()      → DONE quand : email envoyé ET heartbeat.json écrit
```

---

## 5. Les 6 clusters de scoring

> Chaque cluster produit un score de 1 à 10. Le score de conviction final est la moyenne pondérée des 6 clusters. Les poids sont **révisables** — la boucle de stratégie peut les ajuster.

### Architecture globale
```
Conviction (0-100) = (
  C1_earnings_catalyst  × 0.25  +
  C2_price_momentum     × 0.20  +
  C3_smart_money        × 0.20  +
  C4_quality_gate       × 0.15  +
  C5_valuation          × 0.10  +
  C6_news_sentiment     × 0.10
) × 10
```

---

### Cluster 1 — Earnings & Transcript Catalyst (poids : 25%)

**Signal capturé** : Post-Earnings Announcement Drift (PEAD) + analyse sémantique du transcript pondérée par locuteur. Le marché sous-réagit à la fois aux surprises EPS ET au contenu du transcript. Le drift dure 3 à 8 semaines mais le signal est le plus fort dans les 10 premiers jours.

**Base académique** :
- Bernard & Thomas (1989) : PEAD confirmé sur 60 jours post-annonce
- Ball & Brown (1968) : première documentation du phénomène PEAD
- **Medya et al. (2022) — P5** : transcript sémantique bat l'EPS surprise dans 80% des cas
- **Sidhu, Fan & Pishgar (2026) — P6** : 6.5M phrases, 16 428 earnings calls S&P500, 2015-2025
  - Trouvaille majeure : **toutes les voix ne valent pas pareil** — les questions des analystes (20% des phrases) génèrent 49% de l'alpha prédictif
  - IC pondéré par locuteur (M4) = 0.119 vs simple mean 0.081 (+46%)
  - IC analyste seul (M5) = 0.141 — le signal le plus fort de tout le paper
  - Alpha mensuel Fama-French 5 facteurs : 2.03%/mois (M4), 2.54%/mois (M5)
  - **Out-of-sample : le signal SE RENFORCE** (IC 0.115 in-sample → 0.142 OOS, alpha 1.56% → 2.77%)
  - **Sentiment ⊥ EPS surprise** : les deux restent significatifs en régression jointe (t=5.57 sentiment, t=13.43 SUE) — information orthogonale
  - **Décroissance du signal** : half-life 6-7 jours — IC(J1)=0.119, IC(J5)=0.099, IC(J10)=0.065, IC(J21)=0.032
  - **Règle contrariante** : EPS décevant + ton analyste positif = spread 2.23% (le plus grand de tous les cas)
  - FinBERT subsume complètement Loughran-McDonald dans tous les modèles (t=5.90 vs t=0.86)

**Poids IC par locuteur (Sidhu et al. Table 5 — validés par XGBoost SHAP)**:

| Locuteur | % des phrases | IC (p<0.001) | Poids dans notre scoring | SHAP validation |
|---|---|---|---|---|
| Analyste sell-side | 20.2% | 0.128*** | **49%** | 59.6% |
| CFO | 26.3% | 0.078*** | **30%** | 29.1% |
| Exécutif (CEO/COO/CTO) | 51.0% | 0.042*** | **16%** | 8.5% |
| Autres | 2.5% | 0.015 (n.s.) | 5% | 2.8% |

> **Insight clé** : Le CEO parle 51% du temps mais ne représente que 16% du signal prédictif. Les analystes parlent 20% du temps mais génèrent 49% du signal. L'analyste pose des questions non scénarisées, spontanées, basées sur un jugement professionnel — difficile à anticiper et à gérer pour le management. Le CEO peut "spinner" son discours préparé ; l'analyste ne peut pas.

**Données FMP utilisées** :
- `/earning-call-transcript` : transcript complet avec identification des locuteurs → **input primaire**
- `/earnings-surprises` : EPS actual vs estimated → input secondaire (orthogonal au sentiment)
- `/earnings-calendar` : date du prochain earnings → gestion risque binaire
- `/price-target-summary` : upgrades/downgrades POST-earnings uniquement

**Règle de fraîcheur du signal (Sidhu et al. — décroissance IC)**:
```
Multiplicateur de fraîcheur C1 :
  ≤ 3 jours post-earnings  → ×1.00 (signal plein)
  4-7 jours                → ×0.83 (IC J5 / IC J1)
  8-12 jours               → ×0.55 (IC J10 / IC J1)
  13-21 jours              → ×0.27 (IC J21 / IC J1)
  > 21 jours               → ×0.10 (signal résiduel — presque ignoré)

Application : score_C1_final = score_C1_brut × multiplicateur_fraîcheur
```

**Passe 3 — Prompt de scoring C1 pour Claude** :
```
Tu es un analyste actions expert. Ton rôle est d'analyser le transcript
de l'earnings call de {TICKER} (call du {DATE}) et de prédire si les
prochains earnings constitueront une positive ou negative surprise.

AVERTISSEMENT BIAIS DE CLASSE (FinCall-Surprise P7) :
Dans les données réelles, 80-89% des earnings surprises sont POSITIVES.
Ne sois PAS biaisé vers "POSITIF" par défaut. Une analyse équilibrée
qui identifie correctement les négatifs a plus de valeur qu'une prédiction
systématiquement haussière. Évalue avec la même rigueur les deux directions.

Jours depuis l'earnings call : {DAYS_SINCE} → multiplicateur fraîcheur : {FRESHNESS_MULT}

GESTION DU TRANSCRIPT LONG (FinCall-Surprise P7) :
Si le transcript est long, priorise dans cet ordre de préservation :
1. ANALYSTES (à préserver en priorité absolue — signal le plus fort)
2. CFO (à préserver en deuxième)
3. CEO/Exécutifs (peut être résumé si nécessaire)
4. Opérateur (résumer en premier — langage procédural sans valeur)

ANALYSE PAR LOCUTEUR (pondération IC-dérivée, Sidhu et al. 2026) :

1. QUESTIONS & RÉPONSES DES ANALYSTES SELL-SIDE (poids 49% du score transcript)
   Ce sont les questions NON scénarisées. L'analyste n'a aucun intérêt à
   gérer son ton — il exprime un jugement professionnel authentique.
   
   Évalue :
   - Ton des questions : sceptique, hostile, neutre, positif, enthousiaste ?
   - Nature des follow-ups : l'analyste relance-t-il sur des points négatifs ?
   - Validation implicite : est-ce que les analystes semblent satisfaits des réponses ?
   - Présence de questions sur la guidance, les marges, les risques compétitifs
   
   Score analyste (1-10) : ___
   Justification (1-2 phrases) : ___

2. DÉCLARATIONS CFO (poids 30% du score transcript)
   Prépare les finances, souvent plus factuel que le CEO.
   
   Évalue :
   - Précision et détail du guidance financier
   - Ton sur les marges, le cash flow, la dette
   - Absence/présence de langage de couverture ("we expect", "we hope", "approximately")
   
   Score CFO (1-10) : ___
   Justification (1-2 phrases) : ___

3. DÉCLARATIONS EXÉCUTIVES CEO/COO/CTO (poids 16% du score transcript)
   Attention : les déclarations préparées peuvent être strategiquement optimistes.
   
   Évalue le ton MALGRÉ le biais de gestion :
   - Niveau de certitude vs hedging
   - Références spécifiques vs vagueness
   - Cohérence avec les chiffres présentés par le CFO
   
   Score exécutif (1-10) : ___
   Justification (1-2 phrases) : ___

4. SCORE TRANSCRIPT PONDÉRÉ :
   score_transcript = (score_analyste × 0.49) + (score_cfo × 0.30) + (score_exec × 0.16)

5. RÈGLE CONTRARIANTE (Sidhu et al. — double-sort Low SUE) :
   ⚡ Si EPS surprise NÉGATIVE mais score analyste > 7 :
   → Signal CONTRARIAN fort. Marché sous-estime la confiance des analystes.
   → Bonus automatique +2 sur le score transcript final.

SCORE EPS SURPRISE (poids 35% du C1) :
   EPS surprise % = {EPS_SURPRISE_PCT}
   [Appliquer barème ci-dessous]

UPGRADES POST-EARNINGS (poids 25% du C1, ignorés si antérieurs à l'earnings) :
   [Analyser /price-target-summary — dates uniquement post-earnings]

FORMULE FINALE C1 :
   C1_brut = (score_transcript × 0.40) + (score_eps × 0.35) + (score_upgrades × 0.25)
   C1_final = C1_brut × multiplicateur_fraîcheur

RÉPONDS EN JSON :
{
  "score_analyste": X,
  "score_cfo": X,
  "score_exec": X,
  "score_transcript_pondere": X,
  "score_eps": X,
  "score_upgrades": X,
  "c1_brut": X,
  "c1_final": X,
  "rationale_analyste": "...",
  "rationale_cfo": "...",
  "signal_contrarian": true/false,
  "verdict": "POSITIVE_SURPRISE | NEGATIVE_SURPRISE | NEUTRAL"
}

⚠️ RÈGLE SECTORIELLE (Medya et al. P5) :
   Healthcare : ajuster à transcript × 0.30 + EPS × 0.45 + upgrades × 0.25
```

**Règles de scoring C1 — barème EPS surprise** :

| Condition | Score EPS |
|---|---|
| EPS surprise > +10% + < 10 jours | 9-10 |
| EPS surprise +5% à +10% + < 20 jours | 7-8 |
| EPS surprise +2% à +5% | 5-6 |
| Surprise neutre ±2% | 4 |
| Surprise négative -2% à -5% | 2-3 |
| Surprise négative > -5% | 1 |
| Earnings dans < 5 jours | Pénalité -3 (risque binaire) |

**Règles de scoring C1 — barème transcript pondéré** :

| Condition | Score transcript |
|---|---|
| Analystes enthousiastes, questions de validation, CFO précis | 9-10 |
| Analystes globalement positifs, peu de scepticisme | 7-8 |
| Analystes neutres, quelques questions défensives | 5-6 |
| Analystes sceptiques, CFO hedging fort | 3-4 |
| Analystes hostiles, questions récurrentes sur problèmes | 1-2 |
| EPS négatif + analyste très positif (contrarian signal) | Bonus +2 |
| Upgrade analyste POST-earnings + price target +15% | Bonus +1 |

**⚠️ Signal le plus puissant identifié (Sidhu et al.)** :
> *"Sentiment is particularly informative when earnings disappoint — positive analyst tone during a bad quarter signals management confidence that the market underweights."*
> 
> → Quand EPS surprise < -2% ET score analyste > 7 → ENVISAGER BUY contrarian (C1 score peut atteindre 8-9 malgré mauvais EPS)

**Décision D1 — Close** : Architecture finale validée. Transcript = input primaire, pondération par locuteur (49/30/16/5), règle de fraîcheur intégrée.
**Décision D3 — Close** : Horizon optimal = 0-10 jours post-earnings (83% du signal encore présent à J+5). Ne plus prendre de position C1 > 21 jours.

**⚠️ Avertissement classe imbalance (Shu et al. P7 — FinCall-Surprise)** :
Dans les données de marché réelles, les positive earnings surprises représentent **79 à 89% des cas**. Un système qui prédit "positif" systématiquement aura une accuracy élevée mais une valeur nulle.

Conséquences directes :
- Notre dashboard doit mesurer **F1 score équilibré** sur C1, pas l'accuracy brute
- Un C1 score élevé (7-10) est la norme — ce n'est pas en soi un signal d'achat fort
- Le signal RÉELLEMENT rare et précieux est le C1 négatif (3-4) qui détecte les déceptions → SELL
- Et le signal contrarian documenté (EPS négatif + analyste positif) reste le plus rare et le plus fort

**Gestion des longs transcripts (Shu et al. P7)** :
20% des transcripts dépassent la fenêtre de contexte. Stratégie de résumé par priorité :
```
Si transcript > limite tokens :
  1. Résumer/tronquer : sections Operator (procédural, sans valeur analytique)
  2. Si encore trop long : résumer sections Executive (CEO, COO)
  3. Préserver INTACT en priorité absolue : sections Analyst (Q&A)
  
Rationale : Sections Analyst = 49% du signal (Sidhu et al. P6).
Les supprimer en premier serait la pire décision possible.
```

**Validation Claude Sonnet (Shu et al. P7)** :
Les modèles fine-tunés sur données financières (FinLLaMa3, LLaMa-RAG) s'effondrent complètement (10-12% accuracy, génération de texte répétitif sans sens). Les grands modèles généralistes (GPT-5, Claude Sonnet) donnent des prédictions équilibrées sur les deux classes. Notre choix de Claude Sonnet est confirmé pour la 3ème fois comme supérieur à tout modèle financier spécialisé.

**Multimodal (audio/slides) — Report indéfini (Shu et al. P7)** :
Les gains audio et image sont inconsistants entre modèles (+4% pour certains, -20% pour d'autres). L'approche texte seul (FMP transcript) est validée comme la bonne base. Audio/slides peuvent être explorés en V2 si les résultats paper trading le justifient. Ne pas complexifier inutilement la V1.

---

### Cluster 2 — Price Momentum (poids : 20%)

**Signal capturé** : Le momentum de prix (winners continuent de gagner à court terme, Jegadeesh & Titman 1993).

**Base académique** :
- Jegadeesh & Titman (1993) : "Returns to Buying Winners and Selling Losers"
- Validé par TradExpert (Market Analyst) et 3S-Trader (Technical Agent)
- Strat-LLM S2 : Breakout Momentum (prix casse le high 3 jours)

**Données FMP utilisées** :
- `/historical-chart/daily` : OHLCV 4 semaines
- `/technical-indicators/rsi` : RSI 14 jours
- `/technical-indicators/macd` : MACD (12,26,9)
- `/technical-indicators/sma` : SMA 20 et SMA 50
- `/technical-indicators/adx` : ADX (force de tendance)
- `/technical-indicators/bbands` : Bollinger Bands (compression = setup)

**Règles de scoring** :

| Condition | Score |
|---|---|
| Prix > SMA20 > SMA50 + RSI 50-65 + ADX > 25 | 9-10 |
| Prix > SMA20 + RSI 45-70 + tendance haussière | 7-8 |
| Prix entre SMA20 et SMA50, RSI neutre | 5-6 |
| Prix < SMA20, RSI < 45 | 3-4 |
| Prix < SMA50, RSI < 35, ADX fort baissier | 1-2 |
| RSI > 75 (suracheté) | Pénalité -2 |
| Bollinger compression + breakout récent | Bonus +1 (Strat-LLM S3) |
| Prix casse high 3 jours | Bonus +1 (Strat-LLM S2) |

**Note Strat-LLM** : En marché haussier (VIX < 20, SPY > MA50) → Guided Mode privilégie momentum. En marché baissier → Strict Mode réduit les scores momentum de 20%.

**⚡ Synergy C2×C6 (Anic et al. P8)** : Le signal news LLM (C6) est conçu pour *conditionner* le signal momentum (C2), pas pour s'y substituer. Quand C2 ≥ 7 (momentum fort), C6 scored en mode "context-priming momentum" amplifie ou filtre la décision BUY. Quand C2 < 5, C6 seul ne suffit pas à déclencher un BUY. L'interaction C2×C6 est la plus puissante du système pour les positions momentum — les deux clusters ne sont pas indépendants.

---

### Cluster 3 — Smart Money (poids : 20%)

**Signal capturé** : Les insiders et le Congrès surperforment systématiquement le marché parce qu'ils ont une information supérieure ou un accès privilégié.

**Base académique** :
- Lakonishok & Lee (2001) : signal insider fort sur mid-caps
- Ziobrowski et al. (2004) : sénateurs US surperforment de 10%/an
- Ziobrowski et al. (2011) : version Chambre des représentants
- **Huang, Ma et al. (2025) — P15** : Dataset IFD de 4M+ Form 4 filings (2002-2025). Trouvaille majeure : **17.4% des dépôts Form 4 sont tardifs** (hors délai SEC de 2 jours ouvrés). Taux de violation différentiels par rôle :
  - Beneficial Owners (>5% shareholders) : **22.24%** de violation — le plus élevé
  - Other Insiders : 16.59%
  - CEO : **10.88%** — le plus fiable temporellement
  - Corporate Suite : 10.63%
  - 77% des violations sont des oversights (≤3 jours de retard, insiders occasionnels)
  - 23% sont intentionnelles (≥4 jours, insiders qui violent ≥95% du temps)

**Données FMP utilisées** :
- `/insider-trading/statistics` : ratio achats/ventes sur 3 mois
- `/insider-trading/search` : transactions récentes par ticker — **utiliser `transactionDate`, jamais `filingDate` pour mesurer la recency** (P15)
- `/senate-latest` + `/house-latest` : trades Congress < 30 jours
- `/institutional-ownership` : variation ownership institutionnel (13F delta)

**⚠️ Règle critique — TRANDATE vs FDATE (Huang et al. P15)** :
```
17.4% des Form 4 sont déposés hors délai légal.
→ Toujours mesurer la recency depuis la DATE DE TRANSACTION (TRANDATE/transactionDate)
   et NON depuis la date de dépôt (FDATE/filingDate).

Exemple : Filing reçu aujourd'hui avec TRANDATE = J-45 → ce n'est PAS un signal récent.
           Filing reçu aujourd'hui avec TRANDATE = J-5 → signal récent, même déposé tard.

Dans FMP /insider-trading/search : vérifier le champ transactionDate pour le calcul de recency.
Ne pas se fier au tri par date d'apparition dans le feed FMP.
```

**Taux de violation par rôle — implications pour le scoring** :
- **CEO/CFO (≈10.8% de violation)** : signal temporellement le plus fiable. Quand le CEO achète dans les 30 jours (TRANDATE), c'est un signal de haute qualité — peu de risque de confusion de date.
- **Beneficial Owners (22.24% de violation)** : timing moins fiable. Étendre la fenêtre de recency à 45 jours pour les beneficial owners (vs 30 jours pour CEO/CFO). Décote légère si la date de dépôt est > 5 jours après la TRANDATE.
- **Violations intentionnelles (23% des violations)** : un insider qui viole ≥95% du temps mais dépose dans les délais est un comportement anormal → signal comportemental potentiellement fort. Claude doit noter ce cas si identifiable via les données FMP (gap_days ≈ 0 pour un insider historiquement tardif).

**Règles de scoring** :

| Condition | Score |
|---|---|
| Achat insider CEO/CFO > 100K$ dans les 30 jours (TRANDATE) | 9-10 |
| Achats clustérisés (3+ insiders, même ticker, 2 semaines) | 10 |
| Achat Congress < 45 jours (healthcare/tech) | 8-9 |
| Augmentation ownership institutionnel > 5% (trimestre) | 7-8 |
| Achats insiders récents sans ventes | 6-7 |
| Pas de transaction notable | 5 (neutre) |
| Ventes insiders significatives | 2-3 |
| Réduction massive institutionnelle > -10% | 1-2 |
| **Filing tardif > 5 jours ouvrés sur achat CEO/CFO** | **Pénalité -1 (signal potentiellement stale — P15)** |

**⚠️ Important** : Distinguer les ventes d'insiders pour taxes/diversification vs ventes discrétionnaires. Claude doit raisonner sur le contexte (Form 4, nature de la transaction). Toujours vérifier `transactionDate` vs `filingDate` pour tout signal C3.

---

### Cluster 4 — Quality Gate (poids : 15%)

**Signal capturé** : Les entreprises en amélioration fondamentale (Piotroski F-Score élevé) surperforment, et les entreprises proches de la faillite (Altman Z-Score faible) sous-performent. **Valide uniquement sur mid-caps** — le signal disparaît sur les large-caps très suivies.

**Base académique** :
- **Piotroski (2000) — P18** : F-Score 0-9 sur 14 043 observations 1976-1996 (high BM firms = value distressed). Conçu spécifiquement pour les entreprises **ignorées des analystes et en détresse financière** — notre univers mid-cap exact. **9 signaux binaires** dans 3 zones :

  **Zone A — Profitabilité (4 signaux)** :
  - F_ROA : ROA > 0 → 1 (rentabilité positive = capacité à générer des fonds en interne)
  - F_ΔROA : ROA courant > ROA année précédente → 1 (amélioration de la rentabilité)
  - F_CFO : CFO/Total Assets > 0 → 1 (flux opérationnels positifs)
  - F_ACCRUAL : **CFO > ROA → 1** (les profits ne sont PAS gonflés par des accruals — signal critique : earnings driven par accruals = mauvais signal futur, Sloan 1996)

  **Zone B — Levier/Liquidité/Source de fonds (3 signaux)** :
  - F_ΔLEVER : Ratio dette LT/actifs diminue → 1 (réduction du levier = bon signal pour firme distressed)
  - F_ΔLIQUID : Current ratio s'améliore → 1 (hausse liquidité = meilleure capacité à servir la dette courante)
  - F_EQOFFER : **Pas d'émission d'actions nouvelles → 1** (une firme distressed qui émet des actions signale son incapacité à se financer en interne — signal fortement négatif)

  **Zone C — Efficacité opérationnelle (2 signaux)** :
  - F_ΔMARGIN : Gross margin s'améliore → 1 (réduction coûts ou hausse prix produits)
  - F_ΔTURN : Asset turnover s'améliore → 1 (meilleure productivité de la base d'actifs)

  **F-SCORE = somme des 9 signaux (0-9). Score 8-9 = strong, score 0-1 = weak.**

  **Corrélation retours** : F-SCORE agrégé (IC = 0.121 à 1 an) > meilleur signal individuel ROA (IC = 0.086) ou CFO (IC = 0.096) — valide l'approche composite vs signal unique. **Conséquence directe** : dans notre évaluation NF-Score (P10), Claude doit intégrer les 9 signaux ensemble, jamais s'appuyer sur 1-2 ratios isolés.
- **Altman (1968) — P17** : Z-Score — 5 ratios financiers combinés en analyse discriminante sur 66 entreprises manufacturières. Trois zones validées empiriquement :
  - **Z > 2.99** : zone safe (non-faillite) — FMP utilise > 3.0 comme approximation
  - **1.81 ≤ Z ≤ 2.99** : "zone d'ignorance" / gray area — classification incertaine, erreurs observées dans cette plage
  - **Z < 1.81** : zone de danger (faillite probable)
  - **Cut-off optimal : 2.675** (minimise les erreurs de classification dans l'échantillon original)
  - **5 variables** : X₁ = Working Capital/Total Assets (liquidité) ; X₂ = Retained Earnings/Total Assets (profitabilité cumulée) ; X₃ = EBIT/Total Assets (efficacité opérationnelle) ; X₄ = Market Value Equity/Total Debt (levier marché) ; X₅ = Sales/Total Assets (rotation actifs)
  - **Limite temporelle critique** : précision 95% à 1 an avant faillite, 72% à 2 ans, puis chute dramatique (48% à 3 ans, 29% à 4 ans) — le Z-Score est un **indicateur d'état courant**, pas un prédicteur long terme. Pour notre swing trading (3-21 jours), c'est exactement le bon usage.
- **Huang, Capretz & Ho (2021) — P9** : RF feature importance sur 22 ans de données S&P100. Hiérarchie des signaux fondamentaux validée empiriquement :
  - **Rang 1** : PB (price-to-book) → intégré dans C5 mais confirme la valeur de la métrique
  - **Rang 2** : Relative Return (momentum) → confirme C2 comme feature fondamentale complémentaire
  - **Rang 3** : Book Value → couvert par Altman Z-Score
  - **Rang 4** : PE → intégré dans C5
  - **Rang 5** : **CapEx change (% variation des dépenses d'investissement)** → signal absent de notre système, à intégrer
  - **Rang 6** : Liability change → couvert partiellement par Altman Z-Score et Piotroski
- **Gimeno, Lobán & Vicente (2020) — P10** : NF-Score (Neural F-Score) sur S&P500 + Eurofirst 300, 2006-2017
  - F-Score **ÉCHOUE** sur large-caps US : High F-Score → -4.81% excess return à 1 an (prix déjà intégré par les analystes)
  - NF-Score surpasse F-Score de +4.16% annuel (US) en considérant magnitude + interactions entre zones
  - **Signal valide sur mid-caps** sous-suivies : Piotroski l'avait conçu pour entreprises "ignorées par les analystes" — notre univers exact
  - **Principe NF-Score** : les 3 zones financières (profitabilité, levier/liquidité, efficacité opérationnelle) **interagissent** — un bon score de profitabilité avec levier croissant est un signal ambigu, pas simplement additif
- **Schwartz & Hanauer (2024) — P12** : Comparaison de 4 formules d'investissement (F-Score, Magic Formula, Acquirer's Multiple, Conservative Formula) sur 60 ans de données US (1963-2022), hors microcaps :
  - **Alpha F-Score entièrement capturé par les facteurs** : alpha FF5FM = 0.74%, t=0.76, **non-significatif** — la surperformance du F-Score provient *exclusivement* de l'exposition aux facteurs value, profitabilité et investissement (RMW, HML, CMA), pas d'un signal indépendant
  - **Conséquence directe** : le F-Score est un **proxy d'exposition factorielle**, pas un générateur d'alpha autonome — valide strictement son rôle de filtre défensif dans notre C4, jamais comme signal BUY positif
  - **Risque de drawdown élevé** : portefeuille concentré F-Score (40 stocks, post-2000) = **57.5% de drawdown max** — le plus élevé des 4 formules, supérieur au marché (44.1%)
  - **Vulnérabilité "Quant Winter" (2018-2020)** : F-Score sous-performe sévèrement pendant les crises facteur value — en STRICT Mode (VIX > 25), C4 doit être traité comme **bloqueur pur uniquement**, sans pouvoir générer de signal positif
  - **Magic Formula (EBIT/EV + ROC) = alpha le plus robuste parmi les 4 formules** : seule formule conservant un alpha significatif après contrôle des 6 facteurs (FF6FM alpha = 4.15%/an, t=3.46) — valide la combinaison valuation (C5) + profitabilité (C4) dans notre système bi-cluster

**Données FMP utilisées** :
- `/scores-bulk` ou `/financial-scores` : Piotroski + Altman pré-calculés
- `/income-statement` : revenue growth, net income growth
- `/balance-sheet` : debt/equity, current ratio
- `/cash-flow-statement` : free cash flow, operating cash flow, **CapEx (capital expenditure change YoY)**

**⚡ Principe d'évaluation non-binaire (NF-Score, P10)**:
Claude ne traite pas les signaux Piotroski comme binaires (0/1). Pour chacun des 9 signaux (P18), Claude évalue la **magnitude** du changement et les **interactions** entre zones :
```
Zone A (Profitabilité) → Zone B (Levier/Liquidité) → Zone C (Efficacité Opérationnelle)

Signal d'alerte : ROA en hausse (A positif) MAIS levier aussi en hausse (B négatif)
→ La profitabilité pourrait être financée par la dette, pas par l'opérationnel
→ Score composite plus bas que la somme des deux signaux pris isolément

Signal fort : toutes les zones alignées (profitabilité + réduction dette + amélioration efficacité)
→ Score composite plus haut que la somme arithmétique

⚠️ Signaux à vérifier explicitement (P18) :
→ F_ACCRUAL : si ROA > CFO (profits > cash opérationnel), les earnings sont gonflés par des accruals
   — c'est le signal Sloan (1996) de manipulation comptable, particulièrement important sur firmes distressed
   — Claude doit toujours comparer ROA vs CFO/actifs dans son raisonnement C4
→ F_EQOFFER : une émission d'actions récente sur une firme mid-cap en difficulté = signal très négatif
   — indique incapacité à se financer en interne, coût du capital élevé assumé
   — vérifiable via /cash-flow-statement (proceeds from stock issuance) ou /balance-sheet (shares outstanding)
```

**Règles de scoring** :

| Condition | Score |
|---|---|
| Piotroski ≥ 8 ET Altman > 3.0 (zone safe) | 9-10 |
| Piotroski 6-7 ET Altman ≥ 2.675 (cut-off optimal, zone safe-ish) | 7-8 |
| Piotroski 5 ET Altman 1.81-2.675 (zone grise — incertitude) | 5-6 |
| Piotroski 3-4 ET Altman 1.81-2.675 (zone grise) | 3-4 |
| Piotroski ≤ 2 OU Altman < 1.81 (zone danger) | 1-2 |
| Croissance FCF > 20% YoY | Bonus +1 |
| Réduction dette > 15% YoY | Bonus +1 |
| **CapEx en croissance > 10% YoY** (investissement actif) | **Bonus +1 (P9)** |
| **CapEx en chute > 20% YoY** (désinvestissement) | **Pénalité -1 (P9)** |
| **Toutes les 3 zones Piotroski positives** (profitabilité + levier + efficacité) | **Bonus +1 (P10 — alignement complet)** |
| **Zones contradictoires** (ex. ROA+ mais levier+) | **Pénalité -1 (P10 — signal ambigu)** |
| **ROA > CFO/actifs** (earnings gonflés par accruals — signal Sloan) | **Pénalité -1 (P18 — F_ACCRUAL négatif)** |
| **Émission d'actions récente** (< 12 mois, firme mid-cap distressed) | **Pénalité -1 (P18 — F_EQOFFER négatif)** |

> **Note CapEx (P9)** : Une croissance des dépenses d'investissement signale qu'une entreprise investit dans sa capacité future — signal positif pour les mid-caps en expansion. Une chute brutale du CapEx peut signaler une réduction défensive ou une contrainte de trésorerie. Appliquer uniquement aux secteurs Technology et Industrials (pertinence limitée en Healthcare).

> **Note Altman gray area (P17)** : Les stocks avec Z entre 1.81 et 2.675 sont en "zone d'ignorance" — Altman lui-même documentait des erreurs de classification dans cette plage. Claude doit traiter ces stocks avec prudence accrue dans le raisonnement C4, en s'appuyant davantage sur les composantes individuelles (X₁-X₅) que sur le score composite seul. Un Z entre 2.675 et 2.99 est toujours techniquement dans la gray area mais proche du safe — ne pas sur-pénaliser.

> **⚠️ Avertissement taille (P10)** : Si un stock de notre univers approche les $20B de market cap (limite haute), le signal F-Score perd de sa fiabilité (couverture analytique croissante). Claude doit pénaliser légèrement le C4 pour les stocks en haut de notre fourchette ($15B-$20B) et le traiter comme filtre défensif uniquement.

> **⚠️ Avertissement "Quant Winter" (P12)** : En régime STRICT Mode (VIX > 25) ou quand la boucle de stratégie détecte plusieurs semaines consécutives de sous-performance des signaux C4/C5 (exposition value en stress), C4 passe en **mode bloqueur pur** : il peut uniquement empêcher un BUY (score < 3), jamais le déclencher. Le facteur value peut sous-performer violemment pendant 12 à 24 mois (2018-2020 : -50%+ de drawdown relatif pour les formules value) — ne jamais prendre de position BUY en s'appuyant principalement sur C4 en régime adverse.

**Rôle du cluster** : Filtre défensif **exclusivement** — jamais générateur d'alpha autonome (P12 : alpha entièrement factorisé). Un score < 3 peut bloquer un BUY même si les autres clusters sont forts. Un score élevé ne suffit pas à déclencher un BUY sans conviction sur C1, C2 ou C3.

> **Note de confirmation P16 (Jeong & Kim 2019 — KOSPI coréen)** : Sur un univers de value stocks pré-screené par F-Score, subdiviser davantage en "groupe achat (F ≥ 8)" vs "groupe vente (F ≤ 1)" **n'améliore pas** les métriques risk-adjusted par rapport à traiter l'ensemble du portefeuille. La portée est limitée (marché coréen, rebalancement quotidien ML — non applicable à notre approche LLM swing trading). Confirme dans un 3ème contexte géographique (après P10 US+Europe, P12 US 60 ans) que le F-Score discrimine utilement à l'entrée de l'univers, pas à l'intérieur d'un univers déjà filtré — ce qui est exactement notre usage de C4.

---

### Cluster 5 — Valuation (poids : 10%)

**Signal capturé** : Les actions sous-valorisées par rapport à leur valeur intrinsèque (DCF) et à leur secteur (PE ratio, earnings yield) tendent à mean-reverter. La combinaison earnings yield + qualité (Magic Formula) est la seule formule de valeur avec alpha résiduel robuste.

**Base académique** :
- Value investing classique (Graham, Damodaran)
- "Financial Statement Analysis with Large Language Models" (Kim, Muhn & Nikolaev, 2024)
- **Schwartz & Hanauer (2024) — P12** : Comparaison de 4 formules d'investissement sur 60 ans :
  - **Magic Formula (EBIT/EV + ROC) = alpha le plus robuste** : seule formule avec alpha significatif après modèle 6 facteurs (FF6FM alpha = 4.15%/an, t=3.46) — l'alpha provient du ROC (return on capital = EBIT/tangible capital), une mesure de profitabilité *supérieure* au facteur RMW standard
  - **Acquirer's Multiple (EBIT/EV = earnings yield pur)** : rendement brut top décile le plus élevé de toutes les formules, mais beta 1.41 (cyclique) — signal de valorisation puissant mais exposé aux drawdowns en période de stress
  - **EV/EBITDA (proxy earnings yield)** comme signal de valeur relative surpasse le PE ratio dans tous les modèles testés — à utiliser en complément du DCF
  - **Notre C4 + C5 ensemble ≈ Magic Formula** : C4 capte la qualité/profitabilité (ROC), C5 capte la valorisation (EY) — la combinaison bi-cluster est académiquement justifiée comme étant la plus alpha-générative
  - Performance decay réelle post-2000 mais toujours positive : **Magic Formula** 15.8% AR, Sharpe 0.69, MDD 50.6% — **Conservative Formula** (low-vol + momentum + payout yield) : 11.4% AR, Sharpe 0.78, MDD 40.1% (meilleur risk-adjusted)

**Données FMP utilisées** :
- `/discounted-cash-flow` : upside DCF vs prix actuel
- `/sector-pe-snapshot` : PE moyen du secteur
- `/ratios-ttm-bulk` : PE, PB, PS du ticker vs secteur
- `/key-metrics-ttm-bulk` : **EV/EBITDA** (proxy earnings yield — Acquirer's Multiple approach, P12), FCF yield, return on capital employed (proxy ROC Magic Formula)

**Règles de scoring** :

| Condition | Score |
|---|---|
| DCF upside > 40% + PE < secteur | 9-10 |
| DCF upside 20-40% + PE < secteur | 7-8 |
| DCF upside 10-20% | 6-7 |
| DCF upside 0-10% | 5 |
| DCF downside 0-10% (légèrement surévalué) | 3-4 |
| DCF downside > 20% (très surévalué) | 1-2 |
| **EV/EBITDA < médiane sectorielle** (earnings yield élevé — Acquirer's Multiple approach) | **Bonus +1 (P12)** |
| **EV/EBITDA < 50% de la médiane sectorielle** (deep value sur earnings yield) | **Bonus +2 (P12 — top décile Acquirer's Multiple)** |
| FCF yield > 5% | Bonus +1 |

> **Note EV/EBITDA (P12)** : L'earnings yield (EBIT/EV ou EBITDA/EV) est un meilleur prédicteur de rendement que le PE ratio selon 60 ans de données. FMP fournit `enterpriseValueMultiple` (EV/EBITDA) dans `/key-metrics-ttm-bulk`. Comparer au secteur via `/sector-pe-snapshot` (PE sectoriel comme proxy de la valorisation relative). Un EV/EBITDA bas = earnings yield élevé = action bon marché sur ses bénéfices opérationnels.

> **⚠️ Limites** : Le DCF FMP est automatique — pas toujours fiable sur les hyper-growth. Claude doit le prendre comme indicateur relatif, non absolu. L'EV/EBITDA est plus robuste que le DCF pour les comparaisons intra-secteur.

---

### Cluster 6 — News Sentiment (poids : 10%)

**Signal capturé** : Le sentiment agrégé des news et des documents publics influence le momentum à court terme (1-2 semaines). En mode C2-conditionné (context-priming), le LLM évalue si les news supportent la *continuation du trend* plutôt que le sentiment seul.

**Base académique** :
- Lopez-Lira & Tang (2023) : "Can ChatGPT Forecast Stock Price Movements?"
- Validé par TradExpert (News Analyst) et 3S-Trader (News Agent + News Impact)
- Strat-LLM : sentiment intégré dans tous les modes
- **Medya et al. (2022) — P5** : dimensions LIWC validées sur 97K transcripts avec p<0.001 :
  - Émotion négative : coefficient -0.64*** (signal le plus fort, toutes conditions)
  - Score tristesse : coefficient -0.73*** (encore plus fort en contrôlant les autres)
  - Émotion positive : coefficient +0.26*** (signal positif fiable)
  - Anxiété : coefficient -0.26* (signal négatif modéré)
  - Certitude, colère, insight : non significatifs — **ne pas surpondérer**
- **Anic, Barbon, Seiz & Zarattini (2025) — P8** : LLM-enhanced momentum, S&P500, Oct 2019–Mar 2025
  - LLM news scoring conditionné sur momentum : Sharpe 0.57 → 0.69 (full sample), 0.79 → 1.06 (out-of-sample)
  - **Lookback optimal : 24h (k=1 jour)** — au-delà, le marché a déjà intégré l'info
  - **Context-priming** : informer le LLM que le stock est candidat momentum améliore le signal
  - **Simple prompts > advanced** : prompt court surpasse prompt structuré complexe (Sharpe ~1.1 vs ~0.95)
  - 4ème confirmation anti-fine-tuning : résultats plus forts post-cutoff modèle (OOS strict)
  - Concentration optimale : 25 stocks → Sharpe 1.3 (cohérent avec notre 8-12 positions)
  - Rebalancing mensuel >> hebdomadaire (valide notre cycle hebdomadaire comme floor minimum)

**Données FMP utilisées** :
- `/stock_news` : 5 articles les plus récents — **fenêtre primaire 24h, secondaire 48h** (P8)
- `/news-sentiment` : score agrégé FMP (-1 à +1)
- `/sec-filings-8k` : événements matériels récents

**⚡ Technique Context-Priming (Anic et al. P8 — clé)**:
Quand C2 ≥ 7 (stock en momentum fort), le prompt Passe 2 doit informer Claude du contexte momentum :
```
CONTEXTE TRADING : Ce stock ({TICKER}) est un candidat fort pour une position momentum
(C2 = {c2}/10). Évalue si les news des dernières 24h confirment ou infirment la
continuation de ce trend. La question n'est pas "les news sont-elles positives en
absolu" mais "les news supportent-elles la continuation du mouvement récent ?"
```
Si C2 < 5 : prompt standard sans context-priming (momentum absent → sentiment pur).

**Règles de scoring affinées** :

| Condition | Score |
|---|---|
| News-sentiment > 0.7 + aucun terme anxieux/triste dans 8-K | 9-10 |
| News-sentiment 0.4-0.7 + ton positif dominant | 7-8 |
| News-sentiment 0.1-0.4 | 6 |
| News-sentiment neutre -0.1 à +0.1 | 5 |
| News-sentiment -0.1 à -0.4 OU termes d'anxiété fréquents | 3-4 |
| News-sentiment < -0.4 + termes tristes/négatifs dominants | 1-2 |
| 8-K positif (M&A accretive, guidance relevé, buyback) | Bonus +1 |
| 8-K négatif (lawsuit, restatement, guidance baissé) | Pénalité -2 |
| Context-priming actif (C2 ≥ 7) + news confirment momentum | Bonus +1 (P8) |

**Note importante — séparation C1/C6** : Le transcript earnings call appartient à C1 (scoring primaire de l'earnings event). C6 couvre uniquement les news quotidiennes et les 8-K hors earnings. Ne pas double-compter le même transcript dans les deux clusters.

**Note sectorielle (Medya et al.)** : En Healthcare, les news EPS/Sales gardent plus de poids que le sentiment pur — ajuster le ratio si le stock analysé est en Healthcare.

---

## 6. Mapping FMP → clusters

### Appels par cycle quotidien (par stock analysé)

| Endpoint FMP | Cluster | Fréquence | Note |
|---|---|---|---|
| `/historical-chart/daily` | C2 | Quotidien | 4 semaines |
| `/technical-indicators/rsi` | C2 | Quotidien | 14 jours |
| `/technical-indicators/macd` | C2 | Quotidien | 12,26,9 |
| `/technical-indicators/sma` | C2 | Quotidien | SMA20, SMA50 |
| `/technical-indicators/adx` | C2 | Quotidien | 14 jours |
| `/stock_news` | C6 | Quotidien | 5 articles, **24h primaire** (48h secondaire si < 3 articles) — P8 |
| `/news-sentiment` | C6 | Quotidien | — |
| `/earning-call-transcript` | C1 | Quotidien | Dernier transcript — **input primaire C1** |
| `/earnings-surprises` | C1 | Quotidien | Derniers 2 quarters — input secondaire |
| `/earnings-calendar` | C1 | Quotidien | Next 30 days — gestion risque binaire |
| `/price-target-summary` | C1 | Quotidien | Upgrades POST-earnings uniquement |
| `/insider-trading/statistics` | C3 | Quotidien | 3 mois |
| `/insider-trading/search` | C3 | Quotidien | **Utiliser `transactionDate` (TRANDATE) pour la recency — jamais `filingDate`** (P15 : 17.4% des filings sont tardifs, Beneficial Owners 22% de violation) |
| `/financial-scores` | C4 | Quotidien | Piotroski + Altman |
| `/discounted-cash-flow` | C5 | Quotidien | — |
| `/key-metrics-ttm-bulk` | C5 | Quotidien | EV/EBITDA (earnings yield proxy — P12), FCF yield, return on capital |

> **Retiré** : `/analyst-stock-recommendations` — recommandations pré-earnings prouvées non-prédictives (Medya et al. P5, p-value non significative dans tous les modèles testés)
> **Retiré** : `/analyst-estimates` comme signal de scoring — conservé uniquement en calcul intermédiaire pour la surprise EPS

### Appels contextuels (1 fois/jour, globaux)

| Endpoint FMP | Usage | Fréquence |
|---|---|---|
| `/quote?symbol=^VIX` | Détection régime (Free/Strict) | 1x/jour |
| `/treasury` | Taux 10Y, courbe des taux | 1x/jour |
| `/sector-pe-snapshot` | PE moyen par secteur pour C5 | 1x/jour |
| `/senate-latest` | Congress trades récents pour C3 | 2x/jour |
| `/house-latest` | Congress trades récents pour C3 | 2x/jour |
| `/biggest-gainers` + `/biggest-losers` | Contexte marché | 1x/jour |

### Appels hebdomadaires (screener + universe)

| Endpoint FMP | Usage | Fréquence |
|---|---|---|
| `/stock-screener` | Rebuild watchlist 150-200 stocks | 1x/semaine |
| `/scores-bulk` | Piotroski bulk pour présélection | 1x/semaine |
| `/institutional-ownership` | 13F delta pour C3 | 1x/semaine |
| `/sec-filings-8k` | Événements matériels semaine écoulée | 1x/semaine |

---

## 7. Configuration Claude Sonnet

### Mode : Guided Mode (pas Free, pas Strict)

**Source** : Strat-LLM (2026), données live 2025.

- **Free Mode** = Claude décide sans contrainte → instabilité documentée pour les modèles non-reasoners
- **Strict Mode** = Règles rigides → pénalise les modèles raisonneurs (Alignment Tax)
- **Guided Mode** = Stratégies S1-S4 comme guidelines + Claude ajuste selon les signaux

Claude Sonnet est un modèle raisonneur (variance faible = 0.153 dans StockBench). Le Guided Mode lui permet de leverager son raisonnement interne tout en étant ancré sur des règles claires.

### ⚠️ Principe anti-fine-tuning (FinCall-Surprise P7 + Anic et al. P8 — critique)

**Ne jamais fine-tuner Claude Sonnet sur des données financières.**

FinCall-Surprise évalue 26 modèles dont 4 spécialisés finance (Fin-LLaMa3, Finance-LLaMa, Finance-R1, LLaMa-RAG). Résultats :
- Fin-LLaMa3-8B : **10% d'accuracy** (pire qu'aléatoire)
- LLaMa-RAG : **8% d'accuracy**
- Output réel de Fin-LLaMa3 : boucle infinie "we see the company we see the company..."

**4ème confirmation (Anic et al. P8)** : sur les données out-of-sample strict (après le cutoff d'entraînement du modèle), les performances sont *plus élevées* qu'in-sample (Sharpe 0.79→1.06 OOS vs 0.57→0.69 IS). La valeur du LLM vient de sa capacité de raisonnement linguistique général, pas de données mémorisées. Un modèle fine-tuné perd cette flexibilité sans rien gagner.

**5ème confirmation (Ding et al. survey P11)** : sur 27 papers revus, "general-purpose LLMs such as GPT4 has great in-context learning capability in financial oriented tasks." Les agents les plus performants (FinAgent, FinMem) utilisent tous des LLMs généralistes non fine-tunés. Résultat unanime dans la littérature.

Causes : over-finetuning sur données financières spécialisées détruit l'instruction-following et la génération de langage de base. Claude Sonnet généraliste avec un bon prompt surpasse systématiquement ces modèles spécialisés. Ce résultat confirme notre approche : **prompt engineering + Guided Mode, jamais de fine-tuning**.

**⚠️ Risque comportemental sous pression (Ding et al. survey P11)** :
Des études expérimentales montrent que les LLMs peuvent prendre des *actions non-éthiques sous haute pression* (utiliser de l'insider info fictive, créer des explications trompeuses pour les dissimuler). Ce risque est réel en trading.

Notre Couche 2 (validation code) et Couche 3 (Alpaca) protègent contre ces comportements — aucun ordre ne passe si la validation code échoue, indépendamment de ce que Claude "décide". **Principe : ne jamais faire confiance à la décision finale de Claude sans validation code indépendante.**

### ⚠️ Principe des prompts simples (Anic et al. P8)

**Préférer les prompts concis aux prompts complexes.**

P8 compare un prompt "basic" (concis, objectif direct) à un prompt "advanced" (structuré, détaillé, multi-instructions). Le basic surpasse l'advanced (Sharpe ~1.1 vs ~0.95), différence non significative statistiquement mais robuste à toutes les configurations testées.

Règle pratique pour nos prompts C6 et décision finale :
- Donner l'objectif clairement + le contexte trading (context-priming si C2 ≥ 7)
- Ne pas surstructurer avec des sections, sous-sections, instructions exhaustives
- Laisser Claude raisonner librement dans le cadre donné
- Réserver les prompts structurés (JSON avec barèmes) uniquement à C1 où la précision analytique est critique

### Les 4 stratégies de référence (S1-S4) à injecter en Guided Mode

Inspiré directement de Strat-LLM :

```
S1 — Short-Term Reversal
Basé sur l'hypothèse de surréaction (behavioral finance).
Signal : action en chute > 8% sur 5 jours sans catalyseur fondamental.
Action : BUY en anticipation du mean-reversion.
Condition d'activation : RSI < 35 + C4 Quality Gate > 6 (pour éviter les value traps)

S2 — Breakout Momentum
Signal : prix casse le high des 3 derniers jours avec volume > 150% de la moyenne.
Action : BUY pour capturer la continuation du mouvement.
Condition d'activation : ADX > 20 + C1 Earnings Catalyst > 5

S3 — Volatility Compression
Signal : Bollinger Bands se resserrent (width < 20% de la moyenne 20 jours).
Action : BUY anticipant l'expansion de volatilité.
Condition d'activation : C4 Quality Gate > 5 + C6 News Sentiment > 5

S4 — Price-Volume Confirmation
Signal : prix monte + volume croissant sur 3 jours consécutifs.
Action : BUY pour confirmer la force du mouvement.
Condition d'activation : C3 Smart Money > 6 (confirmation smart money)
```

### Structure du system prompt (squelette)

```
⚠️ META-INSTRUCTION — LIS EN PREMIER, TOUJOURS :
Tu es un agent de trading algorithmique entièrement autonome sur actions US mid-cap.
Aucun humain ne valide tes décisions avant exécution sur Alpaca.
Tes décisions BUY entraînent directement l'achat de titres avec de l'argent réel.

PRINCIPE ABSOLU : le doute = HOLD.
Ne force jamais un trade. Ne cherche pas à "utiliser" la conviction disponible.
La décision la plus fréquente et la plus correcte est HOLD. Un trade non pris
ne coûte rien. Un mauvais trade coûte du capital et perturbe le compounding.

BIAIS COGNITIFS À ÉVITER ACTIVEMENT (ils s'appliquent aux LLMs autant qu'aux humains) :

1. Recency bias — La news d'hier n'est pas plus vraie que celle de la semaine dernière.
   Le fait qu'une action ait monté 5% hier n'est pas une raison de BUY aujourd'hui.
   Pèse les signaux sur leur horizon propre, pas sur leur ordre d'arrivée.

2. Confirmation bias — Après avoir vu un score C1 élevé, ne cherche pas
   inconsciemment à justifier un BUY dans les autres clusters. Évalue C2, C3,
   C4 de façon indépendante, comme si tu n'avais pas encore vu C1.

3. Anchoring — Si ce ticker a été analysé la semaine dernière avec une conviction
   de 75, ne laisse pas ce chiffre influencer l'analyse courante. Repart de zéro.

4. Loss aversion — Si une position est à -6% et le stop-loss est à -7%, ne reporte
   pas l'exit en espérant un rebond. La règle de stop-loss existe précisément pour
   éviter ce biais. Elle est non-négociable.

5. FOMO — Un score de conviction de 85 justifie une taille de 8-10%. Pas 15%.
   La performance extraordinaire d'un signal ne justifie pas de dépasser les limites.
   Les règles de sizing protègent le portefeuille contre les erreurs d'une seule analyse.

6. Overconfidence — Une conviction de 92 ne signifie pas "certitude". Elle signifie
   "signaux fortement alignés selon notre modèle actuel". Des surprises arrivent toujours.
   C'est pourquoi les stop-losses existent même sur les convictions maximales.

GESTION DES DONNÉES MANQUANTES :
Si certaines données FMP sont absentes, applique ces fallbacks sans interrompre :
- Transcript manquant → C1 = (EPS_score × 0.60 + upgrades_score × 0.40) × freshness_mult
- Pas d'earnings data → C1 = 5 (neutre), note "données manquantes" dans rationale
- Pas d'insider data → C3 = 5 (neutre), note "données manquantes"
- Pas de DCF FMP → C5 basé uniquement sur PE vs secteur et EV/EBITDA
- Si > 3 clusters manquent de données → HOLD automatique, analyse incomplète

GESTION DES SIGNAUX CONFLICTUELS :
Si deux clusters s'opposent fortement (différence > 5 points, ex: C1=9, C2=2) :
- Ne moyenne pas aveuglément — note le conflit dans `signal_conflicts`
- Identifie lequel a le plus d'informations actuelles (C1 post-earnings récent > C2 technique)
- La formule de conviction s'applique normalement — ne la surcharge jamais
- Si la conviction calculée est < 60, c'est la réponse correcte même avec un C1 = 9
- Signale le conflit dans le rationale pour que la boucle stratégique puisse apprendre

CONTEXTE MARCHÉ ACTUEL :
- VIX : {vix}
- SPY vs MA50 : {spy_regime} → Mode : {FREE|GUIDED|STRICT}
- Taux 10Y : {rate}
- PE secteur {sector} : {sector_pe}

STRATÉGIE COURANTE (semaine {week}) :
{current_strategy}

DONNÉES STOCK {TICKER} :
[Rapport technique - Passe 1]
[Rapport sentiment - Passe 2]
[Rapport fondamentaux - Passe 3]

SCORES :
- C1 Earnings Catalyst : {c1}/10
- C2 Price Momentum    : {c2}/10
- C3 Smart Money       : {c3}/10
- C4 Quality Gate      : {c4}/10
- C5 Valuation         : {c5}/10
- C6 News Sentiment    : {c6}/10
- Conviction brute     : {conviction}/100

DÉBAT BULL/BEAR (Researcher Team) :
[Bull Case] : {bull_arguments} (confiance BUY : {bull_confidence}/10)
[Bear Case] : {bear_arguments} (score risque : {bear_risk}/10)
→ Ton rôle de Trader est de SYNTHÉTISER ce débat, pas de répéter un côté.

PORTFOLIO ACTUEL :
{positions}
→ Note la corrélation sectorielle avec les positions existantes avant de dimensionner.

RÈGLES NON-NÉGOCIABLES :
[Voir Section 8]

Génère une décision structurée en JSON incluant bull_bear_synthesis.
```

### Format de sortie JSON

```typescript
interface TradingDecision {
  ticker: string;
  action: "BUY" | "SELL" | "HOLD";
  conviction: number;              // 0-100
  position_size_pct: number;       // % du portfolio AVANT ajustement corrélation
  position_size_pct_final: number; // % du portfolio APRÈS ajustement corrélation (celui exécuté)
  entry_price_target: number;      // prix limite suggéré
  stop_loss_pct: number;           // % de stop depuis entry (ex: 7 = -7%)
  take_profit_pct: number;         // % de target (ex: 15 = +15%)
  strategy_used: "S1" | "S2" | "S3" | "S4" | "COMPOSITE";
  rationale: string;               // raisonnement de Claude Trader
  bull_bear_synthesis: string;     // synthèse du débat Bull/Bear (P14)
  key_risks: string[];             // risques identifiés
  hold_days_estimate: number;      // durée estimée de la position
  signal_conflicts: string[];      // ex: ["C1=9 vs C2=2 — momentum contra-trend à surveiller"]
  data_completeness: {             // quelles données étaient disponibles
    transcript: boolean;
    earnings: boolean;
    insider: boolean;
    dcf: boolean;
    fallbacks_applied: string[];   // liste des fallbacks utilisés
  };
  correlation_note: string;        // ex: "3 positions tech en portefeuille — taille réduite de 30%"
}
```

### Détection de régime (adapte le mode automatiquement)

```
VIX < 18 ET SPY > MA50  → FREE Mode   (capture momentum, positions plus larges)
VIX 18-25               → GUIDED Mode (équilibré, par défaut)
VIX > 25 OU SPY < MA50  → STRICT Mode (positions réduites de 50%, stop-loss renforcés)
VIX > 35 (crise)        → PAUSE Mode  (aucun nouveau BUY, liquidation progressive)
```

> **⚠️ Régime "Quant Winter" (P12)** : En STRICT Mode (VIX > 25), les signaux C4 et C5 (exposition facteur value) **ne peuvent pas déclencher un BUY** — ils servent uniquement de bloqueurs. Historiquement, le facteur value sous-performe violemment pendant les crises de liquidité/growth (2018-2020 : drawdown relatif > 50% pour les formules value). Sous STRICT Mode, les seuls signaux BUY valides sont portés par C1 (earnings catalyst) ou C3 (smart money) avec C2 (momentum) en confirmation.

### Pattern multi-agent (Pipeline complet — P14 refonte)

**Source** : TradingAgents (P14) + MindStudio + Strat-LLM + Huang et al. P9.

```
Pipeline complet par stock analysé (7 appels Claude) :

Étape 1 — Analysts (Passes 1+2+3)
  3 appels séquentiels → 3 rapports structurés compacts
  Output : scores C1-C6 + synthèses JSON structurées

Étape 2 — Researchers (Bull + Bear) [NOUVEAU P14]
  2 appels indépendants et parallélisables
  Researcher Bullish : meilleur argument BUY (isolé)
  Researcher Bearish : meilleur argument contre-BUY (isolé)
  Output : débat structuré JSON

Étape 3 — Trader (Décision finale)
  1 appel Claude en Guided Mode
  Input : scores + débat Bull/Bear + stratégie courante + contexte macro
  Output : TradingDecision JSON avec bull_bear_synthesis

Étape 4 — Reviewer (Risk Gate)
  1 appel Claude avec 3 perspectives de risque
  Input : TradingDecision + scores + portefeuille actuel (sans voir le raisonnement interne)
  Perspectives intégrées dans UN SEUL appel :
    → Conservateur : "Quels risques justifient un blocage ?"
    → Neutre       : "La conviction est-elle justifiée par les signaux ?"
    → Agressif     : "Y a-t-il une opportunité sous-exploitée ?"
  Output : APPROVE / REJECT + ajustement taille position recommandé (±20%)
```

**Règles de convergence (P9 consensus strict renforcé par P14)** :
- Un BUY est exécuté seulement si Trader → BUY ET Reviewer → APPROVE
- En désaccord (Trader BUY, Reviewer REJECT) → HOLD systématique, jamais de compromis
- Un SELL est exécuté même si Reviewer → HOLD (protection asymétrique)
- Si Researcher Bullish et Researcher Bearish sont très alignés dans le même sens (score confiance BUY et score risque dans la même direction) → signal fort : amplifier la conviction du Trader de ±10 points

**Coût estimé par stock analysé** : ~7 appels Claude Sonnet. Sur 20-30 stocks/cycle → budget à monitorer dans `agent_logs`.

> **⚠️ Limitation résultats TradingAgents (P14)** : Les Sharpe de 6 à 8 reportés sont issus d'un backtesting de *3 mois seulement* (Jan-Mar 2024, marché haussier) sur AAPL, GOOGL, AMZN uniquement (mega-caps). Les auteurs eux-mêmes notent en bas de page que ces Sharpe élevés résultent de "peu de drawdowns pendant cette période". Ces chiffres ne sont PAS représentatifs d'une performance live sostenée. L'apport de P14 est **architectural** (structure multi-agent, débat Bull/Bear, protocole structuré), pas les métriques de performance.

---

## 8. Règles de gestion du risque

### Les 3 couches (MindStudio article + Strat-LLM)

**Couche 1 — Dans le system prompt (non-négociable)**
```
- RÈGLE MAÎTRE : le doute = HOLD. Ne jamais forcer un trade.
- Maximum 12% du capital sur une seule position (avant ajustement corrélation)
- Minimum 5% de cash réservé en permanence
- Pas de BUY si earnings dans les 5 prochains jours (risque binaire)
- Pas de BUY si VIX > 35
- Stop-loss obligatoire sur chaque position (entre 5% et 10% selon conviction)
- Take-profit suggéré : ratio risk/reward minimum 1:2
- Maximum 3 positions dans le même secteur simultanément
- Pas de SELL short (long only pour commencer)
- Trailing stop-loss : position > +8% → déplacer stop à +2% de l'entrée (lock partiel)
                       position > +15% → déplacer stop à +7% de l'entrée
                       position > +20% → déplacer stop à +12% de l'entrée
- Earnings dans < 3 jours ET position en PROFIT → SELL (lock profits)
- Earnings dans < 3 jours ET position en PERTE → HOLD (ne pas cristalliser la perte
  avant l'event ; réévaluer après l'annonce ; le stop-loss protège le downside extrême)
```

**Couche 2 — Validation code (Edge Function Supabase)**
```typescript
function validateOrder(decision: TradingDecision, portfolio: Portfolio): ValidationResult {
  // === RÈGLES HARD-CODED INDÉPENDANTES DE CLAUDE ===

  // 1. Taille de position
  if (decision.position_size_pct_final > 12) return REJECT("position trop grande");
  if (portfolio.cash_pct < 5) return REJECT("cash insuffisant");

  // 2. Stop-loss
  if (decision.stop_loss_pct < 3) return REJECT("stop-loss trop serré");
  if (decision.stop_loss_pct > 15) return REJECT("stop-loss trop large");

  // 3. Événements
  if (isEarningsInNextDays(decision.ticker, 5)) return REJECT("earnings imminent");

  // 4. Concentration sectorielle
  if (getSectorCount(portfolio, decision.ticker) >= 3) return REJECT("concentration secteur");

  // 5. Drawdown global
  if (portfolio.total_drawdown_pct > 20) return REJECT("drawdown max global atteint");

  // 6. Vérification ticker (P13)
  if (!isTickerInWatchlist(decision.ticker)) return REJECT("ticker inconnu ou hors univers");
  if (decision.ticker !== requestedTicker) return REJECT("confusion ticker détectée");

  // 7. Ajustement corrélation sectorielle (nouveau)
  // Logique : si le nouveau stock est dans un secteur déjà représenté, réduire la taille.
  // Deux stocks tech corrélés à 0.8+ = exposition doublée sur le même risque sectoriel.
  const sectorCount = getSectorCount(portfolio, decision.ticker);
  if (sectorCount === 1) {
    // Un stock de ce secteur déjà en portefeuille → réduire de 20%
    decision.position_size_pct_final *= 0.80;
    decision.correlation_note = `1 position ${getSector(decision.ticker)} existante — taille réduite de 20%`;
  } else if (sectorCount === 2) {
    // Deux stocks de ce secteur déjà en portefeuille → réduire de 40%
    // (le 3ème est encore autorisé mais avec taille réduite)
    decision.position_size_pct_final *= 0.60;
    decision.correlation_note = `2 positions ${getSector(decision.ticker)} existantes — taille réduite de 40%`;
  }

  return APPROVE();
}

// === FONCTION update_positions() — tournée à 9h31 ET et toutes les 4h ===
function updatePositions(portfolio: Portfolio): void {
  for (const position of portfolio.open_positions) {
    const currentPrice = getMarketPrice(position.ticker);
    const entryPrice = position.entry_price;
    const returnPct = (currentPrice - entryPrice) / entryPrice * 100;

    // --- RÈGLE GAP OVERNIGHT (priorité absolue) ---
    // Si le prix actuel est DÉJÀ sous le stop-loss défini à l'entrée,
    // c'est qu'un gap s'est produit (overnight ou intraday).
    // Le bracket order Alpaca n'a pas pu s'exécuter au prix de stop prévu.
    // → Sortie immédiate au marché.
    // Logique : une action qui a gapé de -15% sur mauvaise news continue
    // typiquement à baisser dans les heures suivantes (momentum négatif post-choc).
    // Il vaut mieux cristalliser la perte à -15% que risquer -25%.
    const stopLossPrice = entryPrice * (1 - position.stop_loss_pct / 100);
    if (currentPrice < stopLossPrice && !position.stop_triggered) {
      submitMarketSell(position.ticker, position.quantity);
      logGapEvent(position.ticker, returnPct, "gap_overnight_exit");
      continue;
    }

    // --- TRAILING STOP-LOSS ---
    // Logique : verrouiller les gains progressivement pour qu'un winner
    // ne redevienne jamais un loser. Le trailing stop préserve le compounding.
    if (returnPct >= 8 && returnPct < 15) {
      const newStopPrice = entryPrice * 1.02; // Stop à +2% (break-even+)
      if (newStopPrice > position.current_stop_price) {
        updateBracketOrder(position.ticker, newStopPrice);
        logTrailingStopUpdate(position.ticker, "+2%", returnPct);
      }
    } else if (returnPct >= 15 && returnPct < 20) {
      const newStopPrice = entryPrice * 1.07; // Stop à +7%
      if (newStopPrice > position.current_stop_price) {
        updateBracketOrder(position.ticker, newStopPrice);
        logTrailingStopUpdate(position.ticker, "+7%", returnPct);
      }
    } else if (returnPct >= 20) {
      const newStopPrice = entryPrice * 1.12; // Stop à +12%
      if (newStopPrice > position.current_stop_price) {
        updateBracketOrder(position.ticker, newStopPrice);
        logTrailingStopUpdate(position.ticker, "+12%", returnPct);
      }
    }
  }
}
```

**Couche 3 — Protections natives Alpaca**
```
- Bracket orders : chaque BUY inclut automatiquement le stop-loss et le take-profit
- Day trading protection : pas de PDT rule (compte > 25K à terme, paper trading pour commencer)
- Fractional shares : permet position sizing précis même avec petit capital
```

### Règles de sizing des positions

| Conviction | Mode marché | Taille position (avant corrélation) |
|---|---|---|
| 80-100 | Free | 10-12% |
| 80-100 | Guided | 8-10% |
| 80-100 | Strict | 4-6% |
| 60-79 | Free | 7-9% |
| 60-79 | Guided | 5-7% |
| 60-79 | Strict | 2-4% |
| < 60 | Tous | HOLD (pas de trade) |

**Ajustement corrélation sectorielle (appliqué après la table ci-dessus par Couche 2) :**
- 0 position du même secteur en portefeuille → taille inchangée
- 1 position du même secteur → ×0.80 (réduction 20%)
- 2 positions du même secteur → ×0.60 (réduction 40%) — 3ème encore autorisé, taille réduite

**Pourquoi cette réduction préserve le capital :** deux stocks tech mid-cap corrélés à 0.75+
évoluent quasi-ensemble lors d'une rotation sectorielle. Une réduction de taille évite que
le drawdown du secteur impacte le portefeuille global proportionnellement à la somme des positions.
Le gain n'est pas sur le return individuel mais sur la stabilité du portfolio global et le maintien
du système sous le seuil de PAUSE Mode (-20%). La continuité du trading compose sur le long terme.

**Sélection si > 12 signaux passent 60 :** trier par conviction décroissante, prendre les top 8-12.
L'abondance de signaux est une bonne nouvelle — on choisit les meilleurs, pas les premiers.

### Règles de sortie

```
Exit triggers (par ordre de priorité strict) :

PRIORITÉ 0 — Gap overnight (Couche 2 automatique, avant tout) :
  Si prix d'ouverture < stop-loss défini → market sell immédiat à l'ouverture.
  Pas d'attente de rebond. Pas d'exception.
  Logique : un gap sur mauvaise news continue généralement (momentum post-choc).
  Cristalliser -15% est presque toujours meilleur que risquer -25%.

1. Stop-loss atteint intraday → SELL immédiat (Couche 3 Alpaca bracket order)

2. Take-profit atteint → SELL partiel (50%) ou total selon la stratégie courante

3. Trailing stop-loss atteint → SELL automatique (position avait progressé puis retracé)
   Protège les gains : une position à +18% qui retrace jusqu'au stop à +7% = gain sécurisé.

4. Score de conviction chute < 40 lors du prochain cycle → SELL
   (la thèse originale d'entrée ne tient plus)

5. Earnings dans < 3 jours ET position en PROFIT → SELL (lock profits avant event binaire)
   Earnings dans < 3 jours ET position en PERTE → HOLD (stop-loss protège le downside,
   ne pas cristalliser juste avant l'event qui pourrait corriger la thèse)

6. Durée max atteinte (21 jours) → SELL si pas de signal fort pour rester
   (le signal C1 PEAD a expiré — 83% du signal consommé après 5 jours)

7. Drawdown global > 15% → liquidation 50% du portefeuille (positions les plus faibles d'abord)

8. Drawdown global > 20% → liquidation totale + PAUSE Mode
```

---

## 8.5 Protocoles opérationnels

### Protocole Cold Start (semaines 1-4)

**Le problème :** la boucle stratégique du dimanche dépend de données de performance historiques pour ajuster les poids des clusters. En semaine 1, ces données n'existent pas.

**La solution :**
```
Semaines 1-4 : poids fixes par défaut (25/20/20/15/10/10), non modifiables.
               La boucle stratégique tourne mais ne produit PAS de nouvelles pondérations.
               Elle produit uniquement : observation du régime marché + biais sectoriels.

Semaine 5+ : premier ajustement de poids autorisé si ET SEULEMENT SI :
             → Au moins 8 positions fermées avec P&L réalisé
             → Au moins 3 semaines de données (éviter les conclusions sur 1 semaine atypique)

La boucle stratégique doit signaler explicitement :
  { cold_start: true, adjustments_blocked: true, reason: "< 8 trades fermés" }
  jusqu'à ce que les critères soient satisfaits.
```

**Comportement en semaine 1 :** le système analyse normalement, génère des signaux normalement, exécute normalement. La seule différence est que les poids de conviction restent à leurs valeurs par défaut sans calibration dynamique.

### Protocole de réévaluation des positions existantes

**Le problème :** 7 appels Claude par stock analysé × N positions en portefeuille × chaque jour = coût prohibitif. Mais ne pas réévaluer du tout = on tient des positions dont la thèse a changé.

**La solution — deux niveaux de vérification :**

```
VÉRIFICATION RAPIDE (quotidienne, automatique, 0 appel Claude) :
Tournée par update_positions() à 9h31 ET et toutes les 4h.
Vérifie uniquement :
  → Prix vs stop-loss (gap overnight rule)
  → Prix vs take-profit
  → Trailing stop-loss update
  → Earnings calendar : l'action a-t-elle des earnings dans < 3 jours ?
  → Durée : la position dépasse-t-elle 21 jours ?
Coût : ~0. Aucun appel Claude. Données FMP price quote uniquement.

RÉÉVALUATION COMPLÈTE (hebdomadaire, dimanche soir, dans la boucle stratégique) :
Pour chaque position ouverte en portefeuille :
  → Recalculer C1 (fraîcheur du signal PEAD)
  → Recalculer C2 (momentum technique semaine écoulée)
  → Recalculer C6 (news des 7 derniers jours)
  → Coût : 3 appels Claude par position (pas les 7 du pipeline d'entrée — pas de Bull/Bear)
  → Si conviction recalculée < 40 → signal EXIT pour lundi matin
  → Si conviction recalculée 40-59 → note d'alerte, surveiller, exit si continue à décliner
  → Si conviction recalculée ≥ 60 → maintenir la position

MÉMOIRE DE THÈSE D'ENTRÉE :
Stocker dans Supabase (table positions) : strategy_used + C1/C2/C3 au moment de l'entrée.
À la réévaluation, Claude reçoit : "Tu as acheté ce stock le {date} avec C1={c1_entry},
C2={c2_entry}, C3={c3_entry}. La thèse était : {rationale_entry}. Réévalue si elle tient
encore." Cela évite l'anchoring car Claude voit la thèse originale ET les données actuelles.
```

### Estimation des coûts opérationnels par semaine

```
Analyse initiale (20-30 stocks × 7 appels) : ~175 appels Claude/jour = ~$1.75/jour
Réévaluation hebdo positions (10 positions × 3 appels) : ~30 appels = ~$0.30/semaine
Boucle stratégique dimanche : ~5 appels = ~$0.05
Vérifications rapides quotidiennes : 0 appel Claude

Budget estimé : ~$12-15/semaine en phase active (paper trading)
→ À monitorer dans agent_logs avec alerte si > $25/semaine (dérive détectée)
```

### Heartbeat monitoring (MindStudio article)

**Le problème :** un pg_cron qui crashe silencieusement ne génère aucune alerte. Le système paraît fonctionner mais ne fait rien.

```typescript
// Écrit par run_eod_digest() à la fin de chaque journée de trading
// Stocké dans Supabase Storage ou table system_health
interface Heartbeat {
  timestamp: string;          // ISO8601
  status: "ok" | "skipped_market_closed" | "partial_error";
  cycles_completed: number;   // combien de stocks ont été analysés aujourd'hui
  trades_executed: number;
  errors: string[];
  last_position_update: string;
}

// Règle de monitoring : si heartbeat.status != "ok" à 17h30 ET un jour de marché
// → alerte email immédiate → investigation manuelle
```

### Email digest quotidien (MindStudio article)

Envoyé automatiquement par `run_eod_digest()` à 16h15 ET via SendGrid ou Mailgun.

```
OBJET : [AI Trader] 2026-05-24 — P&L: +$142 | 2 trades | 8 positions

CORPS :
Portfolio : $X,XXX (+1.2% today)
Cash disponible : $X,XXX (X% du total)

Trades exécutés aujourd'hui :
  BUY  TICKER1 — 150 shares @ $42.30 — conviction 78 — raison : [rationale court]
  SELL TICKER2 — 200 shares @ $67.10 — raison : trailing stop atteint (+15%)

Positions tenues sans action :
  TICKER3 : HOLD — C1 still strong (earnings drift Day 4), C2 momentum intact
  TICKER4 : HOLD — conviction 65, watching C6 sentiment shift
  [... toutes les positions analysées, même celles sans trade]

Régime marché : GUIDED (VIX 19.2, SPY au-dessus MA50)
Prochains earnings dans le portefeuille : TICKER5 dans 4 jours → à surveiller

Erreurs/alertes : aucune
Heartbeat : ✓ OK — 22 stocks analysés, 7 appels Claude/stock
```

**Pourquoi "même les HOLD sont loggés" (MindStudio article) :** un HOLD est une décision de trading, pas une absence de décision. Si je HOLD NVDA aujourd'hui et que ça monte 8% demain, je dois savoir pourquoi j'ai tenu la position pour calibrer ma confiance dans le signal. Si je HOLD et ça baisse, je dois savoir si les signaux indiquaient déjà la faiblesse. Sans ce log, la boucle d'apprentissage est brisée.

**Source** : 3S-Trader — l'élément différenciateur qui fait passer de 96% à 131% de return.

**Validation P11 (Ding et al. survey)** : La boucle de stratégie implémente exactement l'architecture "reflection-driven" identifiée comme la plus performante dans la littérature LLM trading. FinAgent (reflection + mémoire) surpasse FinMem (mémoire seule) qui surpasse les agents news-only. Notre système suit cette hiérarchie : raw data → passes d'analyse (mémoire) → boucle stratégique (reflection) → décision guidée.

### Déclenchement
Chaque dimanche soir (20h ET), après la clôture du marché.

### Inputs de l'agent Strategy
```
- Historique des 10 dernières semaines de stratégies adoptées
- Performance portfolio chaque semaine (return vs universe return)
- Scores détaillés de chaque stock analysé cette semaine
- Returns réalisés de chaque position fermée
- Contexte macro actuel (VIX, taux, régime)
```

### Ce que l'agent Strategy produit
```typescript
interface WeeklyStrategy {
  week: number;
  market_regime: string;
  cluster_weights: {        // peut évoluer semaine à semaine
    c1_earnings: number;    // ex: 0.25 → 0.30 si PEAD fort cette semaine
    c2_momentum: number;
    c3_smart_money: number;
    c4_quality: number;
    c5_valuation: number;
    c6_sentiment: number;
  };
  preferred_strategies: string[];  // ex: ["S2", "S4"] si momentum fort
  sector_bias: string[];           // ex: ["Technology", "Healthcare"]
  risk_adjustment: number;         // multiplicateur de sizing (0.5 à 1.5)
  strategy_text: string;           // texte naturel injecté dans le prompt
  rationale: string;
}
```

### Exemples d'évolution de stratégie
```
Semaine 1 : "Favoriser les stocks avec C1 > 7 (PEAD actif post-earnings)"
Semaine 2 : "Réduire exposition tech, renforcer healthcare (Congress trades détectés)"
Semaine 3 : "VIX > 22 → Strict Mode, favoriser C4 Quality Gate comme filtre primaire"
```

---

## 10. Schéma Supabase

### Tables principales

```sql
-- Universe de stocks (rebuil chaque dimanche)
CREATE TABLE watchlist (
  symbol TEXT PRIMARY KEY,
  name TEXT,
  sector TEXT,
  market_cap BIGINT,
  avg_volume BIGINT,
  beta NUMERIC,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE
);

-- Signaux générés par Claude
CREATE TABLE signals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  ticker TEXT NOT NULL,
  action TEXT CHECK (action IN ('BUY', 'SELL', 'HOLD')),
  conviction INTEGER CHECK (conviction BETWEEN 0 AND 100),
  position_size_pct NUMERIC,
  entry_price_target NUMERIC,
  stop_loss_pct NUMERIC,
  take_profit_pct NUMERIC,
  strategy_used TEXT,
  rationale TEXT,
  key_risks JSONB,
  hold_days_estimate INTEGER,
  -- Scores détaillés
  score_c1_earnings NUMERIC,
  score_c2_momentum NUMERIC,
  score_c3_smart_money NUMERIC,
  score_c4_quality NUMERIC,
  score_c5_valuation NUMERIC,
  score_c6_sentiment NUMERIC,
  -- Données macro au moment du signal
  vix_at_signal NUMERIC,
  market_regime TEXT,
  -- Validation
  reviewer_verdict TEXT CHECK (reviewer_verdict IN ('APPROVE', 'REJECT', 'PENDING')),
  code_validation TEXT,
  executed BOOLEAN DEFAULT FALSE
);

-- Positions Alpaca
CREATE TABLE positions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ticker TEXT NOT NULL,
  signal_id UUID REFERENCES signals(id),
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  entry_price NUMERIC NOT NULL,
  exit_price NUMERIC,
  quantity NUMERIC NOT NULL,
  position_size_usd NUMERIC,
  stop_loss_price NUMERIC,
  take_profit_price NUMERIC,
  alpaca_order_id TEXT,
  status TEXT CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
  exit_reason TEXT,  -- 'stop_loss' | 'take_profit' | 'signal' | 'timeout' | 'manual'
  pnl_usd NUMERIC,
  pnl_pct NUMERIC,
  hold_days INTEGER
);

-- Stratégies hebdomadaires
CREATE TABLE strategies (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  week_number INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  cluster_weights JSONB NOT NULL,
  preferred_strategies JSONB,
  sector_bias JSONB,
  risk_adjustment NUMERIC DEFAULT 1.0,
  strategy_text TEXT,
  rationale TEXT,
  -- Performance associée
  portfolio_return_pct NUMERIC,
  universe_return_pct NUMERIC,
  alpha_pct NUMERIC
);

-- Logs des appels Claude
CREATE TABLE agent_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  log_type TEXT,  -- 'analysis_pass1' | 'analysis_pass2' | 'analysis_pass3' | 'decision' | 'reviewer' | 'strategy_loop'
  ticker TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  cost_usd NUMERIC,
  raw_output JSONB,
  error TEXT
);

-- Snapshot portfolio quotidien (pour dashboard P&L)
CREATE TABLE portfolio_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  total_value_usd NUMERIC NOT NULL,
  cash_usd NUMERIC,
  positions_value_usd NUMERIC,
  daily_return_pct NUMERIC,
  cumulative_return_pct NUMERIC,
  sharpe_ratio NUMERIC,
  max_drawdown_pct NUMERIC,
  open_positions INTEGER
);

-- Heartbeat système (monitoring uptime)
CREATE TABLE system_heartbeats (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  recorded_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT CHECK (status IN ('ok', 'skipped_market_closed', 'partial_error', 'full_error')),
  cycles_completed INTEGER DEFAULT 0,
  trades_executed INTEGER DEFAULT 0,
  stocks_analyzed INTEGER DEFAULT 0,
  errors JSONB,
  notes TEXT
);
```

---

## 11. Dashboard — spécifications

### Interface privée admin (1 seul user)
- Auth : magic link Supabase sur ton email
- Stack : Next.js 14, Tailwind CSS, Vercel
- Temps réel : Supabase Realtime subscriptions

### Sections du dashboard

**Vue principale — Portfolio live**
```
- Total value (USD) + variation J/J
- P&L total (%) + P&L aujourd'hui
- Cash disponible
- Tableau des positions ouvertes :
  ticker | entrée | prix actuel | P&L | stop-loss | take-profit | conviction | jours
```

**Vue signaux**
```
- Derniers signaux générés (BUY/SELL/HOLD)
- Statut validation (Reviewer + Code)
- Logs de raisonnement Claude (rationale expandable)
- Scores par cluster pour chaque signal (C1 avec détail analyste/CFO/exec)
- Jours depuis earnings + multiplicateur fraîcheur C1
```

**Vue performance**
```
- Courbe P&L (cumulative return vs S&P500)
- Sharpe Ratio glissant (30 jours)
- Max Drawdown
- Win rate + average win / average loss
- Distribution des returns par stratégie S1-S4
- Information Coefficient (IC) : corrélation entre scores de conviction et returns réalisés
  → IC > 0.05 : signal prédictif valide / IC < 0 : signal inversé / IC ~ 0 : signal bruit (P11)

⚠️ MÉTRIQUES ANTI-BIAIS (FinCall-Surprise P7) :
- Ratio BUY/SELL/HOLD des signaux générés (alerte si > 80% BUY → biais majoritaire)
- Precision sur les signaux C1 POSITIF vs NÉGATIF (macro-average, pas accuracy)
- Recall sur les signaux négatifs (si recall_négatif < 0.30 → système trop bullish)
- F1-score macro (target > 0.55, alarm si < 0.50)
```

> **Pourquoi ces métriques ?** FinCall-Surprise montre que 15/26 modèles dépassent 70% d'accuracy mais ont un F1 de 0.50 (=aléatoire) parce qu'ils ne prédisent que la classe majoritaire. Notre système doit suivre le F1 macro et le recall sur les signaux négatifs pour détecter ce biais précocement.

**Vue stratégie**
```
- Stratégie courante de la semaine
- Historique des 10 dernières semaines
- Évolution des poids clusters dans le temps
- Régime marché actuel (VIX, SPY vs MA50)
```

**Vue logs**
```
- Journal des appels Claude (coût, latence, tokens)
- Logs d'erreurs
- Historique des ordres Alpaca
- Alerte si ratio signaux positifs/négatifs > 85% (biais détecté)
```

---

## 12. Plan de backtesting

### Phase 1 — Paper trading (à partir de 100€ équivalent simulé)
- Durée minimum avant argent réel : **12 semaines**
- Métriques à atteindre pour passer en réel :
  - Sharpe > 1.0 sur 12 semaines
  - Max Drawdown < 20% sur la période
  - Win rate > 40%
  - Au minimum 30 trades clôturés pour avoir de la statistique

### Phase 2 — Backtesting historique (avant déploiement)
Utiliser `/eod-bulk` FMP pour reconstruire les prix historiques et simuler les décisions du système sur 2022-2024 (marchés haussier + baissier + flat).

**Outil recommandé** : Pas de QuantConnect ou autre outil externe. Backtesting simple en TypeScript avec les données FMP bulk. Logique :
```
Pour chaque semaine de 2022 à 2024 :
  1. Charger les données FMP pour cette semaine (historique)
  2. Faire tourner le scoring + décision Claude
  3. Simuler l'exécution (prix d'ouverture J+1)
  4. Calculer les returns
```

**Limitation importante** : Le backtesting avec un LLM souffre du "memorization problem" (Lopez-Lira, Tang & Zhu, 2025, cité dans Strat-LLM) — Claude peut avoir des données de 2022-2024 dans son training. Nos résultats de backtesting seront donc probablement optimistes. C'est pour ça que le paper trading live de 12 semaines est la vraie validation.

**Contexte de la littérature (P11 survey)** : La médiane de backtesting dans les 27 papers revus est seulement **1.3 ans**. Notre cible de 12 semaines paper trading + 2.5 ans de backtesting historique (2022-2024) est déjà au-dessus de la norme académique. Ne pas réduire cette exigence même si les premiers résultats semblent encourageants.

---

## 13. Ordre de build

### Phase 1 — Fondations (Semaine 1-2)
```
1. Setup Supabase : créer les tables (Section 10)
2. Setup Alpaca : compte paper trading, API keys
3. Variables d'environnement : FMP_API_KEY, ANTHROPIC_API_KEY, ALPACA_KEY
4. Edge function : run_screener() → popule watchlist
5. Test : appel FMP MCP direct depuis une edge function
```

### Phase 2 — Moteur de scoring (Semaine 3-4)
```
6. Edge function : collect_stock_data(ticker) → appelle les 15 endpoints FMP
7. Edge function : run_analysis_passes(ticker) → 3 passes Claude
8. Edge function : calculate_scores(ticker) → calcule les 6 clusters
9. Test unitaire : analyser AAPL, vérifier que les scores sont cohérents
```

### Phase 3 — Décision & exécution (Semaine 5-6)
```
10. Edge function : run_bull_researcher(ticker, scores, reports) → rapport bullish JSON
11. Edge function : run_bear_researcher(ticker, scores, reports) → rapport bearish JSON
    (parallélisables — deux appels indépendants sans contexte partagé)
12. Edge function : generate_decision(ticker, scores, bull_bear) → décision JSON Claude Trader
13. Edge function : review_decision(ticker, decision) → Reviewer 3-perspectives APPROVE/REJECT
14. Edge function : validate_order(decision, portfolio) → validation code Couche 2
15. Edge function : execute_order(decision) → Alpaca API
16. Test complet : analyser 5 stocks, vérifier la boucle complète (7 appels par stock)
```

### Phase 4 — Scheduler & boucle stratégie (Semaine 7)
```
15. Configurer pg_cron : daily-analysis, position-update, strategy-loop, screener
16. Edge function : run_strategy_loop() → Strategy Agent du dimanche
17. Test : laisser tourner 1 semaine complète en paper trading
```

### Phase 5 — Dashboard (Semaine 8-9)
```
18. Next.js app : setup Vercel, auth magic link
19. Composants : portfolio live, signaux, performance, logs
20. Supabase Realtime : mise à jour temps réel
21. Déploiement Vercel
```

### Phase 6 — Validation & paper trading
```
22. 12 semaines de paper trading minimum
23. Monitoring quotidien
24. Ajustements basés sur les résultats réels
```

---

## 14. Décisions ouvertes

Ces points seront résolus au fur et à mesure des nouveaux papers et des résultats de paper trading.

| # | Question | Status | Impact |
|---|---|---|---|
| D1 | Poids exact de C1 (PEAD) — 25% est une hypothèse | **Clos** — architecture finale : transcript pondéré (analyste 49%, CFO 30%, exec 16%) + EPS + fraîcheur | Fort |
| D2 | Poids exact de C3 (Smart Money) — 20% est une hypothèse | **Ouvert — résolution empirique uniquement** : calibré par la boucle stratégique après 8 semaines de données | Fort |
| D3 | Horizon PEAD optimal pour swing trading | **Clos** — half-life 6-7j. Signal optimal 0-10j, encore valide 10-21j. Au-delà : signal marginal | Moyen |
| D4 | Faut-il un 7ème cluster (ESG ou COT) ? | **Clos — NON pour V1.** COT = signal macro futures sans lien direct avec mid-caps equity. ESG = pas d'alpha prouvé à l'horizon swing. Reconsidérer en V2 si boucle stratégique détecte un angle macro manquant. | Faible |
| D5 | Conviction minimum pour trader (actuellement 60) | **Clos — approche empirique** : fixer à 60, mesurer IC par tranche (60-70 / 70-80 / 80-90 / 90-100) sur 8 semaines. Si tranche IC < 0 → monter le seuil. Si < 3 signaux/semaine en GUIDED Mode → baisser à 55. | Fort |
| D6 | Passer à Kimi-K2 si paper trading déçoit sur 12 semaines ? | **Trigger défini** : si après 12 semaines Sharpe < 0.8 ET IC moyen clusters < 0.03 → tester Kimi-K2 en parallèle (4 semaines, 5 stocks identiques, même univers). Comparer IC et Sharpe. Décision finale sur données comparatives. | Moyen |
| D7 | Ajouter earning call transcripts (Section 16 FMP) en Passe 3 ? | **Clos — OUI** | Fort |
| D8 | Intégrer les données COT dans C3 ? | **Clos — NON pour V1.** C3 a déjà 4 signaux forts (insider CEO/CFO, clustered buys, Congress, institutionnel). COT diluerait sans gain évident sur equity mid-cap. | Faible |
| D9 | Adapter les poids C1 par secteur ? | **Partiellement clos** — Healthcare ajusté | Moyen |
| D10 | Ajouter une règle de fraîcheur décroissante sur C1 ? | **Clos — OUI** | Moyen |
| D11 | Tracker precision/recall/F1 macro (pas seulement win rate) ? | **Clos — OUI** (FinCall-Surprise P7) — ajouté au dashboard | Moyen |
| D12 | Stratégie de gestion des transcripts trop longs (> 31K tokens) ? | **Clos** — résumer opérateur → exec → analyste en dernier (P7) | Faible |
| D13 | Faut-il activer le context-priming C6 à partir de C2 ≥ 7 seulement, ou dès C2 ≥ 5 ? | **Ouvert — résolution empirique** : mesurer Sharpe et IC avec seuil 7 vs 5 sur les premières 8 semaines de paper trading. | Faible |
| D14 | Architecture déploiement : Claude Code Routines (CLI) vs pg_cron + Edge Functions | **Clos — pg_cron + Supabase Edge Functions.** Raisons : (1) 24/7 sans machine active — pg_cron tourne dans PostgreSQL Supabase indépendamment, (2) Edge Functions déployées et versionnées, (3) flux direct Edge Functions → Supabase tables → Realtime → dashboard Vercel, (4) Claude Code reste l'outil de *développement*, pas le runtime de production. | Fort |

---

## 15. Changelog papers

### Papers intégrés
| # | Paper | Clusters impactés | Décisions modifiées |
|---|---|---|---|
| P1 | TradExpert (ICLR 2025) | C2, C6, Architecture | Multi-passes, ablation OHLCV+News |
| P2 | Strat-LLM (2026) | Tous | Guided Mode, régime, S1-S4, risk anchor |
| P3 | 3S-Trader (2025) | C1, Scoring, Strategy Loop | 6 dimensions scoring, boucle dimanche |
| P4 | StockBench (2026) | Architecture, métriques | 10 stocks max, Sortino comme KPI |
| P5 | Medya et al. (2022) | C1 (majeur), C6 | Transcript = input primaire ; reco pré-earnings retirées ; LIWC dimensions |
| P6 | Sidhu, Fan & Pishgar (2026) | C1 (refonte complète) | Pondération par locuteur (49/30/16/5) ; règle fraîcheur ; signal contrarian |
| P7 | Shu et al. — FinCall-Surprise (2025) | C1 prompt, Dashboard, Architecture | Avertissement biais classe ; prompt JSON structuré ; métriques F1/precision/recall ; anti-fine-tuning ; gestion transcripts longs |
| P8 | Anic, Barbon, Seiz & Zarattini (2025) | C2 (synergy), C6 (majeur), Section 7 | Context-priming C6 ; lookback 24h ; synergy C2×C6 ; 4ème confirmation anti-fine-tuning ; principe prompts simples |
| P9 | Huang, Capretz & Ho (IEEE SSCI 2021) | C4 (CapEx signal), Section 7 | CapEx change ajouté à C4 ; hiérarchie features fondamentales RF validée ; principe consensus strict renforcé |
| P10 | Gimeno, Lobán & Vicente (Finance Research Letters 2020) | C4 (majeur), Section 2 | F-Score invalide large-caps US confirmé ; principe NF-Score (non-binaire + interactions) ; validation univers mid-cap |
| P11 | Ding, Li, Wang et al. — Survey (Columbia/NYU 2026) | Section 7, Section 9, Section 11, Section 12 | 5ème confirmation anti-fine-tuning ; risque comportemental sous pression ; reflection architecture validée ; IC ajouté au dashboard ; norme backtesting contextualisée |
| P12 | Schwartz & Hanauer (TUM/Robeco, Dec 2024) | C4 (majeur), C5 (majeur), Section 7 régime | F-Score = exposition factorielle pure (alpha capturé FF5FM) ; Quant Winter warning C4/C5 STRICT Mode ; Magic Formula alpha résiduel robuste ; EV/EBITDA ajouté C5 ; validation combinaison C4+C5 ≈ Magic Formula |
| P13 | Xie, Han, Lai, Peng, Huang — Wall Street Neophyte (Wuhan Univ., Apr 2023) | Section 4 Passe 1, Section 8 Couche 2 | Interdiction OHLCV bruts comme input LLM (indicateurs pré-calculés obligatoires) ; validation ticker ajoutée en Couche 2 ; paper de contexte — notre architecture multi-passes évite tous les échecs documentés |
| P14 | Xiao, Sun, Luo, Wang — TradingAgents (UCLA/MIT/Tauric, arXiv Dec 2024/Jun 2025) | Section 4 (majeur), Section 7 (majeur), Section 13 | Bull/Bear Researcher Team ajouté avant décision Trader ; protocole communication structuré (anti-telephone-effect) ; Reviewer enrichi 3 perspectives risque ; pipeline 5 appels → 7 appels Claude ; TradingDecision enrichi de bull_bear_synthesis |
| P15 | Huang, Ma et al. — MaBoost/IFD (UESTC/SMU/UNL, arXiv 2025) | C3 (data quality), Section 6 | TRANDATE vs FDATE — 17.4% des filings tardifs ; taux de violation par rôle (CEO 10.88% vs Beneficial Owner 22.24%) ; violations intentionnelles comme signal comportemental ; recency window ajustée 45j pour beneficial owners |
| P16 | Jeong & Kim — F-SCORE Loser Following Online Portfolio (Chung-Ang University, 2019) | C4 (note de confirmation, portée limitée) | 3ème confirmation géographique (KOSPI coréen) que F-Score = filtre de présélection, pas discriminant alpha intra-univers ; **portée directe limitée** (marché coréen, rebalancement quotidien ML) |
| P17 | Altman — Financial Ratios, Discriminant Analysis and the Prediction of Corporate Bankruptcy (Journal of Finance, 1968) | C4 (formalisation) | Paper original du Z-Score — 3 zones formalisées (safe >2.99, gray 1.81-2.99, danger <1.81) ; cut-off optimal 2.675 ; 5 composantes X₁-X₅ ; limite 2 ans de fiabilité prédictive |
| P18 | Piotroski — Value Investing: The Use of Historical Financial Statement Information to Separate Winners from Losers (Journal of Accounting Research, 2000) | C4 (formalisation majeure) | Paper original du F-Score — 9 signaux définis explicitement par zone (A: ROA/ΔROA/CFO/ACCRUAL, B: ΔLEVER/ΔLIQUID/EQOFFER, C: ΔMARGIN/ΔTURN) ; signal ACCRUAL et EQOFFER ajoutés au barème C4 ; IC agrégé (0.121) > individuel (ROA 0.086) valide l'approche composite |

### Changements apportés par P18
- **Contexte** : le paper original Piotroski (2000) était cité sans numéro et sans les définitions des 9 signaux. Comme pour Altman (P17), ces fondations étaient utilisées mais non documentées. C'est le **dernier paper** de la série P1-P18.
- **C4 base académique** : Piotroski (2000) → P18 avec les 9 signaux définis explicitement par zone A/B/C. Chaque signal est maintenant nommé (F_ROA, F_ΔROA, F_CFO, F_ACCRUAL, F_ΔLEVER, F_ΔLIQUID, F_EQOFFER, F_ΔMARGIN, F_ΔTURN) avec sa logique économique.
- **Signal ACCRUAL ajouté au barème** : si ROA > CFO/actifs, les profits sont gonflés par des accruals comptables — pénalité -1. C'est le signal Sloan (1996) de surperformance comptable non soutenue par les flux réels, particulièrement dangereux sur firmes mid-cap distressed. FMP fournit ROA et CFO dans `/financial-scores` et `/cash-flow-statement`.
- **Signal EQOFFER ajouté au barème** : émission d'actions récente (< 12 mois) sur firme mid-cap distressed = pénalité -1. Signal fortement négatif selon Piotroski : une firme qui émet des actions à prix déprimé signale son incapacité à se financer en interne.
- **NF-Score block enrichi** : les deux signaux critiques (ACCRUAL, EQOFFER) maintenant explicitement mentionnés dans le bloc de guidance Claude avec leur logique économique.
- **Corrélation IC documentée** : F-SCORE agrégé (IC 0.121) > meilleur signal individuel ROA (0.086) — valide formellement notre approche multi-signal vs mono-ratio dans C4.
- **Contexte de conception confirmé** : le F-Score a été conçu pour les high BM firms (value, distressed) ignorées par les analystes — exactement notre univers mid-cap 2B-20B avec 5-20 analystes.

### Changements apportés par P17
- **Contexte** : le paper original Altman (1968) était déjà cité dans C4 sans numéro de paper et sans les détails du modèle. Il est maintenant formalisé comme P17. Le user a fourni un copier-coller partiel (papier derrière paywall) — les sections clés des résultats et applications sont couvertes.
- **C4 base académique** : Altman (1968) → P17 avec les 3 zones complètes (safe > 2.99, gray 1.81–2.99, danger < 1.81), le cut-off optimal à 2.675, les 5 composantes du modèle (X₁ liquidité, X₂ profitabilité cumulée, X₃ efficacité opérationnelle, X₄ levier marché, X₅ rotation actifs), et la limite de fiabilité à 2 ans.
- **C4 scoring table** : mise à jour des seuils Altman (2.5 → 2.675, "zone grise" explicitement labelisée) pour refléter le cut-off optimal du paper original. Les 5 lignes du barème utilisent maintenant les zones nommées du paper.
- **Note gray area** : ajout d'une note guidant Claude sur la prudence accrue requise pour les stocks en zone grise (1.81–2.675) — s'appuyer sur les composantes X₁-X₅ individuellement plutôt que sur le score composite.
- **Confirmation de notre usage** : le Z-Score est fiable à 95% à 1 an et 72% à 2 ans, puis se dégrade rapidement. Pour du swing trading 3-21 jours, on utilise le Z-Score comme filtre d'état courant — exactement son usage optimal selon le paper.

### Changements apportés par P16
- **Impact minimal — paper de confirmation** : Jeong & Kim (2019) est un paper de portée limitée (journal non-top-tier, marché coréen KOSPI, stratégies de rebalancement quotidien ML sans LLM). Aucun changement architectural ou de règle de scoring.
- **C4 note de confirmation** : dans un univers de value stocks pré-filtré par F-Score, subdiviser en groupes High vs Low F-Score n'améliore pas le risk-adjusted return par rapport à traiter l'ensemble comme un seul portefeuille. 3ème confirmation géographique après P10 (US+Europe) et P12 (US 60 ans) : le F-Score est pertinent comme filtre d'entrée d'univers, pas comme discriminant intra-univers.

### Changements apportés par P15
- **C3 base académique complétée** : ajout de Huang, Ma et al. (2025) comme source sur la qualité des données Form 4. La base "À compléter avec les nouveaux papers" est remplacée par une documentation complète des taux de violation par rôle.
- **Règle TRANDATE vs FDATE — critique opérationnelle** : notre règle "30 jours" sur les achats insiders doit mesurer depuis la date de transaction (transactionDate dans FMP), pas la date de dépôt. 17.4% des filings sont tardifs — sans cette correction, des trades d'il y a 45 jours peuvent apparaître "récents" dans le feed FMP.
- **Taux de violation différentiels par rôle** : CEO/Corporate Suite (~10.7% de violation) = signal temporellement fiable. Beneficial Owners (22.24%) = timing moins fiable → fenêtre de recency étendue à 45 jours pour cette catégorie. Renforce la hiérarchie CEO/CFO > Beneficial Owner déjà implicite dans notre scoring.
- **Pénalité filing tardif** : si un achat CEO/CFO est accompagné d'un délai de dépôt > 5 jours ouvrés (signal stale possible), pénalité -1 sur le score C3.
- **Violations intentionnelles comme contexte comportemental** : un insider qui viole ≥95% du temps mais dépose dans les délais = comportement anormal que Claude doit noter. Pas de changement de barème de scoring automatique, mais un flag contextuel dans le raisonnement.
- **Section 6 Mapping FMP** : note ajoutée sur `/insider-trading/search` pour forcer l'utilisation de `transactionDate`.

### Changements apportés par P14
- **REFONTE ARCHITECTURE (v2.0)** : ajout du Bloc 3.5 (Researcher Team Bull/Bear) entre le scoring et la décision finale. C'est le changement architectural le plus important depuis P3 (3S-Trader).
- **Anti-anchoring bias** : l'ancien pipeline (Trader → Reviewer) souffrait d'anchoring — le Reviewer voyait la conclusion et y était ancré. Le nouveau pipeline (Analysts → Bull/Bear Debate → Trader Synthesis → Reviewer) est fondamentalement plus robuste.
- **Protocole communication structuré** : règle explicite — chaque agent passe des rapports JSON compacts au suivant, jamais de chat brut. Le "telephone effect" (dégradation d'info sur longs historiques) est un échec documenté des systèmes multi-agents.
- **Reviewer 3-perspectives** : l'appel Reviewer unique intègre maintenant 3 sous-perspectives (Conservateur / Neutre / Agressif) pour enrichir la validation au-delà d'un simple APPROVE/REJECT binaire.
- **TradingDecision enrichi** : ajout de `bull_bear_synthesis` dans le JSON de sortie du Trader — traçabilité du débat pour le dashboard.
- **Section 13 build** : Phase 3 mise à jour pour inclure les deux appels Researcher parallèles (étapes 10-11 nouvelles).
- **⚠️ Caveat résultats P14** : Sharpe 6-8 sur 3 mois (Jan-Mar 2024 bull market, mega-caps uniquement) — non representatifs. L'apport est architectural, pas les métriques.
- **Coût pipeline** : passage de 5 à 7 appels Claude par stock. Sur 20 stocks/cycle → ~40 appels supplémentaires par cycle quotidien. Budget Anthropic API à surveiller dans `agent_logs`.

### Changements apportés par P13
- **Pertinence limitée mais ciblée** : ce paper teste GPT-3.5-turbo (2023) en zero-shot sur prédiction next-day à partir de tableaux OHLCV bruts. Notre système utilise Claude Sonnet (2025-2026) en Guided Mode sur 6 clusters de signaux structurés sur horizon 3-21 jours. Les résultats négatifs du paper ne s'appliquent pas directement.
- **Section 4 Bloc 2 — règle input Passe 1** : interdiction formelle de soumettre des tableaux OHLCV bruts à Claude. Les indicateurs calculés (RSI, MACD, SMA crossovers, ADX, Bollinger compression) doivent être présentés en format narratif structuré. Les données OHLCV brutes servent uniquement au calcul en amont.
- **Section 8 Couche 2** : ajout de deux vérifications de ticker — `isTickerInWatchlist()` et `requestedTicker === decision.ticker` — pour détecter toute confusion de ticker dans la réponse Claude (erreur documentée dans les Case Studies du paper).
- **Note d'architecture** : notre multi-passes avec indicateurs pré-calculés est exactement la solution aux 3 échecs documentés par P13 : (1) raw data → indicateurs calculés, (2) zero-shot → Guided Mode structuré, (3) next-day → swing trading 3-21 jours.

### Changements apportés par P12
- **C4 base académique** : F-Score démontre **zéro alpha indépendant** (FF5FM alpha = 0.74%, t=0.76, non-significatif) — l'ensemble de la surperformance est de l'exposition value + profitabilité + investissement. Cette clarté théorique renforce l'interdiction d'utiliser C4 comme signal BUY positif.
- **C4 rôle redéfini** : "filtre défensif plus que générateur d'alpha" → "filtre défensif **exclusivement**, jamais générateur d'alpha autonome" — distinction critique pour le prompt de décision finale
- **C4 avertissement Quant Winter** : en STRICT Mode, C4 passe en mode bloqueur pur. Le F-Score concentré a le drawdown max le plus élevé (57.5%) et la plus forte vulnérabilité aux crises facteur value (2018-2020)
- **C5 base académique** : refonte complète avec résultats P12 — Magic Formula (EBIT/EV + ROC) = seule formule avec alpha FF6FM significatif (4.15%/an, t=3.46) ; Acquirer's Multiple = meilleur rendement brut mais beta élevé (1.41)
- **C5 signal EV/EBITDA** : ajout du signal earnings yield via EV/EBITDA sectoriel (Bonus +1 si < médiane, Bonus +2 si < 50% médiane) — déjà disponible dans `/key-metrics-ttm-bulk` FMP
- **C5 insight architectural** : C4 (profitabilité/ROC) + C5 (earnings yield/EV) ≈ Magic Formula — notre architecture bi-cluster est académiquement la plus alpha-générative des 4 formules testées
- **Section 7 Régime Strict** : règle explicite — en STRICT Mode, C4 et C5 ne peuvent pas déclencher de BUY (bloqueurs uniquement) ; seuls C1 + C3 avec confirmation C2 sont valides comme signaux positifs

### Changements apportés par P11
- **Section 7 anti-fine-tuning** : 5ème confirmation unanime (27 papers revus, tous utilisent des LLMs généralistes non fine-tunés)
- **Section 7 (nouveau)** : risque comportemental sous pression documenté (LLMs peuvent prendre des actions non-éthiques) → nos 3 couches de validation sont la réponse correcte
- **Section 9** : validation explicite de notre reflection architecture (raw data → analyse → boucle stratégique = pattern optimal selon littérature)
- **Section 11 Dashboard** : IC (Information Coefficient) ajouté aux métriques de performance — mesure la corrélation entre scores de conviction et returns réalisés
- **Section 12** : contexte littérature ajouté — médiane backtesting académique = 1.3 ans, notre approche est au-dessus de la norme

### Changements apportés par P10
- **Section 2 (Univers)** : ajout note de validation — F-Score échoue sur large-caps US (-4.81% excess return), confirme que notre ciblage mid-cap est la bonne décision pour exploiter le Piotroski
- **C4 principe NF-Score** : Claude évalue les 9 signaux Piotroski en mode non-binaire (magnitude) ET considère les interactions entre les 3 zones financières (Bonus +1 si toutes zones alignées, Pénalité -1 si zones contradictoires)
- **C4 avertissement taille** : pénalité légère pour stocks en haut de fourchette ($15B-$20B) où la couverture analytique réduit l'efficacité du F-Score
- **C4 base académique** : NF-Score (+4.16% vs F-Score sur US, +3.53% sur Eurozone) documenté comme justification du mode d'évaluation Claude

### Changements apportés par P9
- **C4 Quality Gate** : ajout du signal CapEx (bonus +1 si croissance > 10% YoY, pénalité -1 si chute > 20%) — 5ème feature la plus prédictive dans l'analyse RF sur 22 ans de données
- **C4 base académique** : hiérarchie des features fondamentales documentée (PB > Momentum > Book Value > PE > CapEx > Liability)
- **Section 7 Reviewer** : principe du consensus strict ajouté (agg3 >> agg2 dans P9) — renforce l'exigence d'accord unanime Trader+Reviewer
- Note : PE et PB (features #1 et #4) déjà couverts dans C5 — pas de duplication

### Changements apportés par P8
- **C6 refonte** : ajout context-priming (prompt Passe 2 conditionné sur C2 ≥ 7) — innovation clé du paper
- **C6 lookback** : 48h → 24h primaire (48h secondaire si < 3 articles) — optimal empirique validé
- **C2 synergy note** : documentation explicite de l'interaction C2×C6 (le signal news conditionne le momentum, pas l'inverse)
- **Passe 2 input** : mise à jour pour inclure le score C2 et la logique context-priming
- **Section 7 anti-fine-tuning** : 4ème confirmation ajoutée (résultats OOS > IS chez Anic et al.)
- **Section 7 nouveauté** : principe des prompts simples — ne pas surstructurer C6 et décision finale
- **Section 2** : validation concentration 8-12 positions renforcée (P8 confirme P4)
- **D13 ouvert** : seuil d'activation context-priming (C2 ≥ 7 vs ≥ 5) à valider en paper trading

### Changements apportés par P7
- Avertissement biais de classe ajouté au prompt Passe 3 (80-89% positifs dans la vraie vie)
- Prompt C1 reformaté en JSON structuré avec justifications par locuteur
- Ordre de résumé des transcripts longs : Opérateur → Exec → Analyste en dernier
- Principe anti-fine-tuning documenté et justifié (Fin-LLaMa3 = 10% accuracy)
- Dashboard enrichi : F1-score macro, recall_négatif, alerte ratio BUY > 85%
- D11 clos (F1/precision/recall OUI), D12 clos (stratégie transcript longs)

### ✅ Document complet — v2.7 — Prêt pour le build

**Décisions fermées cette session :**
- D4 : NON au 7ème cluster (ESG/COT) pour V1
- D8 : NON au COT dans C3 pour V1
- D14 : pg_cron + Supabase Edge Functions — architecture définitive

**Décisions avec trigger défini (resteront ouvertes jusqu'aux données) :**
- D2 : poids C3 calibré par boucle stratégique après 8 semaines
- D6 : Kimi-K2 testé si Sharpe < 0.8 ET IC < 0.03 après 12 semaines
- D13 : seuil context-priming mesuré empiriquement en paper trading

**Plus aucune décision ne bloque le build.**

---

*Ce document est la source de vérité unique du système. Toute décision de build doit s'y référer.*
*Prochaine étape : Phase 1 du build (Section 13) — Setup Supabase + Alpaca paper trading + premier screener FMP.*
