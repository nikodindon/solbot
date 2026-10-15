import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/state/market-data.js';
import { atr, average, ema, emaSeries, highest, median, rsi } from '../src/strategy/indicators.js';

function candle(close: number, high = close, low = close): Candle {
  return {
    mint: 'M',
    timeframe: '15m',
    bucketStart: 0,
    open: close,
    high,
    low,
    close,
    tickCount: 1,
    volumeUsd: 0,
  };
}

describe('ema', () => {
  it('calcule la moyenne exponentielle (k = 2/(n+1))', () => {
    const series = emaSeries([1, 2, 3, 4], 3);
    expect(series[0]).toBe(1);
    expect(series[1]).toBeCloseTo(1.5, 10);
    expect(series[2]).toBeCloseTo(2.25, 10);
    expect(series[3]).toBeCloseTo(3.125, 10);
    expect(ema([1, 2, 3, 4], 3)).toBeCloseTo(3.125, 10);
  });

  it('retourne null sur une série vide et refuse une période invalide', () => {
    expect(ema([], 12)).toBeNull();
    expect(emaSeries([], 12)).toEqual([]);
    expect(() => emaSeries([1], 0)).toThrow();
  });
});

describe('rsi (Wilder)', () => {
  it('vaut 100 en hausse continue, 0 en baisse continue, 50 à plat', () => {
    const up = Array.from({ length: 16 }, (_, index) => 100 + index);
    const down = Array.from({ length: 16 }, (_, index) => 100 - index);
    const flat = Array.from({ length: 16 }, () => 100);
    expect(rsi(up, 14)).toBe(100);
    expect(rsi(down, 14)).toBe(0);
    expect(rsi(flat, 14)).toBe(50);
  });

  it('lisse selon Wilder (valeur vérifiée à la main)', () => {
    // period 2 : changements +1, -0.5, +1 → avgGain 0.75, avgLoss 0.125 → RSI = 100 - 100/7.
    const value = rsi([10, 11, 10.5, 11.5], 2);
    expect(value).toBeCloseTo(100 - 100 / 7, 10);
  });

  it('retourne null si l’historique est insuffisant', () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });
});

describe('atr (Wilder)', () => {
  it('calcule le true range lissé', () => {
    expect(atr([candle(10), candle(11), candle(12), candle(13)], 2)).toBeCloseTo(1, 10);
    // TR1 = 2.5, TR2 = 2 → ATR(2) = 2.25.
    const candles = [candle(9.5, 10, 9), candle(11, 12, 10), candle(10, 11, 9)];
    expect(atr(candles, 2)).toBeCloseTo(2.25, 10);
  });

  it('retourne null si l’historique est insuffisant', () => {
    expect(atr([candle(10), candle(11)], 14)).toBeNull();
  });
});

describe('highest / median / average', () => {
  it('plus haute valeur d’une fenêtre', () => {
    expect(highest([1, 5, 3, 2], 3)).toBe(5);
    expect(highest([1, 2], 5)).toBeNull();
    expect(highest([1, 2], 0)).toBeNull();
  });

  it('médiane paire et impaire, valeurs non finies ignorées', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([Number.NaN, 2, 4])).toBe(3);
    expect(median([])).toBeNull();
  });

  it('moyenne des valeurs finies', () => {
    expect(average([1, 2, 3])).toBe(2);
    expect(average([1, Number.POSITIVE_INFINITY])).toBe(1);
    expect(average([])).toBeNull();
  });
});
