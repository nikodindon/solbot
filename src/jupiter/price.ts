import { z } from 'zod';
import { chunk } from '../utils/arrays.js';
import type { JupiterClient } from './client.js';

/** Limite Jupiter : 50 mints maximum par requête Price v3. */
export const PRICE_BATCH_SIZE = 50;

export const PriceInfoSchema = z
  .object({
    usdPrice: z.number(),
    liquidity: z.number(),
    priceChange24h: z.number().nullable().optional(),
    decimals: z.number().int().optional(),
    blockId: z.number().nullable().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

export type PriceInfo = z.infer<typeof PriceInfoSchema>;

const PriceResponseSchema = z.record(z.string(), PriceInfoSchema);

/**
 * API Price v3 : prix USD par mint (lot ≤ 50), avec cache TTL court.
 * Les mints sans prix fiable sont absents de la réponse.
 */
export class PriceApi {
  private readonly cache = new Map<string, { info: PriceInfo; fetchedAt: number }>();

  constructor(
    private readonly client: JupiterClient,
    private readonly cacheTtlMs = 10_000,
  ) {}

  /** Prix USD pour les mints demandés. Mints inconnus/invalides omis du résultat. */
  async getPrices(
    mints: string[],
    options: { useCache?: boolean } = {},
  ): Promise<Map<string, PriceInfo>> {
    const useCache = options.useCache !== false;
    const now = Date.now();
    const result = new Map<string, PriceInfo>();
    const missing: string[] = [];

    for (const mint of new Set(mints)) {
      const cached = this.cache.get(mint);
      if (useCache && cached !== undefined && now - cached.fetchedAt < this.cacheTtlMs) {
        result.set(mint, cached.info);
      } else {
        missing.push(mint);
      }
    }

    for (const batch of chunk(missing, PRICE_BATCH_SIZE)) {
      const response = await this.client.getJson('/price/v3', PriceResponseSchema, {
        ids: batch.join(','),
      });
      const fetchedAt = Date.now();
      for (const [mint, info] of Object.entries(response)) {
        result.set(mint, info);
        this.cache.set(mint, { info, fetchedAt });
      }
    }

    return result;
  }
}
