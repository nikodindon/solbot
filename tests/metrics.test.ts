import { describe, expect, it } from 'vitest';
import {
  computeMetrics,
  maxDrawdownPct,
  sharpeDaily,
  type EquitySample,
} from '../src/backtest/metrics.js';

const DAY1 = Date.UTC(2026, 0, 1, 0, 0, 0);

function day(index: number, hours = 0): number {
  return DAY1 + index * 86_400_000 + hours * 3_600_000;
}

describe('metrics — calcul complet', () => {
  const equity: EquitySample[] = [
    { ts: day(0, 0), navUsd: 1000 },
    { ts: day(0, 1), navUsd: 1010 },
    { ts: day(0, 2), navUsd: 990 },
    { ts: day(0, 3), navUsd: 1030 },
  ];

  it('calcule PnL, win rate, profit factor, drawdown, turnover et frais', () => {
    const metrics = computeMetrics({
      equity,
      closedPositions: [
        { realizedPnlUsd: 10, closedAt: day(0, 1) },
        { realizedPnlUsd: -4, closedAt: day(0, 2) },
        { realizedPnlUsd: 6, closedAt: day(0, 3) },
      ],
      trades: [
        { notionalUsd: 100, feeUsd: 0.5 },
        { notionalUsd: 200, feeUsd: null },
      ],
      initialUsd: 1000,
      days: 10,
    });

    expect(metrics.initialNavUsd).toBe(1000);
    expect(metrics.finalNavUsd).toBe(1030);
    expect(metrics.netPnlUsd).toBeCloseTo(30, 9);
    expect(metrics.netPnlPct).toBeCloseTo(3, 9);
    expect(metrics.trades).toBe(3);
    expect(metrics.wins).toBe(2);
    expect(metrics.losses).toBe(1);
    expect(metrics.winRatePct).toBeCloseTo(66.6667, 3);
    expect(metrics.grossProfitUsd).toBeCloseTo(16, 9);
    expect(metrics.grossLossUsd).toBeCloseTo(4, 9);
    expect(metrics.profitFactor).toBeCloseTo(4, 9);
    // Pic 1010 → 990 : (1010 - 990) / 1010.
    expect(metrics.maxDrawdownPct).toBeCloseTo(1.9802, 3);
    expect(metrics.sharpe).toBeNull(); // un seul jour UTC
    expect(metrics.turnover).toBeCloseTo(300 / 1007.5, 6);
    expect(metrics.turnoverPerDay).toBeCloseTo(300 / 1007.5 / 10, 6);
    expect(metrics.feesUsd).toBeCloseTo(0.5, 9);
    expect(metrics.avgTradeUsd).toBeCloseTo(150, 9);
  });

  it('calcule un Sharpe annualisé sur les clôtures quotidiennes', () => {
    const metrics = computeMetrics({
      equity: [
        { ts: day(0), navUsd: 1000 },
        { ts: day(1), navUsd: 1010 },
        { ts: day(2), navUsd: 1000 },
      ],
      closedPositions: [],
      trades: [],
      initialUsd: 1000,
      days: 2,
    });

    expect(metrics.sharpe).toBeCloseTo(0.0951, 3);
    expect(metrics.winRatePct).toBeNull();
    expect(metrics.profitFactor).toBeNull();
  });
});

describe('metrics — cas limites', () => {
  it('retourne des métriques neutres sans données', () => {
    const metrics = computeMetrics({
      equity: [],
      closedPositions: [],
      trades: [],
      initialUsd: 1000,
      days: 30,
    });

    expect(metrics.finalNavUsd).toBe(1000);
    expect(metrics.netPnlUsd).toBe(0);
    expect(metrics.netPnlPct).toBe(0);
    expect(metrics.winRatePct).toBeNull();
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.maxDrawdownPct).toBeNull();
    expect(metrics.sharpe).toBeNull();
    expect(metrics.turnover).toBe(0);
    expect(metrics.feesUsd).toBe(0);
    expect(metrics.avgTradeUsd).toBe(0);
  });

  it('drawdown : null sous deux points, sinon pire creux depuis un pic', () => {
    expect(maxDrawdownPct([])).toBeNull();
    expect(maxDrawdownPct([{ ts: 1, navUsd: 100 }])).toBeNull();
    expect(
      maxDrawdownPct([
        { ts: 1, navUsd: 100 },
        { ts: 2, navUsd: 80 },
        { ts: 3, navUsd: 120 },
      ]),
    ).toBeCloseTo(20, 9);
  });

  it('Sharpe : null sous trois jours ou sans volatilité', () => {
    expect(sharpeDaily([])).toBeNull();
    expect(
      sharpeDaily([
        { ts: day(0), navUsd: 1000 },
        { ts: day(1), navUsd: 1010 },
      ]),
    ).toBeNull();
    // Croissance régulière : rendements identiques → écart-type nul.
    expect(
      sharpeDaily([
        { ts: day(0), navUsd: 1000 },
        { ts: day(1), navUsd: 1010 },
        { ts: day(2), navUsd: 1020.1 },
      ]),
    ).toBeNull();
  });
});
