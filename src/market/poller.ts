import type { DatabaseSync } from 'node:sqlite';
import type { PriceApi } from '../jupiter/price.js';
import type { TokensApi } from '../jupiter/tokens.js';
import { insertTicks, upsertCandles } from '../state/market-data.js';
import { ticksToCandleUpdates, type PriceTick } from './ohlcv.js';

export interface PolledPrice {
  usdPrice: number;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  /** Décimales du token (Price v3) — `null` si Jupiter ne les fournit pas. */
  decimals: number | null;
}

export interface PollSummary {
  ts: number;
  /** Mints demandés. */
  requested: number;
  /** Mints avec un prix retourné (les illiquides peuvent manquer). */
  priced: number;
  /** Mints avec un volume 24 h connu (Tokens v2). */
  volumeCovered: number;
  ticksInserted: number;
  candlesUpserted: number;
  durationMs: number;
  /** Dernier prix connu par mint — consommé par le moteur (évaluation + marks). */
  prices: Map<string, PolledPrice>;
}

/** Lot de mints pour l'endpoint Tokens v2 (limite Jupiter : 100 par requête). */
const TOKENS_BATCH = 100;

/**
 * Un cycle de polling : prix (sans cache) + volumes 24 h (Tokens v2) → ticks
 * persistés → fusion dans les bougies. Les ticks portent liquidité, variation
 * 24 h et volume ; le delta de volume est calculé au moment de l'insertion.
 */
export async function pollOnce(options: {
  db: DatabaseSync;
  priceApi: PriceApi;
  tokensApi: TokensApi;
  mints: string[];
}): Promise<PollSummary> {
  const startedAt = Date.now();
  const [prices, volumes] = await Promise.all([
    options.priceApi.getPrices(options.mints, { useCache: false }),
    fetchVolumes(options.tokensApi, options.mints),
  ]);

  const ticks: PriceTick[] = [];
  const summaryPrices = new Map<string, PolledPrice>();
  for (const [mint, info] of prices) {
    const volume24hUsd = volumes.get(mint) ?? null;
    ticks.push({
      mint,
      usdPrice: info.usdPrice,
      liquidityUsd: info.liquidity ?? null,
      priceChange24h: info.priceChange24h ?? null,
      blockId: info.blockId ?? null,
      ts: startedAt,
      volume24hUsd,
    });
    summaryPrices.set(mint, {
      usdPrice: info.usdPrice,
      liquidityUsd: info.liquidity ?? null,
      volume24hUsd,
      decimals: info.decimals ?? null,
    });
  }

  const enriched = insertTicks(options.db, ticks);
  const updates = ticksToCandleUpdates(enriched);
  upsertCandles(options.db, updates);

  return {
    ts: startedAt,
    requested: options.mints.length,
    priced: prices.size,
    volumeCovered: ticks.filter((tick) => tick.volume24hUsd !== null).length,
    ticksInserted: ticks.length,
    candlesUpserted: updates.length,
    durationMs: Date.now() - startedAt,
    prices: summaryPrices,
  };
}

/** Volume 24 h (USD) par mint via Tokens v2 — best effort (une erreur ne casse pas le cycle). */
async function fetchVolumes(tokensApi: TokensApi, mints: string[]): Promise<Map<string, number>> {
  const volumes = new Map<string, number>();
  if (mints.length === 0) return volumes;

  const unique = [...new Set(mints)];
  for (let offset = 0; offset < unique.length; offset += TOKENS_BATCH) {
    const batch = unique.slice(offset, offset + TOKENS_BATCH);
    try {
      const tokens = await tokensApi.search(batch.join(','));
      for (const token of tokens) {
        const stats = token.stats24h;
        if (stats === undefined) continue;
        const total = (stats.buyVolume ?? 0) + (stats.sellVolume ?? 0);
        if (total > 0) volumes.set(token.id, total);
      }
    } catch {
      // Le volume est un bonus : on continue avec les prix seuls.
    }
  }
  return volumes;
}
