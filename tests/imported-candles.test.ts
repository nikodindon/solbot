import { describe, expect, it } from 'vitest';
import type { CandleUpdate } from '../src/market/ohlcv.js';
import { upsertCandles } from '../src/state/market-data.js';
import { openDatabase } from '../src/state/db.js';
import {
  getImportedCandles,
  getImportedCoverage,
  getMergedCandles,
  upsertImportedCandles,
  type ImportedCandleInput,
} from '../src/state/imported-candles.js';
import { runMigrations } from '../src/state/migrations.js';

const A = 'A'.repeat(44);
const B = 'B'.repeat(44);

function memoryDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

function imported(
  mint: string,
  bucketStart: number,
  close: number,
  volumeUsd = 100,
): ImportedCandleInput {
  return {
    mint,
    timeframe: '15m',
    bucketStart,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volumeUsd,
    source: 'geckoterminal',
  };
}

function live(bucketStart: number, close: number, volumeUsd: number): CandleUpdate {
  return {
    mint: A,
    timeframe: '15m',
    bucketStart,
    open: close,
    high: close * 1.02,
    low: close * 0.98,
    close,
    volumeUsd,
  };
}

describe('imported_candles', () => {
  it('insère, met à jour (upsert) et relit les bougies importées', () => {
    const db = memoryDb();
    upsertImportedCandles(db, [imported(A, 1_000, 10), imported(A, 1_900_000, 11)], 42);

    let candles = getImportedCandles(db, A, '15m');
    expect(candles).toHaveLength(2);
    expect(candles[0]).toMatchObject({
      bucketStart: 1_000,
      close: 10,
      tickCount: 0,
      volumeUsd: 100,
    });

    upsertImportedCandles(db, [imported(A, 1_000, 12, 250)]);
    candles = getImportedCandles(db, A, '15m');
    expect(candles).toHaveLength(2);
    expect(candles[0]).toMatchObject({ bucketStart: 1_000, close: 12, volumeUsd: 250 });
    db.close();
  });

  it('refuse une bougie à OHLC non positif (transaction annulée)', () => {
    const db = memoryDb();
    expect(() =>
      upsertImportedCandles(db, [imported(A, 1_000, 10), imported(A, 2_000, 0)]),
    ).toThrow(/invalide/);
    expect(getImportedCandles(db, A, '15m')).toHaveLength(0);
    db.close();
  });

  it('filtre par bornes temporelles et calcule la couverture', () => {
    const db = memoryDb();
    upsertImportedCandles(db, [
      imported(A, 1_000, 10),
      imported(A, 2_000, 11),
      imported(A, 3_000, 12),
      imported(B, 1_000, 5),
    ]);

    expect(getImportedCandles(db, A, '15m', { fromTs: 2_000, toTs: 2_500 })).toHaveLength(1);
    expect(getImportedCoverage(db, '15m')).toEqual([
      { mint: A, count: 3, firstTs: 1_000, lastTs: 3_000 },
      { mint: B, count: 1, firstTs: 1_000, lastTs: 1_000 },
    ]);
    db.close();
  });
});

describe('getMergedCandles', () => {
  it('donne priorité à l’OHLC importé et conserve le volume live quand l’import n’en a pas', () => {
    const db = memoryDb();
    upsertCandles(db, [live(1_000, 11, 5), live(2_000, 12, 7)]);
    upsertImportedCandles(db, [
      imported(A, 1_000, 19, 0), // même bucket : OHLC importé prime, volume live conservé
      imported(A, 3_000, 31, 3), // bucket absent du live : ajouté
    ]);

    const merged = getMergedCandles(db, A, '15m');
    expect(merged.map((candle) => candle.bucketStart)).toEqual([1_000, 2_000, 3_000]);
    expect(merged[0]).toMatchObject({ close: 19, volumeUsd: 5 });
    expect(merged[1]).toMatchObject({ close: 12, volumeUsd: 7 });
    expect(merged[2]).toMatchObject({ close: 31, volumeUsd: 3 });
    db.close();
  });

  it('respecte les bornes temporelles demandées', () => {
    const db = memoryDb();
    upsertImportedCandles(db, [imported(A, 1_000, 10), imported(A, 2_000, 11)]);
    upsertCandles(db, [live(3_000, 12, 1)]);

    const merged = getMergedCandles(db, A, '15m', { fromTs: 2_000, toTs: 3_000 });
    expect(merged.map((candle) => candle.bucketStart)).toEqual([2_000, 3_000]);
    db.close();
  });
});
