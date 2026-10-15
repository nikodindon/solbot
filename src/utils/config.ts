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

const StrategiesSchema = z.strictObject({
  momentum: StrategySchema.default(MOMENTUM_DEFAULT),
  mean_reversion: StrategySchema.default(StrategySchema.parse({})),
  dca_rotation: StrategySchema.default(StrategySchema.parse({})),
  copy_trade: StrategySchema.default(StrategySchema.parse({})),
});

const PaperSchema = z.strictObject({
  initial_usdc: z.number().min(1).default(1000),
  /** Slippage modélisé sur chaque fill paper (aller simple). */
  fill_slippage_bps: z.number().int().min(0).max(500).default(20),
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

const ExecutionSchema = z.strictObject({
  path: z.enum(['meta_aggregator', 'router']).default('meta_aggregator'),
  slippage: z.union([z.literal('rtse'), z.number().int().min(1).max(5000)]).default('rtse'),
  exclude_routers: z.array(z.enum(['jupiterz', 'dflow', 'okx'])).default([]),
  retries: z.number().int().min(0).max(10).default(3),
  retry_backoff_ms: z.number().int().min(50).max(60_000).default(750),
  confirm_timeout_s: z.number().int().min(5).max(300).default(60),
});

const TelegramSchema = z.strictObject({
  enabled: z.boolean().default(false),
  notify_on: z
    .array(z.enum(['trade', 'error', 'daily_report']))
    .default(['trade', 'error', 'daily_report']),
});

const NotificationsSchema = z.strictObject({
  telegram: TelegramSchema.default(TelegramSchema.parse({})),
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
  notifications: NotificationsSchema.default(NotificationsSchema.parse({})),
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
