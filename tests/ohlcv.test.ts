import { describe, expect, it } from 'vitest';
import {
  TIMEFRAMES,
  TIMEFRAME_KEYS,
  bucketStart,
  ticksToCandleUpdates,
} from '../src/market/ohlcv.js';

describe('bucketStart', () => {
  it('aligne sur le début du bucket', () => {
    expect(bucketStart(60_000, TIMEFRAMES['1m'])).toBe(60_000);
    expect(bucketStart(119_999, TIMEFRAMES['1m'])).toBe(60_000);
    expect(bucketStart(120_000, TIMEFRAMES['1m'])).toBe(120_000);
  });

  it('gère tous les timeframes', () => {
    const ts = 1_700_000_123_456;
    for (const timeframe of TIMEFRAME_KEYS) {
      const start = bucketStart(ts, TIMEFRAMES[timeframe]);
      expect(start % TIMEFRAMES[timeframe]).toBe(0);
      expect(start).toBeLessThanOrEqual(ts);
      expect(ts - start).toBeLessThan(TIMEFRAMES[timeframe]);
    }
  });
});

describe('ticksToCandleUpdates', () => {
  it('produit une mise à jour par tick et par timeframe', () => {
    const tick = {
      mint: 'M',
      usdPrice: 2.5,
      liquidityUsd: null,
      priceChange24h: null,
      blockId: null,
      ts: 1_000_000,
    };
    const updates = ticksToCandleUpdates([tick]);

    expect(updates).toHaveLength(TIMEFRAME_KEYS.length);
    expect(updates.map((update) => update.timeframe)).toEqual(['1m', '5m', '15m', '1h']);
    for (const update of updates) {
      expect(update).toMatchObject({ mint: 'M', open: 2.5, high: 2.5, low: 2.5, close: 2.5 });
      expect(update.bucketStart).toBe(bucketStart(tick.ts, TIMEFRAMES[update.timeframe]));
    }
  });

  it('ne produit rien pour une liste vide', () => {
    expect(ticksToCandleUpdates([])).toEqual([]);
  });
});
