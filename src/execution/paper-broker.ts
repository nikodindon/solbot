import { SOL_MINT, USDC_MINT } from '../constants.js';

/**
 * Frais Jupiter approchés (bps) pour la simulation paper — barème réel :
 * 0 bps stable↔stable / LST↔LST, 2 bps SOL↔stable, 5 bps LST↔stable,
 * 10 bps tout le reste, 50 bps tokens < 24 h (exclus par l'univers).
 */
export function jupiterFeeBps(inputMint: string, outputMint: string): number {
  const isStable = (mint: string): boolean => mint === USDC_MINT;
  const isSol = (mint: string): boolean => mint === SOL_MINT;
  if (isStable(inputMint) && isStable(outputMint)) return 0;
  if ((isStable(inputMint) && isSol(outputMint)) || (isSol(inputMint) && isStable(outputMint))) {
    return 2;
  }
  return 10;
}

/**
 * Modèle de coûts du broker paper (et du backtest) :
 * frais (barème Jupiter ou forçage), slippage modélisé, impact de marché
 * (`impact ≈ impact_k × notionnel / liquidité`) et priority fee en SOL.
 */
export interface PaperCosts {
  /** Slippage modélisé par fill (aller simple, bps). */
  fillSlippageBps: number;
  /** Impact de marché : k × notionnel / liquidité (fraction). 0 = désactivé. */
  impactK: number;
  /** Priority fee + frais réseau par swap, en SOL. 0 = désactivé. */
  priorityFeeSol: number;
  /** Force le barème de frais (bps) au lieu du barème Jupiter par paire. */
  feeBpsOverride: number | null;
}

/** Défauts alignés sur le bloc `paper` de la config. */
export const DEFAULT_PAPER_COSTS: PaperCosts = {
  fillSlippageBps: 20,
  impactK: 0,
  priorityFeeSol: 0,
  feeBpsOverride: null,
};

export interface PaperFill {
  side: 'buy' | 'sell';
  /** Montant d'entrée en unités de base (texte u64). */
  inAmount: string;
  /** Montant de sortie en unités de base (texte u64). */
  outAmount: string;
  /** Prix effectif (frais + slippage + impact inclus), pour l'audit. */
  effectivePriceUsd: number;
  /** Frais de taker (bps) en USD. */
  feeUsd: number;
  /** Coût fixe modélisé (priority fee + réseau) en USD. */
  flatFeeUsd: number;
  slippageBps: number;
  feeBps: number;
}

/** Contexte de marché optionnel d'un fill simulé. */
interface SimulatedMarketInput {
  /** Liquidité du pool (USD) — active le modèle d'impact si `impactK > 0`. */
  liquidityUsd?: number | null;
  /** Coût fixe du swap en USD (priority fee × prix SOL). */
  flatFeeUsd?: number;
}

/**
 * Courtier **paper** : remplit les ordres à un prix modélisé (slippage de
 * config + impact optionnel + frais Jupiter approchés + coût fixe), sans
 * toucher au réseau. Les quantités de sortie sont arrondies vers le bas
 * (jamais de fraction d'unité de base).
 */
export class PaperBroker {
  constructor(private readonly costs: PaperCosts) {}

  buy(
    input: {
      /** Montant payé en unités de base de la devise de base (ex. USDC). */
      spendBaseUnits: string;
      inputMint: string;
      inputDecimals: number;
      /** Prix USD du token payé (défaut 1 : devise de base stable). */
      inputPriceUsd?: number;
      outputMint: string;
      outputDecimals: number;
      /** Prix USD du token reçu. */
      priceUsd: number;
    } & SimulatedMarketInput,
  ): PaperFill {
    const spendUi = Number(input.spendBaseUnits) / 10 ** input.inputDecimals;
    const spendUsd = spendUi * (input.inputPriceUsd ?? 1);
    const feeBps = this.costs.feeBpsOverride ?? jupiterFeeBps(input.inputMint, input.outputMint);
    const feeUsd = (spendUsd * feeBps) / 10_000;
    const flatFeeUsd = Math.max(0, input.flatFeeUsd ?? 0);
    const impact = this.impactFrac(spendUsd, input.liquidityUsd);
    const effectivePriceUsd = input.priceUsd * (1 + this.costs.fillSlippageBps / 10_000 + impact);
    const budget = Math.max(0, spendUsd - feeUsd - flatFeeUsd);
    const qty = budget / effectivePriceUsd;
    const outAmount = toBaseUnitsFloor(qty, input.outputDecimals);
    return {
      side: 'buy',
      inAmount: input.spendBaseUnits,
      outAmount,
      effectivePriceUsd,
      feeUsd,
      flatFeeUsd,
      slippageBps: this.costs.fillSlippageBps,
      feeBps,
    };
  }

  sell(
    input: {
      /** Quantité vendue en unités de base du token. */
      qtyBaseUnits: string;
      tokenMint: string;
      tokenDecimals: number;
      /** Devise de base reçue (mint + décimales). */
      outputMint: string;
      outputDecimals: number;
      /** Prix USD du token vendu. */
      priceUsd: number;
      /** Prix USD de la devise de base reçue (défaut 1). */
      outputPriceUsd?: number;
    } & SimulatedMarketInput,
  ): PaperFill {
    const qty = Number(input.qtyBaseUnits) / 10 ** input.tokenDecimals;
    const feeBps = this.costs.feeBpsOverride ?? jupiterFeeBps(input.tokenMint, input.outputMint);
    const impact = this.impactFrac(qty * input.priceUsd, input.liquidityUsd);
    const effectivePriceUsd = input.priceUsd * (1 - this.costs.fillSlippageBps / 10_000 - impact);
    const grossUsd = Math.max(0, qty * effectivePriceUsd);
    const feeUsd = (grossUsd * feeBps) / 10_000;
    const flatFeeUsd = Math.max(0, input.flatFeeUsd ?? 0);
    const outAmount = toBaseUnitsFloor(
      Math.max(0, grossUsd - feeUsd - flatFeeUsd) / (input.outputPriceUsd ?? 1),
      input.outputDecimals,
    );
    return {
      side: 'sell',
      inAmount: input.qtyBaseUnits,
      outAmount,
      effectivePriceUsd,
      feeUsd,
      flatFeeUsd,
      slippageBps: this.costs.fillSlippageBps,
      feeBps,
    };
  }

  /** Fraction d'impact de marché (bornée à 50 %), 0 si le modèle est désactivé. */
  private impactFrac(sizeUsd: number, liquidityUsd: number | null | undefined): number {
    if (!(this.costs.impactK > 0)) return 0;
    if (liquidityUsd === null || liquidityUsd === undefined || !(liquidityUsd > 0)) return 0;
    return Math.min(0.5, (this.costs.impactK * sizeUsd) / liquidityUsd);
  }
}

/** Quantité décimale → unités de base entières (arrondi vers le bas). */
export function toBaseUnitsFloor(qty: number, decimals: number): string {
  if (!Number.isFinite(qty) || qty <= 0) return '0';
  return BigInt(Math.floor(qty * 10 ** decimals + 1e-9)).toString();
}
