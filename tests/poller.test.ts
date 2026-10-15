import { describe, expect, it } from 'vitest';
import type { PriceApi, PriceInfo } from '../src/jupiter/price.js';
import type { TokenInfo, TokensApi } from '../src/jupiter/tokens.js';
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

function fakeTokensApi(volumes: Map<string, number>): TokensApi {
  return {
    search: async (query: string) =>
      query
        .split(',')
        .filter((mint) => volumes.has(mint))
        .map(
          (mint) =>
            ({
              id: mint,
              stats24h: { buyVolume: volumes.get(mint)!, sellVolume: 0 },
            }) as unknown as TokenInfo,
        ),
  } as unknown as TokensApi;
}

describe('pollOnce', () => {
  it('persiste les ticks et les bougies du cycle', async () => {
    const db = memoryDb();
    const mint = 'M'.repeat(44);

    const summary = await pollOnce({
      db,
      priceApi: fakePriceApi(new Map([[mint, INFO]])),
      tokensApi: fakeTokensApi(new Map()),
      mints: [mint, 'inconnu'.padEnd(44, 'x')],
    });

    expect(summary.requested).toBe(2);
    expect(summary.priced).toBe(1);
    expect(summary.ticksInserted).toBe(1);
    expect(summary.candlesUpserted).toBe(4); // 1 tick × 4 timeframes
    expect(countTicks(db, mint)).toBe(1);
    expect(summary.prices.get(mint)?.usdPrice).toBe(42.5);

    const candle = getCandles(db, mint, '1m')[0];
    expect(candle).toMatchObject({ open: 42.5, close: 42.5, tickCount: 1 });
    db.close();
  });

  it('accumule le volume 24 h par delta dans les bougies', async () => {
    const db = memoryDb();
    const mint = 'V'.repeat(44);

    // 1er cycle : le delta est inconnu (pas de tick précédent) → volume 0.
    await pollOnce({
      db,
      priceApi: fakePriceApi(new Map([[mint, INFO]])),
      tokensApi: fakeTokensApi(new Map([[mint, 5_000]])),
      mints: [mint],
    });
    const first = getCandles(db, mint, '1m')[0];
    expect(first?.volumeUsd).toBe(0);

    // 2e cycle : 24 h de volume passent de 5 000 à 6 500 → delta 1 500.
    const summary = await pollOnce({
      db,
      priceApi: fakePriceApi(new Map([[mint, INFO]])),
      tokensApi: fakeTokensApi(new Map([[mint, 6_500]])),
      mints: [mint],
    });
    expect(summary.volumeCovered).toBe(1);
    const second = getCandles(db, mint, '1m')[0];
    expect(second?.volumeUsd).toBe(1_500);
    expect(second?.tickCount).toBe(2);
    db.close();
  });

  it('encaisse un cycle sans aucun prix (mints illiquides)', async () => {
    const db = memoryDb();
    const summary = await pollOnce({
      db,
      priceApi: fakePriceApi(new Map()),
      tokensApi: fakeTokensApi(new Map()),
      mints: ['x'.repeat(44)],
    });
    expect(summary.priced).toBe(0);
    expect(summary.ticksInserted).toBe(0);
    expect(summary.candlesUpserted).toBe(0);
    db.close();
  });
});
