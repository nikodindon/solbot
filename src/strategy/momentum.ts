import { TIMEFRAMES, type Timeframe } from '../market/ohlcv.js';
import type { Candle } from '../state/market-data.js';
import { SolbotError } from '../utils/errors.js';
import { atr, ema, highest, median, rsi } from './indicators.js';
import {
  closedCandles,
  type AssetSnapshot,
  type DataRequirement,
  type MarketSnapshot,
  type Signal,
  type Strategy,
} from './types.js';

export interface MomentumParams {
  timeframe: Timeframe;
  ema_fast: number;
  ema_slow: number;
  rsi_period: number;
  rsi_entry: number;
  atr_period: number;
  atr_stop_mult: number;
  breakout_lookback: number;
  volume_mult: number;
  volume_lookback: number;
}

/** Doivent rester alignés avec `MOMENTUM_DEFAULT` de la config. */
export const MOMENTUM_DEFAULTS: Omit<MomentumParams, 'timeframe'> = {
  ema_fast: 12,
  ema_slow: 26,
  rsi_period: 14,
  rsi_entry: 65,
  atr_period: 14,
  atr_stop_mult: 2,
  breakout_lookback: 20,
  volume_mult: 1.5,
  volume_lookback: 20,
};

const TTL_MS = 90_000;

/** Bougies clôturées nécessaires pour évaluer (tous filtres confondus). */
export function momentumRequiredBars(params: MomentumParams): number {
  return Math.max(
    params.ema_slow + 1,
    params.rsi_period + 1,
    params.atr_period + 1,
    params.breakout_lookback + 1,
    params.volume_lookback + 1,
  );
}

/** Valide et normalise les paramètres momentum de `config.yaml`. */
export function parseMomentumParams(
  raw: Record<string, unknown>,
  timeframe: string,
): MomentumParams {
  const merged = { ...MOMENTUM_DEFAULTS, ...raw, timeframe } as Record<string, unknown>;
  if (!(timeframe in TIMEFRAMES)) {
    throw new SolbotError(
      `Timeframe momentum « ${timeframe} » inconnu (attendu : ${Object.keys(TIMEFRAMES).join(', ')})`,
    );
  }
  const positiveInt = (key: string): number => {
    const value = Number(merged[key]);
    if (!Number.isInteger(value) || value < 2) {
      throw new SolbotError(
        `Paramètre momentum ${key} invalide : ${String(merged[key])} (entier ≥ 2)`,
      );
    }
    return value;
  };
  const positive = (key: string): number => {
    const value = Number(merged[key]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new SolbotError(`Paramètre momentum ${key} invalide : ${String(merged[key])} (> 0)`);
    }
    return value;
  };

  return {
    timeframe: timeframe as Timeframe,
    ema_fast: positiveInt('ema_fast'),
    ema_slow: positiveInt('ema_slow'),
    rsi_period: positiveInt('rsi_period'),
    rsi_entry: positive('rsi_entry'),
    atr_period: positiveInt('atr_period'),
    atr_stop_mult: positive('atr_stop_mult'),
    breakout_lookback: positiveInt('breakout_lookback'),
    volume_mult: positive('volume_mult'),
    volume_lookback: positiveInt('volume_lookback'),
  };
}

/**
 * Stratégie **momentum** : breakout sur plus haut de `breakout_lookback` bougies,
 * confirmé par la tendance EMA rapide > lente, un RSI non suracheté et un volume
 * en hausse (volume 24 h agrégé par bougie). Sortie quand la tendance EMA
 * s'inverse ; le stop initial est dérivé de l'ATR (transmis au portefeuille via
 * `suggestedStopLossPct`).
 */
export class MomentumStrategy implements Strategy {
  readonly name = 'momentum';
  readonly requiredData: DataRequirement[];

  constructor(private readonly params: MomentumParams) {
    this.requiredData = [{ timeframe: params.timeframe, bars: momentumRequiredBars(params) }];
  }

  get parameterSummary(): MomentumParams {
    return this.params;
  }

  evaluate(market: MarketSnapshot): Signal[] {
    const { params } = this;
    const timeframeMs = TIMEFRAMES[params.timeframe];
    const minBars = momentumRequiredBars(params);
    const signals: Signal[] = [];

    for (const asset of market.assets) {
      const candles = closedCandles(asset.candles[params.timeframe], timeframeMs, market.ts);
      if (candles.length < minBars) continue;

      const signal = this.evaluateAsset(asset, candles);
      if (signal !== null) signals.push(signal);
    }
    return signals;
  }

  private evaluateAsset(asset: AssetSnapshot, candles: Candle[]): Signal | null {
    const { params } = this;
    const closes = candles.map((candle) => candle.close);
    const emaFast = ema(closes, params.ema_fast);
    const emaSlow = ema(closes, params.ema_slow);
    const lastClose = closes[closes.length - 1]!;
    const price = asset.priceUsd > 0 ? asset.priceUsd : lastClose;
    if (emaFast === null || emaSlow === null) return null;

    // ── Sortie : la tendance s'est inversée (état, pas seulement croisement) ──
    if (emaFast < emaSlow) {
      return {
        assetMint: asset.mint,
        symbol: asset.symbol,
        side: 'sell',
        confidence: 0.6,
        ttlMs: TTL_MS,
        reason: `tendance EMA baissière (EMA${params.ema_fast} ${emaFast.toPrecision(5)} < EMA${params.ema_slow} ${emaSlow.toPrecision(5)})`,
      };
    }

    // ── Entrée : breakout confirmé ──
    const rsiValue = rsi(closes, params.rsi_period);
    const atrValue = atr(candles, params.atr_period);
    if (rsiValue === null || atrValue === null || atrValue <= 0) return null;
    if (rsiValue >= params.rsi_entry) return null;

    const history = candles.slice(0, -1); // bougies antérieures à la bougie de signal
    const breakoutWindow = history.slice(-params.breakout_lookback);
    const priorHigh = highest(
      breakoutWindow.map((candle) => candle.high),
      breakoutWindow.length,
    );
    if (priorHigh === null || priorHigh <= 0 || price <= priorHigh) return null;
    if (price <= emaSlow) return null;

    const volumeRatio = this.volumeRatio(candles);
    const volumeOk = volumeRatio === null || volumeRatio >= params.volume_mult;
    if (!volumeOk) return null;

    const breakoutMargin = (price - priorHigh) / priorHigh;
    const trendSpread = (emaFast - emaSlow) / emaSlow;
    const volumeScore =
      volumeRatio === null ? 0.5 : clamp01((volumeRatio - 1) / Math.max(1, params.volume_mult));
    const breakoutScore = clamp01(breakoutMargin / 0.02);
    const trendScore = clamp01(trendSpread / 0.03);
    const confidence = clamp01(0.4 + 0.2 * volumeScore + 0.2 * breakoutScore + 0.2 * trendScore);

    const stopPct = clamp((params.atr_stop_mult * atrValue * 100) / price, 1, 50);

    const volumeText =
      volumeRatio === null ? 'volume indisponible' : `volume ×${volumeRatio.toFixed(1)}`;
    return {
      assetMint: asset.mint,
      symbol: asset.symbol,
      side: 'buy',
      confidence,
      ttlMs: TTL_MS,
      reason:
        `breakout (${price.toPrecision(6)} > ${priorHigh.toPrecision(6)} sur ${params.breakout_lookback} bougies) · ` +
        `EMA${params.ema_fast}>EMA${params.ema_slow} · RSI ${rsiValue.toFixed(1)} · ${volumeText}`,
      suggestedStopLossPct: stopPct,
    };
  }

  /** Volume de la bougie de signal vs médiane des précédentes ; `null` si pas de volume. */
  private volumeRatio(candles: Candle[]): number | null {
    const window = candles.slice(0, -1).slice(-this.params.volume_lookback);
    const baseline = median(window.map((candle) => candle.volumeUsd));
    if (baseline === null || baseline <= 0) return null;
    return candles[candles.length - 1]!.volumeUsd / baseline;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
