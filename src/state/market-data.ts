import type { DatabaseSync } from 'node:sqlite';
import type { CandleUpdate, PriceTick } from '../market/ohlcv.js';

/* ──────────────────────────────────────────────────────────────
 * Ticks de prix
 * ────────────────────────────────────────────────────────────── */

/**
 * Insère les ticks en calculant le **delta de volume 24 h** de chaque mint par
 * rapport au dernier tick stocké (le tick précédent n'est pas dans le lot :
 * un cycle de polling insère un seul point par mint). Retourne les ticks
 * enrichis (`volumeDeltaUsd`) à passer à `ticksToCandleUpdates`.
 */
export function insertTicks(db: DatabaseSync, ticks: PriceTick[]): PriceTick[] {
  if (ticks.length === 0) return [];

  const lastVolume = db.prepare(
    `SELECT volume_24h_usd AS volume FROM price_ticks
     WHERE mint = ? AND volume_24h_usd IS NOT NULL
     ORDER BY ts DESC, id DESC LIMIT 1`,
  );
  const insert = db.prepare(`
    INSERT INTO price_ticks (mint, usd_price, liquidity_usd, price_change_24h, block_id, ts, volume_24h_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const enriched: PriceTick[] = [];
  db.exec('BEGIN');
  try {
    for (const tick of ticks) {
      let delta: number | null = null;
      if (tick.volume24hUsd !== null && tick.volume24hUsd !== undefined) {
        const previous = lastVolume.get(tick.mint) as unknown as { volume: number } | undefined;
        delta = previous === undefined ? null : Math.max(0, tick.volume24hUsd - previous.volume);
      }
      insert.run(
        tick.mint,
        tick.usdPrice,
        tick.liquidityUsd,
        tick.priceChange24h,
        tick.blockId,
        tick.ts,
        tick.volume24hUsd ?? null,
      );
      enriched.push({ ...tick, volumeDeltaUsd: delta });
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return enriched;
}

/** Volume 24 h du dernier tick stocké pour un mint (pour les contextes hors poller). */
export function latestVolume24h(db: DatabaseSync, mint: string): number | null {
  const row = db
    .prepare(
      `SELECT volume_24h_usd AS volume FROM price_ticks
       WHERE mint = ? AND volume_24h_usd IS NOT NULL
       ORDER BY ts DESC, id DESC LIMIT 1`,
    )
    .get(mint) as unknown as { volume: number } | undefined;
  return row?.volume ?? null;
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
  volumeUsd: number;
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
  volume_usd: number;
}

/**
 * Fusionne les mises à jour dans la table `candles`.
 * Sur conflit : le premier tick du bucket fixe l'ouverture, high/low s'élargissent,
 * le close suit le dernier tick traité (les ticks sont fournis dans l'ordre
 * chronologique) et le volume s'accumule.
 */
export function upsertCandles(db: DatabaseSync, updates: CandleUpdate[]): void {
  if (updates.length === 0) return;
  const statement = db.prepare(`
    INSERT INTO candles (mint, timeframe, bucket_start, open, high, low, close, tick_count, volume_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT (mint, timeframe, bucket_start) DO UPDATE SET
      high       = MAX(high, excluded.high),
      low        = MIN(low, excluded.low),
      close      = excluded.close,
      tick_count = tick_count + 1,
      volume_usd = volume_usd + excluded.volume_usd
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
        update.volumeUsd,
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
    volumeUsd: row.volume_usd,
  }));
}

/** Nombre de ticks stockés pour un mint (indicateur de couverture du poller). */
export function countTicks(db: DatabaseSync, mint: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM price_ticks WHERE mint = ?')
    .get(mint) as unknown as { count: number };
  return row.count;
}
