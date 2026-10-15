# solbot — Présentation pour traders

> **À qui s'adresse ce document ?** Aux traders particuliers qui veulent comprendre ce que fait
> `solbot` **sans lire une ligne de code**. Tout le jargon est expliqué dans l'annexe en bas de page.
> Le détail technique complet est dans le [README principal](../README.md).

---

## Le pitch — 30 secondes

**solbot** est un robot de trading automatique pour le marché _spot_ de Solana, propulsé par
**Jupiter** (l'agrégateur d'échange le plus utilisé de l'écosystème). Vous le lancez sur une
machine : il surveille le marché en continu, applique des règles précises d'achat et de vente,
et respecte des limites de risque que vous fixez. Il ne dort jamais, ne panique jamais, et
**chaque décision est enregistrée noir sur blanc**. Par défaut, il commence en mode _paper_ :
il trade pour de faux, avec les vrais prix du marché. Aucun centime ne bouge tant que vous
ne le décidez pas — et le bot refuse de se lancer en réel sans que des garde-fous soient verts.

---

## Slide 1 — Le problème

Trader les cryptos soi-même, c'est :

- **un travail de 24/7** — les meilleures opportunités ne tombent pas pendant vos heures de bureau ;
- **des émotions coûteuses** — vendre trop tôt, garder trop longtemps, paniquer dans la baisse ;
- **zéro traçabilité** — après coup, vous savez rarement _pourquoi_ vous avez acheté, ni combien
  de frais et de slippage ont mangé la performance.

Et les bots clé-en-main du marché ? Souvent des boîtes noires : vous confiez vos fonds à un
programme dont vous ne savez rien. Impossible de vérifier ce qu'il fait réellement.

---

## Slide 2 — La solution : solbot

Un bot **open source** (le code est visible et auditable) qui :

- **trade tout seul** sur Solana : achats et ventes de tokens via Jupiter, 24 h/24 ;
- **vous laisse la main** : vous gardez vos clés, vous choisissez la stratégie, les montants et les limites ;
- **dit toujours la vérité** : chaque signal, chaque rejet du gestionnaire de risque et chaque trade
  est journalisé dans une base locale ; les rapports incluent les frais réels.

Point clé : solbot est **honnête par conception**. Le projet ne promet aucun rendement et documente
aussi ce qui peut mal se passer (frais, slippage, échecs, pertes).

---

## Slide 3 — Comment ça marche (vue simple)

À chaque **cycle** (toutes les 30 secondes par défaut), le bot :

1. **Regarde le marché** — prix et volumes via Jupiter, pour tous les tokens de votre liste de suivi ;
2. **Vérifie vos positions** — stop-loss, take-profit, trailing stop : les sorties de sécurité
   passent **toujours en premier** ;
3. **Cherche des opportunités** — les stratégies activées émettent des signaux d'achat ou de vente ;
4. **Demande l'autorisation au gestionnaire de risque** — il a le dernier mot, toujours ;
5. **Exécute** — via Jupiter ; en mode paper, tout est simulé, **aucun ordre réel n'est envoyé** ;
6. **Tout enregistre** — base de données locale + notifications sur votre téléphone (Telegram).

Un seul trade à la fois : pas de rafale incontrôlée, pas d'emballement.

---

## Slide 4 — Les stratégies incluses

| Stratégie                   | Principe en français simple                      | Quand elle achète / vend                                                                                                      |
| --------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **Momentum**                | « acheter ce qui monte, avec des confirmations » | achète quand le prix casse ses plus hauts avec volume et RSI en confirmation ; sort quand la tendance s'inverse (ou sur stop) |
| **Mean-reversion / grille** | « acheter bas, revendre à la moyenne »           | achète quand le prix décroche anormalement sous sa moyenne ; vend quand il y revient                                          |
| **DCA / rotation**          | « rééquilibrer en continu un portefeuille »      | maintient une allocation cible (ex. 40 % SOL / 60 % USDC) et corrige les dérives                                              |

Vous activez une seule stratégie ou plusieurs : le bot **arbitre** entre leurs signaux
(jamais deux actions contradictoires dans le même cycle, la sortie gagne toujours en cas de conflit).

Toute nouvelle stratégie se teste d'abord en backtest puis en paper — jamais directement en réel.

---

## Slide 5 — Les garde-fous : le RiskManager

Le bot peut **refuser un signal**, même excellent. C'est la pièce la plus importante du projet.
Valeurs par défaut :

- **Taille** : 5 % du capital maximum par position ;
- **Nombre** : 6 positions ouvertes maximum en même temps ;
- **Concentration** : 15 % maximum du portefeuille sur un même actif ;
- **Perte journalière** : −3 % → plus aucune entrée pendant 24 h (les sorties restent actives) ;
- **Drawdown max** : −15 % depuis le plus haut → kill-switch, plus aucune entrée ;
- **Sorties automatiques** : stop-loss −8 %, take-profit +15 %, trailing stop activé à +6 %
  puis suivi à 3 % ;
- **Qualité d'exécution** : refus si l'impact prix estimé dépasse 1 % ; anti-churn de 5 minutes
  entre deux trades sur le même actif ;
- **Réserve de frais** : 0,05 SOL intouchable, réservé aux frais réseau.

Et **deux interrupteurs d'urgence** : la commande Telegram `/kill` (coupe les entrées à distance)
et un fichier `STOP` sur la machine (mêmes effets). Dans les deux cas : plus d'entrées, mais les
sorties continuent de protéger vos positions.

---

## Slide 6 — Trois modes : essayer → vérifier → risquer

| Mode        | Ordres réels ?               | Argent réel ? | À quoi ça sert                                            |
| ----------- | ---------------------------- | ------------- | --------------------------------------------------------- |
| **paper**   | non                          | non           | s'entraîner et observer, avec de vrais prix de marché     |
| **dry-run** | préparés mais jamais envoyés | non           | vérifier que chaque ordre _serait_ réellement exécutable  |
| **live**    | oui, signés et envoyés       | **oui**       | trader avec de vrais fonds, seulement quand tout est vert |

On commence **toujours** par le mode paper. On ne passe en réel que si un **backtest sérieux**
(≥ 30 jours de données) est concluant pour les paramètres choisis. Le bot lui-même **refuse de
démarrer en live** sinon : ce n'est pas une consigne, c'est un verrou dans le code.

---

## Slide 7 — Les backtests : 6 jeux de paramètres, 30 jours de vraies données

Rejeu du moteur réel sur la fenêtre **15/09 → 15/10/2026** (~32 000 bougies de 15 minutes par run,
12 tokens liquides, caisse virtuelle de 1 000 $, **frais inclus** : slippage, impact, priority fee).

| #   | Étiquette        | Stratégie & paramètres                                 | Résultat net | Trades gagnants | Profit factor | Pire baisse | Entrées |
| --- | ---------------- | ------------------------------------------------------ | ------------ | --------------- | ------------- | ----------- | ------- |
| 1   | `momentum-base`  | momentum (RSI 65, volume ×1.5)                         | **+2,55 %**  | 31,1 %          | 1,19          | −3,86 %     | 185     |
| 2   | `momentum-relax` | momentum (RSI 70, volume ×1.2)                         | −0,62 %      | 30,9 %          | 0,94          | −6,25 %     | 255     |
| 3   | `meanrev-z2`     | mean-reversion (z 2.0 / 0.5)                           | −2,57 %      | 56,6 %          | 0,80          | −5,73 %     | 196     |
| 4   | `meanrev-z15`    | mean-reversion (z 1.5 / 0.5)                           | −3,88 %      | 56,3 %          | 0,78          | −5,74 %     | 311     |
| 5   | `dca-ab`         | DCA (40 % SOL / 60 % caisse, dérive 5 %, réappro 25 $) | +0,12 %      | 60,0 %          | 1,06          | −1,21 %     | 23      |
| 6   | `dca-b`          | DCA (50/50, dérive 10 %, réappro 50 $)                 | +0,18 %      | 60,0 %          | 1,11          | −1,18 %     | 17      |

_Profit factor = gains totaux ÷ pertes totales ; au-dessus de 1, la stratégie gagne plus qu'elle ne perd.
« Pire baisse » = baisse maximale depuis un sommet (drawdown)._

---

## Slide 8 — Lecture honnête de ces chiffres

- **Une seule fenêtre de marché** : 30 jours dans un régime donné. Ce n'est **pas une prédiction**
  du mois prochain.
- `momentum-base` gagne (+2,55 %), mais la variante « relâchée » — qui trade plus (255 entrées) —
  perd : les frais (27,71 $ contre 20,63 $) mangent la différence.
- La mean-reversion gagne la majorité de ses trades (~56 %) **mais perd au total** : quelques pertes
  dépassent les gains, et chaque aller-retour a un coût.
- Le DCA est quasi à plat : il limite la casse (−1,2 % de pire baisse) mais ne rapporte presque rien
  sur cette période.

**Conclusion : le bot est un outil, pas une machine à cash.** La seule façon de juger une stratégie :
des backtests sur plusieurs périodes, puis une **longue** observation en paper avant tout capital réel.

---

## Slide 9 — Les risques (ce que le bot ne peut pas éviter)

- **Perte totale possible** : les tokens à faible liquidité peuvent s'effondrer. Ce projet est un
  outil expérimental, pas un conseil financier.
- **Frais et slippage** : faibles sur Solana, mais réels à chaque aller-retour. Trop trader = les
  coûts s'accumulent (c'est visible dans le tableau ci-dessus).
- **Panne d'infrastructure** : coupure réseau, RPC en échec, machine redémarrée. Le bot sait
  reprendre son état tout seul, mais aucune garantie à 100 % n'existe.
- **Le passé ne prédit pas le futur** : une stratégie gagnante 30 jours peut perdre les 30 suivants.
  Les conditions de marché changent.
- **La clé privée** vit dans un fichier local sur la machine (protégé en lecture seule pour vous).
  Un coffre chiffré est prévu dans une prochaine version.

**Règle d'or : jamais votre wallet principal, jamais de l'argent dont vous avez besoin.**

---

## Slide 10 — Le suivi : votre téléphone comme cockpit

Une fois un bot Telegram créé (gratuit, 2 minutes via @BotFather) :

- **notifications** : chaque trade, chaque erreur, le rapport du jour, les alertes (réserve de frais
  basse, RPC en échec, taux d'échec anormal, écart de réconciliation), et chaque sauvegarde ;
- **commandes** : `/status` (état général), `/positions` (positions ouvertes), `/pnl` (performance),
  `/pause` et `/resume`, et `/kill` pour **couper toutes les entrées à distance**.

Sans Telegram, tout reste consultable dans les journaux et la base locale — mais vous perdez le
pilotage depuis le téléphone.

---

## Slide 11 — Démarrage : de zéro au premier run paper

En résumé (le pas-à-pas complet est dans le README, section « Démarrage rapide ») :

- **`init`** — génère un wallet dédié et le fichier de configuration ; affiche l'adresse à financer
  (utile seulement pour le futur mode réel) ;
- **watchlist** — on choisit quels tokens liquides surveiller et la stratégie à tester ;
- **`start --paper`** — premier run complet en argent fictif, avec les vrais prix ; on regarde vivre
  le bot (positions, PnL, rejets du risque) ;
- **`report`** — résultats détaillés : PnL, trades gagnants, profit factor, pire baisse, frais.

Puis, avant tout passage en réel : **au moins 7 jours d'observation continue en paper**,
sur des paramètres validés par backtest. Et seulement ensuite : un petit capital, sur un wallet
dédié, avec `confirm_live: true` — le verrou explicite.

Le mode paper fonctionne sans le moindre centime : c'est la porte d'entrée.

---

## Slide 12 — La roadmap : et après ?

- ✅ **Aujourd'hui (v0.6.0)** — moteur multi-stratégies, backtests, mode paper complet, et tout ce
  qu'il faut pour tourner 24/7 : Docker, notifications et commandes Telegram, métriques de santé,
  sauvegardes automatiques de la base.
- 🔜 **v0.7.0 — exécution avancée** : chemins d'échange plus efficaces, slippage adaptatif selon la
  volatilité, envoi de transactions optimisé. Objectif : réduire les coûts par trade.
- 🔭 **v1.0 — intelligence & extensions** : copy-trading (suivre des wallets performants),
  ordres limite et DCA déposés **sur la blockchain** comme filets de sécurité (ils survivent même si
  le bot s'arrête), coffre chiffré pour la clé privée, et un tableau de bord web en lecture seule.

---

## Slide 13 — En résumé

- Un bot **open source** qui trade seul sur Solana, avec des **garde-fous stricts** et une
  **traçabilité complète** de chaque décision ;
- On commence **toujours** par de l'argent fictif (paper), puis des backtests, et seulement ensuite
  du réel — et le bot **bloque le réel** sans backtest concluant ;
- **Rien n'est garanti** : c'est un outil expérimental, à réserver au capital que vous pouvez perdre
  entièrement.

**Envie de tester ?** Le README vous emmène du clonage au premier run paper en une dizaine de minutes.

---

## Annexe — Petit dictionnaire

| Terme               | Traduction simple                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------- |
| **Backtest**        | Rejouer une stratégie sur des données _passées_ pour voir comment elle aurait performé.     |
| **Paper mode**      | Trading simulé : vraies données de marché, argent fictif, aucun ordre envoyé.               |
| **Dry-run**         | Préparer chaque ordre comme en réel (vérifier qu'il serait exécutable) sans l'envoyer.      |
| **NAV**             | Valeur totale du portefeuille (caisse + positions valorisées au prix du marché).            |
| **Drawdown**        | Baisse depuis le plus haut atteint ; mesure la pire série de pertes traversée.              |
| **Win rate**        | Pourcentage de trades gagnants. Un win rate élevé ne garantit pas un profit global.         |
| **Profit factor**   | Gains totaux ÷ pertes totales. > 1 : la stratégie gagne plus qu'elle ne perd.               |
| **Sharpe**          | Rendement ajusté du risque ; plus c'est haut, meilleur est le couple rendement/volatilité.  |
| **Slippage**        | Écart entre le prix attendu et le prix réellement obtenu lors de l'échange.                 |
| **Impact prix**     | Combien votre propre ordre déplace le prix — élevé si le token est peu liquide.             |
| **Watchlist**       | Votre liste de tokens surveillés par le bot (filtres de liquidité, âge, sécurité).          |
| **Kill-switch**     | Interrupteur d'urgence : coupe toutes les entrées (les sorties restent actives).            |
| **RSI / EMA / ATR** | Indicateurs techniques classiques (force, moyenne, volatilité) utilisés par les stratégies. |
| **Momentum**        | Stratégie qui « suit la tendance » : achète ce qui monte avec des confirmations.            |
| **Mean-reversion**  | Stratégie de retour à la moyenne : achète bas ce qui a trop baissé, revend au retour.       |
| **DCA / rotation**  | Achats réguliers et rééquilibrage d'un portefeuille vers une allocation cible.              |
| **Jupiter**         | L'agrégateur d'échange dominant de Solana : il route votre ordre vers la meilleure piscine. |
| **RPC**             | Point d'accès à la blockchain Solana, utilisé par le bot pour lire les soldes.              |

## Pour aller plus loin

- **Démarrage complet, commandes détaillées** → [README §5](../README.md#5-démarrage-rapide)
- **Gestion du risque, règle par règle** → [README §9](../README.md#9-gestion-du-risque)
- **Backtesting & paper trading** → [README §11](../README.md#11-backtesting--paper-trading)
- **Observabilité & production 24/7** → [README §12](../README.md#12-observabilité--production)
- **Roadmap et phases** → [README §13](../README.md#13-roadmap-avancée)
