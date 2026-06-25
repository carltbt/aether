# DEVIATIONS.md — Écarts vs STRATEGY.md

Ce fichier track toute décision d'implémentation qui s'écarte (temporairement ou définitivement) de la spec de STRATEGY.md. Chaque écart doit être documenté avec : raison, impact, critère de réévaluation.

---

## D-001 — FMP Premium au lieu d'Ultimate (V1 paper trading)

**Date** : 2026-05-25
**Statut** : Actif — réévaluation prévue après 6 semaines de paper trading
**Sections STRATEGY.md impactées** : 3 (Stack), 5 (C1, C3), 6 (Mapping FMP)

### Décision
Lancer V1 avec FMP **Premium** ($49/mo) au lieu d'Ultimate ($99/mo).

### Endpoints manquants vs STRATEGY.md
- `/earning-call-transcript` — Ultimate only → impacte **C1 (Earnings Catalyst, poids 25%)**
- `/institutional-ownership` (13F holdings) — Ultimate only → impacte **C3 (Smart Money, poids 20%)**
- `/eod-bulk` (Bulk delivery) — Ultimate only → impacte **Phase 2 backtest historique**

### Fallback appliqué
**Pour C1** (fallback déjà documenté dans STRATEGY.md Section 7) :
```
Transcript manquant → C1 = (EPS_score × 0.60 + upgrades_score × 0.40) × freshness_mult
```
→ C1 fonctionne sans la pondération locuteur 49/30/16/5 de Sidhu et al. P6.

**Pour C3** : pas de signal 13F, mais les 3 autres signaux restent (insider CEO/CFO, congress trades, insider stats).
- Impact relatif sur C3 : ~25% du signal perdu
- Impact système global : ~5% (C3 pèse 20%)

**Pour Phase 2 (backtest)** : on devra faire les calls EOD individuellement (rate-limité à 750/min, plus lent) au lieu d'un bulk delivery. Ralentit le backtest mais ne le bloque pas.

### Pourquoi cette décision
1. **Contrainte budgétaire user** ($50/mo additionnel = $600/an, non négligeable au démarrage)
2. **Pipeline Phase 1-3 indépendant** : les phases setup/scoring/exécution n'utilisent PAS les transcripts (ils arrivent en input C1 seulement)
3. **Réversibilité instantanée** : upgrade Ultimate prorata, prend 30 sec, rétroactif sur le mois courant
4. **Validation empirique > décision théorique** : on mesure si C1 dégradé suffit, on ne suppose pas

### Critères de réévaluation (trigger upgrade Ultimate)
Mesurer sur les 6 premières semaines de paper trading (Phase 6) :
- **Si Sharpe global > 1.0 ET IC C1 > 0.05** → C1 fallback est suffisant → garde Premium
- **Si Sharpe global < 0.8 OU IC C1 < 0.03** → C1 fallback insuffisant → upgrade Ultimate immédiat

Ces seuils découlent du trigger D6 défini dans STRATEGY.md Section 14 pour Claude Sonnet vs Kimi-K2.

### Métriques à tracker spécifiquement (Dashboard Section 11)
- IC C1 isolé (séparé des autres clusters) pour mesurer l'efficacité de la formule fallback
- F1 macro des prédictions C1 (positive surprise vs negative surprise vs neutral)
- Comparaison Sharpe portfolio vs Sharpe simulé "si on retirait C1" — pour quantifier la contribution réelle de C1 dégradé

### Coût opportunité accepté
Si C1 dégradé sous-performe pendant les 6 premières semaines, on aura "perdu" potentiellement quelques bons signaux qui auraient été captés avec le transcript pondéré. Cette perte est acceptée comme prix de la validation empirique.

---

## D-002 — Refonte de la logique de sortie (diagnostic 18/06)

**Date** : 2026-06-20
**Statut** : Actif — réévaluation après 4 semaines de paper trading
**Sections STRATEGY.md impactées** : 8 (Couche 2/3, gestion de position)

### Contexte (ce qui a déclenché)
Sur les ~10 premiers jours live, le portefeuille a culminé à +$559 puis tout rendu (−$346) : les gains n'étaient pas protégés. Causes identifiées :
1. Bracket Alpaca soumis en `time_in_force=day` → les legs stop/TP **expiraient** chaque soir → aucune protection native (0 ordre ouvert observé). GTLB a fini à **−11.3%** alors que son stop était à −7.5%.
2. `update-positions` ne tournait **qu'une fois en séance** (cron 13/17/21 UTC, marché 13:30–20:00).
3. Trailing trop haut (lock dès +8%) → les hausses 3–7% (la majorité) round-trippaient jusqu'au stop.
4. Hold max 21j ≫ demi-vie PEAD (~6-7j).
5. Les positions tenues étaient ré-analysées mais sans **aucun chemin de sortie LLM** (HOLD = ne pas entrer).

### Écarts vs STRATEGY.md
- **Bracket GTC** (au lieu de l'entrée day) : entrée LIMIT marketable (+0.3%) + `time_in_force=gtc` → legs stop/TP persistants.
- **Cadence update-positions** : `*/30 13-20` (toutes les 30 min en séance) au lieu de 3×/jour. + cancel des ordres Alpaca du symbole avant toute vente manuelle (anti-oversell).
- **Trailing plus fin** : lock break-even+0.5% dès +4% (vs +8%), puis +3% / +7% / +12% à +7 / +12 / +18%.
- **Règle give-back (NOUVELLE)** : sortie si pic de gain ≥ +5% ET retour sous 50% du pic.
- **Hold max 21j → 10j**.
- **review-positions (NOUVELLE fonction, cron 15:15 UTC)** : revue LLM quotidienne HOLD/SELL des positions tenues, avec contexte du holding (P&L, jours, pic, thèse) — peut déclencher la vente. Couche qualitative complémentaire aux règles prix.
- **Dédup ticker** (déjà D-rien, noté ici) : validate-order rejette si position OPEN sur le ticker ; execute-order vérifie aussi les positions Alpaca live ; select-daily-candidates exclut les tickers détenus.

### Pourquoi
Protéger le capital prime sur la fidélité à la spec V1. Les seuils de STRATEGY.md (trailing 8%, hold 21j) ont été écrits avant observation empirique ; les données live montrent qu'ils laissent fuir les gains sur des swings PEAD courts.

### Critères de réévaluation
Sur 4 semaines : si le profit factor passe > 1.3 ET le give-back médian (gain rendu) < 30% → la nouvelle logique tient. Sinon, recalibrer les seuils (give-back 50%→40%, hold 10→7j). Mesurer aussi le taux de SELL de review-positions (si > 50% des revues = SELL → prompt trop agressif, churn).

---

## D-003 — Hardening post-audit multi-agents (25/06)

**Date** : 2026-06-25
**Statut** : Actif
**Sections impactées** : 5 (scoring), 8 (sortie/risque), 9 (strategy loop)

Suite à l'audit multi-agents (26 agents, vérif DB live), batch de correctifs de **fiabilité/correctness** (pas de changement de thèse stratégique) :

- **Auto-tuner désarmé** : `run-strategy-loop` en `SHADOW_MODE` — Claude propose des poids mais on n'applique JAMAIS (les poids actifs restent DEFAULT). Plancher `MIN_TRADES_FOR_ADJUSTMENT` 8 → 30. Motif : sur ~5-8 trades, l'IC est du bruit (r≈0.7 pour p<0.05 à n=8) ; `calculate-scores` lit ces poids en live → risque de dérive. Réarmer seulement après backtest + échantillon significatif.
- **Timeout en jours de BOURSE** : `MAX_HOLD_TRADING_DAYS=8` (avant : 10 "jours" calendaires ambigus → sorties réelles à 13-18j).
- **Peak tracking réparé** : `getCurrentPrice` lit `dayHigh` → `peak_price` monte enfin → la règle give-back (inerte jusque-là) est active.
- **Cap dur** `MAX_CONCURRENT_POSITIONS=10` dans validate-order.
- **No-oversell (incident KBH)** : le bracket GTC peut clôturer une position (TP/stop filled) avant le check manuel d'`update-positions`/`review-positions` → la vente manuelle créait un SHORT (KBH -83). Fix : lire la qty RÉELLE Alpaca avant toute vente ; si 0, réconcilier la DB sans ordre ; sinon vendre `min(qtyRéelle, qtyDB)`.
- **Observabilité** : heartbeats START/END dans run-daily-analysis + `ops-watchdog` (cron 16:45 UTC) qui alerte Discord si une fonction du jour n'a pas tourné, s'il reste des orphelins >24h, ou si des positions Alpaca n'ont aucun ordre de protection.
- **État EXPIRED** pour les orphelins BUY/PENDING >24h (reaping).

### Critère de réévaluation
Réarmer l'auto-tuner uniquement après backtest + ≥30 trades. Affiner `MAX_HOLD_TRADING_DAYS`, give-back et le cap N sur la grille de sensibilité du backtest.

---
