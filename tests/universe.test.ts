import { describe, expect, it } from 'vitest';
import { SOL_MINT, USDC_MINT } from '../src/constants.js';
import type { TokenInfo, TokensApi } from '../src/jupiter/tokens.js';
import { filterUniverse, resolveUniverse } from '../src/universe/builder.js';
import { parseConfig } from '../src/utils/config.js';

/** Mint factice de 44 caractères, unique par label. */
const mint = (label: string): string => `mint${label}`.padEnd(44, 'x');

const HOUR_MS = 3_600_000;

function token(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    id: mint(overrides.symbol ?? 'TOK'),
    name: 'Token de test',
    symbol: 'TOK',
    isVerified: true,
    organicScore: 80,
    liquidity: 1_000_000,
    usdPrice: 1.23,
    stats24h: { priceChange: 1.5 },
    tags: [],
    firstPool: { createdAt: new Date(Date.now() - 48 * HOUR_MS).toISOString() },
    ...overrides,
  } as TokenInfo;
}

describe('filterUniverse', () => {
  it('exclut par blacklist, vérification, liquidité, organic score et âge', () => {
    const now = Date.now();
    const black = token({ symbol: 'BLK' });
    const config = parseConfig({
      universe: {
        blacklist_mints: [black.id],
        min_liquidity_usd: 500_000,
        min_organic_score: 50,
        min_age_hours: 24,
        max_watchlist: 10,
      },
    });

    const tokens = [
      token({ symbol: 'OK1' }),
      black,
      token({ symbol: 'UNV', isVerified: false }),
      token({ symbol: 'LIQ', liquidity: 10_000 }),
      token({ symbol: 'ORG', organicScore: 10 }),
      token({
        symbol: 'YNG',
        firstPool: { createdAt: new Date(now - HOUR_MS).toISOString() },
      }),
      token({ symbol: 'NOAGE', firstPool: undefined }),
    ];

    const { selected, exclusions } = filterUniverse(tokens, config, now);

    expect(selected.map((item) => item.symbol).sort()).toEqual(['NOAGE', 'OK1']);
    expect(exclusions).toMatchObject({
      blacklist: 1,
      unverified: 1,
      liquidity: 1,
      organicScore: 1,
      age: 1,
      duplicates: 0,
      whitelist: 0,
    });
  });

  it('restreint l’univers à la whitelist quand elle est renseignée', () => {
    const keep = token({ symbol: 'KEEP' });
    const config = parseConfig({ universe: { whitelist_mints: [keep.id] } });
    const { selected, exclusions } = filterUniverse([keep, token({ symbol: 'DROP' })], config);
    expect(selected.map((item) => item.id)).toEqual([keep.id]);
    expect(exclusions.whitelist).toBe(1);
  });

  it('dédoublonne et tronque à max_watchlist avec un tri déterministe', () => {
    const config = parseConfig({ universe: { max_watchlist: 2 } });
    const tokens = [
      token({ symbol: 'AAA', organicScore: 70, liquidity: 900_000 }),
      token({ symbol: 'BBB', organicScore: 90, liquidity: 500_000 }),
      token({ symbol: 'CCC', organicScore: 90, liquidity: 800_000 }),
      token({ symbol: 'BBB' }), // doublon d'id
    ];

    const { selected, exclusions } = filterUniverse(tokens, config);

    // organic ↓, puis liquidité ↓ : CCC (90/800k) > BBB (90/500k)
    expect(selected.map((item) => item.symbol)).toEqual(['CCC', 'BBB']);
    expect(exclusions.duplicates).toBe(1);
  });
});

describe('resolveUniverse', () => {
  it('ajoute SOL et USDC en tête de watchlist en mode catégorie', async () => {
    const sol = token({ id: SOL_MINT, symbol: 'SOL', organicScore: null });
    const usdc = token({ id: USDC_MINT, symbol: 'USDC', organicScore: null });
    const candidate = token({ symbol: 'CND' });

    const fakeTokensApi = {
      byCategory: async () => [candidate],
      search: async () => [sol, usdc],
    } as unknown as TokensApi;

    const result = await resolveUniverse(fakeTokensApi, parseConfig({}));

    expect(result.source).toBe('category');
    expect(result.candidates).toBe(1);
    expect(result.watchlist.map((item) => item.id)).toEqual([SOL_MINT, USDC_MINT, candidate.id]);
  });

  it('ne complète pas avec les actifs de base en mode whitelist', async () => {
    const kept = token({ symbol: 'WL' });
    const fakeTokensApi = {
      search: async () => [kept],
    } as unknown as TokensApi;

    const config = parseConfig({ universe: { whitelist_mints: [kept.id] } });
    const result = await resolveUniverse(fakeTokensApi, config);

    expect(result.source).toBe('whitelist');
    expect(result.watchlist.map((item) => item.id)).toEqual([kept.id]);
  });
});
