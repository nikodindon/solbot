import type { DatabaseSync } from 'node:sqlite';
import type { CandleUpdate, PriceTick } from '../market/ohlcv.js';

/* ──────────────────────────────────────────────────────────────
 * Ticks de prix
 * ────────────────────────────────────────────────────────────── */

export function insertTicks(db: DatabaseSync, ticks: PriceTick[]): void {
  if (ticks.length === 0) return;
  const insert = db.prepare(`
    INSERT INTO price_ticks (mint, usd_price, liquidity_usd, price_change_24h, block_id, ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    for (const tick of ticks) {
      insert.run(
        tick.mint,
        tick.usdPrice,
        tick.liquidityUsd,
        tick.priceChange24h,
        tick.blockId,
        tick.ts,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/* ──────────────────────────────────────────────────────────────
 * Bougies OHLCV
 * ────────────────────────────────────────────────────────────── */

export interface Candle {
  mint: string;
  timeframe: string;
  bucketStart: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickCount: number;
}

interface CandleRow {
  mint: string;
  timeframe: string;
  bucket_start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tick_count: number;
}

/**
 * Fusionne les mises à jour dans la table `candles`.
 * Sur conflit : le premier tick du bucket fixe l'ouverture, high/low s'élargissent,
 * le close suit le dernier tick traité (les ticks sont fournis dans l'ordre chronologique).
 */
export function upsertCandles(db: DatabaseSync, updates: CandleUpdate[]): void {
  if (updates.length === 0) return;
  const statement = db.prepare(`
    INSERT INTO candles (mint, timeframe, bucket_start, open, high, low, close, tick_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT (mint, timeframe, bucket_start) DO UPDATE SET
      high       = MAX(high, excluded.high),
      low        = MIN(low, excluded.low),
      close      = excluded.close,
      tick_count = tick_count + 1
  `);
  db.exec('BEGIN');
  try {
    for (const update of updates) {
      statement.run(
        update.mint,
        update.timeframe,
        update.bucketStart,
        update.open,
        update.high,
        update.low,
        update.close,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Dernières `limit` bougies, de la plus ancienne à la plus récente. */
export function getCandles(
  db: DatabaseSync,
  mint: string,
  timeframe: string,
  limit = 100,
): Candle[] {
  const rows = db
    .prepare(
      `SELECT * FROM candles
       WHERE mint = ? AND timeframe = ?
       ORDER BY bucket_start DESC
       LIMIT ?`,
    )
    .all(mint, timeframe, limit) as unknown as CandleRow[];
  return rows.reverse().map((row) => ({
    mint: row.mint,
    timeframe: row.timeframe,
    bucketStart: row.bucket_start,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    tickCount: row.tick_count,
  }));
}

/** Nombre de ticks stockés pour un mint (indicateur de couverture du poller). */
export function countTicks(db: DatabaseSync, mint: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM price_ticks WHERE mint = ?')
    .get(mint) as unknown as { count: number };
  return row.count;
}
