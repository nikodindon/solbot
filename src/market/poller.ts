import type { DatabaseSync } from 'node:sqlite';
import type { PriceApi } from '../jupiter/price.js';
import { insertTicks, upsertCandles } from '../state/market-data.js';
import { ticksToCandleUpdates, type PriceTick } from './ohlcv.js';

export interface PollSummary {
  ts: number;
  /** Mints demandés. */
  requested: number;
  /** Mints avec un prix retourné (les illiquides peuvent manquer). */
  priced: number;
  ticksInserted: number;
  candlesUpserted: number;
  durationMs: number;
}

/**
 * Un cycle de polling : prix (sans cache) → ticks persistés → fusion dans les bougies.
 * Les informations secondaires (liquidité, variation 24 h) sont conservées sur le tick.
 */
export async function pollOnce(options: {
  db: DatabaseSync;
  priceApi: PriceApi;
  mints: string[];
}): Promise<PollSummary> {
  const startedAt = Date.now();
  const prices = await options.priceApi.getPrices(options.mints, { useCache: false });

  const ticks: PriceTick[] = [];
  for (const [mint, info] of prices) {
    ticks.push({
      mint,
      usdPrice: info.usdPrice,
      liquidityUsd: info.liquidity ?? null,
      priceChange24h: info.priceChange24h ?? null,
      blockId: info.blockId ?? null,
      ts: startedAt,
    });
  }

  insertTicks(options.db, ticks);
  const updates = ticksToCandleUpdates(ticks);
  upsertCandles(options.db, updates);

  return {
    ts: startedAt,
    requested: options.mints.length,
    priced: prices.size,
    ticksInserted: ticks.length,
    candlesUpserted: updates.length,
    durationMs: Date.now() - startedAt,
  };
}
