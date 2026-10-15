/** Agrégation OHLCV interne : ticks de prix → bougies par timeframe. */

export const TIMEFRAMES = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
} as const;

export type Timeframe = keyof typeof TIMEFRAMES;

export const TIMEFRAME_KEYS = Object.keys(TIMEFRAMES) as Timeframe[];

export interface PriceTick {
  mint: string;
  usdPrice: number;
  liquidityUsd: number | null;
  priceChange24h: number | null;
  blockId: number | null;
  ts: number;
}

export interface CandleUpdate {
  mint: string;
  timeframe: Timeframe;
  bucketStart: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Début du bucket contenant `ts` pour une durée de bougie donnée. */
export function bucketStart(ts: number, timeframeMs: number): number {
  return Math.floor(ts / timeframeMs) * timeframeMs;
}

/**
 * Convertit des ticks (triés par `ts` croissant) en mises à jour de bougies
 * pour chaque timeframe. Chaque tick produit une mise à jour « dégénérée »
 * (open = high = low = close) que la fusion SQLite (upsert) élargit ensuite.
 */
export function ticksToCandleUpdates(ticks: PriceTick[]): CandleUpdate[] {
  const updates: CandleUpdate[] = [];
  for (const tick of ticks) {
    for (const timeframe of TIMEFRAME_KEYS) {
      updates.push({
        mint: tick.mint,
        timeframe,
        bucketStart: bucketStart(tick.ts, TIMEFRAMES[timeframe]),
        open: tick.usdPrice,
        high: tick.usdPrice,
        low: tick.usdPrice,
        close: tick.usdPrice,
      });
    }
  }
  return updates;
}
