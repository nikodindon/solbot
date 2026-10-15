import { describe, expect, it } from 'vitest';
import { SOL_MINT, USDC_MINT } from '../src/constants.js';
import {
  DcaRotationStrategy,
  parseDcaRotationParams,
  type DcaRotationParams,
} from '../src/strategy/dca-rotation.js';
import type { AssetSnapshot, MarketSnapshot, PortfolioContext } from '../src/strategy/types.js';

const WATCH = 'W'.repeat(44);
const UNKNOWN = 'U'.repeat(44);

function params(overrides: Partial<DcaRotationParams> = {}): DcaRotationParams {
  return {
    targets: [
      { key: 'SOL', mint: SOL_MINT, symbol: 'SOL', weight: 0.4 },
      { key: 'USDC', mint: USDC_MINT, symbol: 'USDC', weight: 0.6 },
    ],
    driftTriggerPct: 5,
    topupUsdc: 25,
    baseMint: USDC_MINT,
    baseSymbol: 'USDC',
    ...overrides,
  };
}

function portfolio(overrides: Partial<PortfolioContext> = {}): PortfolioContext {
  return {
    navUsd: 1000,
    cashUsd: 1000,
    valueByMint: new Map(),
    positionsByMint: new Map(),
    ...overrides,
  };
}

function market(
  assets: Array<{ mint: string; symbol: string }>,
  portfolioContext: PortfolioContext | undefined,
): MarketSnapshot {
  const snapshots: AssetSnapshot[] = assets.map((asset) => ({
    mint: asset.mint,
    symbol: asset.symbol,
    priceUsd: 1,
    liquidityUsd: 1_000_000,
    candles: {},
  }));
  return {
    ts: 1_750_000_000_000,
    assets: snapshots,
    ...(portfolioContext === undefined ? {} : { portfolio: portfolioContext }),
  };
}

describe('dca_rotation — paramètres', () => {
  it('applique les défauts (40 % SOL / 60 % caisse USDC)', () => {
    const parsed = parseDcaRotationParams({}, 'USDC');
    expect(parsed.driftTriggerPct).toBe(5);
    expect(parsed.topupUsdc).toBe(25);
    expect(parsed.baseMint).toBe(USDC_MINT);
    expect(parsed.targets).toEqual([
      { key: 'SOL', mint: SOL_MINT, symbol: 'SOL', weight: 0.4 },
      { key: 'USDC', mint: USDC_MINT, symbol: 'USDC', weight: 0.6 },
    ]);
  });

  it('refuse une somme de poids > 1, une clé inconnue, un doublon ou un drift invalide', () => {
    expect(() => parseDcaRotationParams({ target_alloc: { SOL: 0.7, USDC: 0.7 } }, 'USDC')).toThrow(
      /somme des poids/,
    );
    expect(() => parseDcaRotationParams({ target_alloc: { PEPE: 0.5 } }, 'USDC')).toThrow(
      /inconnue/,
    );
    expect(() =>
      parseDcaRotationParams({ target_alloc: { SOL: 0.5, [SOL_MINT]: 0.5 } }, 'USDC'),
    ).toThrow(/dupliquée/);
    expect(() => parseDcaRotationParams({ drift_trigger_pct: 0 }, 'USDC')).toThrow(/drift/);
    expect(() => parseDcaRotationParams({ topup_usdc: 0 }, 'USDC')).toThrow(/topup/);
    expect(() => parseDcaRotationParams({ target_alloc: {} }, 'USDC')).toThrow(/vide/);
  });

  it('accepte une adresse de mint comme cible et la raccourcit', () => {
    const parsed = parseDcaRotationParams({ target_alloc: { [WATCH]: 0.5, USDC: 0.5 } }, 'USDC');
    expect(parsed.targets[0]).toEqual({
      key: WATCH,
      mint: WATCH,
      symbol: 'WWWW…WWWW',
      weight: 0.5,
    });
  });

  it('traite la devise de base SOL comme caisse', () => {
    const parsed = parseDcaRotationParams({}, 'SOL');
    expect(parsed.baseMint).toBe(SOL_MINT);
    expect(parsed.baseSymbol).toBe('SOL');
  });
});

describe('dca_rotation — évaluation', () => {
  it('achète la cible la plus sous-allouée, plafonnée par topup_usdc', () => {
    const strategy = new DcaRotationStrategy(params());
    const signals = strategy.evaluate(market([], portfolio()));

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      assetMint: SOL_MINT,
      side: 'buy',
      allowAdd: true,
      suggestedSizeUsd: 25,
      confidence: 1,
    });
    // Déficit 40 % du NAV (400 $) plafonné à 25 $ ; écart 40 % → edge 4000 bps.
    expect(signals[0]!.edgeEstimateBps).toBeCloseTo(4000, 6);
    expect(signals[0]!.reason).toContain('rotation');
  });

  it('allège la cible la plus sur-allouée d’une portion couvrant l’écart', () => {
    const strategy = new DcaRotationStrategy(params());
    const signals = strategy.evaluate(
      market([], portfolio({ cashUsd: 100, valueByMint: new Map([[SOL_MINT, 900]]) })),
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ assetMint: SOL_MINT, side: 'sell' });
    // Écart +50 % du NAV (500 $) sur 900 $ de position → portion 0.5556.
    expect(signals[0]!.sellPortion).toBeCloseTo(0.5556, 4);
    expect(signals[0]!.suggestedSizeUsd).toBeUndefined();
    expect(signals[0]!.reason).toContain('allègement 56 %');
  });

  it('ne traite qu’une seule action par évaluation (dérive la plus forte)', () => {
    const strategy = new DcaRotationStrategy(
      params({
        targets: [
          { key: 'SOL', mint: SOL_MINT, symbol: 'SOL', weight: 0.3 },
          { key: WATCH, mint: WATCH, symbol: 'WCH', weight: 0.4 },
        ],
      }),
    );
    const signals = strategy.evaluate(market([{ mint: WATCH, symbol: 'WCH' }], portfolio()));

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ assetMint: WATCH, suggestedSizeUsd: 25 });
  });

  it('ignore la caisse et les cibles non négociables (hors watchlist et hors SOL)', () => {
    const strategy = new DcaRotationStrategy(
      params({
        targets: [{ key: UNKNOWN, mint: UNKNOWN, symbol: 'UNK', weight: 0.5 }],
      }),
    );
    // Caisse 100 % (sur-allouée mais jamais tradée) ; UNKNOWN absent du marché → [].
    expect(strategy.evaluate(market([], portfolio()))).toEqual([]);
  });

  it('ne signale rien sans portefeuille ou avec un NAV nul', () => {
    const strategy = new DcaRotationStrategy(params());
    expect(strategy.evaluate(market([], undefined))).toEqual([]);
    expect(strategy.evaluate(market([], portfolio({ navUsd: 0 })))).toEqual([]);
  });
});
