import { z } from 'zod';
import type { JupiterClient } from './client.js';

const StatsSchema = z
  .object({
    priceChange: z.number().optional(),
    buyVolume: z.number().optional(),
    sellVolume: z.number().optional(),
    numBuys: z.number().optional(),
    numSells: z.number().optional(),
    numTraders: z.number().optional(),
  })
  .passthrough();

const FirstPoolSchema = z
  .object({
    id: z.string().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

const AuditSchema = z
  .object({
    mintAuthorityDisabled: z.boolean().optional(),
    freezeAuthorityDisabled: z.boolean().optional(),
    topHoldersPercentage: z.number().optional(),
  })
  .passthrough();

/**
 * Informations token (Tokens API v2). Schéma volontairement tolérant
 * (`passthrough` + champs optionnels) : Jupiter fait évoluer la réponse sans préavis.
 */
export const TokenInfoSchema = z
  .object({
    id: z.string(),
    name: z.string().default(''),
    symbol: z.string().default(''),
    decimals: z.number().int().optional(),
    isVerified: z.boolean().optional(),
    organicScore: z.number().nullable().optional(),
    organicScoreLabel: z.string().optional(),
    usdPrice: z.number().nullable().optional(),
    liquidity: z.number().nullable().optional(),
    mcap: z.number().nullable().optional(),
    fdv: z.number().nullable().optional(),
    holderCount: z.number().nullable().optional(),
    tags: z.array(z.string()).optional(),
    firstPool: FirstPoolSchema.optional(),
    audit: AuditSchema.optional(),
    stats5m: StatsSchema.optional(),
    stats1h: StatsSchema.optional(),
    stats6h: StatsSchema.optional(),
    stats24h: StatsSchema.optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export type TokenInfo = z.infer<typeof TokenInfoSchema>;

const TokenListSchema = z.array(TokenInfoSchema);

export const TOKEN_CATEGORIES = ['toporganicscore', 'toptraded', 'toptrending'] as const;
export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

export const CATEGORY_INTERVALS = ['5m', '1h', '6h', '24h'] as const;
export type CategoryInterval = (typeof CATEGORY_INTERVALS)[number];

export const TOKEN_TAGS = ['lst', 'verified', 'stocks'] as const;
export type TokenTag = (typeof TOKEN_TAGS)[number];

/** API Tokens v2 : recherche, tags, catégories, tokens récents. */
export class TokensApi {
  constructor(private readonly client: JupiterClient) {}

  /** Recherche par symbole, nom ou mint. Un lot de mints (≤ 100) séparés par des virgules est accepté. */
  search(query: string): Promise<TokenInfo[]> {
    return this.client.getJson('/tokens/v2/search', TokenListSchema, { query });
  }

  /** Tokens par tag : `lst`, `verified`, `stocks`. */
  byTag(tag: TokenTag): Promise<TokenInfo[]> {
    return this.client.getJson('/tokens/v2/tag', TokenListSchema, { query: tag });
  }

  /** Classement par catégorie (`toporganicscore` | `toptraded` | `toptrending`) sur un intervalle (5m–24h). */
  byCategory(
    category: TokenCategory,
    interval: CategoryInterval,
    limit = 100,
  ): Promise<TokenInfo[]> {
    return this.client.getJson(`/tokens/v2/${category}/${interval}`, TokenListSchema, { limit });
  }

  /** Tokens dont le premier pool vient d'être créé (30 par défaut). */
  recent(): Promise<TokenInfo[]> {
    return this.client.getJson('/tokens/v2/recent', TokenListSchema);
  }
}
