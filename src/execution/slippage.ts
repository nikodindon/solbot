import type { DatabaseSync } from 'node:sqlite';
import { TIMEFRAMES, type Timeframe } from '../market/ohlcv.js';
import { getCandles, type Candle } from '../state/market-data.js';

/**
 * Slippage adaptatif (Phase 6c).
 *
 * RTSE (slippage automatique de Jupiter) reste la référence ; `adaptive`
 * choisit une borne fixe proportionnelle à la volatilité récente de l'actif
 * d'entrée (ATR des bougies stockées), afin de tolérer plus de mouvement sur
 * les paires agitées et moins sur les paires calmes :
 *
 *   borne (bps) = clamp(atrPct × 10 000 × multiplier, min_bps, max_bps)
 *
 * Si l'historique de bougies est insuffisant, l'exécuteur retombe sur RTSE
 * (prudent : la machinerie de repli est celle de 6a). Un échec classé
 * « slippage » déclenche une re-cotation avec une borne élargie (voir
 * `bumpedSlippageBps`), toujours plafonnée par `risk.max_slippage_bps`.
 */

export interface AdaptiveSlippageOptions {
  timeframe: Timeframe;
  /** Période de l'ATR (nombre de vraies amplitudes moyennées). */
  period: number;
  /** Multiplicateur appliqué à l'ATR (%) pour obtenir la borne (bps). */
  multiplier: number;
  minBps: number;
  maxBps: number;
}

/**
 * ATR sur bougies fermées, exprimé en fraction du dernier close (ex. 0.003 =
 * 0,3 %). `undefined`/`null` si l'historique est insuffisant ou inexploitable.
 * `now` (ms) permet d'écarter une bougie encore en cours de constitution.
 */
export function atrPctFromCandles(
  candles: ReadonlyArray<Pick<Candle, 'bucketStart' | 'high' | 'low' | 'close'>>,
  period: number,
  options: { timeframeMs: number; now?: number } = { timeframeMs: 0 },
): number | null {
  let usable = candles;
  if (options.timeframeMs > 0 && options.now !== undefined) {
    usable = candles.filter((candle) => candle.bucketStart + options.timeframeMs <= options.now!);
  }
  if (usable.length < period + 1) return null;

  const window = usable.slice(-(period + 1));
  let trueRangeSum = 0;
  for (let index = 1; index < window.length; index++) {
    const candle = window[index]!;
    const previous = window[index - 1]!;
    const trueRange = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previous.close),
      Math.abs(candle.low - previous.close),
    );
    if (!Number.isFinite(trueRange) || trueRange < 0) return null;
    trueRangeSum += trueRange;
  }
  const averageTrueRange = trueRangeSum / period;
  const lastClose = window.at(-1)!.close;
  if (!Number.isFinite(lastClose) || lastClose <= 0) return null;
  const pct = averageTrueRange / lastClose;
  return Number.isFinite(pct) ? pct : null;
}

/** Borne de slippage (bps) déduite de l'ATR des bougies fournies. */
export function adaptiveSlippageBpsFromCandles(
  candles: ReadonlyArray<Pick<Candle, 'bucketStart' | 'high' | 'low' | 'close'>>,
  options: AdaptiveSlippageOptions,
  now?: number,
): number | null {
  const pct = atrPctFromCandles(candles, options.period, {
    timeframeMs: TIMEFRAMES[options.timeframe],
    ...(now === undefined ? {} : { now }),
  });
  if (pct === null) return null;
  // Arrondi au millionième avant l'arrondi supérieur : évite qu'un ATR de
  // 0,3 % (30 bps) devienne 31 bps à cause du bruit flottant (30.000000000000004).
  const raw = Math.ceil(Number((pct * 10_000 * options.multiplier).toFixed(6)));
  if (!Number.isFinite(raw)) return null;
  return Math.min(Math.max(raw, options.minBps), options.maxBps);
}

/**
 * Borne de slippage (bps) pour un mint donné, calculée depuis les bougies
 * stockées. `null` si l'historique est insuffisant — l'appelant retombe alors
 * sur RTSE.
 */
export function adaptiveSlippageBps(
  db: DatabaseSync,
  mint: string,
  options: AdaptiveSlippageOptions,
  now: number = Date.now(),
): number | null {
  // +2 : une bougie en cours (écartée) et le close précédent nécessaire à l'ATR.
  const candles = getCandles(db, mint, options.timeframe, options.period + 2);
  return adaptiveSlippageBpsFromCandles(candles, options, now);
}

/**
 * Borne élargie après un échec de type slippage : × facteur, au moins +1 bps,
 * plafonnée par `risk.max_slippage_bps`. Seules les bornes numériques sont
 * élargies — RTSE re-cote de lui-même à chaque appel.
 */
export function bumpedSlippageBps(current: number, factor: number, maxBps: number): number {
  return Math.min(maxBps, Math.max(current + 1, Math.ceil(current * factor)));
}

/** Motifs d'échec « slippage » (message RPC, erreur Jupiter, erreur custom 6001). */
const SLIPPAGE_PATTERNS: readonly RegExp[] = [
  /exceeded.?slippage/i,
  /slippage.*(?:exceed|toleran)/i,
  /0x1771/i, // SlippageToleranceExceeded (6001) en hexadécimal
  /custom\D{0,6}6001/i, // { "InstructionError": [3, { "Custom": 6001 }] } sérialisé
];

/**
 * Texte exploitable d'une erreur : message d'`Error`, chaîne telle quelle, ou
 * JSON compact pour les erreurs RPC structurées (`{ InstructionError: … }`),
 * que `String()` rendrait illisibles (« [object Object] »).
 */
export function failureText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error === null || error === undefined) return '';
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** `true` si le message traduit un dépassement de slippage (échec re-cotable). */
export function isSlippageFailure(message: string | null | undefined): boolean {
  if (message === null || message === undefined || message === '') return false;
  return SLIPPAGE_PATTERNS.some((pattern) => pattern.test(message));
}
