import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runBacktest } from '../src/backtest/runner.js';
import {
  findGuardRun,
  getBacktestEquity,
  getBacktestRuns,
  paramsHash,
} from '../src/backtest/store.js';
import { SOL_MINT, USDC_MINT } from '../src/constants.js';
import { openDatabase, resolveDatabasePath } from '../src/state/db.js';
import { upsertImportedCandles } from '../src/state/imported-candles.js';
import { runMigrations } from '../src/state/migrations.js';
import { replaceWatchlist, type WatchlistItem } from '../src/state/watchlist.js';
import { parseConfig } from '../src/utils/config.js';

const A = 'A'.repeat(44);
const TF_MS = 900_000;
const NOW = 1_750_000_000_000;
const BUCKET0 = Math.floor((NOW - 400 * TF_MS) / TF_MS) * TF_MS;
const BARS = 60;
const TO_TS = BUCKET0 + BARS * TF_MS;

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Config de backtest déterministe : mean-reversion seule (zscore, fenêtre 5),
 * take-profit hors d'atteinte pour que la sortie vienne du signal.
 */
function configYaml(minDays: number): string {
  return `base_currency: USDC
strategies:
  momentum:
    enabled: false
  mean_reversion:
    enabled: true
    weight: 1
    timeframe: 15m
    params:
      window: 5
      z_entry: 1.5
      z_exit: 0.5
      mode: zscore
  dca_rotation:
    enabled: false
risk:
  take_profit_pct: 100
  min_time_between_trades_s: 0
backtest:
  timeframe: 15m
  initial_usdc: 1000
  default_liquidity_usd: 100000
  guard:
    min_days: ${minDays}
database:
  path: ./data/backtest.sqlite
`;
}

function watchItem(): WatchlistItem {
  return {
    mint: A,
    symbol: 'AAA',
    name: 'AAA',
    rank: 1,
    isBase: false,
    isVerified: true,
    organicScore: null,
    liquidityUsd: 1_000_000,
    usdPrice: 1,
    priceChange24h: 0,
    tags: [],
    updatedAt: NOW,
  };
}

/** 30 bougies à 1.00, chute isolée à 0.80 (z ≈ -2 ≤ -1.5), rebond 0.90 puis 1.00 (sortie signal). */
function closes(): number[] {
  return [...Array<number>(30).fill(1), 0.8, 0.9, 1, ...Array<number>(27).fill(1)];
}

interface Fixture {
  root: string;
  dbPath: string;
  yamlPath: string;
  strictPath: string;
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solbot-bt-'));
  temps.push(root);
  const yamlPath = path.join(root, 'config.yaml');
  fs.writeFileSync(yamlPath, configYaml(0));
  const strictPath = path.join(root, 'config-strict.yaml');
  fs.writeFileSync(strictPath, configYaml(3));

  const dbPath = resolveDatabasePath(root, './data/backtest.sqlite');
  const db = openDatabase(dbPath);
  runMigrations(db);
  replaceWatchlist(db, [watchItem()]);
  upsertImportedCandles(
    db,
    closes().map((close, index) => ({
      mint: A,
      timeframe: '15m',
      bucketStart: BUCKET0 + index * TF_MS,
      open: close,
      high: close,
      low: close,
      close,
      volumeUsd: 1000,
      source: 'test',
    })),
    NOW,
  );
  db.close();
  return { root, dbPath, yamlPath, strictPath };
}

function withDb<T>(dbPath: string, task: (db: ReturnType<typeof openDatabase>) => T): T {
  const db = openDatabase(dbPath);
  try {
    return task(db);
  } finally {
    db.close();
  }
}

const decimalsByMint = new Map<string, number | null>([
  [A, 6],
  [SOL_MINT, 9],
  [USDC_MINT, 6],
]);
const liquidityByMint = new Map<string, number | null>([[A, 1_000_000]]);

describe('runBacktest — bout en bout (moteur réel, bougies synthétiques)', () => {
  it('rejoue, trade, enregistre le run et alimente le garde-fou', async () => {
    const fx = fixture();
    const result = await runBacktest({
      root: fx.root,
      configPath: fx.yamlPath,
      label: 'jeu-A',
      fromTs: BUCKET0,
      toTs: TO_TS,
      days: 2,
      timeframe: '15m',
      mints: [A],
      decimalsByMint,
      liquidityByMint,
      now: NOW,
      store: true,
    });

    expect(result.runId).not.toBeNull();
    expect(result.steps).toBe(BARS);
    expect(result.errors).toBe(0);
    expect(result.candles).toBe(BARS);
    expect(result.mintsWithData).toBe(1);
    expect(result.mintsRequested).toBe(1);
    expect(result.timeframe).toBe('15m');
    expect(result.strategies.map((strategy) => strategy.name)).toEqual(['mean_reversion']);

    expect(result.metrics.trades).toBe(1);
    expect(result.metrics.wins).toBe(1);
    expect(result.metrics.winRatePct).toBeCloseTo(100, 6);
    expect(result.metrics.netPnlUsd > 0).toBe(true);
    expect(result.metrics.feesUsd > 0).toBe(true);
    expect(result.entriesByStrategy).toEqual([{ strategy: 'mean_reversion', count: 1 }]);

    expect(result.equity).toHaveLength(BARS);
    expect(result.equity[0]!.navUsd).toBeCloseTo(1000, 6);
    expect(result.conclusive).toBe(true);

    withDb(fx.dbPath, (db) => {
      const guard = findGuardRun(db, result.paramsHash, 0);
      expect(guard?.id).toBe(result.runId);
      expect(guard?.label).toBe('jeu-A');
      expect(getBacktestEquity(db, result.runId!).length).toBe(BARS);
      const runs = getBacktestRuns(db, 5);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.tradesCount).toBe(1);
    });
  });

  it('un run trop court pour le garde-fou n’autorise pas le live (empreinte identique)', async () => {
    const fx = fixture();
    const common = {
      root: fx.root,
      fromTs: BUCKET0,
      toTs: TO_TS,
      days: 2,
      timeframe: '15m' as const,
      mints: [A],
      decimalsByMint,
      liquidityByMint,
      store: true,
    };
    const first = await runBacktest({
      ...common,
      configPath: fx.yamlPath,
      label: 'jeu-A',
      now: NOW,
    });
    const strict = await runBacktest({
      ...common,
      configPath: fx.strictPath,
      label: 'garde-fou-strict',
      now: NOW + 60_000,
    });

    // Le garde-fou n'entre pas dans l'empreinte : même jeu de stratégies = même hash.
    expect(strict.paramsHash).toBe(first.paramsHash);
    expect(strict.conclusive).toBe(false);
    expect(first.conclusive).toBe(true);

    withDb(fx.dbPath, (db) => {
      expect(findGuardRun(db, strict.paramsHash, 3)).toBeNull();
      expect(findGuardRun(db, strict.paramsHash, 0)?.id).toBe(first.runId);
      const runs = getBacktestRuns(db, 5);
      expect(runs.map((run) => run.label)).toEqual(['garde-fou-strict', 'jeu-A']);
    });
  });

  it('refuse de rejouer sans watchlist', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solbot-bt-vide-'));
    temps.push(root);
    const yamlPath = path.join(root, 'config.yaml');
    fs.writeFileSync(yamlPath, configYaml(0));

    await expect(
      runBacktest({ root, configPath: yamlPath, days: 2, toTs: NOW, store: false }),
    ).rejects.toThrow(/Watchlist vide/);
  });
});

describe('paramsHash — empreinte du garde-fou', () => {
  it('est stable pour un même jeu de paramètres et change avec les paramètres', () => {
    const base = parseConfig({});
    expect(paramsHash(base)).toBe(paramsHash(parseConfig({})));

    const variant = parseConfig({
      strategies: { mean_reversion: { enabled: true, params: { z_entry: 2.5 } } },
    });
    expect(paramsHash(variant)).not.toBe(paramsHash(base));
  });
});
