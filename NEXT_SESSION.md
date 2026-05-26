# NEXT_SESSION.md — Plan d'attaque pour la reprise

> 💡 **Comment lire ce fichier** : tu l'ouvres dès la reprise, je le lis aussi → on est synchros sur où on s'est arrêté et où on va.

---

## 📍 Où on s'est arrêté

**Phase 4 TERMINÉE. Aether est AUTONOME en dry_run.**

Score build : **19 / 22 étapes complètes**.

### Ce qui marche fin de session précédente
- **16 Edge Functions ACTIVE** sur Supabase Aether
- **6 pg_cron jobs ACTIVE** — système tourne en background lun-ven sans intervention
- **5 migrations DB**
- **Real macro context** wired (VIX/SPY/Treasury → regime)
- **Earnings 5d check** dans validate-order
- **Pre-filter catalyseur** dans select-daily-candidates
- **Gap overnight + trailing stop tiered** dans update-positions
- **EOD digest + heartbeat** dans run-eod-digest
- **Strategy loop cold start** dans run-strategy-loop
- **Budget cumulé** sur 3 sessions : ~$0.65

### Daily flow automatisé (lun-ven UTC)
```
10:30 ─ fetch-daily-context        (regime FREE/GUIDED/STRICT/PAUSE)
11:00 ─ run-daily-analysis         (top 10 candidats, DRY_RUN — pas d'ordres Alpaca)
13:00 ─ update-positions           (gap overnight + trailing stops)
17:00 ─ update-positions
21:00 ─ update-positions
20:15 ─ run-eod-digest             (heartbeat + summary)
```

### Weekly flow (dim UTC)
```
00:00 ─ run-screener               (rebuild watchlist 271 mid-caps)
01:00 ─ run-strategy-loop          (cold start → default weights V1)
```

### Documents canoniques à connaître
- [STRATEGY.md](STRATEGY.md) — bible v2.7
- [DEVIATIONS.md](DEVIATIONS.md) — D-001 = Premium plan
- [POLISH.md](POLISH.md) — P-001/P-002/P-003/P-004/P-005/P-007/P-008/P-019 = ✅ DONE

---

## 🎯 Plan d'attaque pour cette session

**3 options possibles** — à choisir selon ton humeur / disponibilité :

### Option A — Observer dry_run + setup email Resend (~1h)

Le système tourne déjà. Pendant cette session on :
1. **Vérifie les logs cron** des 1-2 derniers jours :
   ```sql
   SELECT job_name, status, start_time, end_time, return_message 
   FROM cron.job_run_details 
   WHERE start_time > NOW() - INTERVAL '48 hours'
   ORDER BY start_time DESC LIMIT 30;
   ```
2. **Examine les signals créés** par le cron daily-analysis :
   ```sql
   SELECT ticker, conviction, action, created_at, rationale
   FROM signals
   WHERE created_at > NOW() - INTERVAL '48 hours'
   ORDER BY created_at DESC;
   ```
3. **Lit les heartbeats** :
   ```sql
   SELECT recorded_at, status, stocks_analyzed, trades_executed, notes
   FROM system_heartbeats
   ORDER BY recorded_at DESC LIMIT 10;
   ```
4. **Setup Resend** :
   - Sign up sur https://resend.com (free tier 3000 emails/mois)
   - Get API key
   - Add as Supabase Edge Function secret : `RESEND_API_KEY`
   - Test : `curl .../run-eod-digest` → email reçu sur aether.trader.project@gmail.com
5. **Verify on a real ticker** : invoquer manuellement `run-daily-analysis?limit=5&dry_run=true` et regarder la qualité des décisions.

→ Si tout sain → on attaque Phase 5 ou option B.
→ Si quelque chose pète → on debug en priorité.

### Option B — Phase 5 Dashboard Next.js (~3-4h)

Construire un dashboard pour visualiser tout ça en temps réel.

**Stack** :
- Next.js 14 (App Router) + TypeScript
- Tailwind CSS + shadcn/ui
- Supabase JS client (avec Realtime subscriptions)
- Vercel deploy
- Auth : magic link Supabase (1 user admin uniquement)

**Pages essentielles** (STRATEGY.md Section 11) :
1. **Vue principale** — Portfolio live (total value, P&L jour, cash, table positions ouvertes)
2. **Vue signaux** — Derniers signals, conviction, scores 6 clusters, rationale expandable
3. **Vue performance** — Courbe P&L cumulative, Sharpe glissant, drawdown, win rate
4. **Vue stratégie** — Stratégie courante, historique weights par semaine
5. **Vue logs** — agent_logs (coût, latence par appel Claude)

**Effort** : ~3-4h pour V1 minimaliste (juste les graphs essentiels), beaucoup plus pour beau.

### Option C — Pousser le live execution en mode très contrôlé (~1h + observation)

Si tu vois que le système tourne sainement en dry_run depuis quelques jours :
1. Activer LIVE execution mais avec position_size_pct REDUITE artificiellement (genre 2% max au lieu de 8-12%)
2. Modifier le cron daily-analysis pour `dry_run=false&limit=2` (seulement 2 trades max/jour, petites positions)
3. Observer 1 semaine
4. Si OK → augmenter à limit=5, position_size 5%
5. Si OK → activation pleine

⚠️ **À faire SEULEMENT** quand tu es serein sur les dry_runs + tu as des emails digest valides en flux.

---

## 🔧 Pre-flight checklist

Avant de lancer quoi que ce soit :

- [ ] `~/Documents/GitHub/aether` (project lock)
- [ ] MCP `supabase-aether` répond
- [ ] 16 Edge Functions toujours ACTIVE (`list_edge_functions`)
- [ ] 6 cron jobs ACTIVE : `SELECT jobname, active FROM cron.job;`
- [ ] daily_context dernière row ≤ 24h vieille
- [ ] Aucune erreur grave dans `system_heartbeats` récents

---

## 💰 Budget anticipé pour cette session

| Action | Coût estimé |
|---|---|
| Option A (observation + Resend setup) | ~$0.10 (1-2 manual runs) |
| Option B (dashboard build) | $0 (pas de Claude) |
| Option C (live execution prudente) | ~$1-2/jour quand actif |

---

## ⚠️ Points de vigilance permanents

1. **`run-daily-analysis` est en DRY_RUN par défaut** — tant que tu ne modifies pas le cron via `cron.alter_job`, aucun ordre Alpaca réel ne part automatiquement
2. **Premier ordre Alpaca réel = à valider EXPLICITEMENT** — pas de "go" silencieux
3. **Surveiller `system_heartbeats` quotidiennement** — si status != 'ok' un jour de marché → debug avant le suivant
4. **Surveiller cost cumulé** :
   ```sql
   SELECT SUM(cost_usd) AS week, DATE_TRUNC('day', created_at) AS day, SUM(cost_usd) AS day_cost
   FROM agent_logs WHERE created_at > NOW() - INTERVAL '7 days'
   GROUP BY day ORDER BY day DESC;
   ```
   Cible STRATEGY.md = $12-15/semaine. Si dépasse $25 → enquêter (loop infinie ?)

---

## 📝 POLISH restants (au-delà des bloquants déjà faits)

🟠 Importants à traiter dans les 2-3 prochaines sessions :
- **P-006** Réévaluation hebdo des positions ouvertes (3 appels Claude/position) — utile quand on aura des positions
- **P-010** Séparer `position_size_pct` (avant correl) et `position_size_pct_final` (après) — migration + update validate-order

🟡 Cosmétiques + ops :
- **P-009** Pin model version verification avant go-live
- **P-012** `agent_logs.signal_id` FK migration
- **P-013** Retention policy `agent_logs` (>100K rows)
- **P-014** Index partiel `signals.executed=true`
- **P-016** validate-order check cash Alpaca réel
- **P-017** Stock splits adjustment OHLCV
- **P-018** Validation Zod-like Claude responses

---

## 🚀 Definition of done pour cette session

Choisir UNE option, l'exécuter, puis :
- [ ] Update NEXT_SESSION.md pour la prochaine
- [ ] Tag les POLISH items DONE qu'on a fait
- [ ] git commit l'état si tu veux versionner

**Prochaine session après celle-ci** : selon ce qu'on aura fait, soit observation continue, soit Phase 5 dashboard, soit live execution prudente.

---

*19/22 étapes du build complètes. Aether est autonome en paper trading dry_run. 🎉*
