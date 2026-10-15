import type { DatabaseSync } from 'node:sqlite';
import { SolbotError } from '../utils/errors.js';
import type { Candle } from './market-data.js';

export interface ImportedCandleInput {
  mint: string;
  timeframe: string;
  bucketStart: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
  source: string;
}

function toCandle(row: {
  mint: string;
  timeframe: string;
  bucket_start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume_usd: number;
}): Candle {
  return {
    mint: row.mint,
    timeframe: row.timeframe,
    bucketStart: row.bucket_start,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    tickCount: 0,
    volumeUsd: row.volume_usd,
  };
}

/** Insère ou met à jour des bougies importées. Retourne le nombre de lignes traitées. */
export function upsertImportedCandles(
  db: DatabaseSync,
  candles: ImportedCandleInput[],
  now = Date.now(),
): number {
  if (candles.length === 0) return 0;
  const statement = db.prepare(`
    INSERT INTO imported_candles
      (mint, timeframe, bucket_start, open, high, low, close, volume_usd, source, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (mint, timeframe, bucket_start) DO UPDATE SET
      open        = excluded.open,
      high        = excluded.high,
      low         = excluded.low,
      close       = excluded.close,
      volume_usd  = excluded.volume_usd,
      source      = excluded.source,
      imported_at = excluded.imported_at
  `);
  db.exec('BEGIN');
  try {
    for (const candle of candles) {
      if (!(candle.open > 0) || !(candle.high > 0) || !(candle.low > 0) || !(candle.close > 0)) {
        throw new SolbotError(
          `Bougie importée invalide pour ${candle.mint} à ${candle.bucketStart} (OHLC non positif)`,
        );
      }
      statement.run(
        candle.mint,
        candle.timeframe,
        candle.bucketStart,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        Math.max(0, candle.volumeUsd),
        candle.source,
        now,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return candles.length;
}

/** Bougies importées d'un mint (croissantes), bornes temporelles optionnelles. */
export function getImportedCandles(
  db: DatabaseSync,
  mint: string,
  timeframe: string,
  range: { fromTs?: number; toTs?: number } = {},
): Candle[] {
  const where = ['mint = ?', 'timeframe = ?'];
  const params: Array<string | number> = [mint, timeframe];
  if (range.fromTs !== undefined) {
    where.push('bucket_start >= ?');
    params.push(range.fromTs);
  }
  if (range.toTs !== undefined) {
    where.push('bucket_start <= ?');
    params.push(range.toTs);
  }
  const rows = db
    .prepare(
      `SELECT * FROM imported_candles WHERE ${where.join(' AND ')} ORDER BY bucket_start LIMIT 100000`,
    )
    .all(...params) as unknown as Array<Parameters<typeof toCandle>[0]>;
  return rows.map(toCandle);
}

/** Couverture d'import par mint (diagnostic CLI). */
export function getImportedCoverage(
  db: DatabaseSync,
  timeframe: string,
): Array<{ mint: string; count: number; firstTs: number; lastTs: number }> {
  const rows = db
    .prepare(
      `SELECT mint, COUNT(*) AS count, MIN(bucket_start) AS firstTs, MAX(bucket_start) AS lastTs
       FROM imported_candles WHERE timeframe = ? GROUP BY mint ORDER BY count DESC`,
    )
    .all(timeframe) as unknown as Array<{
    mint: string;
    count: number;
    firstTs: number;
    lastTs: number;
  }>;
  return rows;
}

/**
 * Fusionne bougies importées et bougies live pour un backtest :
 * l'OHLC importé prime quand il existe (plus fidèle), le volume live est
 * conservé quand l'import n'en fournit pas (proxy de volume du poller).
 */
export function getMergedCandles(
  db: DatabaseSync,
  mint: string,
  timeframe: string,
  range: { fromTs?: number; toTs?: number } = {},
): Candle[] {
  const imported = getImportedCandles(db, mint, timeframe, range);
  const live = db
    .prepare(
      `SELECT * FROM candles
       WHERE mint = ? AND timeframe = ?
         ${range.fromTs === undefined ? '' : 'AND bucket_start >= ?'}
         ${range.toTs === undefined ? '' : 'AND bucket_start <= ?'}
       ORDER BY bucket_start`,
    )
    .all(
      ...[
        mint,
        timeframe,
        ...(range.fromTs === undefined ? [] : [range.fromTs]),
        ...(range.toTs === undefined ? [] : [range.toTs]),
      ],
    ) as unknown as Array<{
    mint: string;
    timeframe: string;
    bucket_start: number;
    open: number;
    high: number;
    low: number;
    close: number;
    tick_count: number;
    volume_usd: number;
  }>;

  const merged = new Map<number, Candle>();
  for (const row of live) {
    merged.set(row.bucket_start, {
      mint: row.mint,
      timeframe: row.timeframe,
      bucketStart: row.bucket_start,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      tickCount: row.tick_count,
      volumeUsd: row.volume_usd,
    });
  }
  for (const candle of imported) {
    const existing = merged.get(candle.bucketStart);
    merged.set(candle.bucketStart, {
      ...candle,
      volumeUsd: candle.volumeUsd > 0 ? candle.volumeUsd : (existing?.volumeUsd ?? 0),
    });
  }
  return [...merged.values()].sort((a, b) => a.bucketStart - b.bucketStart);
}
