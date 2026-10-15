import { TIMEFRAMES, type Timeframe } from '../market/ohlcv.js';
import type { Candle } from '../state/market-data.js';
import { SolbotError } from '../utils/errors.js';
import { average, stdev } from './indicators.js';
import {
  closedCandles,
  type AssetSnapshot,
  type DataRequirement,
  type MarketSnapshot,
  type Signal,
  type Strategy,
} from './types.js';

export type MeanReversionMode = 'zscore' | 'grid';

export interface MeanReversionParams {
  timeframe: Timeframe;
  window: number;
  zEntry: number;
  zExit: number;
  mode: MeanReversionMode;
  gridStepPct: number;
  gridLevels: number;
}

/** Doivent rester alignés avec les défauts de `config.yaml`. */
export const MEAN_REVERSION_DEFAULTS = {
  window: 96,
  z_entry: 2,
  z_exit: 0.5,
  mode: 'zscore',
  grid_step_pct: 1,
  grid_levels: 5,
} as const;

const TTL_MS = 90_000;

/** Bougies clôturées nécessaires (fenêtre + bougie de référence + marge). */
export function meanReversionRequiredBars(params: MeanReversionParams): number {
  return params.window + 2;
}

/** Valide et normalise les paramètres mean-reversion de `config.yaml`. */
export function parseMeanReversionParams(
  raw: Record<string, unknown>,
  timeframe: string,
): MeanReversionParams {
  const merged = { ...MEAN_REVERSION_DEFAULTS, ...raw } as Record<string, unknown>;
  if (!(timeframe in TIMEFRAMES)) {
    throw new SolbotError(
      `Timeframe mean_reversion « ${timeframe} » inconnu (attendu : ${Object.keys(TIMEFRAMES).join(', ')})`,
    );
  }
  const positiveInt = (key: string, min: number): number => {
    const value = Number(merged[key]);
    if (!Number.isInteger(value) || value < min) {
      throw new SolbotError(
        `Paramètre mean_reversion ${key} invalide : ${String(merged[key])} (entier ≥ ${min})`,
      );
    }
    return value;
  };
  const positive = (key: string, min: number): number => {
    const value = Number(merged[key]);
    if (!Number.isFinite(value) || value < min) {
      throw new SolbotError(
        `Paramètre mean_reversion ${key} invalide : ${String(merged[key])} (≥ ${min})`,
      );
    }
    return value;
  };
  const mode = String(merged.mode);
  if (mode !== 'zscore' && mode !== 'grid') {
    throw new SolbotError(
      `Paramètre mean_reversion mode invalide : « ${mode} » (attendu : zscore ou grid)`,
    );
  }
  const zEntry = positive('z_entry', 0.1);
  const zExit = positive('z_exit', 0);
  if (zExit >= zEntry) {
    throw new SolbotError(
      `Paramètre mean_reversion incohérent : z_exit (${zExit}) doit être < z_entry (${zEntry})`,
    );
  }

  return {
    timeframe: timeframe as Timeframe,
    window: positiveInt('window', 5),
    zEntry,
    zExit,
    mode,
    gridStepPct: positive('grid_step_pct', 0.05),
    gridLevels: positiveInt('grid_levels', 1),
  };
}

/**
 * Stratégie **mean-reversion** (Phase 4), deux variantes :
 *
 * - `zscore` : z-score du prix contre sa moyenne glissante (`window` bougies
 *   clôturées). Achat quand `z ≤ -z_entry` (survente), sortie quand le prix
 *   revient à la moyenne (`z ≥ -z_exit`).
 * - `grid` : grille adaptative autour de l'ancre (moyenne glissante) — un
 *   achat par palier sous l'ancre (`grid_step_pct` × niveau, ≤ `grid_levels`),
 *   ajouts espacés sous le prix moyen d'entrée, sortie au retour à l'ancre.
 *
 * L'edge estimé (bps) est la distance restante jusqu'à la moyenne ; le stop
 * suggéré place l'invalidation à `z_entry` écarts-types sous l'entrée.
 */
export class MeanReversionStrategy implements Strategy {
  readonly name = 'mean_reversion';
  readonly requiredData: DataRequirement[];

  constructor(private readonly params: MeanReversionParams) {
    this.requiredData = [{ timeframe: params.timeframe, bars: meanReversionRequiredBars(params) }];
  }

  get parameterSummary(): MeanReversionParams {
    return this.params;
  }

  evaluate(market: MarketSnapshot): Signal[] {
    const { params } = this;
    const timeframeMs = TIMEFRAMES[params.timeframe];
    const minBars = meanReversionRequiredBars(params);
    const signals: Signal[] = [];

    for (const asset of market.assets) {
      const candles = closedCandles(asset.candles[params.timeframe], timeframeMs, market.ts);
      if (candles.length < minBars) continue;
      const signal = this.evaluateAsset(asset, candles, market);
      if (signal !== null) signals.push(signal);
    }
    return signals;
  }

  private evaluateAsset(
    asset: AssetSnapshot,
    candles: Candle[],
    market: MarketSnapshot,
  ): Signal | null {
    const { params } = this;
    const closes = candles.slice(-params.window).map((candle) => candle.close);
    const mean = average(closes);
    const sigma = stdev(closes);
    if (mean === null || sigma === null || !(mean > 0) || !(sigma > 0)) return null;

    const lastClose = closes[closes.length - 1]!;
    const price = asset.priceUsd > 0 ? asset.priceUsd : lastClose;
    if (!(price > 0)) return null;

    return params.mode === 'zscore'
      ? this.zscoreSignal(asset, price, mean, sigma)
      : this.gridSignal(asset, price, mean, market);
  }

  private zscoreSignal(
    asset: AssetSnapshot,
    price: number,
    mean: number,
    sigma: number,
  ): Signal | null {
    const { params } = this;
    const z = (price - mean) / sigma;

    // Sortie : retour à la moyenne (z remonte au-dessus de -z_exit).
    if (z >= -params.zExit) {
      const edgeBps = Math.max(0, ((z + params.zExit) * sigma * 10_000) / price);
      return {
        assetMint: asset.mint,
        symbol: asset.symbol,
        side: 'sell',
        confidence: 0.55,
        edgeEstimateBps: edgeBps,
        ttlMs: TTL_MS,
        reason: `retour à la moyenne (z ${z.toFixed(2)} ≥ -${params.zExit})`,
      };
    }

    // Entrée : survente.
    if (z > -params.zEntry) return null;
    const overshoot = (Math.abs(z) - params.zEntry) / params.zEntry;
    const confidence = clamp01(0.4 + 0.6 * Math.min(1, overshoot));
    const edgeBps = Math.max(0, ((Math.abs(z) - params.zExit) * sigma * 10_000) / price);
    const stopPct = clamp((params.zEntry * sigma * 100) / price, 1, 50);

    return {
      assetMint: asset.mint,
      symbol: asset.symbol,
      side: 'buy',
      confidence,
      edgeEstimateBps: edgeBps,
      ttlMs: TTL_MS,
      reason: `survente (z ${z.toFixed(2)} ≤ -${params.zEntry}, fenêtre ${params.window})`,
      suggestedStopLossPct: stopPct,
    };
  }

  private gridSignal(
    asset: AssetSnapshot,
    price: number,
    anchor: number,
    market: MarketSnapshot,
  ): Signal | null {
    const { params } = this;
    const level = deepestGridLevel(price, anchor, params.gridStepPct, params.gridLevels);

    if (level === 0) {
      // Sortie : retour à l'ancre (ou au-dessus).
      if (price < anchor) return null;
      return {
        assetMint: asset.mint,
        symbol: asset.symbol,
        side: 'sell',
        confidence: 0.55,
        edgeEstimateBps: Math.max(0, ((price - anchor) * 10_000) / price),
        ttlMs: TTL_MS,
        reason: `grille : retour à l'ancre (${price.toPrecision(6)} ≥ ${anchor.toPrecision(6)})`,
      };
    }

    const held = market.portfolio?.positionsByMint.get(asset.mint);
    if (held !== undefined) {
      const nextLevel = held.avgEntryPriceUsd * (1 - params.gridStepPct / 100);
      if (!(price <= nextLevel)) return null; // attend un palier plus bas que le prix moyen
    }

    const confidence = clamp01(0.4 + 0.6 * (level / params.gridLevels));
    const edgeBps = Math.max(0, ((anchor - price) * 10_000) / price);
    const stopPct = clamp(params.gridLevels * params.gridStepPct + 0.5, 1, 50);
    return {
      assetMint: asset.mint,
      symbol: asset.symbol,
      side: 'buy',
      confidence,
      edgeEstimateBps: edgeBps,
      ttlMs: TTL_MS,
      reason: `grille niveau ${level}/${params.gridLevels} (prix ≤ ancre − ${level} × ${params.gridStepPct} %)`,
      suggestedStopLossPct: stopPct,
      ...(held === undefined ? {} : { allowAdd: true }),
    };
  }
}

/** Palier de grille le plus profond atteint (0 = prix ≥ ancre ou grille vide). */
function deepestGridLevel(price: number, anchor: number, stepPct: number, levels: number): number {
  let level = 0;
  for (let candidate = 1; candidate <= levels; candidate++) {
    if (price <= anchor * (1 - (candidate * stepPct) / 100)) level = candidate;
  }
  return level;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
