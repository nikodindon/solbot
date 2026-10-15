import { DatabaseSync } from 'node:sqlite';
import { SOL_MINT, USDC_MINT } from '../constants.js';
import { Engine } from '../engine/engine.js';
import type { PaperCosts } from '../execution/paper-broker.js';
import { TIMEFRAMES, bucketStart, type Timeframe } from '../market/ohlcv.js';
import type { PolledPrice, PollSummary } from '../market/poller.js';
import { setNumberState, STATE_KEYS } from '../state/bot-state.js';
import { openDatabase, resolveDatabasePath } from '../state/db.js';
import { getMergedCandles } from '../state/imported-candles.js';
import type { Candle } from '../state/market-data.js';
import { runMigrations } from '../state/migrations.js';
import { getWatchlist } from '../state/watchlist.js';
import {
  buildStrategies,
  strategySetDescriptor,
  strategyWeights,
  type StrategyDescriptor,
} from '../strategy/registry.js';
import { loadConfig } from '../utils/config.js';
import { SolbotError, messageOf } from '../utils/errors.js';
import { computeMetrics, type PerformanceMetrics } from './metrics.js';
import { insertBacktestRun, paramsHash, type BacktestEquityPoint } from './store.js';

const MAX_CONSECUTIVE_ERRORS = 5;
const DEFAULT_DAYS = 30;

export interface BacktestRunnerInput {
  root: string;
  /** Config alternative (jeux de paramètres du DoD) ; défaut : config du projet. */
  configPath?: string | null;
  label?: string | null;
  fromTs?: number;
  toTs?: number;
  days?: number;
  timeframe?: Timeframe;
  mints?: string[];
  initialUsdc?: number;
  /** Décimales par mint (API Price ou tests) — sans elles, pas d'entrée. */
  decimalsByMint?: Map<string, number | null>;
  /** Liquidité statique par mint (USD) pour le modèle d'impact. */
  liquidityByMint?: Map<string, number | null>;
  /** `false` : ne pas enregistrer le run (tests). */
  store?: boolean;
  now?: number;
  onProgress?: (line: string) => void;
}

export interface BacktestRunResult {
  runId: number | null;
  label: string | null;
  configPath: string | null;
  paramsHash: string;
  strategies: StrategyDescriptor[];
  timeframe: Timeframe;
  fromTs: number;
  toTs: number;
  days: number;
  initialUsdc: number;
  mintsRequested: number;
  mintsWithData: number;
  candles: number;
  steps: number;
  errors: number;
  conclusive: boolean;
  metrics: PerformanceMetrics;
  rejections: Array<{ rule: string; count: number }>;
  entriesByStrategy: Array<{ strategy: string; count: number }>;
  equity: BacktestEquityPoint[];
}

interface MintFeed {
  candles: Candle[];
  /** Nombre de bougies dont le bucket est ≤ au bucket courant (prix). */
  priceIndex: number;
  /** Nombre de bougies **clôturées** à l'instant courant (évaluation). */
  closedIndex: number;
}

/**
 * Rejoue un backtest en réutilisant le **moteur réel** (stratégies, risque,
 * portefeuille FIFO, broker paper) sur une base SQLite temporaire alimentée
 * par l'historique OHLCV (importé et/ou accumulé). Le prix courant d'un tick
 * est la clôture de la bougie, l'horloge avance bougie par bougie.
 */
export async function runBacktest(input: BacktestRunnerInput): Promise<BacktestRunResult> {
  const progress = input.onProgress ?? ((): void => {});
  const { config } = loadConfig({
    root: input.root,
    ...(input.configPath === undefined ? {} : { yamlPath: input.configPath }),
  });
  const strategies = buildStrategies(config);
  const weights = strategyWeights(config);
  const descriptor = strategySetDescriptor(config);
  const hash = paramsHash(config);

  const timeframe = (input.timeframe ?? config.backtest.timeframe) as Timeframe;
  if (!(timeframe in TIMEFRAMES)) {
    throw new SolbotError(`Timeframe de backtest inconnu : « ${timeframe} »`);
  }
  const tfMs = TIMEFRAMES[timeframe];

  const requiredTimeframes = new Set(
    strategies.flatMap((strategy) => strategy.requiredData.map((data) => data.timeframe)),
  );
  for (const required of requiredTimeframes) {
    if (required !== timeframe) {
      progress(
        `⚠ stratégie exigeant le timeframe ${required} : aucune donnée rejouée (backtest en ${timeframe})`,
      );
    }
  }

  const now = input.now ?? Date.now();
  const toTs = input.toTs ?? now;
  const fromTs = input.fromTs ?? toTs - (input.days ?? DEFAULT_DAYS) * 86_400_000;
  const days = input.days ?? (toTs - fromTs) / 86_400_000;
  if (!(fromTs < toTs)) {
    throw new SolbotError('Fenêtre de backtest invalide : from ≥ to');
  }

  const mainDb = openDatabase(resolveDatabasePath(input.root, config.database.path));
  const tempDb = new DatabaseSync(':memory:');
  try {
    runMigrations(mainDb);
    runMigrations(tempDb);

    const watchlist = getWatchlist(mainDb);
    const selected = input.mints ?? watchlist.map((item) => item.mint);
    if (selected.length === 0) {
      throw new SolbotError('Watchlist vide : rien à rejouer', {
        hint: 'Lancez `solbot scan` puis réessayez.',
      });
    }
    const symbols = new Map(watchlist.map((item) => [item.mint, item.symbol]));
    const universe = [...new Set([...selected, SOL_MINT, USDC_MINT])];

    const maxBars = Math.max(
      0,
      ...strategies.flatMap((strategy) => strategy.requiredData.map((data) => data.bars)),
    );
    const loadFrom = fromTs - maxBars * tfMs;

    const feeds = new Map<string, MintFeed>();
    let candles = 0;
    let mintsWithData = 0;
    for (const mint of universe) {
      const candlesForMint = getMergedCandles(mainDb, mint, timeframe, {
        fromTs: loadFrom,
        toTs,
      });
      candles += candlesForMint.length;
      if (candlesForMint.length > 0) mintsWithData += 1;
      feeds.set(mint, { candles: candlesForMint, priceIndex: 0, closedIndex: 0 });
    }
    if (candles === 0) {
      throw new SolbotError(`Aucune bougie ${timeframe} disponible pour la fenêtre demandée`, {
        hint: 'Importez de l’historique : `solbot backtest import --days 30`.',
      });
    }

    // ── Base temporaire : watchlist + bougies de rejeu ────────────────────
    const insertWatch = tempDb.prepare(
      `INSERT INTO watchlist
         (mint, symbol, name, rank, is_base, is_verified, organic_score, liquidity_usd,
          usd_price, price_change_24h, tags, updated_at)
       VALUES (?, ?, ?, ?, 0, 1, NULL, ?, NULL, NULL, NULL, ?)`,
    );
    selected.forEach((mint, index) => {
      const row = watchlist.find((item) => item.mint === mint);
      insertWatch.run(
        mint,
        symbols.get(mint) ?? shortMint(mint),
        symbols.get(mint) ?? shortMint(mint),
        index + 1,
        input.liquidityByMint?.get(mint) ?? row?.liquidityUsd ?? null,
        now,
      );
    });
    const insertCandle = tempDb.prepare(
      `INSERT INTO candles (mint, timeframe, bucket_start, open, high, low, close, tick_count, volume_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    );
    tempDb.exec('BEGIN');
    try {
      for (const [mint, feed] of feeds) {
        for (const candle of feed.candles) {
          insertCandle.run(
            mint,
            timeframe,
            candle.bucketStart,
            candle.open,
            candle.high,
            candle.low,
            candle.close,
            candle.volumeUsd,
          );
        }
      }
      tempDb.exec('COMMIT');
    } catch (error) {
      tempDb.exec('ROLLBACK');
      throw error;
    }

    // ── Caisse virtuelle initiale du run ──────────────────────────────────
    const initialUsdc = input.initialUsdc ?? config.backtest.initial_usdc;
    setNumberState(tempDb, STATE_KEYS.paperCashUsdc, initialUsdc, fromTs);

    // ── Rejeu : horloge, prix et fenêtres glissantes par mint ─────────────
    let stepTs = 0;
    const decimals = input.decimalsByMint;
    const liquidity = input.liquidityByMint;
    const defaultLiquidity = config.backtest.default_liquidity_usd;

    const priceAt = (mint: string, ts: number): number | null => {
      const feed = feeds.get(mint);
      if (feed === undefined) return null;
      const index = countClosed(feed.candles, ts, tfMs);
      const candle = feed.candles[index - 1];
      return candle === undefined ? null : candle.close;
    };

    const poll = async (requested: string[]): Promise<PollSummary> => {
      const prices = new Map<string, PolledPrice>();
      for (const mint of requested) {
        const feed = feeds.get(mint);
        const candle =
          feed !== undefined && feed.priceIndex > 0 ? feed.candles[feed.priceIndex - 1] : undefined;
        if (candle === undefined) continue;
        prices.set(mint, {
          usdPrice: candle.close,
          liquidityUsd: liquidity?.get(mint) ?? defaultLiquidity,
          volume24hUsd: null,
          decimals: decimals?.get(mint) ?? null,
        });
      }
      return {
        ts: stepTs,
        requested: requested.length,
        priced: prices.size,
        volumeCovered: 0,
        ticksInserted: 0,
        candlesUpserted: 0,
        durationMs: 0,
        prices,
      };
    };

    const getCandles = (mint: string, tf: Timeframe, limit: number): Candle[] => {
      if (tf !== timeframe) return [];
      const feed = feeds.get(mint);
      if (feed === undefined) return [];
      const end = feed.closedIndex;
      return feed.candles.slice(Math.max(0, end - limit), end);
    };

    const costs: PaperCosts = {
      fillSlippageBps: config.backtest.costs.fill_slippage_bps,
      impactK: config.backtest.costs.impact_k,
      priorityFeeSol: config.backtest.costs.priority_fee_sol,
      feeBpsOverride: config.backtest.costs.fee_bps_override,
    };

    const engine = new Engine({
      db: tempDb,
      config,
      mode: 'paper',
      strategies,
      weights,
      poll,
      stopFile: { exists: () => false, createIfAbsent: () => undefined },
      costs,
      getCandles,
      clock: () => stepTs,
      onLog: (line) => progress(`  ${line}`),
    });

    let minBucket = Number.POSITIVE_INFINITY;
    for (const feed of feeds.values()) {
      const first = feed.candles[0];
      if (first !== undefined && first.bucketStart >= loadFrom) {
        minBucket = Math.min(minBucket, first.bucketStart);
      }
    }
    if (!Number.isFinite(minBucket)) {
      throw new SolbotError('Fenêtre couverte par aucune bougie', {
        hint: 'Élargissez la fenêtre ou importez davantage d’historique.',
      });
    }
    const firstBucket = Math.max(minBucket, bucketStart(fromTs, tfMs));

    const equity: BacktestEquityPoint[] = [];
    let steps = 0;
    let errors = 0;
    for (let bucket = firstBucket; bucket + tfMs <= toTs; bucket += tfMs) {
      stepTs = bucket + tfMs;
      for (const feed of feeds.values()) {
        while (
          feed.priceIndex < feed.candles.length &&
          feed.candles[feed.priceIndex]!.bucketStart <= bucket
        ) {
          feed.priceIndex += 1;
        }
        while (
          feed.closedIndex < feed.candles.length &&
          feed.candles[feed.closedIndex]!.bucketStart + tfMs <= stepTs
        ) {
          feed.closedIndex += 1;
        }
      }
      try {
        const result = await engine.runOnce();
        steps += 1;
        equity.push({
          ts: result.ts,
          navUsd: result.navUsd,
          cashUsd: result.cashUsd,
          positionsValueUsd: result.positionsValueUsd,
        });
      } catch (error) {
        errors += 1;
        progress(`  ⚠ erreur de tick (${errors}/${MAX_CONSECUTIVE_ERRORS}) : ${messageOf(error)}`);
        if (errors >= MAX_CONSECUTIVE_ERRORS) {
          throw new SolbotError('Backtest interrompu : erreurs de tick répétées', {
            hint: messageOf(error),
          });
        }
      }
    }
    if (steps === 0) {
      throw new SolbotError('Backtest vide : aucune bougie rejouable dans la fenêtre');
    }

    // ── Métriques depuis la base de rejeu ─────────────────────────────────
    const closedRows = tempDb
      .prepare(
        `SELECT realized_pnl_usd AS pnl, closed_at AS closedAt FROM positions WHERE status = 'closed'`,
      )
      .all() as unknown as Array<{ pnl: number; closedAt: number }>;
    const tradeRows = tempDb
      .prepare(
        `SELECT input_mint, output_mint, in_amount, out_amount, created_at, fee_usd
         FROM trades WHERE mode = 'paper'`,
      )
      .all() as unknown as Array<{
      input_mint: string;
      output_mint: string;
      in_amount: string;
      out_amount: string | null;
      created_at: number;
      fee_usd: number | null;
    }>;
    const trades = tradeRows.map((row) => ({
      notionalUsd: notionalUsd(row, decimals, priceAt),
      feeUsd: row.fee_usd,
    }));

    const rejections = (
      tempDb
        .prepare(
          `SELECT rule, COUNT(*) AS count FROM risk_rejections GROUP BY rule ORDER BY count DESC LIMIT 10`,
        )
        .all() as unknown as Array<{ rule: string; count: number }>
    ).map((row) => ({ rule: row.rule, count: row.count }));

    const entriesByStrategy = (
      tempDb
        .prepare(
          `SELECT strategy, COUNT(*) AS count FROM trades WHERE trigger = 'entry' GROUP BY strategy ORDER BY count DESC`,
        )
        .all() as unknown as Array<{ strategy: string; count: number }>
    ).map((row) => ({ strategy: row.strategy, count: row.count }));

    const metrics = computeMetrics({
      equity: equity.map((point) => ({ ts: point.ts, navUsd: point.navUsd })),
      closedPositions: closedRows.map((row) => ({
        realizedPnlUsd: row.pnl,
        closedAt: row.closedAt,
      })),
      trades,
      initialUsd: initialUsdc,
      days,
    });
    const conclusive = days >= config.backtest.guard.min_days;

    let runId: number | null = null;
    if (input.store !== false) {
      runId = insertBacktestRun(
        mainDb,
        {
          label: input.label ?? null,
          configPath: input.configPath ?? null,
          paramsHash: hash,
          strategies: descriptor,
          timeframe,
          fromTs,
          toTs,
          days,
          initialUsdc,
          mintsCount: selected.length,
          candlesCount: candles,
          tradesCount: closedRows.length,
          conclusive,
          metrics,
          rejections,
        },
        equity,
        now,
      );
    }

    return {
      runId,
      label: input.label ?? null,
      configPath: input.configPath ?? null,
      paramsHash: hash,
      strategies: descriptor,
      timeframe,
      fromTs,
      toTs,
      days,
      initialUsdc,
      mintsRequested: selected.length,
      mintsWithData,
      candles,
      steps,
      errors,
      conclusive,
      metrics,
      rejections,
      entriesByStrategy,
      equity,
    };
  } finally {
    tempDb.close();
    mainDb.close();
  }
}

/** Nombre de bougies **clôturées** à l'instant `ts` (recherche binaire). */
function countClosed(candles: Candle[], ts: number, tfMs: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (candles[middle]!.bucketStart + tfMs <= ts) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Notionnel USD approximatif d'un trade (branche USDC directe, sinon prix de la bougie). */
function notionalUsd(
  row: {
    input_mint: string;
    output_mint: string;
    in_amount: string;
    out_amount: string | null;
    created_at: number;
  },
  decimals: Map<string, number | null> | undefined,
  priceAt: (mint: string, ts: number) => number | null,
): number {
  try {
    if (row.input_mint === USDC_MINT) return Number(BigInt(row.in_amount)) / 1e6;
    if (row.output_mint === USDC_MINT && row.out_amount !== null) {
      return Number(BigInt(row.out_amount)) / 1e6;
    }
    const price = priceAt(row.input_mint, row.created_at);
    const tokenDecimals = decimals?.get(row.input_mint) ?? (row.input_mint === SOL_MINT ? 9 : null);
    if (price === null || tokenDecimals === null) return 0;
    return (Number(BigInt(row.in_amount)) / 10 ** tokenDecimals) * price;
  } catch {
    return 0;
  }
}

function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}
