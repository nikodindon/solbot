import fs from 'node:fs';
import bs58 from 'bs58';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { DEFAULT_RPC_URL } from '../constants.js';
import { ConfigError } from './errors.js';
import { getConfigExamplePath, getConfigPath, getProjectRoot } from './paths.js';

/* ──────────────────────────────────────────────────────────────
 * Schémas — config.yaml
 * ────────────────────────────────────────────────────────────── */

// Convention : le défaut d'une section entière est `SectionSchema.default(SectionSchema.parse({}))`,
// c'est-à-dire un objet pré-rempli par les défauts de ses propres clés.

const httpUrl = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'URL http(s) invalide' },
);

const percent = z.number().min(0).max(100);

const UniverseSchema = z.strictObject({
  category: z.enum(['toporganicscore', 'toptraded', 'toptrending']).default('toptraded'),
  interval: z.enum(['5m', '1h', '6h', '24h']).default('24h'),
  candidate_limit: z.number().int().min(1).max(200).default(100),
  verified_only: z.boolean().default(true),
  min_liquidity_usd: z.number().min(0).default(250_000),
  min_organic_score: percent.default(60),
  min_age_hours: z.number().min(0).default(24),
  blacklist_mints: z.array(z.string().min(32)).default([]),
  whitelist_mints: z.array(z.string().min(32)).default([]),
  max_watchlist: z.number().int().min(1).max(200).default(40),
});

const StrategySchema = z.strictObject({
  enabled: z.boolean().default(false),
  weight: z.number().min(0).max(10).default(1),
  timeframe: z.string().min(1).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
});

/** La stratégie momentum est activée par défaut (bot utilisable dès l'installation, en paper). */
const MOMENTUM_DEFAULT = {
  enabled: true,
  weight: 1,
  timeframe: '15m',
  params: {
    ema_fast: 12,
    ema_slow: 26,
    rsi_period: 14,
    rsi_entry: 65,
    atr_period: 14,
    atr_stop_mult: 2.0,
    breakout_lookback: 20,
    volume_mult: 1.5,
    volume_lookback: 20,
  },
};

const MEAN_REVERSION_DEFAULT = {
  enabled: false,
  weight: 1,
  timeframe: '15m',
  params: {
    window: 96,
    z_entry: 2.0,
    z_exit: 0.5,
    mode: 'zscore',
    grid_step_pct: 1.0,
    grid_levels: 5,
  },
};

const DCA_ROTATION_DEFAULT = {
  enabled: false,
  weight: 0.5,
  params: {
    target_alloc: { SOL: 0.4, USDC: 0.6 },
    drift_trigger_pct: 5,
    topup_usdc: 25,
  },
};

const StrategiesSchema = z.strictObject({
  momentum: StrategySchema.default(MOMENTUM_DEFAULT),
  mean_reversion: StrategySchema.default(MEAN_REVERSION_DEFAULT),
  dca_rotation: StrategySchema.default(DCA_ROTATION_DEFAULT),
  copy_trade: StrategySchema.default(StrategySchema.parse({})),
});

const PaperSchema = z.strictObject({
  initial_usdc: z.number().min(1).default(1000),
  /** Slippage modélisé sur chaque fill paper (aller simple). */
  fill_slippage_bps: z.number().int().min(0).max(500).default(20),
  /** Impact de marché modélisé (paper) : impact ≈ impact_k × notionnel / liquidité. */
  impact_k: z.number().min(0).max(10).default(0),
  /** Priority fee + frais réseau par swap, en SOL (0 = ignoré). */
  priority_fee_sol: z.number().min(0).default(0),
  /** Force le barème de frais (bps) au lieu du barème Jupiter par paire. */
  fee_bps_override: z.number().int().min(0).max(500).nullable().default(null),
});

const BacktestCostsSchema = z.strictObject({
  fill_slippage_bps: z.number().int().min(0).max(500).default(10),
  impact_k: z.number().min(0).max(10).default(0.5),
  priority_fee_sol: z.number().min(0).default(0.00005),
  fee_bps_override: z.number().int().min(0).max(500).nullable().default(null),
});

const BacktestGuardSchema = z.strictObject({
  /** Couverture minimale (jours de données) pour qu'un backtest soit concluant. */
  min_days: z.number().min(0).max(365).default(30),
  /** Exiger un PnL net positif pour autoriser le live (garde-fou renforcé). */
  require_positive_net_pnl: z.boolean().default(false),
});

const BacktestSchema = z.strictObject({
  timeframe: z.enum(['1m', '5m', '15m', '1h']).default('15m'),
  initial_usdc: z.number().min(1).default(1000),
  /** Liquidité statique de secours (USD) si la watchlist n'en fournit pas. */
  default_liquidity_usd: z.number().min(0).default(250_000),
  costs: BacktestCostsSchema.default(BacktestCostsSchema.parse({})),
  guard: BacktestGuardSchema.default(BacktestGuardSchema.parse({})),
});

const EngineSchema = z.strictObject({
  /** Entrées maximum exécutées par tick (anti-rafale). Les sorties ne sont pas limitées. */
  max_entries_per_tick: z.number().int().min(1).max(10).default(1),
});

const TrailingStopSchema = z.strictObject({
  activation_pct: z.number().min(0).default(6),
  retrace_pct: z.number().min(0.1).default(3),
});

const RiskSchema = z.strictObject({
  max_position_pct: z.number().min(0.1).max(100).default(5),
  max_positions: z.number().int().min(1).max(50).default(6),
  max_asset_exposure_pct: z.number().min(0.1).max(100).default(15),
  daily_loss_limit_pct: z.number().min(0.1).max(100).default(3),
  max_drawdown_pct: z.number().min(0.1).max(100).default(15),
  stop_loss_pct: z.number().min(0.1).max(95).default(8),
  take_profit_pct: z.number().min(0.1).max(1000).default(15),
  trailing_stop: TrailingStopSchema.default(TrailingStopSchema.parse({})),
  max_slippage_bps: z.number().int().min(1).max(5000).default(100),
  min_time_between_trades_s: z.number().int().min(0).default(300),
  max_price_impact_pct: percent.default(1),
  sol_gas_reserve: z.number().min(0).default(0.05),
});

/** Options du chemin Router (`/build`) — Phase 6. */
const RouterSchema = z.strictObject({
  compute_unit_price_percentile: z
    .union([z.enum(['medium', 'high', 'veryHigh']), z.number().int().min(0).max(10_000)])
    .default('high'),
  max_accounts: z.number().int().min(1).max(64).default(64),
  fast_mode: z.boolean().default(false),
  cu_limit_buffer: z.number().min(1).max(2).default(1.2),
  /** Plafond du prix des CU en micro-lamports (0 = pas de plafond). */
  cu_price_cap_microlamports: z.number().int().min(0).default(0),
  /** Tip ajouté par `/build` en lamports (0 = aucun ; 1 000 000 = 0,001 SOL). */
  tip_lamports: z.number().int().min(0).default(0),
  /**
   * Cible d'atterrissage du chemin Router (Phase 6b) : `rpc` (notre nœud),
   * `tx_jup` (infra Jupiter, tip ≥ 0,001 SOL) ou `jito` (bundles Jito).
   */
  landing: z.enum(['rpc', 'tx_jup', 'jito']).default('rpc'),
  /** Tip taillé pour un bundle Jito (imposé automatiquement si `landing: jito`). */
  for_jito_bundle: z.boolean().default(false),
  /**
   * Point d'entrée régional du Block Engine Jito (Phase 6c) : choisissez la
   * région la plus proche de votre VPS (ex. `frankfurt` ou `amsterdam` en
   * Europe) pour réduire la latence d'atterrissage. `global` = mainnet Jito.
   */
  jito_region: z
    .enum(['global', 'amsterdam', 'frankfurt', 'london', 'ny', 'slc', 'singapore', 'tokyo'])
    .default('global'),
  /**
   * Version des transactions demandées à `/build` (Phase 6c) : `0` (défaut,
   * ALTs) ou `1` (SIMD-0385, 4096 octets, sans tables d'adresses — expérimental
   * jusqu'à validation mainnet ; nécessite un signer local).
   */
  transaction_version: z.number().int().min(0).max(1).default(0),
});

/** Réglages de la bascule automatique de chemin (`execution.path: auto`) — Phase 6b. */
const AutoPathSchema = z.strictObject({
  /** Fenêtre glissante des statistiques live (jours). */
  window_days: z.number().int().min(1).max(90).default(7),
  /** Swaps live minimum par chemin avant de comparer. */
  min_samples: z.number().int().min(1).max(1000).default(20),
  /** Écart de taux de landing exigé pour basculer (0,02 = 2 points). */
  rate_margin: z.number().min(0).max(0.5).default(0.02),
});

/** Réglages du slippage adaptatif (`execution.slippage: adaptive`) — Phase 6c. */
const AdaptiveSlippageSchema = z.strictObject({
  /** Timeframe des bougies servant au calcul de l'ATR. */
  timeframe: z.enum(['1m', '5m', '15m', '1h']).default('15m'),
  /** Nombre de bougies moyennées par l'ATR (période classique : 14). */
  period: z.number().int().min(2).max(200).default(14),
  /** Multiplicateur appliqué à l'ATR (%) pour obtenir la borne (bps). */
  multiplier: z.number().min(0.1).max(10).default(1),
  /** Plancher de la borne (bps) — un plancher bas re-cote plus souvent. */
  min_bps: z.number().int().min(1).max(5000).default(10),
  /** Plafond de la borne (bps) ; `risk.max_slippage_bps` reste le garde-fou absolu. */
  max_bps: z.number().int().min(1).max(5000).default(100),
});

const ExecutionSchema = z.strictObject({
  path: z.enum(['meta_aggregator', 'router', 'auto']).default('meta_aggregator'),
  /**
   * Slippage demandé : `rtse` (automatique Jupiter, recommandé), `adaptive`
   * (borne calculée depuis la volatilité ATR de l'actif d'entrée — repli RTSE
   * si l'historique est insuffisant) ou un entier en bps. Les bornes
   * numériques peuvent être élargies automatiquement après un échec de type
   * slippage (`slippage_bump_factor`), jamais au-delà de
   * `risk.max_slippage_bps`.
   */
  slippage: z
    .union([z.literal('rtse'), z.literal('adaptive'), z.number().int().min(1).max(5000)])
    .default('rtse'),
  /** Paramètres du calcul adaptatif (utilisés si `slippage: adaptive`). */
  slippage_adaptive: AdaptiveSlippageSchema.default(AdaptiveSlippageSchema.parse({})),
  /**
   * Facteur d'élargissement de la borne après un échec « slippage »
   * (1 = désactivé). Ex. : borne 50 bps, facteur 2 → 100 bps à la re-cotation.
   */
  slippage_bump_factor: z.number().min(1).max(10).default(2),
  exclude_routers: z.array(z.enum(['jupiterz', 'dflow', 'okx'])).default([]),
  retries: z.number().int().min(0).max(10).default(3),
  retry_backoff_ms: z.number().int().min(50).max(60_000).default(750),
  confirm_timeout_s: z.number().int().min(5).max(300).default(60),
  router: RouterSchema.default(RouterSchema.parse({})),
  /** Bascule automatique (`path: auto`) — ignoré sinon. */
  auto: AutoPathSchema.default(AutoPathSchema.parse({})),
});

const TelegramSchema = z.strictObject({
  enabled: z.boolean().default(false),
  notify_on: z
    .array(z.enum(['trade', 'error', 'daily_report', 'alert', 'backup']))
    .default(['trade', 'error', 'daily_report']),
  /** Commandes entrantes (`/status`, `/pause`, `/kill`…) — long polling. */
  commands_enabled: z.boolean().default(true),
  /** Heure UTC (0–23) du rapport PnL quotidien pendant que le moteur tourne. */
  daily_report_utc_hour: z.number().int().min(0).max(23).default(8),
});

const NotificationsSchema = z.strictObject({
  telegram: TelegramSchema.default(TelegramSchema.parse({})),
});

const MonitoringSchema = z.strictObject({
  /** Serveur HTTP local : `/healthz` (Docker/systemd) et `/metrics` (Prometheus). */
  enabled: z.boolean().default(false),
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(9464),
});

const AlertsSchema = z.strictObject({
  enabled: z.boolean().default(true),
  /** Anti-spam : délai minimal entre deux alertes d'une même règle (minutes). */
  cooldown_min: z.number().int().min(1).max(1440).default(30),
  /** Erreurs de tick consécutives déclenchant une alerte (« RPC en échec »). */
  tick_error_threshold: z.number().int().min(1).max(10).default(2),
  /** Fenêtre d'observation du taux d'échec d'exécution (minutes). */
  execute_failure_window_min: z.number().int().min(1).max(1440).default(60),
  /** Minimum de trades dans la fenêtre avant de calculer le taux. */
  execute_failure_min_trades: z.number().int().min(1).max(100).default(5),
  /** Taux d'échec d'exécution (%) au-delà duquel une alerte est émise. */
  execute_failure_rate_pct: percent.default(30),
});

const BackupsSchema = z.strictObject({
  enabled: z.boolean().default(true),
  dir: z.string().min(1).default('./data/backups'),
  /** Nombre de sauvegardes conservées (rotation). */
  keep: z.number().int().min(1).max(90).default(7),
  /** Heure UTC (0–23) du backup quotidien pendant que le moteur tourne. */
  daily_utc_hour: z.number().int().min(0).max(23).default(3),
});

const DatabaseSchema = z.strictObject({
  path: z.string().min(1).default('./data/solbot.sqlite'),
});

export const ConfigSchema = z.strictObject({
  mode: z.enum(['paper', 'dry_run', 'live']).default('paper'),
  confirm_live: z.boolean().default(false),
  base_currency: z.enum(['USDC', 'SOL']).default('USDC'),
  loop_interval_s: z.number().int().min(5).max(3600).default(30),
  universe: UniverseSchema.default(UniverseSchema.parse({})),
  strategies: StrategiesSchema.default(StrategiesSchema.parse({})),
  risk: RiskSchema.default(RiskSchema.parse({})),
  execution: ExecutionSchema.default(ExecutionSchema.parse({})),
  paper: PaperSchema.default(PaperSchema.parse({})),
  engine: EngineSchema.default(EngineSchema.parse({})),
  backtest: BacktestSchema.default(BacktestSchema.parse({})),
  notifications: NotificationsSchema.default(NotificationsSchema.parse({})),
  monitoring: MonitoringSchema.default(MonitoringSchema.parse({})),
  alerts: AlertsSchema.default(AlertsSchema.parse({})),
  backups: BackupsSchema.default(BackupsSchema.parse({})),
  database: DatabaseSchema.default(DatabaseSchema.parse({})),
});

export type Config = z.infer<typeof ConfigSchema>;
export type StrategyConfig = z.infer<typeof StrategySchema>;

/* ──────────────────────────────────────────────────────────────
 * Schémas — variables d'environnement (.env)
 * ────────────────────────────────────────────────────────────── */

/** Une chaîne vide (`KEY=`) est traitée comme une variable absente. */
function emptyToUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema,
  );
}

const privateKeyBase58 = z.string().refine(
  (value) => {
    try {
      return bs58.decode(value.trim()).length === 64;
    } catch {
      return false;
    }
  },
  {
    message:
      'clé privée invalide — attendu : base58 de 64 octets (générée par `npm run solbot -- init`)',
  },
);

export const EnvSchema = z
  .object({
    BS58_PRIVATE_KEY: emptyToUndefined(privateKeyBase58.optional()),
    JUPITER_API_KEY: emptyToUndefined(z.string().optional()),
    JUPITER_RPS: emptyToUndefined(z.coerce.number().positive().max(200).optional()),
    SOLANA_RPC_URL: emptyToUndefined(httpUrl.default(DEFAULT_RPC_URL)),
    SOLANA_RPC_URL_FALLBACK: emptyToUndefined(httpUrl.optional()),
    TELEGRAM_BOT_TOKEN: emptyToUndefined(z.string().optional()),
    TELEGRAM_CHAT_ID: emptyToUndefined(z.string().optional()),
    LOG_LEVEL: emptyToUndefined(
      z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    ),
  })
  .passthrough();

export type Env = z.infer<typeof EnvSchema>;

/* ──────────────────────────────────────────────────────────────
 * Parsing & chargement
 * ────────────────────────────────────────────────────────────── */

function formatZodIssues(prefix: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(racine)';
    return `  • ${path} : ${issue.message}`;
  });
  return [prefix, ...lines].join('\n');
}

/** Valide les variables d'environnement — lève une ConfigError listant chaque problème. */
export function parseEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(formatZodIssues("Variables d'environnement invalides :", result.error));
  }
  return result.data;
}

/** Valide l'objet issu de config.yaml (ou de l'exemple) et applique les défauts. */
export function parseConfig(raw: unknown): Config {
  const input = raw ?? {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ConfigError('config.yaml doit contenir un objet YAML (mode:, risk:, …)');
  }

  const result = ConfigSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(formatZodIssues('config.yaml invalide :', result.error));
  }
  const config = result.data;

  if (config.mode === 'live' && !config.confirm_live) {
    throw new ConfigError("mode 'live' configuré sans confirm_live: true", {
      hint: "Ajoutez `confirm_live: true` dans config.yaml pour confirmer explicitement l'usage de fonds réels.",
    });
  }
  return config;
}

function readYamlFile(filePath: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ConfigError(`Impossible de lire ${filePath}`, { cause: error });
  }
  try {
    return parseYaml(text);
  } catch (error) {
    throw new ConfigError(`YAML invalide dans ${filePath}`, {
      hint: error instanceof Error ? error.message : undefined,
      cause: error,
    });
  }
}

export interface ConfigSources {
  /** Fichier réellement chargé (`null` si tout provient des défauts). */
  yamlPath: string | null;
  /** `true` si le fichier d'exemple a été utilisé faute de config.yaml. */
  usedExample: boolean;
}

export interface LoadedConfig {
  config: Config;
  sources: ConfigSources;
}

/**
 * Charge la configuration effective :
 *   config/config.yaml → sinon config/config.example.yaml → sinon défauts purs.
 */
export function loadConfig(
  options: { root?: string; yamlPath?: string | null } = {},
): LoadedConfig {
  const root = options.root ?? getProjectRoot();
  let yamlPath: string | null =
    options.yamlPath === undefined ? getConfigPath(root) : options.yamlPath;
  let usedExample = false;

  if (yamlPath === null || !fs.existsSync(yamlPath)) {
    const examplePath = getConfigExamplePath(root);
    if (fs.existsSync(examplePath)) {
      yamlPath = examplePath;
      usedExample = true;
    } else {
      yamlPath = null;
    }
  }

  const raw = yamlPath === null ? {} : readYamlFile(yamlPath);
  return { config: parseConfig(raw), sources: { yamlPath, usedExample } };
}
