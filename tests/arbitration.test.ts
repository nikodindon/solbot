import { describe, expect, it } from 'vitest';
import { rankSignals, scoreSignal, type WeightedSignal } from '../src/strategy/arbitration.js';
import type { Signal } from '../src/strategy/types.js';

const A = 'A'.repeat(44);
const B = 'B'.repeat(44);

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    assetMint: A,
    symbol: 'AAA',
    side: 'buy',
    confidence: 0.5,
    ttlMs: 90_000,
    reason: 'test',
    ...overrides,
  };
}

function weighted(
  strategy: string,
  weight: number,
  overrides: Partial<Signal> = {},
): WeightedSignal {
  return { strategy, weight, signal: signal(overrides) };
}

describe('arbitrage — score', () => {
  it('combine confiance × poids × facteur d’edge (clampé à 200 bps)', () => {
    expect(scoreSignal(signal({ confidence: 1 }), 1)).toBeCloseTo(1, 9);
    expect(scoreSignal(signal({ confidence: 1, edgeEstimateBps: 100 }), 1)).toBeCloseTo(1.25, 9);
    expect(scoreSignal(signal({ confidence: 1, edgeEstimateBps: 200 }), 1)).toBeCloseTo(1.5, 9);
    expect(scoreSignal(signal({ confidence: 1, edgeEstimateBps: 5000 }), 1)).toBeCloseTo(1.5, 9);
    expect(scoreSignal(signal({ confidence: 1, edgeEstimateBps: -50 }), 1)).toBeCloseTo(1, 9);
    expect(scoreSignal(signal({ confidence: 0.5 }), 2)).toBeCloseTo(1, 9);
    expect(scoreSignal(signal({ confidence: 0.5 }), -3)).toBe(0);
    expect(scoreSignal(signal({ confidence: 3 }), 1)).toBeCloseTo(1, 9);
  });
});

describe('arbitrage — classement', () => {
  it('regroupe par (mint, côté), trie les candidats et retient le meilleur score', () => {
    const groups = rankSignals([
      weighted('alpha', 1, { confidence: 0.5 }),
      weighted('beta', 1, { confidence: 0.9 }),
      weighted('gamma', 1, { assetMint: B, symbol: 'BBB', confidence: 0.8, edgeEstimateBps: 100 }),
      weighted('delta', 1, { confidence: 0.9, side: 'sell' }),
    ]);

    expect(groups).toHaveLength(3);
    // buy:B (score 1.0, edge) passe devant buy:A et sell:A (0.9).
    expect(groups[0]!.mint).toBe(B);

    const buyA = groups.find((group) => group.mint === A && group.side === 'buy')!;
    expect(buyA.candidates.map((candidate) => candidate.strategy)).toEqual(['beta', 'alpha']);
    expect(buyA.candidates[1]!.score).toBeCloseTo(0.5, 9);

    const sellA = groups.find((group) => group.mint === A && group.side === 'sell')!;
    expect(sellA.side).toBe('sell');
  });

  it('départage les scores égaux par ordre alphabétique de stratégie', () => {
    const groups = rankSignals([
      weighted('zeta', 1, { confidence: 0.6 }),
      weighted('alpha', 1, { confidence: 0.6 }),
    ]);

    expect(groups[0]!.candidates.map((candidate) => candidate.strategy)).toEqual(['alpha', 'zeta']);
    expect(groups[0]!.candidates.every((candidate) => candidate.score === 0.6)).toBe(true);
  });

  it('renvoie un tableau vide sans signal', () => {
    expect(rankSignals([])).toEqual([]);
  });
});
