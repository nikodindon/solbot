import { describe, expect, it } from 'vitest';
import {
  formatBaseUnits,
  maxSpendableBaseUnits,
  parseDecimalAmount,
} from '../src/execution/amount.js';
import { SolbotError } from '../src/utils/errors.js';

describe('parseDecimalAmount', () => {
  it('convertit les montants décimaux en unités de base', () => {
    expect(parseDecimalAmount('1', 9)).toBe(1_000_000_000n);
    expect(parseDecimalAmount('0.5', 9)).toBe(500_000_000n);
    expect(parseDecimalAmount('1,5', 6)).toBe(1_500_000n);
    expect(parseDecimalAmount(' 12.34 ', 2)).toBe(1234n);
    expect(parseDecimalAmount('0.000000001', 9)).toBe(1n);
    expect(parseDecimalAmount('147', 0)).toBe(147n);
  });

  it('rejette les formats invalides', () => {
    for (const bad of ['', 'abc', '1.2.3', '-1', '1e3', '1..2', '.5']) {
      expect(() => parseDecimalAmount(bad, 9)).toThrowError(SolbotError);
    }
  });

  it('rejette un excès de précision pour le token', () => {
    expect(() => parseDecimalAmount('0.1234567891', 9)).toThrowError(/trop précis/);
    expect(() => parseDecimalAmount('1.234', 2)).toThrowError(/trop précis/);
  });

  it('rejette zéro', () => {
    expect(() => parseDecimalAmount('0', 9)).toThrowError(/strictement positif/);
    expect(() => parseDecimalAmount('0.0', 9)).toThrowError(/strictement positif/);
  });
});

describe('formatBaseUnits', () => {
  it('formate les unités de base en décimal lisible', () => {
    expect(formatBaseUnits(1_500_000n, 6)).toBe('1.5');
    expect(formatBaseUnits(1_000_000_000n, 9)).toBe('1');
    expect(formatBaseUnits(1n, 9)).toBe('0.000000001');
    expect(formatBaseUnits(42n, 0)).toBe('42');
    expect(formatBaseUnits(0n, 6)).toBe('0');
  });

  it('supprime les zéros de fin et gère les grands montants', () => {
    expect(formatBaseUnits(5_123_456n, 6)).toBe('5.123456');
    expect(formatBaseUnits(12_340_000_000n, 9)).toBe('12.34');
    expect(formatBaseUnits(-1_500_000n, 6)).toBe('-1.5');
  });
});

describe('maxSpendableBaseUnits', () => {
  it('réserve le montant demandé', () => {
    expect(maxSpendableBaseUnits(1_000_000n)).toBe(1_000_000n);
    expect(maxSpendableBaseUnits(1_000_000n, 200_000n)).toBe(800_000n);
  });

  it('refuse quand la réserve n’est pas couverte', () => {
    expect(() => maxSpendableBaseUnits(100_000n, 100_000n)).toThrowError(/réserve de gaz/);
    expect(() => maxSpendableBaseUnits(0n, 50_000_000n)).toThrowError(/réserve de gaz/);
  });
});
