# NEXT_SESSION.md — Plan d'attaque pour la reprise

> 💡 **Ouvrir en premier à la reprise.** Mis à jour à la fin de chaque session. Dernière MAJ : **2026-07-01** (audit complet + remédiation).

---

## 📍 État réel du système (au 01/07/2026)

⚠️ **Le système trade en PAPER LIVE** (Alpaca paper, `paper-api.alpaca.markets`, compte PA3***C4, ~$100k). **Ce n'est PAS du dry_run.** Le cron `aether-daily-analysis` (jobid 2) tourne en `dry_run=false&limit=15` depuis **~le 3 juin 2026**.

*(Les anciennes versions de ce fichier disaient « DRY_RUN permanent / 0 BUY » — c'était FAUX depuis le 3 juin. Corrigé lors de l'audit du 01/07.)*

### Positions & P&L
- **8 positions CLÔTURÉES** + **2 OUVERTES** : **COO** (entrée 70.49, stop 65.56, TP 80.36) et **KBH** (entrée 61.99, stop 57.96, TP 70.67).
- **Les deux positions ouvertes sont protégées** (OCO natif ré-armé le 01/07 — cf. incident ci-dessous). Vérifier à la reprise : `curl .../functions/v1/ops-watchdog` → `naked_positions: []`.
- Sorties déjà observées en prod : stop_loss_hit, take_profit (KBH +745), timeout, thesis_review_sell.

### Machinerie
- **~27 Edge Functions ACTIVE** · **11+ cron jobs** · Dashboard Next sur Vercel (code accès 6 chiffres).
- **Coût Anthropic ~$3-4/mois** (tiering Haiku/Sonnet correct, 0% d'erreur LLM). Runtime = clé API propre → **inchangé par le passage Max→Pro**.
- **Feature store as-of** (`snapshot-features`, cron 22:00 UTC) accumule depuis le 29/06 pour le backtest à ~6 mois.

### Documents canoniques
- [STRATEGY.md](STRATEGY.md) — bible v2.7 · [DEVIATIONS.md](DEVIATIONS.md) — D-001 → **D-004** · [POLISH.md](POLISH.md)

---

## 🔎 Audit complet du 01/07 — fait & corrigé

Audit exhaustif 100% (10 domaines, 15 agents, findings vérifiés en adversarial). Verdict global : **🟡 sain et fonctionnel, mais 4 trous sûreté/gouvernance corrigés**. Détail dans D-004.

**Corrigé le 01/07** (les 4 HIGH + quick wins) :
- ✅ **Short à nu bloqué** (execute-order ne SELL plus + validate-order REJECT SELL sans position).
- ✅ **Veto Reviewer 2/3 déterministe** (tally code, plus seulement le verdict LLM).
- ✅ **Watchdog bracket par-position** → a révélé **COO+KBH sans stop natif** → **ré-armés en OCO** (`admin-rearm-stops`).
- ✅ **NEXT_SESSION.md corrigé** (ce fichier ne ment plus sur l'état live).
- ✅ **roe** dérivé + backfill · watchdog match END · cron update-positions 13-21 · RLS/index feature_snapshots/shadow.

**Statut des 5 pré-requis go-live (argent réel)** — honnête :
1. ✅ ≥5 jours d'observation sans crash — largement dépassé (live depuis juin).
2. ✅ ≥1 BUY exécuté — oui (10 positions).
3. ✅ Reviewer rejette les mauvais setups — observé + veto désormais déterministe.
4. ⚠️ **P-006 (réévaluation hebdo 3-pass) NON codé** — substitut : `review-positions` quotidien (cf. D-004c). À décider avant argent réel.
5. ✅ Observabilité (heartbeats + watchdog + Discord) opérationnelle et a déjà attrapé une panne (25/06).

---

## 🎯 Options pour la prochaine session

### A — Pousser l'UI polish (rapide, 5 min)
Le dashboard a été refait (live room responsive, vraies icônes, header partagé). **Le déploiement Vercel nécessite un push** :
```bash
cd ~/Documents/GitHub/aether && git push origin main
```

### B — Meds de l'audit (non-bloquants, cf. D-004)
Par ordre d'impact : staleness contexte week-end/férié (garde jour de bourse dans fetch-daily-context + assertion fraîcheur dans generate-decision) · C1 collapse (D-004d) · grades = counts pas events (D-004b) · résidu OCO après vente partielle.

### C — P-006 réévaluation hebdo (avant tout go-live réel)
Coder la re-évaluation 3-passes par position OPEN (SELL si conviction < 40), OU acter formellement le substitut `review-positions` dans DEVIATIONS (déjà fait en D-004c).

### D — Attendre le dataset (le vrai déblocage)
Dans ~30-60 jours de snapshots : coder `analyze-ic` qui joint `feature_snapshots` aux rendements forward → IC réel par cluster → savoir enfin quels clusters portent l'edge (le backtest prix a montré que C2 seul n'en a pas, D-004b). Puis ré-armer l'auto-tuner sur des bases solides.

---

## 🧹 Wrap-up à la reprise

1. **Santé** : `SELECT recorded_at, status, notes FROM system_heartbeats ORDER BY recorded_at DESC LIMIT 10;` (1 ligne watchdog/jour ouvré, status ok).
2. **Stops** : `curl .../functions/v1/ops-watchdog` → `naked_positions` doit être `[]`.
3. **Positions** : `SELECT ticker, status, pnl_usd FROM positions ORDER BY opened_at DESC LIMIT 12;`
4. **Coût** : `SELECT SUM(cost_usd), MIN(created_at) FROM agent_logs;` (cible < $1/jour ; si > $10/sem → enquêter loop).
5. **Snapshot frais** : `SELECT snapshot_date, count(*) FROM feature_snapshots GROUP BY 1 ORDER BY 1 DESC LIMIT 5;`

---

## 🔒 Vigilance permanente
- Le système trade en **paper LIVE** — toute modif de execute-order / validate-order / update-positions / review-positions touche le chemin de l'argent. Tester en dry_run + smoke avant deploy.
- **MCP uniquement** pour Supabase Aether (jamais le CLI). Projet `rhqtjzlwkjwetneqdvkv` (jamais InvestIQ).
- Doute = HOLD. C4/C5 = bloqueurs en STRICT, jamais générateurs de BUY. Couche 2 indépendante de Claude.
- **Carl passe Max → Pro vers le 03/07** → faire les gros audits maintenant, viser des interventions ciblées ensuite.

---

*Système en paper live depuis juin. Audit 01/07 : sain, 4 trous corrigés, positions protégées. Prochain palier = accumuler le dataset as-of pour mesurer l'edge réel. 🌙*
