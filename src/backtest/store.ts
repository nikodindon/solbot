import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { strategySetDescriptor, type StrategyDescriptor } from '../strategy/registry.js';
import type { Config } from '../utils/config.js';
import type { PerformanceMetrics } from './metrics.js';

/**
 * Empreinte des paramètres d'un jeu de stratégies : un backtest ne vaut que
 * pour exactement cette configuration (garde-fou live, DoD Phase 4).
 */
export function paramsHash(config: Config): string {
  const payload = { base: config.base_currency, strategies: strategySetDescriptor(config) };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export interface BacktestRunInput {
  label: string | null;
  configPath: string | null;
  paramsHash: string;
  strategies: StrategyDescriptor[];
  timeframe: string;
  fromTs: number;
  toTs: number;
  days: number;
  initialUsdc: number;
  mintsCount: number;
  candlesCount: number;
  tradesCount: number;
  conclusive: boolean;
  metrics: PerformanceMetrics;
  rejections: Array<{ rule: string; count: number }>;
}

export interface BacktestRunRow extends BacktestRunInput {
  id: number;
  createdAt: number;
}

export interface BacktestEquityPoint {
  ts: number;
  navUsd: number;
  cashUsd: number;
  positionsValueUsd: number;
}

interface RunDbRow {
  id: number;
  created_at: number;
  label: string | null;
  config_path: string | null;
  params_hash: string;
  strategies: string;
  timeframe: string;
  from_ts: number;
  to_ts: number;
  days: number;
  initial_usdc: number;
  mints_count: number;
  candles_count: number;
  trades_count: number;
  conclusive: number;
  metrics: string;
  rejections: string | null;
}

function toDomain(row: RunDbRow): BacktestRunRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    label: row.label,
    configPath: row.config_path,
    paramsHash: row.params_hash,
    strategies: JSON.parse(row.strategies) as StrategyDescriptor[],
    timeframe: row.timeframe,
    fromTs: row.from_ts,
    toTs: row.to_ts,
    days: row.days,
    initialUsdc: row.initial_usdc,
    mintsCount: row.mints_count,
    candlesCount: row.candles_count,
    tradesCount: row.trades_count,
    conclusive: row.conclusive === 1,
    metrics: JSON.parse(row.metrics) as PerformanceMetrics,
    rejections:
      row.rejections === null
        ? []
        : (JSON.parse(row.rejections) as Array<{ rule: string; count: number }>),
  };
}

/** Enregistre un run de backtest (métriques + courbe d'equity). Retourne son id. */
export function insertBacktestRun(
  db: DatabaseSync,
  run: BacktestRunInput,
  equity: BacktestEquityPoint[],
  now = Date.now(),
): number {
  const result = db
    .prepare(
      `INSERT INTO backtest_runs
        (created_at, label, config_path, params_hash, strategies, timeframe, from_ts, to_ts,
         days, initial_usdc, mints_count, candles_count, trades_count, conclusive, metrics, rejections)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      now,
      run.label,
      run.configPath,
      run.paramsHash,
      JSON.stringify(run.strategies),
      run.timeframe,
      run.fromTs,
      run.toTs,
      run.days,
      run.initialUsdc,
      run.mintsCount,
      run.candlesCount,
      run.tradesCount,
      run.conclusive ? 1 : 0,
      JSON.stringify(run.metrics),
      JSON.stringify(run.rejections),
    ) as unknown as { lastInsertRowid: number | bigint };
  const runId = Number(result.lastInsertRowid);

  if (equity.length > 0) {
    const statement = db.prepare(
      `INSERT INTO backtest_equity (run_id, ts, nav_usd, cash_usd, positions_value_usd)
       VALUES (?, ?, ?, ?, ?)`,
    );
    db.exec('BEGIN');
    try {
      for (const point of equity) {
        statement.run(runId, point.ts, point.navUsd, point.cashUsd, point.positionsValueUsd);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return runId;
}

/** Derniers runs de backtest (du plus récent au plus ancien). */
export function getBacktestRuns(db: DatabaseSync, limit = 10): BacktestRunRow[] {
  const rows = db
    .prepare('SELECT * FROM backtest_runs ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit) as unknown as RunDbRow[];
  return rows.map(toDomain);
}

export function getBacktestRun(db: DatabaseSync, id: number): BacktestRunRow | null {
  const row = db.prepare('SELECT * FROM backtest_runs WHERE id = ?').get(id) as unknown as
    RunDbRow | undefined;
  return row === undefined ? null : toDomain(row);
}

/** Courbe d'equity d'un run (croissante). */
export function getBacktestEquity(db: DatabaseSync, runId: number): BacktestEquityPoint[] {
  const rows = db
    .prepare(
      'SELECT ts, nav_usd, cash_usd, positions_value_usd FROM backtest_equity WHERE run_id = ? ORDER BY ts',
    )
    .all(runId) as unknown as Array<{
    ts: number;
    nav_usd: number;
    cash_usd: number;
    positions_value_usd: number;
  }>;
  return rows.map((row) => ({
    ts: row.ts,
    navUsd: row.nav_usd,
    cashUsd: row.cash_usd,
    positionsValueUsd: row.positions_value_usd,
  }));
}

/**
 * Garde-fou live (DoD Phase 4) : dernier run **concluant** couvrant au moins
 * `minDays` jours pour exactement cette empreinte de paramètres.
 */
export function findGuardRun(
  db: DatabaseSync,
  hash: string,
  minDays: number,
): BacktestRunRow | null {
  const row = db
    .prepare(
      `SELECT * FROM backtest_runs
       WHERE params_hash = ? AND conclusive = 1 AND days >= ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(hash, minDays) as unknown as RunDbRow | undefined;
  return row === undefined ? null : toDomain(row);
}
