import { Command } from 'commander';
import { computeBacktestGuardNote } from '../backtest/notes.js';
import { importCandlesGecko } from '../backtest/import-gecko.js';
import { runBacktest, type BacktestRunResult } from '../backtest/runner.js';
import { JupiterClient } from '../jupiter/client.js';
import { PriceApi } from '../jupiter/price.js';
import { TIMEFRAMES, type Timeframe } from '../market/ohlcv.js';
import { openDatabase, resolveDatabasePath } from '../state/db.js';
import { getImportedCoverage } from '../state/imported-candles.js';
import { runMigrations } from '../state/migrations.js';
import { getWatchlist } from '../state/watchlist.js';
import { loadConfig, parseEnv } from '../utils/config.js';
import { loadEnvFile } from '../utils/env-file.js';
import { SolbotError, messageOf } from '../utils/errors.js';
import { getProjectRoot } from '../utils/paths.js';
import { fail, formatPct, ICONS, parseIntOption, printHeader, shorten } from './ui.js';

export interface BacktestCliOptions {
  from?: string;
  to?: string;
  days?: string;
  timeframe?: string;
  mints?: string;
  label?: string;
  config?: string;
  initialUsdc?: string;
  /** `--no-store` → false. */
  store?: boolean;
}

/**
 * `solbot backtest` : rejoue l'historique OHLCV (importé et/ou accumulé) avec
 * le moteur réel — stratégies, arbitrage, risque, portefeuille FIFO, coûts
 * modélisés. Résultats imprimés et enregistrés (garde-fou live).
 */
export async function runBacktestCli(options: BacktestCliOptions): Promise<void> {
  const root = getProjectRoot();
  loadEnvFile(root);
  const env = parseEnv();
  const configPath = options.config ?? null;
  const { config } = loadConfig({
    root,
    ...(configPath === null ? {} : { yamlPath: configPath }),
  });

  const timeframe = resolveTimeframe(options.timeframe, config.backtest.timeframe);
  const now = Date.now();
  const toTs = options.to === undefined ? now : parseTimeOption(options.to, '--to');
  const fromTs = options.from === undefined ? undefined : parseTimeOption(options.from, '--from');
  const days =
    options.days === undefined ? undefined : parseIntOption(options.days, '--days', 1, 365);
  const initialUsdc =
    options.initialUsdc === undefined
      ? undefined
      : parseNumberOption(options.initialUsdc, '--initial-usdc', 1);
  const mints = parseMints(options.mints);

  // Décimales et liquidité (Price v3) : sans elles, les entrées ne peuvent
  // pas être dimensionnées (conversion en unités de base).
  const db = openDatabase(resolveDatabasePath(root, config.database.path));
  runMigrations(db);
  const watchlist = getWatchlist(db);
  const selected = mints ?? watchlist.map((item) => item.mint);
  const liquidityByMint = new Map<string, number | null>(
    watchlist.map((item) => [item.mint, item.liquidityUsd]),
  );
  const decimalsByMint = new Map<string, number | null>();
  try {
    const client = new JupiterClient({
      apiKey: env.JUPITER_API_KEY,
      ratePerSecond: env.JUPITER_RPS,
    });
    const priceApi = new PriceApi(client);
    const prices = await priceApi.getPrices(selected, { useCache: false });
    for (const [mint, info] of prices) {
      decimalsByMint.set(mint, info.decimals ?? null);
      const known = liquidityByMint.get(mint);
      if ((known === null || known === undefined || known <= 0) && info.liquidity > 0) {
        liquidityByMint.set(mint, info.liquidity);
      }
    }
    console.log(
      `  ${ICONS.ok} métadonnées marché : ${prices.size}/${selected.length} mints (décimales + liquidité)`,
    );
  } catch (error) {
    console.log(
      `  ${ICONS.warn} métadonnées marché indisponibles (${messageOf(error)}) — les entrées peuvent être bloquées`,
    );
  } finally {
    db.close();
  }

  printHeader('solbot backtest — rejeu de l’historique');
  const result = await runBacktest({
    root,
    ...(configPath === null ? {} : { configPath }),
    label: options.label ?? null,
    ...(fromTs === undefined ? {} : { fromTs }),
    toTs,
    ...(days === undefined ? {} : { days }),
    timeframe,
    ...(mints === undefined ? {} : { mints }),
    ...(initialUsdc === undefined ? {} : { initialUsdc }),
    decimalsByMint,
    liquidityByMint,
    store: options.store !== false,
    onProgress: (line) => console.log(line),
  });
  printBacktestResult(result, config.backtest.guard.min_days);
}

function printBacktestResult(result: BacktestRunResult, guardMinDays: number): void {
  const metrics = result.metrics;
  const iso = (ts: number): string => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
  const runLabel = result.runId === null ? '(non enregistré)' : `run #${result.runId}`;
  console.log(
    `  ${runLabel}${result.label === null ? '' : ` « ${result.label} »`} · empreinte ${result.paramsHash.slice(0, 8)} · ${result.timeframe}`,
  );
  console.log(
    `  stratégies : ${result.strategies.map((s) => `${s.name} ×${s.weight}`).join(', ')}`,
  );
  console.log(
    `  période ${metrics.days.toFixed(2)} j (${iso(result.fromTs)} → ${iso(result.toTs)}) · ` +
      `${result.mintsRequested} mints (${result.mintsWithData} couverts) · ${result.candles} bougies · ${result.steps} ticks`,
  );
  console.log(
    `  NAV ${metrics.initialNavUsd.toFixed(2)} → ${metrics.finalNavUsd.toFixed(2)} $ — ` +
      `net ${metrics.netPnlUsd >= 0 ? '+' : ''}${metrics.netPnlUsd.toFixed(2)} $ (${formatPct(metrics.netPnlPct)})`,
  );
  const winRate = metrics.winRatePct === null ? '—' : `${metrics.winRatePct.toFixed(1)} %`;
  const profitFactor = metrics.profitFactor === null ? '—' : metrics.profitFactor.toFixed(2);
  const drawdown = metrics.maxDrawdownPct === null ? '—' : `${metrics.maxDrawdownPct.toFixed(2)} %`;
  const sharpe = metrics.sharpe === null ? '—' : metrics.sharpe.toFixed(2);
  console.log(
    `  win rate ${winRate} (${metrics.wins}W/${metrics.losses}L, ${metrics.trades} clôturées) · ` +
      `PF ${profitFactor} · DD max ${drawdown} · Sharpe ${sharpe}`,
  );
  console.log(
    `  turnover ×${metrics.turnover.toFixed(2)} (${metrics.turnoverPerDay.toFixed(2)}/j) · ` +
      `frais ${metrics.feesUsd.toFixed(2)} $ · notionnel moyen ${metrics.avgTradeUsd.toFixed(2)} $`,
  );
  if (result.entriesByStrategy.length > 0) {
    console.log(
      `  entrées : ${result.entriesByStrategy.map((entry) => `${entry.strategy} ×${entry.count}`).join(', ')}`,
    );
  }
  if (result.rejections.length > 0) {
    console.log(
      `  rejets de risque : ${result.rejections.map((row) => `${row.rule} ×${row.count}`).join(', ')}`,
    );
  }
  console.log(`  garde-fou live : ${computeBacktestGuardNote(result, guardMinDays)}`);
  console.log('');
}

export interface BacktestImportCliOptions {
  days?: string;
  timeframe?: string;
  mints?: string;
  pause?: string;
}

/** `solbot backtest import` : historique OHLCV via l'API publique GeckoTerminal. */
export async function runBacktestImportCli(options: BacktestImportCliOptions): Promise<void> {
  const root = getProjectRoot();
  const { config } = loadConfig({ root });
  const timeframe = resolveTimeframe(options.timeframe, config.backtest.timeframe);
  const days = options.days === undefined ? 30 : parseIntOption(options.days, '--days', 1, 365);
  const pauseMs =
    options.pause === undefined ? 1500 : parseIntOption(options.pause, '--pause', 50, 10_000);
  const mints = parseMints(options.mints);

  const db = openDatabase(resolveDatabasePath(root, config.database.path));
  runMigrations(db);
  try {
    const watchlist = getWatchlist(db);
    const universe =
      mints === undefined
        ? watchlist.map((item) => ({ mint: item.mint, symbol: item.symbol }))
        : mints.map((mint) => ({
            mint,
            symbol: watchlist.find((item) => item.mint === mint)?.symbol ?? shorten(mint),
          }));
    if (universe.length === 0) {
      throw new SolbotError('Aucun mint à importer', {
        hint: 'Lancez `solbot scan` pour construire la watchlist, ou passez --mints.',
      });
    }

    printHeader(`solbot backtest import — ${days} j de ${timeframe} (GeckoTerminal)`);
    const result = await importCandlesGecko({
      db,
      mints: universe,
      timeframe,
      days,
      pauseMs,
      onProgress: (line) => console.log(line),
    });
    console.log(
      `  ${ICONS.ok} ${result.mintsImported}/${universe.length} mints importés · ` +
        `${result.candles} bougies · ${result.requests} requêtes`,
    );
    for (const skipped of result.skipped.slice(0, 10)) {
      console.log(`  ${ICONS.warn} ${skipped.symbol} : ${skipped.reason}`);
    }
    const coverage = getImportedCoverage(db, timeframe).slice(0, 10);
    if (coverage.length > 0) {
      console.log('  couverture :');
      for (const row of coverage) {
        const first = new Date(row.firstTs).toISOString().slice(0, 16).replace('T', ' ');
        const last = new Date(row.lastTs).toISOString().slice(0, 16).replace('T', ' ');
        console.log(`    ${shorten(row.mint, 6, 6)} : ${row.count} bougies (${first} → ${last})`);
      }
    }
  } finally {
    db.close();
  }
}

function resolveTimeframe(raw: string | undefined, fallback: string): Timeframe {
  const value = raw ?? fallback;
  if (!(value in TIMEFRAMES)) {
    throw new SolbotError(
      `Timeframe invalide : « ${value} » (attendu : ${Object.keys(TIMEFRAMES).join(', ')})`,
    );
  }
  return value as Timeframe;
}

/** `--from`/`--to` : ISO 8601 ou epoch (secondes si < 1e12, millisecondes sinon). */
function parseTimeOption(raw: string, label: string): number {
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.round(numeric < 1e12 ? numeric * 1000 : numeric);
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return parsed;
  throw new SolbotError(`${label} invalide : « ${raw} » (ISO 8601 ou epoch attendu)`);
}

function parseNumberOption(raw: string, label: string, min: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new SolbotError(`${label} invalide : « ${raw} » (≥ ${min} attendu)`);
  }
  return value;
}

function parseMints(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const mints = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (mints.length === 0) {
    throw new SolbotError('--mints vide : passez une liste de mints séparés par des virgules');
  }
  return mints;
}

export function backtestCommand(): Command {
  const command = new Command('backtest')
    .description(
      'Backtest offline : rejoue l’historique OHLCV avec les stratégies, l’arbitrage et le risque réels',
    )
    .option('--from <date>', 'début de la fenêtre (ISO 8601 ou epoch s/ms)')
    .option('--to <date>', 'fin de la fenêtre (défaut : maintenant)')
    .option('--days <n>', 'fenêtre en jours si --from est absent (défaut : 30)')
    .option(
      '--timeframe <tf>',
      `timeframe (${Object.keys(TIMEFRAMES).join('|')}) — défaut : config`,
    )
    .option('--mints <liste>', 'mints séparés par des virgules (défaut : watchlist)')
    .option('--label <nom>', 'étiquette du run (comparaison de jeux de paramètres)')
    .option('--config <chemin>', 'config.yaml alternative (jeux de paramètres)')
    .option('--initial-usdc <n>', 'caisse virtuelle initiale (défaut : backtest.initial_usdc)')
    .option('--no-store', 'ne pas enregistrer le run (pas d’effet sur le garde-fou)')
    .action(
      async (options: {
        from?: string;
        to?: string;
        days?: string;
        timeframe?: string;
        mints?: string;
        label?: string;
        config?: string;
        initialUsdc?: string;
        store?: boolean;
      }) => {
        try {
          await runBacktestCli({
            ...(options.from === undefined ? {} : { from: options.from }),
            ...(options.to === undefined ? {} : { to: options.to }),
            ...(options.days === undefined ? {} : { days: options.days }),
            ...(options.timeframe === undefined ? {} : { timeframe: options.timeframe }),
            ...(options.mints === undefined ? {} : { mints: options.mints }),
            ...(options.label === undefined ? {} : { label: options.label }),
            ...(options.config === undefined ? {} : { config: options.config }),
            ...(options.initialUsdc === undefined ? {} : { initialUsdc: options.initialUsdc }),
            store: options.store !== false,
          });
        } catch (error) {
          fail(error);
        }
      },
    );

  // Options homonymes avec la sous-commande `import` : les options écrites
  // après `import` doivent lui être attribuées (cf. src/index.ts).
  command.enablePositionalOptions();

  command.addCommand(
    new Command('import')
      .description('importe l’historique OHLCV via l’API publique GeckoTerminal (sans clé)')
      .option('--days <n>', 'profondeur d’historique en jours (défaut : 30)')
      .option(
        '--timeframe <tf>',
        `timeframe (${Object.keys(TIMEFRAMES).join('|')}) — défaut : config`,
      )
      .option('--mints <liste>', 'mints séparés par des virgules (défaut : watchlist)')
      .option('--pause <ms>', 'pause entre requêtes GeckoTerminal (défaut : 1500 ms)')
      .action(
        async (options: { days?: string; timeframe?: string; mints?: string; pause?: string }) => {
          try {
            await runBacktestImportCli({
              ...(options.days === undefined ? {} : { days: options.days }),
              ...(options.timeframe === undefined ? {} : { timeframe: options.timeframe }),
              ...(options.mints === undefined ? {} : { mints: options.mints }),
              ...(options.pause === undefined ? {} : { pause: options.pause }),
            });
          } catch (error) {
            fail(error);
          }
        },
      ),
  );
  return command;
}
