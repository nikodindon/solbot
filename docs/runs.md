# Journal des runs paper

Ce document raconte les **runs réels en mode paper** de solbot : configuration, résultats,
incidents et décisions. Il complète le README (qui décrit le fonctionnement du bot) : ici,
on documente **ce qui s'est passé**.

> ⚠️ Tous les chiffres sont en **mode paper** (aucun fonds réel engagé). Les horodatages des
> logs et de la base sont en **UTC** ; l'heure locale (CET/CEST) est indiquée quand c'est utile.
> Source de vérité : SQLite (`data/solbot.sqlite`), sauvegardes quotidiennes
> (`data/backups/`) et journaux (`data/paper-continuous.log`, `data/ab.log`).

---

## Vue d'ensemble

| Run | Période (UTC) | Instance | Config clé | Fin de run |
|---|---|---|---|---|
| **1 — Principal** | ~17/10 → 28/10 11:36 | `main` (4100) | sizing 6,5 % / 14 positions, cooldown 30 min, blacklist SPCXx | Kill-switch DD 15,19 % → **848,47 $** |
| **1 bis — A/B TP partiel** | 22/10 13:46 → 28/10 | `feat/tp-partiel` (4101) | TP partiel 50 % à +6 % | Kill-switch DD 15,19 % → **848,43 $**, 17 TP partiels |
| **2 — Après reset** | 28/10 11:40 → 04/11 ~09:28 | les deux | mêmes réglages | Kill-switch DD ≥15 % → principal **860,54 $**, A/B **865,63 $** |
| **3 — Courant** | 04/11 16:01 → en cours | les deux | + protection anti-faux-kill-switch | en cours |

Tous les runs partent de **1 000 $ virtuels**. Les dashboards sont en lecture seule sur le
réseau local : `http://<ip>:4100` (principal) et `:4101` (A/B).

---

## Run 1 — principal puis expérience A/B (17/10 → 28/10)

### Chronologie

- **~17/10** : premier run paper à 1 000 $. Pic de NAV à **1 000,43 $** le 17/10 à 09:54 UTC.
- **20/10** : passage en continu via `deploy/watchdog-paper.sh` (scan + moteur, relance auto,
  scan/refresh de la watchlist toutes les 12 h).
- **21/10** : sizing porté à **6,5 % par position** et **14 positions max** (+30 %), blacklist
  ciblée de **SPCXx** uniquement.
- **22/10 13:46** : lancement de l'**expérience A/B** sur la branche `feat/tp-partiel` :
  instance séparée (worktree, base copiée, dashboard 4101, Telegram coupé) avec
  **TP partiel 50 % à +6 %**. Le run principal reste en TP classique.
- **23/10** : coupure réseau → ajout d'un watchdog dédié à l'A/B (`ab-watchdog.sh`).
- **25/10** : premier point d'étape. L'A/B a déclenché **7 TP partiels** (USELESS, STONK, Bonk,
  SI, ORCA, USELESS, GRASS) pour ~**+13,48 $ sécurisés**. Principal **894,68 $** vs A/B
  **888,87 $** : le principal mène de ~5,8 $.
- **28/10** : marché durablement baissier. Les deux runs atteignent le **kill-switch à 15,19 %**
  de drawdown, positions liquidées, **0 position**. Principal **848,47 $**, A/B **848,43 $**.

### Résultats de l'expérience A/B (depuis le split du 22/10)

| | Principal | A/B TP partiel |
|---|---|---|
| Trades fermés | 171 | 165 |
| Gagnants | 32 | 31 |
| PnL réalisé | **−111,20 $** | **−111,25 $** |
| Déclencheurs | stop 99, momentum 55, trailing 16, TP 1 | stop 88, momentum 62, **TP partiel 17**, trailing 15 |
| Meilleurs | DOPE +9,73, STONK +7,00, USELESS +5,65 | SI +5,39, STONK +4,89, USELESS +4,64 |
| Pires | CARDS −11,87, DOPE −7,03, SI −5,41 | CARDS −11,46, DOPE −7,36, −6,97 |

**Conclusion honnête** : les 17 TP partiels ont tous été gagnants (+1,6 à +2,8 $ chacun),
mais le **PnL total est quasi identique** (−111,20 $ vs −111,25 $) et les NAV finissent à
0,04 $ l'une de l'autre. Dans ce marché baissier, le TP partiel a **réduit la variance** mais
n'a **pas créé de performance** : les pertes venaient des stops, pas des gains rendus.

### Décisions issues du run 1

- Cooldown anti-churn porté de 5 min à **30 min** (`min_time_between_trades_s: 1800`).
- TP partiel conservé sur la branche `feat/tp-partiel`, **désactivé par défaut** sur `main`.
- Reset des deux runs à 1 000 $ le **28/10 11:40 UTC**.

---

## Run 2 — après le reset du 28/10 (28/10 → 04/11)

- Départ : **1 000 $** sur les deux instances, base et kill-switch remis à zéro.
- Le run a duré environ **6,5 jours**. Dernier point sauvegardé le **04/11 à 03:00 UTC** :
  - **Principal** : NAV **860,54 $**, pic **1 018,87 $**, 191 trades fermés, 22 gagnants,
    PnL réalisé **−139,46 $**.
  - **A/B** : NAV **865,63 $**, pic **1 018,49 $**, 195 trades fermés, 23 gagnants,
    PnL réalisé **−134,37 $**, **11 TP partiels**.
- Le 04/11, le PC a été redémarré : les moteurs étaient arrêtés et le drawdown dépassait
  encore 15 % → **kill-switch** et **0 position**.
- **Reset à 1 000 $** le 04/11 vers 16:01 UTC (nouvelle base, `STOP` supprimé).

---

## Run 3 — courant (depuis le 04/11 16:01 UTC)

### Chronologie

- **04/11 16:01** : reset à 1 000 $, watchlist rescanée (42 actifs), moteurs et dashboards
  relancés.
- **05/11 ~08:00 UTC** : **faux kill-switch**. Un cycle de poll incomplet a valorisé les
  positions détenues à **0 $** pendant ~1 min 30 :
  - principal : 995,66 $ → **863,86 $** (−13,2 %) puis retour à 995,32 $ ;
  - A/B : 994,25 $ → **797,59 $** (−19,8 %) puis retour à 992,68 $.
  - Conséquences : **kill-switch A/B** (`STOP`, DD affiché 20,35 %) et **pause perte
    journalière** sur les deux (13,5 % / 20,23 %), alors que le drawdown réel était < 1 %.
- **05/11 ~11:00 UTC** : **dégel** (suppression du `STOP` et de la pause).
- **05/11 ~12:00 UTC** : correctif déployé (commit `9710bb1`) :
  - valorisation de secours avec le **dernier prix connu** au lieu de 0 $ ;
  - pic de NAV et garde-fous **neutralisés** si la valorisation est incomplète ;
  - **confirmation sur 2 ticks consécutifs** avant pause journalière / kill-switch ;
  - pas de point d'equity enregistré si une position reste non valorisable.

### État au 05/11 ~11:06 UTC

| | Principal | A/B |
|---|---|---|
| NAV | **996,18 $** | **993,73 $** |
| Caisse | 927,49 $ | 895,47 $ |
| Positions | TROLL | TROLL (moitié) + SI |
| Drawdown | 0,53 % | 0,76 % |
| PnL réalisé | −7,59 $ (9 fermées, 1 gagnante) | −9,27 $ (10 fermées, 1 gagnante) |

Observations : beaucoup de petits stop-loss (−0,90 à −2,88 $), un seul gagnant par run
(OPENAI), durée moyenne de détention **~50 min**. Net : −0,4 % / −0,6 %.

---

## Incidents & décisions transverses

| Date | Événement | Décision / action |
|---|---|---|
| 20/10 | Besoin de continuité | Watchdog `deploy/watchdog-paper.sh` (scan 12 h, relance auto) |
| 21/10 | Trop de positions / actif indésirable | Sizing 6,5 % / 14 positions, blacklist SPCXx |
| 22/10 | Tester le TP partiel | Branche `feat/tp-partiel`, instance A/B séparée |
| 23/10 | Coupure réseau | Watchdog dédié A/B + relance auto |
| 28/10 | Drawdown 15,19 % | Kill-switch, puis **reset** à 1 000 $ |
| 04/11 | Reboot PC, DD ≥15 % | Kill-switch, puis **reset** à 1 000 $ |
| 05/11 | Faux kill-switch (prix manquant) | Dégel + correctif `9710bb1` + tests |
| 05/11 | Le watchdog pouvait tuer solbot3 | Motifs `pgrep`/`pkill` limités à `$ROOT` (`81ad1f0`) |

### Points ouverts

- **Wallet non financé (0 SOL)** : impossible de faire un A/B ≥ 200 swaps en live.
- **Auto-start au boot** non configuré : après un reboot, les moteurs doivent être relancés
  (cron `@reboot` ou service systemd envisageable).
- Le **TP partiel** reste à réévaluer dans un marché haussier (les +6 % n'ont pas eu
  l'occasion de courir durablement dans les runs 1 et 2).

---

## Où trouver les données

| Donnée | Emplacement |
|---|---|
| Base principale | `data/solbot.sqlite` |
| Base A/B | `<worktree>/data/tp-partiel.sqlite` |
| Sauvegardes quotidiennes | `data/backups/solbot-AAAA-MM-JJ*.sqlite` |
| Log du moteur principal | `data/paper-continuous.log` |
| Log du moteur A/B | `<worktree>/data/ab.log` |
| Dashboards | `http://<ip>:4100` (principal), `:4101` (A/B) |

> Les runs 1 et 2 ont été **réinitialisés** : leur historique détaillé n'est plus dans la base
> courante, mais les sauvegardes à partir du **31/10** permettent de retrouver les chiffres.
> Les runs antérieurs au 31/10 sont documentés ici à partir des bilans de suivi.

---

## Mise à jour de ce journal

Ajouter une entrée à chaque **reset**, **incident** ou **bilan marquant**, avec :
la date UTC, l'instance concernée, la NAV, les positions, le drawdown et la décision prise.
