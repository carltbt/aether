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

## D-004 — Remédiation post-audit complet (01/07)

**Date** : 2026-07-01
**Statut** : Actif
**Sections impactées** : 7 (Reviewer), 8 (Couche 2/3, exécution), 5 (C1), 8.5 (réévaluation)

Suite à l'audit exhaustif 100% (10 domaines, 15 agents, findings vérifiés en adversarial). Correctifs de sûreté/correctness (pas de changement de thèse). Les 4 HIGH + quick wins :

- **Short à nu bloqué (2 couches)** : `execute-order` ne soumet PLUS de SELL (le payload historique `qty:"1"` market sans garde de position détenue pouvait ouvrir un short sur un ticker non-détenu). Les sorties passent EXCLUSIVEMENT par update-positions / review-positions (durcis no-oversell). Indépendamment, `validate-order` REJETTE tout SELL sans position OPEN (Couche 2). Long-only V1 garanti.
- **Veto Reviewer 2/3 déterministe** : `review-decision` comptait uniquement le `verdict` libre du modèle. Ajout d'un tally code des 3 stances de perspectives → FORCE REJECT si ≥2 REJECT (BUY uniquement, SELL reste asymétrique-approve P14). Le veto « non-négociable » de STRATEGY.md ne dépend plus de l'auto-cohérence du LLM.
- **Watchdog bracket PAR POSITION** : l'ancien check agrégé (pos>0 && ordres=0) ne voyait pas UNE position à nu parmi plusieurs. Détection par symbole d'un leg protecteur (stop OU OCO/bracket via `legs`). **A immédiatement révélé COO+KBH sans stop natif** (les OCO stop legs avaient disparu, il ne restait que le TP) → ré-armés en OCO propre via `admin-rearm-stops` (COO stop 65.56, KBH stop 57.96).
- **roe** : `feature_snapshots.roe` était 100% NULL (le champ `returnOnEquityTTM` n'existe pas dans ratios-ttm). Dérivé de `netIncomePerShareTTM / shareholdersEquityPerShareTTM` (null si equity ≤ 0) + backfill des snapshots existants.
- **Watchdog fin-de-run** : match du heartbeat `END` (pas `START`) → un run qui crashe en cours ne reporte plus vert. Cron `update-positions` étendu à `13-21` UTC (couvre la clôture en hiver EST).
- **RLS + index** : policy `admin_full_access` canonique sur `feature_snapshots` ; index sur `shadow_positions.signal_id`.

### D-004b — Finding backtest ENTRÉE (couche prix sans edge)
Le backtest d'entrée v1 (point-in-time, breakout momentum vs entrée aléatoire) montre : avg **+0.088%/trade** vs random **+0.779%/8j** → **edge ≈ −0.69%/trade**, profit factor ~1.0, TP 18% quasi jamais touché. **Conclusion : la couche prix/momentum (C2) seule n'est PAS l'edge** dans le régime haussier actuel. L'edge doit venir des catalyseurs PEAD + fondamentaux + synthèse LLM — non testable sans données as-of (d'où le feature store, cf. [create_feature_snapshots]). **Réévaluation** : re-run une fois ~6 mois de snapshots accumulés (IC par cluster).

### D-004c — P-006 (réévaluation hebdo 3-pass) non codé, substitut documenté
STRATEGY.md 8.5 spécifie une re-évaluation hebdo 3-passes par position OPEN (SELL si conviction < 40). **Non implémentée.** Substitut actif : `review-positions` (revue LLM quotidienne single-call HOLD/SELL, cf. D-002). Plus léger qu'un re-score complet, mais quotidien plutôt qu'hebdo. **Réévaluation** : implémenter P-006 complet avant tout go-live argent réel, ou acter formellement le substitut.

## D-005 — Remédiation « cœur » du diagnostic med (01/07)

**Date** : 2026-07-01
**Statut** : Actif
**Sections impactées** : robustesse (appels LLM), 8 (exécution/Couche 2), 5 (C1/C5 scoring), observabilité

Suite au diagnostic des optionnels + découverte (52 findings, 42 nouveaux, 23 vérifiés). Thème transversal : « succès HTTP masquant un échec sémantique ». Correctifs déployés (10 fonctions) :

- **Retry/backoff LLM (429/5xx)** dans le `callClaude` des 5 fonctions Claude (run-analysis-passes, run-researchers, generate-decision, review-decision, review-positions) : 3 retries jittered, honore `Retry-After`. Motif : un 429 sur pass3 droppait le ticker en silence (5 confirmés), non rattrapable par sweep.
- **Fail-closed JSON** : HTTP 200 mais JSON illisible → `ok:false error:"json_parse_failed"` (au lieu d'une dégradation muette en HOLD/null).
- **execute-order fill-orphan** : un échec d'écriture DB APRÈS un fill Alpaca était avalé (`ok:true`) → position live non trackée. Désormais retry 1× puis `ok:false needs_reconcile` + heartbeat `partial_error` + flag `DB_ORPHAN_RISK`.
- **C1 déterministe en code** : `c1 = clamp(round((eps×0.6 + upgrades×0.4) × freshnessMult(days)), 1, 10)` — le LLM n'émet plus que ses composantes de jugement. Vérifié sur AAON (eps2/upg1/56j → c1=1). Corrige un biais ×2-6 non-reproductible à temp=0.
- **EV/EBITDA** : `km.evToEBITDATTM` n'existe pas chez FMP (même classe que le bug roe) → lecture de `enterpriseValueMultipleTTM` depuis ratios-ttm. **DCF sanitize** : dcf ≤ 0 ou |upside| > 100% → n/a (both run-analysis-passes + snapshot-features), + règle de rubrique C5.
- **validate-order RR** : le ratio 1:2 passe de *warning* à *reject* (Couche 2 fermait un trou : un TP < 2×SL passait).
- **admin-close-position** : seul un 404 = « à plat » (une erreur transitoire ne l'est plus) + trace DB (position CLOSED + heartbeat).
- **ops-watchdog** : alerte sur `partial_error` du jour + orphelin `DB_ORPHAN_RISK` + réconciliation position Alpaca sans ligne OPEN en DB.

### Critère de réévaluation
Surveiller les heartbeats `partial_error` et les alertes Discord ; si des 429 persistent malgré le retry, augmenter MAX_RETRIES ou espacer les batches.

### D-005b — Rééquilibrage anti-strict (déployé) + vérification « pas plus strict »
Le recompute C1 déterministe (D-005) corrige un biais **haussier** du LLM → pour les valeurs momentum à earnings anciens, C1 tombait à ~1 et **tirait la conviction sous le gate 60 = plus strict**. Contre-mesures déployées pour garantir un net **neutre-ou-moins-strict** (jamais plus) :
- **C1 renormalisé** (run-analysis-passes) : candidat momentum (C2≥7) sans catalyseur frais (>21j) → C1 traité comme **MANQUANT** (calculate-scores renormalise son poids de 25% sur les autres clusters) au lieu d'un score plancher.
- **C3 baseline** : rubrique renforcée — absence d'activité insider = **NEUTRE (5)**, pas négatif ; 2-3 réservé aux ventes observées (médiane réelle était 3).
- **Reviewer Conservative gradué** (review-decision) : la perspective Conservative votait **REJECT 52/52** (biais structurel) → dégradait le veto 2/3 en veto « 1 REJECT » et appliquait −15% à presque tout BUY. Reformulée en verdict gradué APPROVE/NEUTRAL/REJECT.

**Vérification (baseline live avant D-005b)** : 291 signaux, conviction moy **53.7**, **74/291** franchissent le gate 60, **111 coincés à 50-59** juste sous le gate, Conservative **52/52 REJECT**. Direction de chaque changement : C1-renorm ↑conviction momentum, C3-baseline +4 sur les « no-activity », Conservative-gradué débloque les BUY approuvés à taille pleine. **Net : MOINS strict** (plus de BUY franchissent + plus approuvés + taille pleine), ce qui compense et dépasse la sévérité du recompute C1. Le seul nouveau gate dur (RR 2:1) bloque **0 BUY actuel** (48/48 déjà ≥2.0).

**Reste en attente** (strictness-neutre, non fait) : Bull/Bear ±10 (generate-decision), staleness contexte write-side (fetch-daily-context), shadow filter (track-shadow-portfolio), P-006 (re-éval hebdo 3-pass + colonnes entry-snapshot + cron).

---

## D-004d — C1 (25%) s'effondre en freshness ×0.1 hors fenêtre earnings
Le cluster le plus pondéré (C1 Earnings 25%) est multiplié par un facteur de fraîcheur qui tombe à ×0.1 au-delà de 21j post-earnings ; `select-daily-candidates` injecte des candidats momentum (freshness=0). Résultat : C1 devient un plancher quasi-fixe pour une grande part des candidats → conviction tirée vers la bande HOLD (les non-exécutés se groupent à 43-58, juste sous le gate 60). **Piste (non appliquée)** : pour les candidats de la branche momentum, renormaliser C1 hors dénominateur (traiter comme manquant) OU profil de poids distinct. À trancher avec les données du feature store.

---
