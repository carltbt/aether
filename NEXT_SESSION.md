# NEXT_SESSION.md — Plan d'attaque pour la reprise

> 💡 **Comment lire ce fichier** : tu l'ouvres dès la reprise, je le lis aussi → on est synchros. Mis à jour à la fin de chaque session.

---

## 📍 Où on s'est arrêté

**20/22 build steps complétés.** Phases 1-5 terminées. Le système tourne en autonome en paper trading DRY_RUN depuis le 26 mai. Phase 6 = observation 12 semaines.

### Architecture finale (snapshot)
- **17 Edge Functions ACTIVE** sur Supabase Aether
- **6 migrations DB** versionnées git
- **6 cron jobs ACTIVE** (lun-ven automatique + dim hebdo)
- **Dashboard prod live** : https://aether-gamma-one.vercel.app (code accès 6 chiffres)
- **Email digest quotidien** via Resend → `aether.trader.project@gmail.com`
- **Budget cumulé** : ~$0.65 Anthropic sur 5 sessions de dev

### Premier run autonome observé (26 mai)
- 10:30 UTC → fetch-daily-context → regime FREE, VIX 16.68
- 11:00 UTC → run-daily-analysis → 9 tickers du top fenêtre catalyseur
- **DECK (conv 68)** premier candidat à passer le gate → Trader override HOLD (value trap detection sur insider apathy + BB 91%)
- 0 BUY exécuté, dashboard live affiche correctement les 9 signals avec leurs scores

### Documents canoniques
- [STRATEGY.md](STRATEGY.md) — bible v2.7
- [DEVIATIONS.md](DEVIATIONS.md) — D-001 Premium plan
- [POLISH.md](POLISH.md) — 8/20 items DONE (P-001/2/3/4/5/7/8/19/20)
- Dashboard repo : `dashboard/` (Next 15 + Tailwind 4 + service role)

---

## 🎯 3 options pour cette session — au choix selon ton humeur

### Option B — Dashboard v2 enrichissements (1-2h, le plus stimulant)

Le V1 dashboard est fonctionnel mais minimal. Ce qui manque pour un vrai cockpit :

1. **📈 Courbe P&L cumulative** (Recharts déjà installé) — line chart depuis première position OPEN. Affiche return % vs S&P500 baseline.
2. **💰 Cost trend 7 derniers jours** — bar chart cost/jour, alert si > $25/sem
3. **📅 Filtre signals** par date / action / conviction min — pratique quand on a 100+ signals
4. **🔍 Drill-down agent_logs par signal** — modal ou nouvelle page `/signals/[id]` qui montre les 7 appels Claude (pass1/2/3, bull, bear, decision, reviewer) avec coût + rationale complète
5. **⚙️ Strategy weights history** — table week-by-week avec poids C1-C6 et regime
6. **📊 Sector breakdown** des signals (camembert ou stacked bar) — quels secteurs dominent
7. **🚦 Status panel** avec heartbeat + last cron runs + last context fetch

Effort par item : 10-30 min chacun. Tu choisis quels prioritaires.

**Pré-requis** : la dashboard tourne (✅), tu sais comment commit + push (✅), Vercel auto-redeploy à chaque push.

---

### Option C — SELL prédictif P-006 (1h, utile que quand positions OPEN)

STRATEGY.md Section 8.5 prévoit la réévaluation hebdo des positions :
- Tous les dimanches : pour chaque position OPEN, re-run 3 passes Claude (technical/sentiment/fundamentals)
- Coût ~$0.025/position × 10 positions = $0.30/sem
- Si conviction recalculée < 40 → SELL signal lundi matin
- Évite de tenir des positions dont la thèse a changé

**Pas urgent tant qu'on a 0 position OPEN** (en dry_run permanent). Mais critique à avoir AVANT le premier vrai BUY live.

À coder :
- Edge Function `reevaluate-open-positions` (analogue à `run-analysis-passes` mais 3 passes au lieu de 7)
- Cron `aether-position-reevaluation` dim 23h UTC (juste avant strategy-loop)
- Logique : si new_conviction < 40 → INSERT row dans `signals` avec action='SELL' pour cette position
- L'orchestrateur ou update-positions catch ce signal et exécute

Référence : POLISH.md P-006.

---

### Option E — Decision live execution (DANGEREUX si fait trop tôt)

Actuellement : `cron aether-daily-analysis` invoque `run-daily-analysis?dry_run=true&limit=25`.

**Pour passer en LIVE** :
```sql
SELECT cron.alter_job(
  job_id := 2,
  command := $$
  SELECT net.http_get(
    url := 'https://rhqtjzlwkjwetneqdvkv.supabase.co/functions/v1/run-daily-analysis?limit=25'
  );
  $$
);
```

⚠️ **PRÉ-REQUIS AVANT D'ACTIVER LIVE** :
1. ≥ 5 jours ouvrables d'observation dry_run sans crash
2. Au moins 1 BUY proposé par le système (qui aurait été exécuté si live) — pour valider que c'est pas systématiquement HOLD
3. Vérifier que Reviewer rejette les mauvais setups (déjà observé sur SKY le 26 mai ✅)
4. P-006 SELL prédictif idéalement coded (sinon on tient des positions périmées)
5. Heartbeat email digest OK depuis 5 jours (capacité à détecter une panne en J+1)

Si tu actives sans ces 5 conditions, **tu prends un risque réel d'argent perdu**.

**Mon vote** : pas avant 1-2 semaines d'observation minimum.

---

## 🧹 Tâches de wrap-up à faire au début de la prochaine session

Indépendamment de B/C/E :

1. **Pull/check le système est sain** :
   ```sql
   SELECT recorded_at, status, stocks_analyzed, trades_executed 
   FROM system_heartbeats ORDER BY recorded_at DESC LIMIT 7;
   ```
   Doit montrer 1 heartbeat par jour ouvrable depuis le 26 mai.

2. **Check signals générés depuis dernière session** :
   ```sql
   SELECT DATE(created_at), COUNT(*), 
     COUNT(*) FILTER (WHERE action='BUY') AS buys,
     SUM(cost_usd) FROM signals s
   LEFT JOIN agent_logs al ON al.ticker = s.ticker AND DATE(al.created_at) = DATE(s.created_at)
   WHERE s.created_at > NOW() - INTERVAL '14 days'
   GROUP BY DATE(created_at) ORDER BY 1 DESC;
   ```

3. **Vérifier coût cumulé** :
   ```sql
   SELECT SUM(cost_usd) AS total_usd, MIN(created_at) AS since FROM agent_logs;
   ```
   Si > $10/sem → enquêter (loop ?). Cible STRATEGY.md $12-15/sem en prod active.

4. **Observer dans le dashboard** :
   - Combien de jours sans BUY ?
   - Si > 7 jours sans BUY → discussion sérieuse sur recalibration (seuil 60→55 ou FMP Ultimate)
   - Si BUY apparus → analyser qualité des décisions (Trader rationale, Reviewer verdict)

---

## 🔧 Pre-flight checklist

- [ ] `~/Documents/GitHub/aether` (project lock)
- [ ] MCP `supabase-aether` répond
- [ ] 17 Edge Functions toujours ACTIVE (`list_edge_functions`)
- [ ] 6 cron jobs ACTIVE : `SELECT jobname, active FROM cron.job;`
- [ ] daily_context dernière row ≤ 24h vieille
- [ ] system_heartbeats dernier ≤ 24h
- [ ] Dashboard accessible via `aether-gamma-one.vercel.app` + code `227522`

---

## 💰 Budget anticipé

| Action | Coût estimé |
|---|---|
| Option B (dashboard charts) | $0 (pas de Claude) |
| Option C (SELL prédictif code + 1 test) | ~$0.10 |
| Option E (live activation) | ~$2-5/jour quand actif |
| Daily cron observation cost | $1-2/jour automatique |

---

## ⚠️ Points de vigilance permanents

1. **Cron `aether-daily-analysis` reste en DRY_RUN** tant qu'on a pas explicitement passé en live via `cron.alter_job`
2. **Surveiller `system_heartbeats` chaque jour ouvrable** — si status != 'ok' → debug avant le suivant
3. **Email digest reçu chaque jour à ~20h UTC** — si tu n'en reçois pas → vérifier Resend dashboard + Supabase logs
4. **Vercel free tier limits** : 100GB bandwidth/mois, fonctions 1M invocations/mois. On est très loin de saturer mais à surveiller si on ajoute beaucoup de viz client-side
5. **Service role JWT dans Vercel env vars** — never rotater sans aussi rotater dans `.env.local` local + Edge Function secrets

---

## 📝 POLISH items toujours en attente

🟠 Importants :
- **P-006** Réévaluation hebdo positions (= Option C ci-dessus)
- **P-010** `position_size_pct_final` séparé de `position_size_pct` (migration)

🟡 Cosmétiques / ops :
- **P-009** Pin model version verification avant go-live
- **P-012** `agent_logs.signal_id` FK migration (utile pour drill-down dashboard)
- **P-013** Retention policy `agent_logs` (>100K rows)
- **P-014** Index partiel `signals.executed=true`
- **P-016** validate-order check cash Alpaca réel
- **P-017** Stock splits adjustment OHLCV
- **P-018** Validation Zod-like Claude responses

🟢 Nouveaux notés en post-session :
- **P-021** (à créer) : batching dans run-daily-analysis pour analyser > 15 candidats sans timeout (background tasks ou multi-cron)

---

## 🚀 Definition of done pour cette session

- [ ] Pull/check système sain (4 queries ci-dessus)
- [ ] Choisir B ou C, l'exécuter
- [ ] Si Option E (live) — vérifier les 5 pré-requis avant
- [ ] Update ce NEXT_SESSION.md pour la suivante
- [ ] git commit + push (Vercel auto-redeploy si dashboard touché)

---

*20/22 étapes du build complètes. Phase 6 = observation passive en cours. Le système trade tout seul en dry_run depuis le 26 mai. 🌙*
