# solbot

> Bot de trading **spot autonome** sur Solana, propulsé par l'agrégateur **Jupiter**.
> Scanner continu des actifs, moteur de stratégies modulaire, gestion du risque stricte, exécution 24/7.

---

> ⚠️ **AVERTISSEMENT — À LIRE EN PREMIER**
>
> Ce logiciel manipule des **fonds réels** sur **mainnet-beta** (Jupiter n'existe pas sur devnet).
> Le trading de crypto-actifs, _a fortiori_ de tokens à faible liquidité, peut entraîner la **perte totale** du capital.
> Ce projet est un outil expérimental : il ne constitue **pas un conseil financier**.
> Commencez toujours par le **mode paper**, puis engagez uniquement du capital que vous pouvez perdre entièrement,
> sur un **wallet dédié** — jamais votre wallet principal.

---

## Sommaire

1. [Vision](#1-vision)
2. [Fonctionnalités cibles (v1.0)](#2-fonctionnalités-cibles-v10)
3. [Comment ça marche](#3-comment-ça-marche)
4. [Stack technique](#4-stack-technique)
5. [Démarrage rapide](#5-démarrage-rapide)
6. [Le wallet & le fichier `.env`](#6-le-wallet--le-fichier-env)
7. [Configuration](#7-configuration)
8. [Moteur de stratégies](#8-moteur-de-stratégies)
9. [Gestion du risque](#9-gestion-du-risque)
10. [Exécution & landing des transactions](#10-exécution--landing-des-transactions)
11. [Backtesting & paper trading](#11-backtesting--paper-trading)
12. [Observabilité & état](#12-observabilité--état)
13. [Roadmap avancée](#13-roadmap-avancée)
14. [Sécurité — checklist](#14-sécurité--checklist)
15. [Pièges connus & FAQ](#15-pièges-connus--faq)
16. [Ressources](#16-ressources)
17. [Licence](#17-licence)

---

## 1. Vision

**solbot** est un bot de trading **spot** complet pour Solana : il découvre en continu les actifs tradés sur
[Jupiter](https://jup.ag), génère des signaux via un **moteur de stratégies pluggable**, arbitre ces signaux
sous contrainte d'un **RiskManager** intransigeant, puis exécute les swaps via la **Jupiter Swap API V2**
(`/order` + `/execute`) avec landing géré par Jupiter.

Principes directeurs :

- **Sécurité d'abord** : wallet dédié, mode paper par défaut à l'installation, kill-switch, plafonds d'exposition.
- **Modulaire** : chaque stratégie est un plugin derrière une interface stable ; chaque brique (données, risque, exécution, notif) est testable indépendamment.
- **Observable** : chaque décision est journalisée (signal → arbitrage → ordre → exécution) et auditable dans SQLite.
- **Honnête** : le bot ne promet pas de rendement. Le README documente les frais, le slippage, les échecs d'exécution et les pièges.

Le projet démarre volontairement simple (`.env` + un process Node + SQLite) pour itérer vite, et monte en
robustesse progressivement (voir la [roadmap](#13-roadmap-avancée)).

---

## 2. Fonctionnalités cibles (v1.0)

| Domaine | Fonctionnalité |
|---|---|
| **Wallet** | `solbot init` génère un wallet au premier lancement, stocke la clé dans `.env` (chmod 600), refuse d'écraser, affiche l'adresse à financer. Keystore chiffré prévu en Phase 7. |
| **Univers d'actifs** | Découverte dynamique des tokens via **Tokens API v2** (vérifiés, tags, catégories, récents) + filtres liquidité / âge / organic score / blacklist. Des centaines d'actifs Jupiter, pas seulement SOL/USDC. |
| **Données de marché** | **Price API v3** (jusqu'à 50 mints par requête), polling périodique, agrégation OHLCV interne sur SQLite. |
| **Stratégies** | Moteur pluggable : **momentum**, **mean-reversion / grille**, **DCA / rotation de portefeuille**, **copy-trading** (Phase 7). Pondération et arbitrage par score. |
| **Risque** | Position sizing (% du NAV), plafonds d'exposition, stop-loss / take-profit / trailing stop, limite de perte journalière, drawdown max, cooldowns, price impact max, réserve de gaz SOL. |
| **Exécution** | Swap V2 Meta-Aggregator (`/order` → signature → `/execute`), slippage **RTSE** automatique, retries intelligents par code d'erreur, journalisation complète, modes paper / dry-run / live. |
| **24/7** | Daemon (Docker / systemd), reprise après crash avec réconciliation on-chain, notifications Telegram, healthcheck, rapport PnL quotidien. |
| **Analyse** | Backtest offline sur données historiques, métriques (PnL, win rate, profit factor, Sharpe, max drawdown), walk-forward en Phase 7. |
| **Extensions** | Ordres limite & DCA natifs Jupiter (Trigger API) comme filets de sécurité on-chain, dashboard web lecture seule (Phase 7). |

---

## 3. Comment ça marche

### 3.1 Cycle de trading

À chaque tick (période configurable, défaut : 30 s) :

```
 ┌────────────────────────────────────────────────────────────────────┐
 │ 1. REFRESH MARCHÉ                                                  │
 │    Price API v3 → watchlist + positions (1 requête / 50 mints)     │
 │    Mise à jour des ticks OHLCV en SQLite                           │
 ├────────────────────────────────────────────────────────────────────┤
 │ 2. GESTION DES POSITIONS                                           │
 │    Mark-to-market · PnL · stop-loss / take-profit / trailing       │
 ├────────────────────────────────────────────────────────────────────┤
 │ 3. ÉVALUATION DES STRATÉGIES                                       │
 │    Chaque stratégie activée → signaux candidats (avec confiance)   │
 ├────────────────────────────────────────────────────────────────────┤
 │ 4. ARBITRAGE DES SIGNAUX                                           │
 │    Score = confiance × edge estimé × fraîcheur                     │
 │    Max 1 action par tick (anti-rafale)                             │
 ├────────────────────────────────────────────────────────────────────┤
 │ 5. RISK CHECKS                                                     │
 │    Drawdown du jour · exposition · liquidité · cooldown · gaz SOL  │
 ├────────────────────────────────────────────────────────────────────┤
 │ 6. EXÉCUTION                                                       │
 │    GET /swap/v2/order → sign → POST /swap/v2/execute → résultat    │
 │    (paper mode : simulation, aucun ordre réel)                     │
 ├────────────────────────────────────────────────────────────────────┤
 │ 7. JOURNALISATION & NOTIFICATION                                   │
 │    SQLite (trades, signaux, erreurs) · logs pino · Telegram        │
 └────────────────────────────────────────────────────────────────────┘
```

### 3.2 Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                            solbot (Node.js)                          │
│                                                                      │
│   ┌───────────┐      ┌───────────────┐      ┌────────────────┐       │
│   │  Scanner  │─────▶│ Signal Engine │─────▶│  RiskManager   │       │
│   └─────┬─────┘      └───────┬───────┘      └───────┬────────┘       │
│         │                    │                      │                │
│         │          ┌─────────┴──────────┐           ▼                │
│         │          │   Stratégies       │   ┌────────────────┐       │
│         │          │  (plugins)         │   │   Executor     │       │
│         │          │  momentum · grid   │   │  (Swap V2)     │       │
│         │          │  dca · copy-trade  │   └───────┬────────┘       │
│         │          └────────────────────┘           │                │
│         ▼                                           ▼                │
│   ┌──────────────┐   REST (x-api-key)       ┌────────────────┐       │
│   │ Jupiter APIs │◀────────────────────────▶│  api.jup.ag    │       │
│   │ price/tokens │                          │  /swap/v2/*    │       │
│   └──────┬───────┘                          └───────┬────────┘       │
│          │                                          │                │
│   ┌──────▼───────┐                          ┌───────▼────────┐       │
│   │   SQLite     │                          │  Signer        │       │
│   │ état · PnL   │                          │  (Keypair)     │       │
│   └──────────────┘                          └───────┬────────┘       │
│                                                     │                │
│   ┌──────────────┐  ┌──────────────┐         ┌──────▼─────────┐      │
│   │  Telegram    │  │  Logs pino   │         │  Solana RPC    │      │
│   │  notif/ctl   │  │              │         │  (lecture)     │      │
│   └──────────────┘  └──────────────┘         └────────────────┘      │
└──────────────────────────────────────────────────────────────────────┘
```

> 💡 Fait méconnu : le path **Meta-Aggregator de Jupiter est RPC-less** — `/order` + `/execute` ne nécessitent
> aucun nœud RPC. Un RPC Solana reste utile pour **lire les soldes**, reconstruire l'état des positions au
> démarrage et (en Phase 6) utiliser le path Router avec votre propre envoi de transactions.

---

## 4. Stack technique

| Couche | Choix | Justification |
|---|---|---|
| Runtime | **Node.js 22 LTS** + **TypeScript 5.x** (`strict`) | Écosystème Solana le plus mature, typage fort pour un bot de trading. |
| SDK Solana | **`@solana/web3.js` v1** (principal) · **`@solana/kit` v8+** (Phase 6, transactions v1) | web3.js reste le standard de facto ; kit est requis pour signer les transactions Solana v1 (SIMD-0385, 4096 bytes). |
| Jupiter | Client REST maison typé sur **Swap V2** (`api.jup.ag/swap/v2`), **Price v3**, **Tokens v2** — validé par **zod** | `@jup-ag/api` cible l'ancienne API V1 (lite-api) en voie de retrait ; un client maison fin et typé est plus sûr et plus simple. |
| CLI | `commander` | Commandes `init`, `doctor`, `balance`, `scan`, `price`, `watch`, `swap`, `start`, `backtest`, `status`. |
| Config | Fichier `.env` (parseur interne, zéro dépendance) + `config.yaml` + validation **`zod`** au boot | Fail-fast : configuration invalide = arrêt immédiat, surface minimale. |
| Persistance | **`node:sqlite`** (SQLite intégré à Node 22 — zéro dépendance native) + migrations maison | Monoprocessus, zéro infra, aucun binaire à compiler. |
| Logs | **`pino`** (JSON) avec redaction des secrets | Logs structurés, exploitables, jamais de clé privée. |
| HTTP | `fetch` natif + **token bucket** maison (respect des rate limits Jupiter) | Contrôle fin des retries/429/5xx. |
| Tests | **`vitest`** | Rapide, TS natif. |
| Notifications | Telegram Bot API (via `fetch`) | Alertes & contrôle à distance (`/pause`, `/pnl`…). |
| Déploiement | Docker ou systemd | Redémarrage auto, volume persistant pour `data/`. |

---

## 5. Démarrage rapide

### 5.1 Prérequis

- Node.js ≥ 22 et npm ≥ 10
- Une **clé API Jupiter** (https://developers.jup.ag/portal) — optionnelle pour prototyper
  (accès *keyless* limité à 0.5 RPS), **requise** pour un fonctionnement sérieux.
- Une URL RPC Solana (le RPC public `api.mainnet-beta.solana.com` suffit pour tester ;
  Helius / QuickNode / Triton pour la production).
- Un peu de SOL (frais réseau) et un capital de départ en USDC (ex. 20–50 USDC pour les tests).

### 5.2 Installation

```bash
git clone <votre-repo> solbot && cd solbot
npm install
```

> 🗂️ Le `.gitignore` créé en Phase 0 doit couvrir : `.env`, `data/`, `dist/`, `node_modules/`.
> Tant que ce n'est pas le cas, **ne committez rien** : une clé privée commitée est une clé compromise.

### 5.3 Premier lancement : création du wallet

```bash
npm run solbot -- init
```

Sortie typique :

```
  solbot init — création du wallet de trading
  ─────────────────────────────────────────────
  ✔ Wallet généré : 7xKX3f...9fQm
  ✔ .env créé (chmod 600) — clé stockée dans BS58_PRIVATE_KEY

  ⚠ Cette clé contrôle des fonds réels.
    • Sauvegardez-la dans votre gestionnaire de mots de passe.
    • Ne la partagez JAMAIS, ne la commitez JAMAIS.

  Prochaines étapes :
   1. Envoyez du SOL (≥ 0.05) sur   7xKX3f...9fQm   → frais réseau
   2. Envoyez des USDC (capital de trading de départ suggéré : 20–50)
   3. Renseignez JUPITER_API_KEY dans .env → https://developers.jup.ag/portal
   4. Lancez : npm run solbot -- doctor
```

Comportement du `init` :

- refuse d'écraser un `.env` existant contenant déjà une clé (sauf `--force` explicite) ;
- écrit le fichier avec les permissions `600` ;
- la clé est encodée **base58** (format compatible Phantom — importable en cas de besoin) ;
- **aucun log ne contient jamais la clé**, même en `LOG_LEVEL=debug`.

### 5.4 Financer le wallet

Depuis n'importe quel exchange ou wallet, envoyez sur l'adresse affichée :

- **SOL** : ≥ 0.05 SOL (frais de transaction, priorités, éventuel wrapping) ;
- **USDC** : le capital de trading (commencez petit : 20–50 USDC).

### 5.5 Vérifier puis lancer

```bash
npm run solbot -- doctor          # vérifie RPC, clé API, solde, version
npm run solbot -- scan            # construit la watchlist (univers filtré) → SQLite
npm run solbot -- price SOL USDC  # prix en direct (Price v3) + paire implicite
npm run solbot -- watch           # collecte ticks + bougies OHLCV en continu (Ctrl+C)
npm run solbot -- swap SOL USDC 0.05 --dry-run   # swap simulé : vrai /order + simulation RPC, sans signature
npm run solbot -- start --paper   # démarre le moteur en mode paper (Phase 3)
```

Le mode **paper** est le défaut à l'installation :

```bash
npm run solbot -- start --paper   # simulation complète (mêmes règles, aucun ordre)
npm run solbot -- start --dry-run # obtient de vrais /order + simulation on-chain, sans signer
npm run solbot -- start --live    # ⚠ fonds réels — exige confirm_live: true en config
```

Le swap manuel suit la même logique — `solbot swap` respecte le mode de `config.yaml`, et les
drapeaux `--dry-run` / `--live` le forcent (le live exige `confirm_live: true` + confirmation) :

```bash
npm run solbot -- swap SOL USDC 0.05 --dry-run        # citation réelle + simulation, aucun fonds engagé
npm run solbot -- swap USDC SOL max --dry-run         # vend tout le solde USDC (réserve de gaz conservée pour SOL)
npm run solbot -- swap BONK USDC 1000 --max-slippage-bps 50
npm run solbot -- swap USDC SOL 10 --live             # ⚠ fonds réels — confirmation interactive (« oui », timeout 60 s)
npm run solbot -- swap SOL USDC 0.01 --live --yes     # ⚠ automatisation — pas de confirmation (bots/cron)
```

---

## 6. Le wallet & le fichier `.env`

### Format

```ini
# ── Wallet (généré par `npm run solbot -- init`) ──────────────
BS58_PRIVATE_KEY=            # clé privée 64 bytes encodée base58
# ── Jupiter ───────────────────────────────────────────────────
JUPITER_API_KEY=             # https://developers.jup.ag/portal
JUPITER_RPS=                 # débit max (req/s) — vide = 1 avec clé, 0.5 sans
# ── RPC Solana (lecture) ──────────────────────────────────────
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
# ── Notifications (optionnel) ─────────────────────────────────
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
# ── Divers ────────────────────────────────────────────────────
LOG_LEVEL=info
```

### Modèle de menace (assumé et documenté)

Stocker la clé en clair dans `.env` est un **compromis de développement**, acceptable en Phase 0–2 uniquement, avec ces mitigations :

| Risque | Mitigation |
|---|---|
| Fuite via Git | `.env` dans `.gitignore` **dès le premier commit**. |
| Lecture par un autre process/utilisateur | `chmod 600`, utilisateur système dédié au bot. |
| Fuite via les logs/crash dumps | Redaction pino ; la clé ne transite jamais par le logger. |
| Compromission de la machine | Wallet **dédié** avec capital limité — jamais le wallet principal. |
| Fuite de la clé (avérée) | Procédure de rotation : transférer immédiatement les fonds vers un nouveau wallet, regénérer via `init --force`, révoquer la clé API Jupiter. |

> 🔒 La roadmap inclut en **Phase 7** un keystore chiffré (argon2 + AES-GCM) puis une abstraction *signer*
> (local chiffré | service de signature distant | KMS/HSM). L'interface `Signer` est prévue dès la Phase 0
> pour rendre cette migration indolore.

---

## 7. Configuration

### 7.1 Variables d'environnement

Voir la section [6](#6-le-wallet--le-fichier-env). Toute variable manquante ou invalide fait échouer le
démarrage avec un message explicite (validation zod), plutôt que d'échouer en plein trade.

### 7.2 `config/config.yaml`

Copiez `config/config.example.yaml` vers `config/config.yaml` et ajustez.
Exemple complet et commenté :

```yaml
mode: paper                # paper | dry_run | live (live exige confirm_live: true ci-dessous)
confirm_live: false        # garde-fou : doit être true pour autoriser le mode live
base_currency: USDC        # devise de référence pour le NAV et le PnL
loop_interval_s: 30        # période du tick principal

universe:                  # quels actifs le scanner peut trader
  category: toptraded      # classement source : toporganicscore | toptraded | toptrending
  interval: 24h            # fenêtre du classement : 5m | 1h | 6h | 24h
  candidate_limit: 100     # candidats demandés à Jupiter avant filtrage
  verified_only: true      # uniquement les tokens vérifiés (Tokens API v2)
  min_liquidity_usd: 250000
  min_organic_score: 60    # score "organic" Jupiter : filtre anti-volume artificiel
  min_age_hours: 24        # évite les tokens < 24 h (frais Jupiter 50 bps + risque rug)
  blacklist_mints: []      # mints interdits (ex. tokens à problème connus)
  whitelist_mints: []      # si non vide → univers restreint à cette liste
  max_watchlist: 40        # taille max de la short-list surveillée (hors SOL/USDC)

strategies:                # chaque stratégie est activable/paramétrable indépendamment
  momentum:
    enabled: true
    weight: 1.0
    timeframe: 15m
    params: { ema_fast: 12, ema_slow: 26, rsi_period: 14, rsi_entry: 65, atr_stop_mult: 2.0 }
  mean_reversion:
    enabled: false
    weight: 1.0
    params: { z_entry: 2.0, z_exit: 0.5, window: 96 }
  dca_rotation:
    enabled: false
    weight: 0.5
    params: { target_alloc: { SOL: 0.4, USDC: 0.6 }, drift_trigger_pct: 5, topup_usdc: 25 }
  copy_trade:
    enabled: false
    weight: 1.0
    params: { wallets: [], max_delay_ms: 2000, size_mode: proportional, max_trade_usdc: 50 }

risk:                      # le RiskManager a toujours le dernier mot
  max_position_pct: 5          # % du NAV par position
  max_positions: 6             # nombre max de positions ouvertes simultanément
  max_asset_exposure_pct: 15   # % du NAV max sur un même actif
  daily_loss_limit_pct: 3      # perte journalière max → pause automatique 24 h
  max_drawdown_pct: 15         # drawdown max depuis le pic → kill-switch
  stop_loss_pct: 8
  take_profit_pct: 15
  trailing_stop: { activation_pct: 6, retrace_pct: 3 }
  max_slippage_bps: 100        # utilisé si execution.slippage n'est pas 'rtse'
  min_time_between_trades_s: 300
  max_price_impact_pct: 1.0    # rejet si l'impact estimé dépasse ce seuil
  sol_gas_reserve: 0.05        # SOL intouchable, réservé aux frais

execution:
  path: meta_aggregator        # meta_aggregator (/order+/execute) | router (/build)
  slippage: rtse               # rtse (recommandé) | <entier en bps>
  exclude_routers: []          # ex. [jupiterz] pour forcer des frais de gaz classiques
  retries: 3
  retry_backoff_ms: 750
  confirm_timeout_s: 60

notifications:
  telegram:
    enabled: false
    notify_on: [trade, error, daily_report]

database:
  path: ./data/solbot.sqlite
```

---

## 8. Moteur de stratégies

Chaque stratégie implémente une interface unique :

```ts
interface Strategy {
  name: string;
  requiredData: DataRequirement[];          // ex. candles 15m, prix spot, liquidité
  evaluate(market: MarketSnapshot): Signal[]; // signaux candidats
}

interface Signal {
  assetMint: string;
  side: 'buy' | 'sell';
  confidence: number;      // 0..1
  edgeEstimateBps?: number; // edge estimé, net de frais
  ttlMs: number;           // durée de validité du signal
  reason: string;          // journalisé pour audit
  suggestedStopLossPct?: number;
}
```

Le **Signal Engine** collecte les signaux de toutes les stratégies activées, les pondère (`weight`),
arbitre par score (`confiance × edge × fraîcheur`) et ne transmet au RiskManager qu'un nombre limité
d'actions par tick (anti-rafale, anti-churn).

| Stratégie | Principe | Signaux produits | Statut |
|---|---|---|---|
| **momentum** | EMA rapide/lente + filtre RSI + confirmation volume ; stops basés ATR | Entrée long sur breakout confirmé ; sortie sur croisement inverse | Phase 3 (première) |
| **mean_reversion** | Z-score du prix vs moyenne glissante (ou grille adaptative autour d'une ancre) | Entrée quand déviation > seuil ; sortie au retour à la moyenne | Phase 4 |
| **dca_rotation** | Allocation cible (ex. 40 % SOL / 60 % USDC), rééquilibrage par dérive | Achats/ventes de rééquilibrage périodiques | Phase 4 |
| **copy_trade** | Surveillance de wallets performants (logs RPC / webhooks), réplication contrainte par le risque | Réplication proportionnelle du swap détecté | Phase 7 |

> 🧪 Toute nouvelle stratégie se développe et se valide d'abord en **backtest** puis en **paper mode**
> avant d'être autorisée en live (garde-fou : `enabled: false` par défaut).

---

## 9. Gestion du risque

Le RiskManager est **l'autorité finale** : un signal, même excellent, peut être rejeté.
Il applique, dans l'ordre :

1. **Kill-switch global** — fichier `STOP` présent, signal d'arrêt reçu, ou drawdown max atteint → liquidation neige : plus aucune entrée.
2. **Limite de perte journalière** — perte cumulée > `daily_loss_limit_pct` → pause 24 h (reprise automatique au reset UTC).
3. **Plafonds d'exposition** — positions ouvertes, exposition par actif, NAV engagé.
4. **Sizing** — taille = `min(max_position_pct × NAV, exposition restante, contrainte de liquidité)`. La contrainte de liquidité utilise le prix/impact estimé (rejet si impact > `max_price_impact_pct`).
5. **Cooldowns** — délai minimum entre deux trades sur le même actif (anti-churn).
6. **Réserve de gaz** — le SOL sous `sol_gas_reserve` n'est jamais vendu ; le bot refuse un trade si les frais estimés mangent la réserve.
7. **Garde de sortie** — stop-loss, take-profit, trailing stop appliqués à chaque tick, avec priorité absolue sur toute entrée.

Chaque rejet est journalisé avec sa raison (`risk_rejections` en base) : en fin de journée, le rapport
Telegram inclut le compteur de rejets par motif — outil de réglage essentiel.

---

## 10. Exécution & landing des transactions

### Path par défaut : Meta-Aggregator (Swap V2)

```ts
// 1. Devis + transaction assemblée — tous les routeurs se battent pour le meilleur prix
GET https://api.jup.ag/swap/v2/order?inputMint=<mint>&outputMint=<mint>&amount=<unités minimales>&taker=<pubkey>
Headers: { "x-api-key": JUPITER_API_KEY }
// → { transaction: <base64>, requestId, outAmount, router, feeBps, ... }

// 2. Signature locale — si le routeur retenu est JupiterZ, on effectue une signature PARTIELLE :
//    une signature market-maker supplémentaire est ajoutée côté Jupiter lors du /execute
const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
tx.sign([wallet]);
const signedTransaction = Buffer.from(tx.serialize()).toString('base64');

// 3. Exécution avec landing géré par Jupiter (Jupiter Beam)
POST https://api.jup.ag/swap/v2/execute
Body: { signedTransaction, requestId }
// → { status: "Success"|"Failed", signature, code, totalInputAmount, totalOutputAmount, ... }
```

Points clés retenus pour l'implémentation :

- **Signature immédiate** : `lastValidBlockHeight` (routeurs on-chain) et `expireAt` (RFQ) bornent la validité ; les prix bougent — on signe et on envoie aussitôt.
- **Slippage RTSE** : appliqué automatiquement par `/order`. Ne le fixer manuellement qu'en connaissance de cause (l'ajout de paramètres optionnels passe l'ordre en mode `manual` et peut restreindre le routing).
- **Gestion des error codes** (voir FAQ) : chaque code a une stratégie de récupération (re-quote, attente, abandon + notification).
- **Frais Jupiter** : 2 bps SOL↔stable, 5 bps LST↔stable, 10 bps paires quelconques, 50 bps tokens < 24 h — inclus dans le devis, suivis dans le PnL.
- **`totalOutputAmount` vs `outputAmountResult`** : on comptabilise `totalInput/OutputAmount` (reflet réel du wallet) dans le PnL.

### Path avancé : Router (`/build`) — Phase 6

Pour les cas nécessitant un contrôle total (instructions custom, option de landing par `tx.jup.ag` avec tip ≥ 0.001 SOL, simulation CU à 1.2×, `mode=fast` pour latence minimale sur paires connues) :

```
GET /swap/v2/build → computeBudgetInstructions + setupInstructions + swapInstruction + cleanupInstruction + tipInstruction + ALTs
→ construire la transaction soi-même → simuler → signer → envoyer via son RPC ou tx.jup.ag
```

Le path Router n'a **aucun frais Jupiter** (routing Metis uniquement, pas de RFQ) mais exige de gérer soi-même CU, priority fees et landing. Le bot vise le Meta-Aggregator par défaut et mesure les deux en Phase 6.

---

## 11. Backtesting & paper trading

Trois niveaux de validation avant le live :

| Mode | Description | Phase |
|---|---|---|
| **Backtest** | Rejoue l'historique OHLCV stocké (ou importé) + modèle de coûts réaliste : frais Jupiter par paire, priority fees, slippage estimé (modèle impact = k × taille/liquidité). | 4 |
| **Paper** | Le bot tourne en temps réel, réels appels API, **aucun ordre** : les "fills" sont simulés au prix courant + slippage modélisé. Table `paper_trades` séparée. | 3–4 |
| **Dry-run** | Obtient de vrais `/order` et simule la transaction on-chain (`simulateTransaction`), détecte les échecs réalistes (slippage, comptes manquants), **sans signer ni envoyer**. | 2 |

⚠️ Honnêteté méthodologique : les données historiques de qualité sont limitées (Price API v3 ne fournit
que le spot actuel). Le bot **accumule ses propres ticks OHLCV en SQLite** dès la Phase 1 ; les backtests
initiaux utilisent donc soit cette accumulation, soit un import externe (Birdeye, GeckoTerminal).
Un backtest sur trop peu de données est signalé comme non concluant.

Métriques générées : PnL net (après tous frais), win rate, profit factor, turnover, max drawdown,
Sharpe simplifié, et **slippage réalisé vs estimé** (le juge de paix de l'exécution).

---

## 12. Observabilité & état

- **SQLite** (`data/solbot.sqlite`) — source de vérité locale :
  `trades`, `paper_trades`, `positions`, `price_ticks`, `signals`, `risk_rejections`, `errors`, `daily_pnl`.
- **Réconciliation au démarrage** : l'état des positions est reconstruit depuis la **chaîne** (soldes réels via RPC) puis confronté à la base ; toute divergence est journalisée et notifiée — jamais de "position fantôme".
- **Logs pino JSON** : un flux par décision (`signal`, `arbitrage`, `risk`, `order`, `execute`, `error`), rotation quotidienne.
- **Telegram** (Phase 5) : notification d'exécution, d'erreur, rapport PnL quotidien ; commandes `/status`, `/positions`, `/pnl`, `/pause`, `/resume`, `/kill`.
- **Healthcheck** : endpoint HTTP local (Phase 5) pour Docker/systemd + métriques Prometheus.

---

## 13. Roadmap avancée

### Vue d'ensemble

| Phase | Version | Focus | Risque de perte de fonds |
|---|---|---|---|
| 0 | v0.1.0 | Fondations : config, wallet, CLI, doctor — ✅ **réalisée** | nul (aucun trade) |
| 1 | v0.2.0 | Données de marché : Price v3, Tokens v2, SQLite, scan — ✅ **réalisée** | nul |
| 2 | v0.3.0 | Premier swap : `/order` + `/execute`, dry-run, erreurs — ✅ **réalisée** | faible (manuel, montants choisis) |
| 3 | v0.4.0 | Moteur autonome mono-stratégie + risque complet | réel encadré |
| 4 | v0.5.0 | Multi-stratégies + backtesting + paper complet | réel encadré |
| 5 | v0.6.0 | Production 24/7 : Docker, Telegram, métriques, backups | réel encadré |
| 6 | v0.7.0 | Exécution avancée : `/build`, tx.jup.ag, Jito, v1 txs | réel avancé |
| 7 | v1.0.0 | Intelligence & extensions : copy-trading, Trigger API, keystore | réel mature |

Chaque phase a une **Definition of Done** mesurable. Une phase ne commence que si la précédente est verte.

---

### Phase 0 — Fondations (v0.1.0) — ✅ **réalisée**

- [x] Initialisation projet : TypeScript strict, ESLint/Prettier, `tsx`, `vitest`
- [x] `src/utils/config.ts` : chargement `.env` + `config.yaml`, validation **zod**, fail-fast
- [x] `src/utils/logger.ts` : pino JSON + redaction des secrets
- [x] `src/solana/connection.ts` : connexion RPC (retry, timeout, fallback de secours)
- [x] CLI `commander` : `init`, `doctor`, `balance`, `version` (+ stubs `swap`/`start`/`backtest` qui renvoient vers la roadmap)
- [x] **`solbot init`** : génération `Keypair` ed25519 → `.env` (base58, chmod 600), refus d'écrasement, adresse affichée, guide de financement
- [x] Interface `Signer` abstraite (impl. unique : `EnvSigner`) — prépare la Phase 7
- [x] `solbot doctor` : RPC joignable, clé API valide, soldes SOL/USDC, version Node, dossier `data/`
- [x] `.gitignore` (`.env`, `data/`, `dist/`, `node_modules/`)
- [x] Tests unitaires : config (cas invalides), parseur `.env`, wallet/signer, `init` — **37 tests verts**

**DoD** : ✅ `init` puis `doctor` opérationnels (testés contre le RPC mainnet et l'API Jupiter réels) ;
tous les cas de configuration invalide couverts par les tests ; aucun secret dans les logs (redaction pino vérifiée).

### Phase 1 — Données de marché (v0.2.0) — ✅ **réalisée**

- [x] `JupiterClient` : wrapper `fetch` typé (zod) + `x-api-key`, timeouts, retry 429/5xx avec backoff exponentiel (+ respect de `x-ratelimit-reset`), **token bucket** respectant le tier (Keyless 0.5 RPS / Free 1 / Developer 10 / Launch 50 / Pro 150 — surcharge via `JUPITER_RPS`)
- [x] **Price v3** : `GET /price/v3?ids=` (batches ≤ 50 mints), cache TTL court (10 s)
- [x] **Tokens v2** : `search`, `tag`, `category`, `recent` — découverte d'actifs
- [x] **Univers** : filtres (vérifié, liquidité, organic score, âge, blacklist/whitelist) + tri déterministe (organic ↓ · liquidité ↓ · symbole ↑) → watchlist (SOL/USDC toujours inclus en mode catégorie)
- [x] SQLite via **`node:sqlite`** (intégré à Node 22 — zéro dépendance native) : migrations versionnées, tables `watchlist`, `price_ticks`, `candles`
- [x] Poller de prix (`solbot watch`) → ticks persistés → agrégation OHLCV interne **1m/5m/15m/1h** (upsert idempotent : open figé, high/low élargis, close = dernier tick)
- [x] CLI : `solbot scan [--top N] [--no-save]`, `solbot price SOL USDC` (aussi par nom ou mint), `solbot watch [--once] [--interval 5] [--duration 60] [--refresh]`

**DoD** : ✅ `solbot scan` produit une watchlist filtrée et **stable** (tri déterministe, métriques d'exclusion affichées) ;
`solbot watch` alimente des bougies cohérentes (agrégation couverte par tests unitaires + vérifiée en base après cycles réels) ;
client **429-safe** (retry + backoff + respect des headers de rate limit) — vérifié contre l'API Jupiter mainnet réelle.
**73 tests verts** (dont rate limiter, client HTTP, lots Price v3, filtres d'univers, OHLCV, migrations).

### Phase 2 — Premier swap (v0.3.0) — ✅ **réalisée**

- [x] `Executor` Swap V2 : `/order` (avec `taker` = adresse du wallet) → désérialisation `VersionedTransaction` → signature (partielle si router `jupiterz`) → `/execute` → parsing complet du résultat
- [x] Gestion exhaustive des erreurs : codes `/order` (`""` + errorCode) et `/execute` (-1, -2, -3, -1000→-1005, -2000→-2004) avec stratégie par code — re-quote borné par `execution.retries` (backoff `execution.retry_backoff_ms`) ou abandon immédiat — et messages français avec indice actionnable
- [x] Mode **dry-run** : vrai `/order` + `simulateTransaction` (`sigVerify: false`, blockhash remplacé), journalisation sans signature
- [x] Journalisation `trades` (migration v2) : signature, mints, montants in/out (texte u64), `router`, `feeBps`/`feeMint`, impact prix, slippage demandé et **réalisé** (vs `outAmount` attendu), codes d'erreur
- [x] CLI : `solbot swap <entrée> <sortie> <montant|max> [--dry-run] [--live] [--yes] [--max-slippage-bps N]` — garde-fous : plafond `risk.max_slippage_bps`, `confirm_live: true`, confirmation interactive (timeout `execution.confirm_timeout_s`), réserve de gaz respectée par `max`
- [x] Tests d'intégration contre l'API réelle (`tests/integration/`, désactivés par défaut — `SOLBOT_INTEGRATION=1 npm run test:integration`)

**DoD** (état au 15/10/2026) : ✅ 10 dry-runs consécutifs sans crash ; ✅ échec provoqué vérifié — fonds
insuffisants (`errorCode 1`) et slippage au-dessus du plafond, contre l'API mainnet réelle ; ✅ **114 tests**
(dont le test `@integration`). ⏳ **Reste à valider dès que le wallet est financé** : aller-retour
USDC→SOL→USDC de 10 USDC, slippage total < 1 %, deux swaps journalisés avec leur signature.

### Phase 3 — Moteur autonome mono-stratégie (v0.4.0)

- [ ] Interface `Strategy` + registre + chargement depuis la config
- [ ] Stratégie **momentum** complète (EMA 12/26, RSI, confirmation volume, stops ATR)
- [ ] `Portfolio` : positions, cost basis FIFO, mark-to-market, PnL réalisé/latent, NAV en USDC
- [ ] `RiskManager` complet (règles de la section 9) + table `risk_rejections`
- [ ] Boucle principale (tick 30 s) + verrou monoconcurrence (1 trade en vol à la fois)
- [ ] **Reprise après crash** : réconciliation on-chain au boot (soldes RPC vs base), décision automatique (adopter l'état chaîne)
- [ ] SL / TP / trailing stop automatiques à chaque tick
- [ ] **Kill-switch** : fichier `STOP` + arrêt propre sur SIGINT/SIGTERM (position conservée, entrées coupées)

**DoD** : 48 h de paper mode en continu sans fuite mémoire ni position orpheline ; un kill-switch manuel coupe les entrées en < 1 tick ; un reboot forcé du process en pleine position est correctement réconcilié ; tous les rejets de risque sont motivés en base.

### Phase 4 — Multi-stratégies & backtesting (v0.5.0)

- [ ] Stratégie **mean-reversion** (z-score, fenêtre paramétrable) + option grille adaptative
- [ ] Stratégie **DCA/rotation** (dérive vs allocation cible, rééquilibrage)
- [ ] **Arbitrage inter-stratégies** : score composite, conflit résolu par confiance × edge × poids ; journalisation de la décision
- [ ] **Backtester** offline : rejeu de ticks/OHLCV + modèle de coûts (frais par paire, priority fees, impact en k×taille/liquidité)
- [ ] **Paper mode** de première classe : mêmes règles que live, table dédiée, rapport comparatif paper vs backtest
- [ ] Rapport de métriques (PnL net, win rate, profit factor, Sharpe, max DD, turnover) en CLI et Telegram

**DoD** : comparaison documentée de ≥ 2 jeux de paramètres par stratégie sur ≥ 30 jours de données ; le backtest de la stratégie momentum reproduit grossièrement le paper mode de la Phase 3 (écart expliqué par les coûts) ; aucune stratégie ne peut être activée en live sans passer par le backtest (garde-fou codé).

### Phase 5 — Production 24/7 (v0.6.0)

- [ ] **Dockerfile** + `docker-compose` (volume `data/`, `restart: unless-stopped`) et unité systemd alternative
- [ ] Healthcheck HTTP local + métriques Prometheus (`prom-client`), dashboard Grafana optionnel
- [ ] **Telegram** : notifications (trade exécuté, erreur, rapport PnL quotidien) + commandes `/status`, `/positions`, `/pnl`, `/pause`, `/resume`, `/kill`
- [ ] Alerting : solde SOL sous réserve, RPC en échec, taux d'échec `/execute` anormal, divergence de réconciliation
- [ ] Sauvegardes SQLite quotidiennes + procédure de restauration testée
- [ ] Rotation des logs, retry RPC avec providers de secours

**DoD** : 7 jours d'uptime sans intervention manuelle ; toute exécution ou erreur notifiée en < 10 s ; restauration d'un backup SQLite validée sur un environnement neuf ; kill-switch testé à distance via Telegram.

### Phase 6 — Exécution avancée (v0.7.0)

- [ ] Path **Router** (`/build`) en option : assemblage d'instructions, simulation CU (limite = 1.2 × simulation), `computeUnitPricePercentile`, `maxAccounts`, `mode=fast` pour les paires connues
- [ ] Landing alternatif **tx.jup.ag** (send-only, tip ≥ 0.001 SOL) + comparaison mesurée du taux de landing vs `/execute`
- [ ] Option **Jito** (bundles, tip account dynamique) pour les sorties urgentes
- [ ] **Slippage adaptatif** : RTSE vs borne fixe selon la volatilité (ATR) ; re-quote intelligent sur échec de type slippage
- [ ] Support **transactions Solana v1** (SIMD-0385, 4096 bytes, `@solana/kit` v8+) quand la taille de transaction est un facteur limitant
- [ ] Optimisation latence : choix de la région API (eu-central-1 pour l'Europe), cache de blockhash, parallélisation des appels de préparation

**DoD** : A/B mesuré sur ≥ 200 swaps réels : taux de landing, slippage moyen et coût total (frais + tips) documentés par chemin d'exécution ; bascule automatique vers le chemin le plus efficace par type de paire.

### Phase 7 — Intelligence & extensions (v1.0.0)

- [ ] **Copy-trading** : watchers de wallets (logs RPC / webhooks Helius), détection de swaps, réplication proportionnelle contrainte par le RiskManager, latence mesurée
- [ ] Intégration **Trigger API** : ordres limite (`/trigger/v2/orders/price`) et DCA (`/trigger/v2/orders/dca`) déposés on-chain comme filets de sécurité — un TP on-chain survit même si le bot tombe
- [ ] **Détection de régime** (tendance / range / volatilité) → pondération dynamique des stratégies
- [ ] **Walk-forward optimization** des paramètres + garde anti-overfit (validation out-of-sample obligatoire)
- [ ] **Keystore chiffré** (argon2id + AES-GCM, déverrouillage au start) puis signers alternatifs (service distant, KMS)
- [ ] **Dashboard web** lecture seule (positions, PnL, journal) + API REST locale
- [ ] Multi-wallets / sous-comptes de stratégie (un wallet par stratégie = PnL propre et risque cloisonné)

**DoD** : le bot tourne avec les secrets chiffrés au repos ; au moins un filet on-chain (limite/DCA) actif en permanence ; le dashboard reflète l'état réel à ± 1 tick ; un wallet de stratégie peut être révoqué/remplacé sans arrêter le bot.

### Idées hors périmètre v1 (backlog ouvert)

- Perps Jupiter (levier) — reporté, risque systémique trop élevé pour ce cadre.
- Yield sur le cash inactif (Jupiter Lend Earn) pour rémunérer l'USDC dormant.
- Marchés de prédiction (Jupiter Prediction).
- Arbitrage circulaire : **non supporté par les APIs publiques** de Jupiter (réservé au binaire Metis) — hors périmètre.

---

## 14. Sécurité — checklist

- [ ] Wallet **dédié** au bot, jamais un wallet principal ; capital plafonné à ce que vous acceptez de perdre.
- [ ] `.env` : `chmod 600`, `.gitignore` dès le premier commit, backup de la clé dans un gestionnaire de mots de passe.
- [ ] Clé API Jupiter : une clé **par environnement** (prod/dev), permissions minimales (Swap + Price + Tokens), rotation si doute.
- [ ] Machine dédiée ou VPS durci (pas de desktop, pas de navigateur), utilisateur système non-root.
- [ ] Garde-fou `confirm_live: true` obligatoire pour le mode live (empêche un lancement live accidentel).
- [ ] Mode paper par défaut à l'installation.
- [ ] Procédure de fuite de clé écrite et testée : transfert des fonds → nouveau wallet → rotation API key → audit des logs.
- [ ] Sauvegardes SQLite chiffrées, hors de la machine si possible.
- [ ] Mises à jour de dépendances surveillées (`npm audit`), pas de dépendances exotiques.

---

## 15. Pièges connus & FAQ

**Jupiter fonctionne-t-il sur devnet ?**
Non. Toute la liquidité Jupiter est sur **mainnet-beta**. Le développement se fait donc en paper/dry-run,
puis éventuellement sur mainnet avec de très petits montants. Il n'existe pas de "Jupiter devnet".

**Quels sont les rate limits ?**
Accès *keyless* : 0.5 RPS. Avec clé API (https://developers.jup.ag/portal) : Free 1 RPS, Developer (25 $/mois)
10 RPS, Launch (100 $/mois) 50 RPS, Pro (500 $/mois) 150 RPS. L'endpoint `/execute` a un **bucket dédié**
plus généreux (Keyless 20 / Free 50 / Payant 100 RPS). Fenêtre glissante de 60 s, quotas **par organisation**.
Le bot intègre un token bucket par tier et lit les headers `x-ratelimit-*`.

**Que signifient les erreurs d'exécution ?**
- `/execute` : `-1` order expirée/introuvable (re-quote), `-2`/`-3` transaction invalide (bug — alerter),
  `-1000` échec de landing (re-tenter), `-1005` blockhash expiré — la signature est arrivée trop tard
  (re-quote immédiat), `-2003` quote RFQ expirée (re-quote), `-2004` swap rejeté par le market maker (re-quote via un autre routeur).
- `/order` avec `transaction: ""` : `errorCode 1` solde insuffisant, `2` pas assez de SOL pour le gaz, `3` sous le minimum gasless.

**Pourquoi le path Meta-Aggregator par défaut ?**
Tous les moteurs de routing se concurrencent (Metis on-chain, **JupiterZ** RFQ — souvent 5–20 bps meilleur sur les
paires majeures —, Dflow, OKX), le slippage RTSE est appliqué automatiquement, le landing (Jupiter Beam) et la
protection MEV sont gérés, et **aucun RPC n'est requis**. Le path Router n'est utile que pour modifier la
transaction (instructions custom, tips tx.jup.ag).

**Quels frais Jupiter dois-je modéliser ?**
0 bps sur les paires pegged (stable/stable, LST/LST) et les achats de tokens Jupiter ; 2 bps SOL↔stable ;
5 bps LST↔stable ; 10 bps pour tout le reste ; **50 bps sur les tokens de moins de 24 h** — d'où le filtre
`min_age_hours: 24` par défaut. S'ajoutent les frais de réseau et priority fees (variables), éventuellement
couverts par le mode gasless (un champ `gasless` + `signatureFeePayer` apparaît dans la réponse `/order`).

**Le bot peut-il se faire « sandwiched » ?**
Le path Meta-Aggregator bénéficie de la protection MEV de l'infrastructure Jupiter. En path Router, vos
transactions passent par votre infra : utilisez `tx.jup.ag` (tip ≥ 0.001 SOL) ou Jito, sinon vous êtes exposé.

**Pourquoi `@jup-ag/api` n'est-il pas utilisé ?**
Ce client cible l'ancienne API V1 (`lite-api.jup.ag/swap/v1`), en voie de retrait au profit de Swap V2.
Le bot embarque un client maison minimal, typé (zod) et testé — moins de surface, plus de contrôle.

**Et si le process crash en pleine position ?**
Rien n'est perdu : la vérité est **on-chain**. Au redémarrage, le bot lit les soldes réels via RPC,
réconcilie avec sa base et reprend. C'est un critère de la Phase 3.

**Puis-je trader les tokens très récents / memecoins ?**
Techniquement oui, mais le bot les exclut par défaut (frais 50 bps, liquidité évanescente, rugs, honeypots).
Réduire `min_age_hours` est un choix explicite, à vos risques.

---

## 16. Ressources

**Jupiter — documentation officielle**

- Vue d'ensemble & portail développeur : https://developers.jup.ag/docs
- Swap API V2 (Meta-Aggregator `/order` + `/execute`) : https://developers.jup.ag/docs/swap/order-and-execute
- Swap API V2 (Router `/build`) : https://developers.jup.ag/docs/swap/build/index
- Techniques avancées (slippage RTSE, gasless, CU, latence) : https://developers.jup.ag/docs/swap/advanced/index
- Price API v3 : https://developers.jup.ag/docs/price/index
- Tokens API v2 : https://developers.jup.ag/docs/tokens/index
- Ordres limite & DCA (Trigger) : https://developers.jup.ag/docs/trigger/index
- Landing de transactions (`tx.jup.ag`) : https://developers.jup.ag/docs/transaction/submit
- Rate limits & plans : https://developers.jup.ag/docs/portal/rate-limits
- Clés API : https://developers.jup.ag/portal

**Solana**

- @solana/web3.js : https://github.com/solana-labs/solana-web3.js
- @solana/kit : https://github.com/anza-xyz/kit
- Explorateur : https://solscan.io

---

## 17. Licence

MIT — voir `LICENSE` (à créer).

> ⚖️ **Rappel final** : ce projet est fourni à des fins éducatives et expérimentales, sans aucune garantie.
> Aucune performance n'est promise ou implicite. Vous êtes seul responsable de vos fonds et de la conformité
> de votre activité avec la réglementation applicable dans votre juridiction.
