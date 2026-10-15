import { SOL_MINT, USDC_MINT } from '../constants.js';
import { SolbotError } from '../utils/errors.js';
import type { DataRequirement, MarketSnapshot, Signal, Strategy } from './types.js';

export interface DcaTarget {
  /** Clé d'origine (`SOL`, `USDC` ou un mint). */
  key: string;
  mint: string;
  symbol: string;
  weight: number;
}

export interface DcaRotationParams {
  targets: DcaTarget[];
  driftTriggerPct: number;
  topupUsdc: number;
  /** Devise de base : la clé correspondante est traitée comme la caisse. */
  baseMint: string;
  baseSymbol: string;
}

/** Doivent rester alignés avec les défauts de `config.yaml`. */
export const DCA_ROTATION_DEFAULTS = {
  drift_trigger_pct: 5,
  topup_usdc: 25,
} as const;

const DEFAULT_TARGET_ALLOC: Record<string, number> = { SOL: 0.4, USDC: 0.6 };

const TTL_MS = 900_000;

/** Valide et normalise les paramètres DCA/rotation de `config.yaml`. */
export function parseDcaRotationParams(
  raw: Record<string, unknown>,
  baseCurrency: 'USDC' | 'SOL',
): DcaRotationParams {
  const merged = { ...DCA_ROTATION_DEFAULTS, ...raw } as Record<string, unknown>;
  const rawAlloc = merged.target_alloc === undefined ? DEFAULT_TARGET_ALLOC : merged.target_alloc;
  if (typeof rawAlloc !== 'object' || rawAlloc === null || Array.isArray(rawAlloc)) {
    throw new SolbotError(
      'Paramètre dca_rotation target_alloc invalide : objet { SYMBOLE: poids } attendu',
    );
  }

  const targets: DcaTarget[] = [];
  const seen = new Set<string>();
  let sum = 0;
  for (const [key, value] of Object.entries(rawAlloc as Record<string, unknown>)) {
    const weight = Number(value);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1) {
      throw new SolbotError(
        `Paramètre dca_rotation : poids invalide pour « ${key} » (${String(value)}) — attendu ]0, 1]`,
      );
    }
    const { mint, symbol } = resolveTarget(key);
    if (seen.has(mint)) {
      throw new SolbotError(`Paramètre dca_rotation : cible dupliquée « ${key} »`);
    }
    seen.add(mint);
    sum += weight;
    targets.push({ key, mint, symbol, weight });
  }
  if (targets.length === 0) {
    throw new SolbotError('Paramètre dca_rotation target_alloc vide : au moins une cible attendue');
  }
  if (sum > 1.000_001) {
    throw new SolbotError(
      `Paramètre dca_rotation : somme des poids ${sum.toFixed(4)} > 1 (le reste serait sur-alloué)`,
    );
  }

  const driftTriggerPct = Number(merged.drift_trigger_pct);
  if (!Number.isFinite(driftTriggerPct) || driftTriggerPct <= 0 || driftTriggerPct > 100) {
    throw new SolbotError(
      `Paramètre dca_rotation drift_trigger_pct invalide : ${String(merged.drift_trigger_pct)} (]0, 100] attendu)`,
    );
  }
  const topupUsdc = Number(merged.topup_usdc);
  if (!Number.isFinite(topupUsdc) || topupUsdc <= 0) {
    throw new SolbotError(
      `Paramètre dca_rotation topup_usdc invalide : ${String(merged.topup_usdc)} (> 0 attendu)`,
    );
  }

  return {
    targets,
    driftTriggerPct,
    topupUsdc,
    baseMint: baseCurrency === 'SOL' ? SOL_MINT : USDC_MINT,
    baseSymbol: baseCurrency,
  };
}

/** `SOL`/`USDC` → mints connus ; une adresse (≥ 32 caractères) → mint tel quel. */
function resolveTarget(key: string): { mint: string; symbol: string } {
  const upper = key.toUpperCase();
  if (upper === 'SOL') return { mint: SOL_MINT, symbol: 'SOL' };
  if (upper === 'USDC') return { mint: USDC_MINT, symbol: 'USDC' };
  if (key.length >= 32) return { mint: key, symbol: shortenMint(key) };
  throw new SolbotError(
    `Paramètre dca_rotation target_alloc : clé « ${key} » inconnue (SOL, USDC ou adresse de mint)`,
  );
}

function shortenMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

/**
 * Stratégie **DCA / rotation** (Phase 4) : maintient une allocation cible du
 * NAV (ex. 40 % SOL / 60 % USDC en caisse) et ne réagit qu'au-delà d'une dérive
 * `drift_trigger_pct` (points de pourcentage du NAV). Sous-allocation → achat
 * plafonné par `topup_usdc` ; sur-allocation → allègement partiel de la
 * position (le RiskManager et les plafonds d'exposition restent maîtres).
 */
export class DcaRotationStrategy implements Strategy {
  readonly name = 'dca_rotation';
  /** Aucune donnée de bougies requise (décision portefeuille). */
  readonly requiredData: DataRequirement[] = [];

  constructor(private readonly params: DcaRotationParams) {}

  get parameterSummary(): DcaRotationParams {
    return this.params;
  }

  evaluate(market: MarketSnapshot): Signal[] {
    const { params } = this;
    const portfolio = market.portfolio;
    if (portfolio === undefined || !(portfolio.navUsd > 0)) return [];

    const nav = portfolio.navUsd;
    const legs = params.targets.map((target) => {
      const isCash = target.mint === params.baseMint;
      const valueUsd = isCash ? portfolio.cashUsd : (portfolio.valueByMint.get(target.mint) ?? 0);
      const actualPct = (valueUsd / nav) * 100;
      const targetPct = target.weight * 100;
      return { target, isCash, valueUsd, actualPct, targetPct, driftPct: actualPct - targetPct };
    });

    // Sous-allocation la plus forte → achat (alimenté par la caisse).
    const under = legs
      .filter(
        (leg) =>
          !leg.isCash &&
          leg.driftPct <= -params.driftTriggerPct &&
          this.tradable(leg.target.mint, market),
      )
      .sort((a, b) => a.driftPct - b.driftPct);
    const buyLeg = under[0];
    if (buyLeg !== undefined) {
      const neededUsd = (Math.abs(buyLeg.driftPct) / 100) * nav;
      const sizeUsd = Math.min(params.topupUsdc, neededUsd);
      if (sizeUsd < 1) return [];
      return [this.signal(buyLeg, 'buy', sizeUsd)];
    }

    // Sur-allocation la plus forte → allègement partiel.
    const over = legs
      .filter(
        (leg) =>
          !leg.isCash &&
          leg.driftPct >= params.driftTriggerPct &&
          leg.valueUsd > 0 &&
          this.tradable(leg.target.mint, market),
      )
      .sort((a, b) => b.driftPct - a.driftPct);
    const sellLeg = over[0];
    if (sellLeg === undefined) return [];
    const neededUsd = (sellLeg.driftPct / 100) * nav;
    const portion = clamp(neededUsd / sellLeg.valueUsd, 0.01, 1);
    return [this.signal(sellLeg, 'sell', null, portion)];
  }

  /** Une cible est négociable si c'est SOL ou si elle est présente au marché (watchlist/position). */
  private tradable(mint: string, market: MarketSnapshot): boolean {
    return mint === SOL_MINT || market.assets.some((asset) => asset.mint === mint);
  }

  private signal(
    leg: {
      target: DcaTarget;
      valueUsd: number;
      actualPct: number;
      targetPct: number;
      driftPct: number;
    },
    side: 'buy' | 'sell',
    sizeUsd: number | null,
    sellPortion?: number,
  ): Signal {
    const { params } = this;
    const excess = Math.min(
      1,
      (Math.abs(leg.driftPct) - params.driftTriggerPct) / params.driftTriggerPct,
    );
    const confidence = clamp01(0.5 + 0.5 * excess);
    const reason =
      side === 'buy'
        ? `rotation : ${leg.target.symbol} ${leg.actualPct.toFixed(1)} % → cible ${leg.targetPct.toFixed(1)} %`
        : `rotation (allègement ${((sellPortion ?? 1) * 100).toFixed(0)} %) : ${leg.target.symbol} ${leg.actualPct.toFixed(1)} % → cible ${leg.targetPct.toFixed(1)} %`;
    return {
      assetMint: leg.target.mint,
      symbol: leg.target.symbol,
      side,
      confidence,
      edgeEstimateBps: Math.abs(leg.driftPct) * 100,
      ttlMs: TTL_MS,
      reason,
      ...(side === 'buy' && sizeUsd !== null ? { allowAdd: true, suggestedSizeUsd: sizeUsd } : {}),
      ...(sellPortion === undefined ? {} : { sellPortion }),
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
