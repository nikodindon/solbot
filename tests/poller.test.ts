import { describe, expect, it } from 'vitest';
import type { PriceApi, PriceInfo } from '../src/jupiter/price.js';
import { pollOnce } from '../src/market/poller.js';
import { openDatabase } from '../src/state/db.js';
import { countTicks, getCandles } from '../src/state/market-data.js';
import { runMigrations } from '../src/state/migrations.js';

function memoryDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

const INFO: PriceInfo = {
  usdPrice: 42.5,
  liquidity: 1_000_000,
  priceChange24h: 0.25,
  decimals: 9,
  blockId: 123,
  createdAt: new Date().toISOString(),
};

function fakePriceApi(prices: Map<string, PriceInfo>): PriceApi {
  return { getPrices: async () => prices } as unknown as PriceApi;
}

describe('pollOnce', () => {
  it('persiste les ticks et les bougies du cycle', async () => {
    const db = memoryDb();
    const mint = 'M'.repeat(44);

    const summary = await pollOnce({
      db,
      priceApi: fakePriceApi(new Map([[mint, INFO]])),
      mints: [mint, 'inconnu'.padEnd(44, 'x')],
    });

    expect(summary.requested).toBe(2);
    expect(summary.priced).toBe(1);
    expect(summary.ticksInserted).toBe(1);
    expect(summary.candlesUpserted).toBe(4); // 1 tick × 4 timeframes
    expect(countTicks(db, mint)).toBe(1);

    const candle = getCandles(db, mint, '1m')[0];
    expect(candle).toMatchObject({ open: 42.5, close: 42.5, tickCount: 1 });
    db.close();
  });

  it('encaisse un cycle sans aucun prix (mints illiquides)', async () => {
    const db = memoryDb();
    const summary = await pollOnce({
      db,
      priceApi: fakePriceApi(new Map()),
      mints: ['x'.repeat(44)],
    });
    expect(summary.priced).toBe(0);
    expect(summary.ticksInserted).toBe(0);
    expect(summary.candlesUpserted).toBe(0);
    db.close();
  });
});
