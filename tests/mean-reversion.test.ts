import { describe, expect, it } from 'vitest';
import {
  MeanReversionStrategy,
  meanReversionRequiredBars,
  parseMeanReversionParams,
  type MeanReversionParams,
} from '../src/strategy/mean-reversion.js';
import type { AssetSnapshot, MarketSnapshot, PortfolioContext } from '../src/strategy/types.js';
import type { Candle } from '../src/state/market-data.js';

const MINT = 'A'.repeat(44);
const TF_MS = 900_000;
const BUCKET0 = Math.floor(1_750_000_000_000 / TF_MS) * TF_MS;

function params(overrides: Partial<MeanReversionParams> = {}): MeanReversionParams {
  return {
    timeframe: '15m',
    window: 5,
    zEntry: 2,
    zExit: 0.5,
    mode: 'zscore',
    gridStepPct: 1,
    gridLevels: 5,
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

/** Marché synthétique : les bougies valent les clôtures fournies (toutes closes). */
function market(closes: number[], options: { portfolio?: PortfolioContext } = {}): MarketSnapshot {
  const candles: Candle[] = closes.map((close, index) => ({
    mint: MINT,
    timeframe: '15m',
    bucketStart: BUCKET0 + index * TF_MS,
    open: close,
    high: close,
    low: close,
    close,
    tickCount: 1,
    volumeUsd: 0,
  }));
  const asset: AssetSnapshot = {
    mint: MINT,
    symbol: 'AAA',
    priceUsd: closes[closes.length - 1]!,
    liquidityUsd: 1_000_000,
    candles: { '15m': candles },
  };
  return {
    ts: BUCKET0 + closes.length * TF_MS,
    assets: [asset],
    ...(options.portfolio === undefined ? {} : { portfolio: options.portfolio }),
  };
}

describe('mean-reversion — paramètres', () => {
  it('applique les défauts et normalise les paramètres', () => {
    const parsed = parseMeanReversionParams({}, '15m');
    expect(parsed).toEqual({
      timeframe: '15m',
      window: 96,
      zEntry: 2,
      zExit: 0.5,
      mode: 'zscore',
      gridStepPct: 1,
      gridLevels: 5,
    });
    expect(meanReversionRequiredBars(parsed)).toBe(98);
  });

  it('refuse z_exit ≥ z_entry, un mode inconnu ou un timeframe inconnu', () => {
    expect(() => parseMeanReversionParams({ z_entry: 2, z_exit: 2 }, '15m')).toThrow(/z_exit/);
    expect(() => parseMeanReversionParams({ mode: 'crossover' }, '15m')).toThrow(/mode/);
    expect(() => parseMeanReversionParams({}, '2m')).toThrow(/Timeframe/);
    expect(() => parseMeanReversionParams({ window: 4 }, '15m')).toThrow(/window/);
  });
});

describe('mean-reversion — mode zscore', () => {
  it('achète en survente (z ≤ -z_entry) avec edge, confiance et stop suggérés', () => {
    // Dernières 5 clôtures [1, 1, 1, 0.95, 0.8] : moyenne 0.95, σ ≈ 0.0775, z ≈ -1.94
    // (marge sous z_entry pour éviter le seuil flottant pile à -2).
    const strategy = new MeanReversionStrategy(params({ zEntry: 1.5 }));
    const signals = strategy.evaluate(market([1, 1, 1, 1, 1, 1, 0.95, 0.8]));

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ assetMint: MINT, side: 'buy' });
    expect(signals[0]!.confidence).toBeCloseTo(0.5746, 3);
    expect(signals[0]!.suggestedStopLossPct).toBeCloseTo(14.52, 1);
    expect(signals[0]!.edgeEstimateBps).toBeGreaterThan(1300);
    expect(signals[0]!.edgeEstimateBps).toBeLessThan(1500);
    expect(signals[0]!.reason).toContain('survente (z -1.94');
    expect(signals[0]!.allowAdd).toBeUndefined();
  });

  it('émet une sortie quand le prix revient à la moyenne (z ≥ -z_exit)', () => {
    const strategy = new MeanReversionStrategy(params());
    // Dernières 5 clôtures [1, 1, 1, 0.99, 1.0] : moyenne 0.998, σ 0.004, z = +0.5.
    const signals = strategy.evaluate(market([1, 1, 1, 1, 1, 0.99, 1.0]));

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ side: 'sell', confidence: 0.55 });
    expect(signals[0]!.edgeEstimateBps).toBeCloseTo(40, 6);
    expect(signals[0]!.reason).toContain('retour à la moyenne');
  });

  it('ne signale rien sans volatilité ou avec trop peu de bougies', () => {
    const strategy = new MeanReversionStrategy(params());
    expect(strategy.evaluate(market([1, 1, 1, 1, 1, 1, 1, 1]))).toEqual([]); // σ = 0
    expect(strategy.evaluate(market([1, 1, 1, 1, 1, 0.8]))).toEqual([]); // 6 < window + 2
  });
});

describe('mean-reversion — mode grid', () => {
  it('achète au palier le plus profond atteint (ancre − niveau × pas)', () => {
    const strategy = new MeanReversionStrategy(params({ mode: 'grid' }));
    // Ancre 0.98 − prix 0.9 → niveau 5/5.
    const signals = strategy.evaluate(market([1, 1, 1, 1, 1, 1, 0.9]));

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ side: 'buy', confidence: 1, suggestedStopLossPct: 5.5 });
    expect(signals[0]!.edgeEstimateBps).toBeCloseTo(888.889, 2);
    expect(signals[0]!.reason).toContain('grille niveau 5/5');
    expect(signals[0]!.allowAdd).toBeUndefined();
  });

  it('autorise l’ajout si le prix franchit un palier sous le prix moyen d’entrée', () => {
    const strategy = new MeanReversionStrategy(params({ mode: 'grid' }));
    const closes = [1, 1, 1, 1, 1, 1, 0.9];

    const added = strategy.evaluate(
      market(closes, {
        portfolio: portfolio({
          positionsByMint: new Map([
            [MINT, { qtyRemaining: '1000000', decimals: 6, avgEntryPriceUsd: 1 }],
          ]),
        }),
      }),
    );
    expect(added[0]).toMatchObject({ side: 'buy', allowAdd: true });

    // Prix moyen 0.90 → prochain palier 0.891 : le prix courant (0.90) ne l'atteint pas.
    const waiting = strategy.evaluate(
      market(closes, {
        portfolio: portfolio({
          positionsByMint: new Map([
            [MINT, { qtyRemaining: '1000000', decimals: 6, avgEntryPriceUsd: 0.9 }],
          ]),
        }),
      }),
    );
    expect(waiting).toEqual([]);
  });

  it('sort au retour à l’ancre (ou au-dessus)', () => {
    const strategy = new MeanReversionStrategy(params({ mode: 'grid' }));
    // Ancre 0.99, prix 1.0 → niveau 0 et prix ≥ ancre.
    const signals = strategy.evaluate(market([1, 1, 1, 1, 1, 1, 0.95, 1.0]));

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ side: 'sell' });
    expect(signals[0]!.edgeEstimateBps).toBeCloseTo(100, 6);
    expect(signals[0]!.reason).toContain("grille : retour à l'ancre");
  });
});
