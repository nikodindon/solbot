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
12. [Observabilité & production](#12-observabilité--production)
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

> 📄 **Pas développeur ?** Une [présentation dédiée](docs/presentation.md) (pitch 30 s, 13 slides,
> glossaire) explique le bot aux traders particuliers.

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
│         │          │  momentum · mean    │   │  (Swap V2)     │       │
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
> démarrage et (Phase 6, disponible) utiliser le path Router avec votre propre envoi de transactions.

---

## 4. Stack technique

| Couche | Choix | Justification |
|---|---|---|
| Runtime | **Node.js 22 LTS** + **TypeScript 5.x** (`strict`) | Écosystème Solana le plus mature, typage fort pour un bot de trading. |
| SDK Solana | **`@solana/web3.js` v1** (principal) · **`@solana/kit` v8+** (Phase 6, transactions v1) | web3.js reste le standard de facto ; kit est requis pour signer les transactions Solana v1 (SIMD-0385, 4096 bytes). |
| Jupiter | Client REST maison typé sur **Swap V2** (`api.jup.ag/swap/v2`), **Price v3**, **Tokens v2** — validé par **zod** | `@jup-ag/api` cible l'ancienne API V1 (lite-api) en voie de retrait ; un client maison fin et typé est plus sûr et plus simple. |
| CLI | `commander` | Commandes `init`, `doctor`, `balance`, `scan`, `price`, `watch`, `swap`, `start`, `backtest`, `report`, `status`. |
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
npm run solbot -- backtest import --days 30        # importe l'historique OHLCV (GeckoTerminal)
npm run solbot -- backtest --days 30 --label base  # rejoue le moteur réel (Phase 4)
npm run solbot -- report --days 30                 # métriques + comparaison au dernier backtest
npm run solbot -- swap SOL USDC 0.05 --dry-run   # swap simulé : vrai /order + simulation RPC, sans signature
npm run solbot -- start --paper   # démarre le moteur en mode paper (Phase 3)
```

Le mode **paper** est le défaut à l'installation :

```bash
npm run solbot -- start --paper   # simulation complète (mêmes règles, aucun ordre)
npm run solbot -- start --dry-run # obtient de vrais /order + simulation on-chain, sans signer
npm run solbot -- start --live    # ⚠ fonds réels — exige confirm_live: true en config
```

Le moteur accepte aussi un arrêt automatique et un tick unique (vérifications rapides) :

```bash
npm run solbot -- start --once                          # un seul tick puis sortie
npm run solbot -- start --paper --duration 3600         # s'arrête après 1 h
npm run solbot -- start --paper --duration 172800 --interval 30   # run paper de 48 h
```

Le swap manuel suit la même logique — `solbot swap` respecte le mode de `config.yaml`, et les
drapeaux `--dry-run` / `--live` le forcent (le live exige `confirm_live: true` + confirmation) :

```bash
npm run solbot -- swap SOL USDC 0.05 --dry-run        # citation réelle + simulation, aucun fonds engagé
npm run solbot -- swap USDC SOL max --dry-run         # vend tout le solde USDC (réserve de gaz conservée pour SOL)
npm run solbot -- swap BONK USDC 1000 --max-slippage-bps 50
npm run solbot -- swap SOL USDC 0.05 --dry-run --path router   # compare les deux chemins d'exécution (Phase 6)
npm run solbot -- swap SOL USDC 0.05 --live --path router --landing jito  # ⚠ atterrissage par bundle Jito (live uniquement)
npm run solbot -- paths --days 7                       # comparaison A/B des chemins (swaps live) — Phase 6b
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
    # atr_* + breakout_* + volume_* : paramètres du moteur (Phase 3)
    params: { ema_fast: 12, ema_slow: 26, rsi_period: 14, rsi_entry: 65, atr_period: 14, atr_stop_mult: 2.0, breakout_lookback: 20, volume_mult: 1.5, volume_lookback: 20 }
  mean_reversion:
    enabled: false
    weight: 1.0
    timeframe: 15m
    # zscore : achat en survente (z ≤ -z_entry), sortie au retour à la moyenne (z ≥ -z_exit)
    # grid : achats par paliers sous l'ancre (grid_step_pct × niveau, ≤ grid_levels), sortie à l'ancre
    params: { window: 96, z_entry: 2.0, z_exit: 0.5, mode: zscore, grid_step_pct: 1.0, grid_levels: 5 }
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

paper:                     # portefeuille virtuel (modes paper et dry-run)
  initial_usdc: 1000           # caisse virtuelle de départ (USD)
  fill_slippage_bps: 20        # slippage modélisé par fill (aller simple)
  impact_k: 0                  # impact ≈ impact_k × notionnel / liquidité (0 = ignoré en paper)
  priority_fee_sol: 0          # frais réseau + priority fee par swap (SOL) ; 0 = ignorés
  fee_bps_override: null       # force un barème de frais (bps) au lieu du barème Jupiter par paire

engine:                    # moteur autonome (`solbot start`)
  max_entries_per_tick: 1      # entrées max transmises au risque par tick (anti-rafale)

backtest:                  # backtest offline (`solbot backtest`)
  timeframe: 15m               # 1m | 5m | 15m | 1h
  initial_usdc: 1000           # caisse virtuelle du run (indépendante du paper)
  default_liquidity_usd: 250000 # liquidité de secours si la watchlist n'en fournit pas
  costs:                       # coûts réalistes (DoD : écart backtest ≈ paper expliqué)
    fill_slippage_bps: 10
    impact_k: 0.5
    priority_fee_sol: 0.00005
    fee_bps_override: null
  guard:                       # garde-fou live : pas de mode live sans backtest concluant
    min_days: 30               # couverture minimale (jours) pour un run concluant
    require_positive_net_pnl: false # true = exiger aussi un PnL net positif

execution:
  path: meta_aggregator        # meta_aggregator (/order+/execute) | router (/build) | auto (stats live)
  slippage: rtse               # rtse (recommandé) | adaptive (ATR) | <entier en bps>
  slippage_adaptive:           # utilisé si slippage: adaptive (Phase 6c)
    timeframe: 15m             # 1m | 5m | 15m | 1h
    period: 14                 # bougies moyennées par l'ATR
    multiplier: 1              # ATR (%) → borne (bps)
    min_bps: 10                # plancher de la borne
    max_bps: 100               # plafond (risk.max_slippage_bps reste le garde-fou absolu)
  slippage_bump_factor: 2      # élargit une borne après échec slippage (1 = désactivé)
  exclude_routers: []          # ex. [jupiterz] pour forcer des frais de gaz classiques
  retries: 3
  retry_backoff_ms: 750
  confirm_timeout_s: 60
  router:                      # chemins router/auto uniquement (Phase 6)
    compute_unit_price_percentile: high # medium | high | veryHigh | <bps 0-10000>
    max_accounts: 64           # plafond de comptes de la route (1-64)
    fast_mode: false           # true = latence réduite, routage légèrement moins optimal
    cu_limit_buffer: 1.2       # limite CU = buffer × CU simulés (1-2)
    cu_price_cap_microlamports: 0 # plafond du prix des CU (0 = pas de plafond)
    landing: rpc               # rpc (votre nœud) | tx_jup (tip ≥ 0,001 SOL) | jito (bundles)
    tip_lamports: 0            # tip minimal (tx_jup impose 1 000 000 ; jito : conseillé ≥ 1 000 000)
    for_jito_bundle: false     # imposé automatiquement par landing: jito
    jito_region: global        # global | amsterdam | frankfurt | london | ny | slc | singapore | tokyo (latence)
    transaction_version: 0     # 0 = v0 (stable) | 1 = v1 SIMD-0385 (expérimental, Phase 6c)
  auto:                        # bascule automatique (path: auto) — Phase 6b
    window_days: 7             # fenêtre glissante des statistiques live
    min_samples: 20            # swaps live minimum par chemin avant de comparer
    rate_margin: 0.02          # écart de taux de landing exigé pour basculer (2 points)

notifications:
  telegram:
    enabled: false               # true + TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID dans .env
    notify_on: [trade, error, daily_report] # ajoutez alert, backup si souhaité
    commands_enabled: true       # commandes entrantes : /status /positions /pnl /pause /resume /kill
    daily_report_utc_hour: 8     # heure UTC du rapport PnL quotidien (moteur en marche)

monitoring:                  # serveur HTTP local : /healthz (Docker/systemd) + /metrics (Prometheus)
  enabled: false
  host: 127.0.0.1
  port: 9464

alerts:                      # alerting (publié via notifications.telegram)
  enabled: true
  cooldown_min: 30             # anti-spam : délai minimal entre deux alertes d'une même règle
  tick_error_threshold: 2      # erreurs de tick consécutives → alerte (« RPC en échec »)
  execute_failure_window_min: 60 # fenêtre d'observation des échecs d'exécution (minutes)
  execute_failure_min_trades: 5 # minimum de trades dans la fenêtre avant de calculer le taux
  execute_failure_rate_pct: 30 # taux d'échec (%) au-delà duquel on alerte

backups:                     # sauvegardes SQLite quotidiennes (`solbot backup` pour un backup manuel)
  enabled: true
  dir: ./data/backups
  keep: 7                      # nombre de sauvegardes conservées (rotation)
  daily_utc_hour: 3            # heure UTC du backup automatique pendant que le moteur tourne

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
  allowAdd?: boolean;      // autorise un ajout à une position existante (grille, DCA)
  suggestedSizeUsd?: number; // plafond de taille suggéré — le RiskManager reste maître
  sellPortion?: number;    // 0..1 — sortie partielle (défaut : toute la position)
}
```

Le **Signal Engine** collecte les signaux de toutes les stratégies activées, les pondère (`weight`),
arbitre par **score composite** (`confiance × poids × facteur d'edge`, edge clampé à 200 bps → facteur
∈ [1, 1.5]) et ne transmet au RiskManager qu'un nombre limité d'actions par tick
(`engine.max_entries_per_tick`, défaut 1 — anti-rafale, anti-churn). Un conflit achat/vente sur le
même actif est résolu en faveur de la **sortie** (`exit_priority`). Chaque décision d'arbitrage
(gagnant, écartés, motif) est journalisée en base (`arbitrations`) ; les signaux actionnables le sont
dans `signals` (avec `acted`) et les rejets dans `risk_rejections`.

| Stratégie | Principe | Signaux produits | Statut |
|---|---|---|---|
| **momentum** | EMA rapide/lente + filtre RSI + cassure des plus hauts + confirmation volume ; stop initial basé ATR | Entrée long sur breakout confirmé ; sortie sur tendance EMA inverse | ✅ Phase 3 (implémentée) |
| **mean_reversion** | Z-score du prix vs moyenne glissante (mode `zscore`) ou grille de paliers sous une ancre (mode `grid`) ; sortie au retour à la moyenne/l'ancre | Entrée quand déviation > seuil (`allowAdd` en grille sous le prix moyen) ; sortie au retour | ✅ Phase 4 (implémentée) |
| **dca_rotation** | Allocation cible (ex. 40 % SOL / 60 % USDC), rééquilibrage par dérive (une action par évaluation) | Achat de la cible sous-allouée (plafonné par `topup_usdc`) ; allègement de la cible sur-allouée (`sellPortion`) | ✅ Phase 4 (implémentée) |
| **copy_trade** | Surveillance de wallets performants (logs RPC / webhooks), réplication contrainte par le risque | Réplication proportionnelle du swap détecté | Phase 7 |

> 🧪 Toute nouvelle stratégie se développe et se valide d'abord en **backtest** puis en **paper mode**
> avant d'être autorisée en live (garde-fou : `enabled: false` par défaut).

### 8.1 Le moteur autonome — `solbot start` (Phase 3)

Un **tick** (toutes les `loop_interval_s`) enchaîne : relevé de marché (prix + volumes) → valorisation
du portefeuille (NAV, PnL latent) → **sorties** (stop-loss, take-profit, trailing, signal de sortie —
priorité absolue) → **entrées** (signaux actionnables, arbitrage, RiskManager, exécution). Un seul
trade est en vol à la fois (verrou structurel) et la boucle attrape ses erreurs : 5 ticks en échec
consécutifs arrêtent le moteur proprement.

| Mode | Marché | Ordres | Portefeuille | Usage |
|---|---|---|---|---|
| `paper` | prix réels (API) | aucun | **virtuel** (`paper.initial_usdc`) | simulation complète, coûts modélisés (frais + slippage) |
| `dry_run` | prix réels | **vrais `/order`** + simulation RPC | virtuel | vérifie l'exécutabilité réelle de chaque ordre, sans fonds |
| `live` | prix réels | réels, signés | on-chain (RPC) | ⚠ fonds réels (`confirm_live: true` + « oui »/`--yes`) |

Points de conception à connaître :

- **Warm-up** — le momentum a besoin de ~27 bougies 15 m clôturées (≈ 6 h 45 de collecte `watch` ou de
  moteur). En dessous, aucun signal ; `start` affiche le compteur `prêts x/y` par tick.
- **Volume proxy** — l'OHLCV interne n'a pas le volume historique Jupiter : le volume par bougie est
  estimé par le **delta des stats 24 h** (achats + ventes, Tokens v2) entre deux ticks. Le premier tick
  d'un mint ne contribue pas (delta inconnu). Approximation documentée, suffisante pour le filtre de
  confirmation (× 1,5 de la médiane).
- **Kill-switch** — fichier `STOP` à la racine (`$SOLBOT_HOME`) : entrées coupées immédiatement, sorties
  toujours exécutées. Créé automatiquement si le drawdown max est franchi ; supprimez-le pour reprendre.
- **Perte journalière** — l'ancre NAV est posée à la première évaluation de chaque journée UTC ;
  dépassement de `daily_loss_limit_pct` → entrées en pause jusqu'à minuit UTC (sorties actives).
- **Reprise après crash (live)** — au démarrage, les soldes on-chain (RPC) font foi : chaque position
  locale est adoptée, ajustée (FIFO) ou clôturée, et chaque décision est journalisée dans `events`.
- **Actifs négociables** — à l'achat, seuls SOL et les actifs de la watchlist (∪ positions ouvertes)
  sont négociables ; la devise de base est exclue des entrées.
- **Ajouts & sorties partielles (Phase 4)** — une stratégie peut demander un **ajout** à une position
  existante (`allowAdd: true`, ex. grille/DCA) ou une **sortie partielle** (`sellPortion: 0..1`) ; le
  portefeuille FIFO gère les lots, les ajouts sont miroir en base.
- **Journal** — `trades` (stratégie, déclencheur, mode), `signals`, `arbitrations`, `risk_rejections`
  (règle + métriques), `events`, `equity_curve` (un point par tick) : tout est en SQLite, dans
  `data/solbot.sqlite`.

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

### Path avancé : Router (`/build`) — implémenté (Phase 6a)

Pour un contrôle total (aucun frais Jupiter, landing par nos soins), `execution.path: router` (ou `solbot swap --path router …`) utilise :

```
GET /swap/v2/build → computeBudgetInstructions + setupInstructions + swapInstruction + cleanupInstruction + tipInstruction + ALTs
→ assemblage v0 par le bot → simulation (CU) → signature → landing RPC → confirmation on-chain
```

- **Choix** : `taker` = notre wallet, `slippageBps=rtse` par défaut, `computeUnitPricePercentile`, `maxAccounts`, `mode=fast` optionnel — routage **Metis on-chain uniquement** (pas de RFQ) et **sans frais Jupiter**.
- **Assemblage** : le bot reconstitue la transaction v0 (limite CU, budget, setup, swap, cleanup, tip, tables d'adresses) à partir des instructions brutes ; le blockhash fourni par le build est conservé.
- **Simulation** : sonde à 1,4 M de CU pour mesurer la consommation réelle, puis limite finale = `cu_limit_buffer` × CU mesurés (1,2 par défaut, plafonnée à 1,4 M) ; le prix des CU peut être plafonné (`cu_price_cap_microlamports`). La simulation tourne dans tous les modes, y compris en live (elle dimensionne la transaction).
- **Landing** (live) — trois cibles au choix (`execution.router.landing`, ou `solbot swap --landing …`) :
  - `rpc` (défaut) : envoi via le RPC configuré (`sendRawTransaction` + confirmation par blockhash) ;
  - `tx_jup` : envoi via l'infra d'atterrissage Jupiter (`tx.jup.ag`, JSON-RPC `sendTransaction`, en-tête `x-api-key`) — **tip ≥ 0,001 SOL** ajouté automatiquement par `/build` ; endpoint en **envoi seul**, la confirmation reste sur notre RPC ;
  - `jito` : envoi en **bundle Jito** (`sendBundle`) avec un tip vers un compte Jito, ajouté par le bot (comptes récupérés dynamiquement via `getTipAccounts`, jamais en dur) ; le sort du bundle est observé (`getInflightBundleStatuses`) — un bundle « Failed » (jamais forwardé) autorise un réessai sûr, toute incertitude bascule sur la confirmation RPC sans réessai.
- **Reçu réel** : déduit des balances de la transaction confirmée (delta du mint de sortie ; best-effort pour SOL natif, la réconciliation corrige les écarts au démarrage). Les échecs de type « confirmation incertaine » ne sont jamais réessayés en aveugle — vérification de la signature requise.
- **Télémétrie** : `path`, CU, prix CU, tip, cible de landing et latence en ms sont journalisés dans `trades` (migration v5).
- **Comparaison A/B + bascule automatique** (Phase 6b) : `solbot paths` compare les deux chemins sur les swaps **live** (taux de landing, slippage moyen, latence moyenne, coût moyen) ; `execution.path: auto` bascule vers le Router **seulement** quand il a assez d'échantillons (min. 20 par défaut) et fait mieux que le Meta-Aggregator au-delà de la marge — sinon le défaut prudent reste le Meta-Aggregator.
- **Slippage adaptatif** (Phase 6c) — `execution.slippage: adaptive` : la borne (bps) est calculée depuis la volatilité récente de l'actif d'entrée (`ATR` des bougies stockées : `atrPct × 10 000 × multiplier`, bornée par `min_bps`/`max_bps`), avec repli automatique sur RTSE si l'historique est insuffisant. Après un **échec classé « slippage »** (simulation, erreur program 6001/0x1771, `/execute`, rejet on-chain), la borne numérique est élargie (`slippage_bump_factor`, × 2 par défaut) avant la re-cotation — jamais au-delà de `risk.max_slippage_bps`, et jamais pour une borne fournie explicitement en CLI (`--max-slippage-bps`).
- **Latence** (Phase 6c) : `execution.router.jito_region` envoie les bundles au **Block Engine régional** le plus proche (frankfurt/amsterdam/london en Europe) et la cible d'atterrissage **préchauffe** ses dépendances (comptes de tip Jito, une seule requête partagée avec `prepare`) en parallèle du premier `/build`. Le cache de blockhash est sans objet ici : chaque `/build` fournit un blockhash frais, volontairement conservé.
- **Transactions Solana v1** (Phase 6c, **expérimental**) — `execution.router.transaction_version: 1` demande à `/build` des transactions **v1** (SIMD-0385, 4 096 octets, jusqu'à 64 comptes **sans tables d'adresses**, budget de calcul porté par la config du message) assemblées et signées via `@solana/kit` v8 (web3.js lit la v1 mais ne sait pas la signer). Le tip Jito et les instructions supplémentaires sont convertis et ajoutés en fin de transaction ; la confirmation lit les reçus v0 comme v1 (`maxSupportedTransactionVersion: 1`). Le chemin `/order` (Meta-Aggregator) reste en v0. Rien n'est activé par défaut ; l'option sera promue après validation en live.

La Phase 6 est **complète** (6a/6b/6c) : le chemin Meta-Aggregator reste le défaut et la mesure A/B réelle
(≥ 200 swaps) reste conditionnée au financement du wallet (§13, DoD).

---

## 11. Backtesting & paper trading

Trois niveaux de validation avant le live :

| Mode | Description | Phase |
|---|---|---|
| **Backtest** | Rejoue le **moteur réel** (stratégies, RiskManager, portefeuille FIFO) sur l'historique OHLCV importé + collecté, un tick par clôture de bougie. | 4 |
| **Paper** | Le bot tourne en temps réel, réels appels API, **aucun ordre** : les "fills" sont simulés au prix courant + coûts modélisés (`paper.*`), caisse virtuelle (`paper.initial_usdc`). | 3–4 |
| **Dry-run** | Obtient de vrais `/order` et simule la transaction on-chain (`simulateTransaction`), détecte les échecs réalistes (slippage, comptes manquants), **sans signer ni envoyer**. | 2 |

### 11.1 Données : accumulation interne + import GeckoTerminal

L'API Jupiter ne fournit que le prix spot. L'historique vient de deux sources :

- l'**accumulation interne** (`solbot watch` / moteur) : bougies OHLCV maison (1m/5m/15m/1h) ;
- l'**import externe** — `solbot backtest import --days N` interroge **GeckoTerminal** (API publique sans
  clé) : pool principal (plus grande réserve USD) de chaque mint, OHLCV en USD, écrit dans
  `imported_candles` avec sa source.

À la lecture, les deux sources sont **fusionnées** : OHLC importé prioritaire sur la bougie live
correspondante, volume live conservé quand l'import n'en a pas. Les tables restent séparées.

### 11.2 Rejeu — `solbot backtest`

```bash
npm run solbot -- backtest import --days 30              # importe ~30 j d'OHLCV 15m
npm run solbot -- backtest --days 30 --label momentum-base
npm run solbot -- backtest --days 30 --label momentum-relaxe --config config/momentum-relaxe.yaml
```

Le rejeu utilise le **même moteur** que le live sur une base `:memory:` (seams injectés : bougies,
horloge, coûts), un tick par clôture de bougie :

- prix au tick = clôture de la dernière bougie **clôturée** ;
- coûts du run = `backtest.costs` (slippage de fill, impact `k × notionnel / liquidité`, priority fee
  convertie en USD via le prix SOL) — plus réalistes que les défauts du paper ;
- `days` dérivé de `--from/--to` si `--days` est absent ; le run (métriques, rejets, courbe d'equity)
  est stocké dans `backtest_runs` + `backtest_equity`, sauf `--no-store`.

### 11.3 Métriques & rapport — `solbot report`

`solbot report [--days N] [--mode paper|backtest|dry_run|live] [--telegram]` calcule depuis la base :
**PnL net** (après frais), win rate, profit factor, **max drawdown**, **Sharpe simplifié** (clôtures
quotidiennes), turnover, frais — et compare au dernier backtest enregistré du même jeu de stratégies
(contexte du garde-fou). Les métriques non calculables valent `null` (jamais de valeur trompeuse).

### 11.4 Chemins d'exécution A/B — `solbot paths`

`solbot paths [--days N]` compare les deux chemins d'exécution sur les swaps **live** (frais + tips) :
taux de landing, slippage moyen, latence moyenne d'atterrissage et coût moyen par swap réussi —
et affiche la recommandation de la bascule automatique (`execution.path: auto`, voir §10).

```console
$ solbot paths --days 7
  solbot paths — chemins d'exécution (7 derniers jours, swaps live)
  ─────────────────────────────────────────────────────────────────
  Chemin            Swaps  Taux landing  Slippage moy.  Latence moy.  Coût moy.
  meta_aggregator      25        100.0 %          25 bps             —        n/d
  router               25         96.0 %          31 bps         1 240 ms  0.001320 SOL

  ✔ recommandation (auto) : meta_aggregator — meta-aggregator au moins aussi fiable (taux de landing et coût)
  ⚠ chemin configuré : meta_aggregator — passez « execution.path: auto » pour la bascule automatique.
```

Notes : seuls les swaps live comptent (un dry-run mesure la qualité des devis, pas de l'atterrissage) ;
le coût du chemin Meta-Aggregator n'est pas journalisé (frais inclus par Jupiter dans `/execute`) et
s'affiche `n/d` ; le coût du chemin Router = frais de base (5 000 lamports) + CU × prix des CU + tip.

### 11.5 Garde-fou live (codé, Phase 4)

**Aucune stratégie ne peut être activée en live sans backtest concluant.** `start --live` exige un run
`conclusive` pour l'**empreinte** du jeu de stratégies (`paramsHash` = sha256 de la devise de base +
descripteur des stratégies, poids et paramètres inclus) avec `days ≥ backtest.guard.min_days`
(défaut 30) et, si `require_positive_net_pnl: true`, un PnL net positif. Modifier un paramètre change
l'empreinte : le backtest doit être rejoué.

⚠️ Honnêteté méthodologique : la profondeur d'historique dépend de l'âge des pools (l'import s'arrête
où la source s'arrête) et la liquidité est supposée **statique** en backtest (colonne `liquidity_usd`
de la watchlist, sinon `backtest.default_liquidity_usd`). Un backtest sur trop peu de données est
signalé **non concluant** (`conclusive = false`).

---

## 12. Observabilité & production

### 12.1 État local (source de vérité)

- **SQLite** (`data/solbot.sqlite`) — source de vérité locale :
  `watchlist`, `price_ticks`, `candles`, `imported_candles`, `positions`, `position_lots`, `trades`,
  `signals`, `arbitrations`, `risk_rejections`, `events`, `equity_curve`, `bot_state`, `backtest_runs`,
  `backtest_equity`.
- **Réconciliation au démarrage** : l'état des positions est reconstruit depuis la **chaîne** (soldes réels via RPC) puis confronté à la base ; toute divergence est journalisée et notifiée — jamais de "position fantôme".
- **Logs pino JSON** : un flux par décision (`signal`, `arbitrage`, `risk`, `order`, `execute`, `error`).

### 12.2 Supervision : `/healthz` + `/metrics`

`monitoring.enabled: true` démarre un serveur HTTP **local** (sans authentification, `127.0.0.1` par défaut) :

| Endpoint | Contenu |
|---|---|
| `GET /healthz` | JSON : `status` (`ok` / `stale` / `degraded`), mode, version, uptime, ticks, âge du dernier tick, NAV, pauses, kill-switch, dernier backup, état de la base. **HTTP 503** si le dernier tick dépasse `3 × intervalle` (moteur bloqué) ou si la base est indisponible |
| `GET /metrics` | format Prometheus (text 0.0.4) : ticks, erreurs, NAV, caisse, positions, drawdown, perte jour, actifs prêts, entrées/sorties, alertes, notifications, backups, uptime, horodatage du dernier tick |

Le healthcheck Docker s'appuie sur `/healthz` (503 → conteneur `unhealthy`) ; branchez Prometheus/Grafana sur `/metrics`.

### 12.3 Telegram : notifications & commandes

`notifications.telegram.enabled: true` + `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` dans `.env` :

- **Notifications sortantes** (`notify_on`) : `trade` (chaque achat/vente), `error` (erreur de tick),
  `daily_report` (rapport PnL quotidien à `daily_report_utc_hour` UTC), `alert` (§12.4), `backup` (backup quotidien).
- **Commandes entrantes** (long polling, `commands_enabled`) — **seul le chat configuré est accepté** :

| Commande | Effet |
|---|---|
| `/status` | dernier tick, NAV, positions, stratégies, pauses, kill-switch |
| `/positions` | positions ouvertes : quantité, entrée, coût, stop, TP, pic observé, âge |
| `/pnl [jours]` | PnL réalisé + frais sur la fenêtre (défaut 1 j), NAV du dernier tick |
| `/pause` | suspend les **entrées** (les sorties SL/TP/trailing restent actives) — persisté en base |
| `/resume` | réactive les entrées |
| `/kill` | active le kill-switch (fichier `STOP`) : entrées coupées, sorties actives |
| `/help` | aide |

Les commandes lisent SQLite → elles fonctionnent même juste après un redémarrage. Une panne Telegram ne
bloque jamais le moteur (best effort).

### 12.4 Alerting

Règles évaluées à chaque tick, anti-spam par règle (`alerts.cooldown_min`, horodatage persisté en base) :

| Règle | Déclencheur |
|---|---|
| réserve de gaz SOL | live : solde SOL < `risk.sol_gas_reserve` (les entrées seront refusées par le risque) |
| RPC / marché en échec | `tick_error_threshold` erreurs de tick consécutives (arrêt automatique à 5) |
| taux d'échec d'exécution | ≥ `execute_failure_rate_pct` % d'échecs sur les trades de la fenêtre (`execute_failure_window_min`, minimum `execute_failure_min_trades`) |
| divergence de réconciliation | au démarrage live : positions adoptées / ajustées / clôturées depuis la chaîne |

### 12.5 Backups SQLite

- **Automatique** : chaque jour après `backups.daily_utc_hour` (UTC), `VACUUM INTO` (cohérent, moteur en cours d'exécution) + rotation `backups.keep`.
- **Manuel** : `solbot backup` · `solbot backup --list` · `solbot backup --keep 14`.
- **Restauration** (moteur arrêté) : `solbot backup --restore <fichier> --yes` — intégrité vérifiée (`PRAGMA integrity_check`)
  avant écrasement, journaux WAL/SHM périmés supprimés, puis `solbot doctor`.

### 12.6 Déploiement 24/7

- **Docker** : `docker compose up -d --build` — `Dockerfile` multi-étapes (deps prod seulement), volume `data/`,
  `restart: unless-stopped`, healthcheck natif, logs bornés (5 × 10 Mo).
- **systemd** (alternative) : `deploy/solbot.service` (redémarrage auto, logs journald) + `deploy/logrotate.solbot`
  si vous redirigez les logs vers des fichiers.
- **Reprise** : un redémarrage (crash, mise à jour, reboot) rejoue la réconciliation depuis la chaîne puis reprend
  l'état SQLite — aucune intervention manuelle.

---

## 13. Roadmap avancée

### Vue d'ensemble

| Phase | Version | Focus | Risque de perte de fonds |
|---|---|---|---|
| 0 | v0.1.0 | Fondations : config, wallet, CLI, doctor — ✅ **réalisée** | nul (aucun trade) |
| 1 | v0.2.0 | Données de marché : Price v3, Tokens v2, SQLite, scan — ✅ **réalisée** | nul |
| 2 | v0.3.0 | Premier swap : `/order` + `/execute`, dry-run, erreurs — ✅ **réalisée** | faible (manuel, montants choisis) |
| 3 | v0.4.0 | Moteur autonome mono-stratégie + risque complet — ✅ **réalisée** | réel encadré |
| 4 | v0.5.0 | Multi-stratégies + backtesting + paper complet — ✅ **réalisée** | réel encadré |
| 5 | v0.6.0 | Production 24/7 : Docker, Telegram, métriques, backups — ✅ **réalisée** | réel encadré |
| 6 | v0.7.0 | Exécution avancée : `/build`, tx.jup.ag, Jito, v1 txs — ✅ **réalisée** | réel avancé |
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

### Phase 3 — Moteur autonome mono-stratégie (v0.4.0) — ✅ **réalisée**

- [x] Interface `Strategy` + registre + chargement depuis la config (stratégie activée sans implémentation → erreur explicite)
- [x] Stratégie **momentum** : breakout (`breakout_lookback` plus hauts) + EMA 12/26 + RSI < `rsi_entry` + confirmation volume (≥ `volume_mult` × médiane) ; sortie sur tendance EMA inverse ; stop initial ATR (`atr_stop_mult`)
- [x] `Portfolio` : positions, lots FIFO (`position_lots`), cost basis, mark-to-market, PnL réalisé/latent, NAV
- [x] `RiskManager` complet (section 9) + table `risk_rejections` (règle, message, métriques) — kill-switch, pause perte journalière (ancre UTC), plafonds, sizing (impact liquidité), cooldowns, réserve de gaz, notionnel minimum
- [x] Boucle principale (`solbot start`, tick `loop_interval_s`) + verrou monoconcurrence (1 trade en vol) + arrêt propre SIGINT/SIGTERM (tick en cours terminé)
- [x] **Reprise après crash** : réconciliation on-chain au boot en live (soldes RPC vs base) — adoption, ajustement FIFO, clôture, chaque décision dans `events`
- [x] SL / TP / trailing stop automatiques à chaque tick (priorité absolue sur les entrées)
- [x] **Kill-switch** : fichier `STOP` (entrées coupées, sorties actives) + création automatique sur drawdown max ; `engine_start`/`engine_stop`/`daily_loss_pause`/`drawdown_kill_switch` dans `events`
- [x] Modes : **paper** (portefeuille virtuel), **dry-run** (vrais `/order` + simulation RPC, portefeuille virtuel), **live** (fonds réels, confirmation unique au démarrage)
- [x] Volume proxy : delta des stats 24 h (Tokens v2) attribué aux bougies (`candles.volume_usd`)

**DoD** (état au 15/10/2026) : ✅ kill-switch manuel (`STOP`) coupe les entrées au tick suivant — couvert par
tests (sorties toujours exécutées) ; ✅ réconciliation testée (adoption/ajustement/clôture) et branchée au boot
live ; ✅ tous les rejets de risque sont en base avec leur règle ; ✅ arrêt propre vérifié (SIGINT/SIGTERM) ;
✅ **191 tests** (moteur paper/dry-run/live simulé, risque règle par règle, FIFO, trailing, réconciliation).
⏳ **Reste à observer** : 48 h de paper mode en continu (`start --paper --duration 172800`) — à lancer
hors session (tmux/nohup), aucun signe de fuite ni position orpheline attendu.

> 📌 Tant que le wallet n'est pas financé, `dry-run`/`live` restent inutilisables (chaque `/order` échoue
> avec `errorCode 1`) : c'est le comportement attendu. Le mode `paper` fonctionne sans aucun fonds.

### Phase 4 — Multi-stratégies & backtesting (v0.5.0) — ✅ **réalisée**

- [x] Stratégie **mean-reversion** : mode `zscore` (fenêtre + seuils paramétrables) et mode **grille** (paliers sous l'ancre, ajouts sous le prix moyen, sortie à l'ancre)
- [x] Stratégie **DCA/rotation** : allocation cible (clés `SOL`/`USDC`/mint), dérive déclencheuse, `topup_usdc` ; une seule action par évaluation, allègement partiel au-delà de la cible
- [x] **Arbitrage inter-stratégies** : score composite `confiance × poids × facteur d'edge`, conflit achat/vente résolu en faveur de la **sortie**, décision journalisée (`arbitrations`)
- [x] **Ajouts & sorties partielles** : `allowAdd`, `suggestedSizeUsd`, `sellPortion` — le RiskManager reste maître de la taille ; SOL achetable (cible DCA)
- [x] **Backtester** offline : rejeu du **moteur réel** sur base `:memory:` (seams bougies/horloge/coûts), un tick par clôture de bougie ; coûts `backtest.costs` (slippage, impact `k × notionnel / liquidité`, priority fee en SOL)
- [x] **Import d'historique** : `backtest import` via GeckoTerminal (pool par réserve, OHLCV USD, retry 429) — table `imported_candles` distincte, fusion OHLC importé prioritaire
- [x] **Paper mode de première classe** : mêmes règles que le live, courbe d'equity par tick (`equity_curve`), mode tracé sur positions/trades
- [x] Rapport de métriques (PnL net, win rate, profit factor, Sharpe, max DD, turnover, frais) — CLI `solbot report` + envoi `--telegram`
- [x] **Garde-fou live** : `start --live` exige un backtest `conclusive` pour l'empreinte du jeu de stratégies (`days ≥ backtest.guard.min_days`, PnL net positif en option)

**DoD** (état au 15/10/2026) : ✅ **≥ 2 jeux de paramètres par stratégie sur ≥ 30 j**, rejoués avec le **moteur réel**
(caisse 1 000 $, 15 m, import GeckoTerminal de 30 j, 12 mints liquides + USDC pour la cotation, coûts `backtest.costs`
par défaut : slippage de fill 10 bps, impact `0.5 × notionnel / liquidité`, priority fee 0.00005 SOL). Fenêtre
15/09 → 15/10/2026, ~32 000 bougies et 2 880 ticks par run ; les 6 runs sont **enregistrés** (`backtest_runs`, label +
`paramsHash`, `days = 30.0` ≥ `backtest.guard.min_days`) :

| # | Étiquette | Stratégie & paramètres | Net | Win rate | PF | DD max | Sharpe | Frais | Entrées |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `momentum-base` | momentum (RSI 65, volume ×1.5) | **+2.55 %** | 31.1 % | 1.19 | 3.86 % | 2.46 | 20.63 $ | 185 |
| 2 | `momentum-relax` | momentum (RSI 70, volume ×1.2) | −0.62 % | 30.9 % | 0.94 | 6.25 % | −0.42 | 27.71 $ | 255 |
| 3 | `meanrev-z2` | MR `zscore` (z 2.0 / 0.5) | −2.57 % | 56.6 % | 0.80 | 5.73 % | −2.33 | 20.25 $ | 196 |
| 4 | `meanrev-z15` | MR `zscore` (z 1.5 / 0.5) | −3.88 % | 56.3 % | 0.78 | 5.74 % | −3.31 | 32.18 $ | 311 |
| 5 | `dca-ab` | DCA (40 % SOL / 60 % caisse, dérive 5 %, topup 25 $) | +0.12 % | 60.0 % | 1.06 | 1.21 % | 1.01 | 0.27 $ | 23 |
| 6 | `dca-b` | DCA (50/50, dérive 10 %, topup 50 $) | +0.18 % | 60.0 % | 1.11 | 1.18 % | 1.14 | 0.24 $ | 17 |

Lecture honnête — **une seule fenêtre de marché, non prédictive** : le momentum de base gagne (+2.55 %, PF 1.19) mais le
jeu « relaxé » perd (255 entrées vs 185, frais 27.71 $ vs 20.63 $, PF 0.94) ; la mean-reversion gagne la majorité de ses
trades (56 %) mais son PF < 1 : quelques pertes dépassent les gains et les allers-retours sont mangés par les coûts ; le
DCA/rotation reste quasi à plat (rotation faible, dérive rarement au-delà du seuil).

⏳ **Comparaison paper Phase 3** : le run paper 48 h (code v0.4.0 — pas de courbe `equity_curve`, comparaison via le
journal et la table `trades`) se termine le **17/10/2026 vers 15:44 UTC** ; la comparaison `momentum-base` vs paper sera
consignée ici. Écart attendu et déjà documenté : coûts modélisés du backtest (frais Jupiter par paire, priority fee,
impact liquidité) et fills paper **au tick** vs clôture de bougie en backtest.

✅ **Garde-fou live vérifié en réel** (`start --live --once --yes`, home isolé) : paramètres sans backtest →
`live bloqué` (code 1) avec la marche à suivre ; run de référence perdant + `require_positive_net_pnl: true` → bloqué ;
`momentum-base` + `confirm_live: true` → ✅ `run #1 · 30.0 j · +25.49 $ · empreinte 2a4b91ca`, puis 1 tick live sur
wallet vide (0 ordre — le drawdown kill-switch se déclenche avec un NAV à 0, comportement attendu).

🧪 **242 tests** (stratégies + arbitrage inter-stratégies, backtester bout-en-bout, import GeckoTerminal avec retry 429,
garde-fou, rapport de métriques, routage CLI `backtest`/`import`).

### Phase 5 — Production 24/7 (v0.6.0) — ✅ **réalisée**

- [x] **Dockerfile** + `docker-compose` (volume `data/`, `restart: unless-stopped`) et unité systemd alternative (`deploy/`)
- [x] Healthcheck HTTP local (`/healthz` → 503 si tick périmé) + métriques Prometheus (`/metrics`) — registre maison (aucune dépendance ajoutée)
- [x] **Telegram** : notifications (trade, erreur, rapport PnL quotidien, alertes, backups) + commandes `/status`, `/positions`, `/pnl`, `/pause`, `/resume`, `/kill` (long polling, chat unique autorisé)
- [x] Alerting : solde SOL sous réserve, RPC en échec, taux d'échec d'exécution anormal, divergence de réconciliation — cooldown persisté par règle
- [x] Sauvegardes SQLite quotidiennes (`VACUUM INTO` + rotation) + `solbot backup` (création, liste, restauration vérifiée par `PRAGMA integrity_check`)
- [x] Rotation des logs (journald/Docker bornés + `deploy/logrotate.solbot`), retry RPC avec provider de secours (hérité Phase 0)
- [x] Pause manuelle des entrées (`/pause`) intégrée au moteur : les sorties SL/TP/trailing restent actives

🧪 **291 tests** (dont 49 Phase 5 : registre de métriques, serveur `/healthz`+`/metrics`, notifier Telegram,
poller de commandes avec autorisation par chat, contrôleur `/status`→`/kill`, moteur d'alertes avec cooldown,
backups + restauration bout-en-bout, superviseur, pause manuelle du moteur).

**DoD** : 7 jours d'uptime sans intervention manuelle ; toute exécution ou erreur notifiée en < 10 s ;
restauration d'un backup SQLite validée sur un environnement neuf ; kill-switch testé à distance via Telegram.

⏳ **Reste à observer** : la restauration de backup est **validée automatiquement** (test bout-en-bout sur base
neuve) et la boucle kill-switch → fichier `STOP` est testée de bout en bout (contrôleur → moteur), mais la
validation « grandeur nature » — 7 jours d'uptime et kill-switch depuis un vrai Telegram — sera mesurée une
fois le bot déployé (Docker/systemd) avec un bot Telegram réel.

🧪 **Vérifié de bout en bout (démo du 15/10/2026, home temporaire)** : `/healthz` → HTTP 200 et `/metrics`
Prometheus pendant un run réel ; backup automatique déclenché au premier tick après l'heure configurée
puis rotation `keep` ; `/pause` → tick marqué « ⏸ pause manuelle » ; `/kill` → tick marqué « ⛔ entrées
coupées » (mêmes primitives que les commandes Telegram) ; restauration d'un backup sur un **environnement
neuf** → 108 911 bougies importées et 6 runs de backtest retrouvés.

### Phase 6 — Exécution avancée (v0.7.0)

- [x] **Path Router (`/build`)** en option : assemblage d'instructions v0, simulation CU (limite = 1,2 × simulation, plafonnée à 1,4 M), `computeUnitPricePercentile`, `maxAccounts`, `mode=fast`, plafond du prix des CU, tip — télémétrie journalisée dans `trades` (migration v5), landing RPC propre avec confirmation et reçu déduit des balances, `solbot swap --path router`
- [x] Landing alternatif **tx.jup.ag** (send-only, JSON-RPC `sendTransaction`, `x-api-key`, tip ≥ 0,001 SOL) et **Jito** (bundles, comptes de tip récupérés dynamiquement, observation du sort du bundle) — `execution.router.landing` ou `solbot swap --landing rpc|tx_jup|jito` *(6b)*
- [x] **Stats A/B + bascule automatique** : `solbot paths` (taux de landing, slippage, latence, coût moyen par chemin, swaps live) et `execution.path: auto` (prudent : min. 20 échantillons/chemin, marge de 2 points, défaut Meta-Aggregator) *(6b)*
- [ ] Landing alternatif **tx.jup.ag** : mesure réelle du taux de landing vs `/execute` *(reste à mesurer — financement requis)*
- [x] **Slippage adaptatif** : RTSE vs borne fixe selon la volatilité (ATR des bougies, bornes `min_bps`/`max_bps`, repli RTSE) ; re-quote intelligent sur échec de type slippage (borne élargie × `slippage_bump_factor`, plafonnée par `risk.max_slippage_bps`, sans jamais toucher une surcharge explicite) *(6c)*
- [x] Support **transactions Solana v1** (SIMD-0385, 4 096 octets, `@solana/kit` v8, budget sur la config du message, sans ALTs) — opt-in `execution.router.transaction_version: 1`, expérimental jusqu'à validation mainnet *(6c)*
- [x] Optimisation latence : **région Jito** (`execution.router.jito_region` : frankfurt/amsterdam/london…), **préchauffe** des comptes de tip en parallèle du `/build`, sonde v1 simulée en JSON-RPC direct (pas de re-sérialisation web3.js) ; cache de blockhash écarté à dessein (`/build` fournit un blockhash frais) *(6c)*

🧪 **97 tests Phase 6** (29 en 6a, 32 en 6b, 36 en 6c) : assemblage Router (limite CU, plafond du prix des CU, ALT, tip,
ordre des instructions), atterrissage et calcul du reçu (`outputAmountFromTransaction`), exécuteur Router
(dry-run, succès live simulé, re-cotation sur simulation en échec, rejet on-chain, confirmation incertaine,
`/build` HTTP 400), parsing `/build`, cibles `tx.jup.ag`/Jito (JSON-RPC, classification refus/incertain,
tip Jito, observation de bundle, région, préchauffe), tips et bascule `auto`, statistiques par chemin
(`collectPathStats`, `pickPath`), slippage adaptatif (ATR, bougies fermées, bornes, détection 6001/0x1771,
élargissement), transactions v1 (conversions, budget sur la config, ordre des instructions, signature
ed25519 vérifiée, repli v0).

**DoD** : A/B mesuré sur ≥ 200 swaps réels : taux de landing, slippage moyen et coût total (frais + tips) documentés par chemin d'exécution ; bascule automatique vers le chemin le plus efficace par type de paire.

⏳ **Reste dépendant du financement** : la mesure A/B réelle (≥ 200 swaps) exige un wallet financé — en attente,
comme l'aller-retour de 10 USDC de la Phase 2. Les mécanismes (`solbot paths`, `execution.path: auto`) sont en
place et testés ; en attendant le financement, les deux chemins se comparent en dry-run
(`solbot swap --path router` vs `--path meta_aggregator`) et `solbot paths` affichera les statistiques dès les
premiers swaps live.

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
