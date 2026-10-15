import { describe, expect, it } from 'vitest';
import { SOL_MINT, USDC_MINT } from '../src/constants.js';
import { jupiterFeeBps, PaperBroker, toBaseUnitsFloor } from '../src/execution/paper-broker.js';

describe('jupiterFeeBps (barème approché)', () => {
  it('applique 0/2/10 bps selon la paire', () => {
    expect(jupiterFeeBps(USDC_MINT, USDC_MINT)).toBe(0);
    expect(jupiterFeeBps(USDC_MINT, SOL_MINT)).toBe(2);
    expect(jupiterFeeBps(SOL_MINT, USDC_MINT)).toBe(2);
    expect(jupiterFeeBps(USDC_MINT, 'B'.repeat(44))).toBe(10);
  });
});

describe('toBaseUnitsFloor', () => {
  it('convertit en unités de base sans jamais dépasser', () => {
    expect(toBaseUnitsFloor(1.5, 6)).toBe('1500000');
    expect(toBaseUnitsFloor(0.0000009, 6)).toBe('0');
    expect(toBaseUnitsFloor(24.9253, 9)).toBe('24925300000');
    expect(toBaseUnitsFloor(Number.NaN, 6)).toBe('0');
    expect(toBaseUnitsFloor(-1, 6)).toBe('0');
  });
});

describe('PaperBroker', () => {
  // 20 bps de slippage modélisé, pas d'impact ni de frais fixes.
  const broker = new PaperBroker({
    fillSlippageBps: 20,
    impactK: 0,
    priorityFeeSol: 0,
    feeBpsOverride: null,
  });

  it('achète avec frais (sur l’entrée) et slippage', () => {
    const fill = broker.buy({
      spendBaseUnits: '50000000', // 50 USDC
      inputMint: USDC_MINT,
      inputDecimals: 6,
      outputMint: 'B'.repeat(44),
      outputDecimals: 6,
      priceUsd: 2,
    });
    // frais 10 bps = 0,05 $ ; prix effectif 2 × 1,002 = 2,004 → qté = 49,95 / 2,004.
    const expectedQty = 49.95 / 2.004;
    expect(fill.feeBps).toBe(10);
    expect(fill.feeUsd).toBeCloseTo(0.05, 10);
    expect(fill.effectivePriceUsd).toBeCloseTo(2.004, 10);
    expect(Number(fill.outAmount) / 10 ** 6).toBeCloseTo(expectedQty, 5);
    expect(fill.inAmount).toBe('50000000');
    expect(fill.side).toBe('buy');
  });

  it('vend avec slippage et frais (sur la sortie)', () => {
    const fill = broker.sell({
      qtyBaseUnits: '3000000', // 3 unités
      tokenMint: 'B'.repeat(44),
      tokenDecimals: 6,
      outputMint: USDC_MINT,
      outputDecimals: 6,
      priceUsd: 10,
    });
    // brut = 3 × 10 × (1 - 0,002) = 29,94 ; frais 10 bps = 0,02994 → net 29,91006.
    expect(fill.effectivePriceUsd).toBeCloseTo(9.98, 10);
    expect(fill.feeUsd).toBeCloseTo(0.02994, 10);
    expect(Number(fill.outAmount) / 10 ** 6).toBeCloseTo(29.91006, 5);
  });

  it('utilise 2 bps de frais sur SOL↔stable', () => {
    const fill = broker.buy({
      spendBaseUnits: '1000000000', // 1 SOL à 150 $
      inputMint: SOL_MINT,
      inputDecimals: 9,
      inputPriceUsd: 150,
      outputMint: USDC_MINT,
      outputDecimals: 6,
      priceUsd: 1, // USDC
    });
    expect(fill.feeBps).toBe(2);
    expect(fill.feeUsd).toBeCloseTo(0.03, 10); // 150 $ × 2 bps
    expect(Number(fill.outAmount) / 10 ** 6).toBeCloseTo((150 - 0.03) / 1.002, 4);
  });

  it('applique le modèle d’impact k × notionnel / liquidité', () => {
    const impacted = new PaperBroker({
      fillSlippageBps: 0,
      impactK: 0.5,
      priorityFeeSol: 0,
      feeBpsOverride: 0,
    });
    // Achat 100 $ dans un pool de 100 000 $ → impact = 0,5 × 100/100 000 = 5 bps.
    const fill = impacted.buy({
      spendBaseUnits: '100000000',
      inputMint: USDC_MINT,
      inputDecimals: 6,
      outputMint: 'B'.repeat(44),
      outputDecimals: 6,
      priceUsd: 1,
      liquidityUsd: 100_000,
    });
    expect(fill.effectivePriceUsd).toBeCloseTo(1.0005, 10);
    expect(Number(fill.outAmount) / 10 ** 6).toBeCloseTo(100 / 1.0005, 5);
  });

  it('déduit le coût fixe (priority fee) et le forçage de frais', () => {
    const fixed = new PaperBroker({
      fillSlippageBps: 0,
      impactK: 0,
      priorityFeeSol: 0,
      feeBpsOverride: 0,
    });
    const fill = fixed.sell({
      qtyBaseUnits: '1000000',
      tokenMint: 'B'.repeat(44),
      tokenDecimals: 6,
      outputMint: USDC_MINT,
      outputDecimals: 6,
      priceUsd: 2,
      flatFeeUsd: 0.01,
    });
    expect(fill.flatFeeUsd).toBeCloseTo(0.01, 10);
    expect(Number(fill.outAmount) / 10 ** 6).toBeCloseTo(1.99, 6);
  });
});
