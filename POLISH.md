# POLISH.md — Améliorations différées du système Aether

Liste des améliorations identifiées pendant le build mais volontairement différées. Chaque item a :
- **Priorité** : 🔴 bloquant avant paper trading | 🟠 important | 🟡 cosmétique
- **Effort** : XS (< 15 min) | S (15-30 min) | M (30-90 min) | L (> 90 min)
- **Trigger** : à quel moment il devient nécessaire de le faire

Trier par priorité puis effort quand on revient dessus.

---

## 🔴 BLOQUANTS — à fixer avant le premier vrai run quotidien

### ✅ P-001 — Real macro context (VIX / SPY regime / Treasury) — **DONE**
**Effort** : M
**Trigger** : Phase 4 quand on active pg_cron `daily-analysis`
**Status** : Migration `daily_context` + Edge Function `fetch-daily-context` + integration dans `generate-decision`. Testé : regime FREE détecté correctement (VIX 16.79, SPY > SMA50).
**Pourquoi bloquant** : `generate-decision` reçoit actuellement `market_context = { vix: 18, regime: "GUIDED" }` en mock. STRATEGY.md Section 7 dit que le **mode (FREE/GUIDED/STRICT/PAUSE) dépend du VIX réel** et impacte directement le sizing (Section 8 table). Sans données réelles, le Trader sizing sera systématiquement biaisé GUIDED même si on est en réalité en STRICT.

**Fix** :
1. Créer une Edge Function `fetch-daily-context` qui appelle :
   - FMP `/stable/quote?symbol=%5EVIX` → VIX courant
   - FMP `/stable/quote?symbol=SPY` + comparaison avec SMA50 calculée localement → spy_vs_ma50
   - FMP `/stable/treasury-rates` → taux 10Y
   - FMP `/stable/biggest-gainers` + `/biggest-losers` → contexte marché
2. Stocker dans une nouvelle table `daily_context` ou dans `system_heartbeats.notes`
3. `decide-and-execute` lit la dernière row de ce contexte et la passe en POST body à `generate-decision`
4. Logique régime : `VIX < 18 + SPY > MA50 = FREE | 18-25 = GUIDED | > 25 ou SPY < MA50 = STRICT | > 35 = PAUSE`

---

### ✅ P-002 — Earnings calendar check dans validate-order — **DONE**
**Effort** : S
**Trigger** : Avant tout BUY réel
**Status** : Fonction `getDaysUntilNextEarnings` fetch FMP earnings-calendar, filter en code par ticker, reject si < 5 jours. Testé : INCY (J-29) approve / DKS (J+1) reject correctement.
**Pourquoi bloquant** : STRATEGY.md Section 8 Couche 1 et Couche 2 : "Pas de BUY si earnings dans les 5 prochains jours (risque binaire)". `validate-order` actuel a un placeholder `earningsInNextNDays: null` → il laisserait passer un BUY 2 jours avant earnings. Risque réel de cristalliser une mauvaise position sur event binaire.

**Fix** :
1. Dans `validate-order`, ajouter un appel `supabase.from("agent_logs").select("raw_output").eq("ticker", t).eq("log_type", "analysis_pass2").order("created_at desc").limit(1)` pour récupérer la dernière `calendar_future` parsée
2. OU plus propre : appeler directement FMP `/stable/earnings-calendar?symbol=X&from=today&to=today+10` depuis validate-order
3. Computer `daysUntilNext = (Date.parse(next.date) - now) / 86400000`
4. Si < 5 → ajouter `reject_reasons.push("earnings_in_${daysUntilNext}_days")`

---

### ✅ P-003 — Pin temperature=0 dans run-analysis-passes (consistency) — **DONE**
**Effort** : XS
**Trigger** : Avant paper trading 12 semaines (reproductibilité audit)
**Status** : `temperature = 0` ajouté dans `callClaude` de `run-analysis-passes`. Testé : 2 runs INCY consécutifs produisent EXACTEMENT les mêmes 6 scores.
**Pourquoi bloquant** : `run-researchers`, `generate-decision`, `review-decision` utilisent `temperature: 0` (déterministe). MAIS `run-analysis-passes` utilise le default Anthropic (temperature: 1). Résultat : les scores Pass 1/2/3 varient entre runs (observé : INCY C3 4↔3, C5 7↔8 sur 3 runs identiques). En paper trading on veut pouvoir rejouer une décision et obtenir le même résultat pour debug.

**Fix** : ajouter `temperature: 0` au `body` de `callClaude` dans `run-analysis-passes/index.ts` (1 ligne).

⚠️ Decision à confirmer : voulons-nous vraiment déterministe sur les passes d'analyse aussi ? Argument contraire = variance Claude = pseudo-ensemble naturel, plus robuste statistiquement. À discuter avant de fix.

---

## 🟠 IMPORTANTS — peuvent attendre Phase 4 mais à ne pas oublier

### ✅ P-004 — Gap overnight rule dans `update-positions` (Priorité 0) — **DONE**
**Effort** : M
**Trigger** : Phase 4 step 17 (création de `update-positions`)
**Status** : Implémenté en Priority 0 dans `update-positions/index.ts`. Si market closed → event PENDING. Si market open → market SELL immédiat + update positions row CLOSED avec exit_reason='gap_overnight'.
**Pourquoi important** : STRATEGY.md Section 8 dit que la règle gap overnight est **Priorité 0** (avant stop-loss, take-profit, trailing). Si prix d'ouverture < stop-loss défini → market sell immédiat sans attente de rebond. La logique existe dans le pseudocode STRATEGY.md ; à implémenter dans `update-positions` au moment de sa création.

**Fix** :
```typescript
const stopLossPrice = entryPrice * (1 - position.stop_loss_pct / 100);
if (currentPrice < stopLossPrice && !position.stop_triggered) {
  await submitMarketSell(position.ticker, position.quantity);
  await logGapEvent(position.ticker, returnPct, "gap_overnight_exit");
  continue;  // Skip trailing/TP logic
}
```

---

### ✅ P-005 — Trailing stop-loss tiered (déjà spec, à coder) — **DONE**
**Effort** : M
**Trigger** : Phase 4 step 17 (`update-positions`)
**Status** : `computeTrailedStopPct()` dans `update-positions` applique les 3 paliers : +8% → stop+2%, +15% → stop+7%, +20% → stop+12%. Testé : position INCY entry $85 / current $97 / +14.31% → stop $79.05 → $86.70. db_ok confirmé.
**Pourquoi important** : STRATEGY.md Section 8 Couche 2 spec les paliers : +8% → stop à +2%, +15% → stop à +7%, +20% → stop à +12%. Sans ça, on ne lock pas les gains et un winner peut redevenir loser.

---

### P-006 — Réévaluation hebdo des positions ouvertes (3 appels Claude/position)
**Effort** : M
**Trigger** : Phase 4, intégré dans la boucle stratégique dimanche
**Pourquoi important** : STRATEGY.md Section 8.5 — éviter le coût prohibitif du re-pipeline complet quotidien, mais ne pas tenir des positions dont la thèse a changé. Coût ~$0.30/semaine pour 10 positions.

---

### ✅ P-007 — Cold start protocol (semaines 1-4, poids fixes) — **DONE**
**Effort** : S
**Trigger** : Phase 4 step 18 (`run-strategy-loop`)
**Status** : Cold start gate dans `run-strategy-loop` : si weeks_data < 3 OR closed_trades < 8 → INSERT default weights (25/20/20/15/10/10) avec note "cold_start", pas d'appel Claude. Testé : mode="cold_start", strategy_id retourné, $0 coût.
**Pourquoi important** : STRATEGY.md Section 8.5 — La boucle stratégique du dimanche ne doit PAS ajuster les poids cluster pendant les 4 premières semaines. `calculate-scores` charge déjà DEFAULT_WEIGHTS si aucune stratégie persistée → cohérent. Mais la boucle elle-même doit explicitement écrire `cold_start: true, adjustments_blocked: true` dans ses logs jusqu'à 8 trades fermés + 3 semaines.

---

### ✅ P-008 — Heartbeat monitoring + email digest — **DONE** (email optional pending Resend setup)
**Effort** : M
**Trigger** : Phase 4 step 20 (`run-eod-digest`)
**Status** : `run-eod-digest` Edge Function créée. Compose digest (portfolio, activity, regime, cost), INSERT system_heartbeats row. Email via Resend si `RESEND_API_KEY` configuré (skipped sinon avec reason claire). Subject preview validé. **Reste à faire** : user sign up Resend + add secret pour activer l'email.
**Pourquoi important** : STRATEGY.md Section 8.5 — un pg_cron qui crashe silencieusement = système qui paraît marcher mais ne fait rien. Heartbeat dans `system_heartbeats` à 16h15 ET + alerte email si != 'ok' à 17h30 ET. SendGrid ou Mailgun. Adresse cible = `aether.trader.project@gmail.com`.

---

## 🟡 COSMÉTIQUES / SOUS-OPTIMISATIONS — quand on aura le temps

### P-009 — Pin Claude model version dans tous les Edge Functions
**Effort** : XS
**Trigger** : Avant go-live réel (paper passe à live)
**Détail** : Tous les `MODEL = "claude-sonnet-4-5-20250929"` sont déjà pinnés à la même version (bonne pratique appliquée). Vérifier au moment du go-live qu'on est sur la dernière Sonnet stable disponible et pinner intentionnellement (pas par accident de copier-coller).

### P-010 — `signals.position_size_pct_final` séparé de `position_size_pct`
**Effort** : S
**Détail** : STRATEGY.md TradingDecision spec mentionne `position_size_pct` (avant corrélation) ET `position_size_pct_final` (après corrélation). Actuellement on overwrite la même colonne dans `signals`. Ajouter une migration pour avoir les 2 colonnes + visibilité dashboard.

### P-011 — Trader affiche conviction recalculée dans rationale
**Effort** : XS
**Détail** : Quand le Trader ajuste la conviction vs convictionRaw (ex: 85→72), forcer le prompt à expliquer pourquoi dans la rationale ("Adjusted from 85 to 72 because..."). Améliore la traçabilité du débat → décision.

### P-012 — `signal_id` propagation dans les `agent_logs`
**Effort** : S
**Détail** : Actuellement `agent_logs` n'a pas de FK vers `signals.id`. Pour le dashboard, on aimerait pouvoir faire `SELECT * FROM agent_logs WHERE signal_id = X` pour voir toute la trace d'une décision. Migration : ajouter `signal_id UUID REFERENCES signals(id) ON DELETE SET NULL` + index.

### P-013 — Retention policy sur `agent_logs`
**Effort** : XS
**Trigger** : Quand la table dépasse 100K rows (~6 mois de paper trading actif)
**Détail** : `agent_logs` grandit à ~150 rows/jour (20 stocks × 7 appels + Bull/Bear). En 6 mois = ~25K rows. Pas urgent. Mais prévoir une politique : garder full pour 90 jours, archiver après (Supabase Storage en JSON dump).

### P-014 — Index sur `signals.created_at DESC WHERE executed = true`
**Effort** : XS
**Détail** : Quand on aura beaucoup de signals dans la DB, la query "derniers trades exécutés" sera fréquente sur le dashboard. Index partiel optimise.

### P-015 — Stripper le synthetic test signal de la DB
**Effort** : XS
**Détail** : signal `9e0117bc-c063-46ca-aaf9-1ebf4becb790` (LSCC test BUY synthétique) doit être supprimé avant le premier vrai paper trading run pour ne pas polluer les stats. `DELETE FROM signals WHERE id = '9e0117bc-c063-46ca-aaf9-1ebf4becb790';`

### P-016 — `Validate-order` checke aussi cash_pct ET portfolio_value réels via Alpaca
**Effort** : S
**Détail** : Actuellement `validate-order` reçoit `cashPct: 100` en V1 default. En vrai il devrait query Alpaca `/v2/account` pour `cash` et `portfolio_value` réels avant validation. Sinon on peut autoriser un BUY qui dépasse le cash disponible.

### P-017 — Stock splits adjustment dans OHLCV
**Effort** : M
**Détail** : Si un mid-cap fait un split pendant la fenêtre d'analyse 90 jours, l'OHLCV brut donne une discontinuité qui fausse le calcul MACD/BBands locaux. FMP a `/stable/stock-split` mais on n'l'utilise pas. Edge case mais à fix quand on observe le premier en paper trading.

### P-018 — Validation Format de la réponse Claude (parsing robuste)
**Effort** : S
**Détail** : Le `callClaude` parse le JSON via regex `\{[\s\S]*\}`. Si Claude répond avec du markdown ou des fences malgré l'instruction, ça plante silencieusement. Ajouter un validator Zod-like sur les champs critiques (`score_c2_momentum entre 1-10`, `action in BUY|SELL|HOLD`) + alerte si invalid.

### ✅ P-019 — Filter tickers by earnings recency dans daily-analysis cron — **DONE**
**Effort** : M
**Trigger** : Phase 4 step 16 (création `daily-analysis` cron)
**Status** : Edge Function `select-daily-candidates` créée. Sur 271 watchlist → 26 candidats dans fenêtre catalyseur J-10 à J+5. Trie par priorité PEAD (freshness). Top 5 actuel identifie déjà 3 BUY potentiels (AAP +97%, DRVN +42%, DECK +18%). À utiliser dans le cron `aether-daily-analysis` au lieu d'iterer la watchlist entière.
**Pourquoi important** :
**Observation empirique** : 5 tickers testés (INCY/LSCC/LUV/EFX/NXT), **0 BUY**. Cause systémique = tous ont earnings 22-34j en arrière → C1 freshness × 0.10. C'est le BON comportement (STRATEGY.md hors fenêtre PEAD), mais ça veut dire que sans pre-filtering, le cron va analyser 20-30 stocks dont ~80-90% donneront HOLD au gate conviction.

**Fix dans Phase 4** : avant le pipeline complet, query FMP `/stable/earnings-calendar?from=today-10&to=today+5` pour récupérer les tickers de notre watchlist qui sont **dans la fenêtre catalyseur** (J-10 à J+5 vs earnings). Prioriser ces 20-30 plutôt qu'un échantillon aléatoire. Économise des appels Claude inutiles + augmente le taux de signaux exploitables.

**Décision empirique** :
- Si fenêtre catalyseur produit < 5 tickers par jour (peu d'earnings ce jour-là) → analyser TOUS ces stocks + compléter avec quelques momentum candidates (C2 ≥ 7 historique)
- Si > 30 tickers en fenêtre → garder le top 20-30 par mcap ou par EPS surprise attendue

---

## Workflow recommandé pour cette TODO

1. **Avant Phase 4** : faire P-001, P-002, P-003 (les 3 bloquants)
2. **Pendant Phase 4** : intégrer P-004, P-005, P-006, P-007, P-008 dans les nouvelles fonctions qu'on créera
3. **Avant 1ère vraie session paper trading** : P-009, P-015, P-016
4. **Pendant les 12 semaines paper** : observer ce qui casse réellement, prioriser les autres
