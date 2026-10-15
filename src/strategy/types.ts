import type { Candle } from '../state/market-data.js';
import type { Timeframe } from '../market/ohlcv.js';

/** Ce qu'une stratégie exige pour pouvoir évaluer un actif. */
export interface DataRequirement {
  timeframe: Timeframe;
  /** Nombre de bougies **clôturées** nécessaires. */
  bars: number;
}

/** Vue d'un actif au moment de l'évaluation. */
export interface AssetSnapshot {
  mint: string;
  symbol: string;
  priceUsd: number;
  liquidityUsd: number | null;
  /** Bougies par timeframe (dernière incluse, éventuellement en cours de formation). */
  candles: Partial<Record<Timeframe, Candle[]>>;
}

export interface MarketSnapshot {
  ts: number;
  assets: AssetSnapshot[];
}

export interface Signal {
  assetMint: string;
  symbol: string;
  side: 'buy' | 'sell';
  /** 0..1 — sert à l'arbitrage entre stratégies. */
  confidence: number;
  /** Edge estimé en bps (optionnel, net de frais). */
  edgeEstimateBps?: number;
  /** Durée de validité du signal (ms). */
  ttlMs: number;
  /** Motif lisible, journalisé pour audit. */
  reason: string;
  /** Stop suggéré en % sous le prix d'entrée (ex. stop ATR du momentum). */
  suggestedStopLossPct?: number;
}

/**
 * Contrat unique de toutes les stratégies (section 8 du README).
 * Une stratégie est **pure** : elle observe un snapshot et émet des signaux ;
 * elle ne touche ni au portefeuille, ni au risque, ni à l'exécution.
 */
export interface Strategy {
  name: string;
  requiredData: DataRequirement[];
  /** Émet des signaux candidats — `[]` si les données sont insuffisantes. */
  evaluate(market: MarketSnapshot): Signal[];
}

/** Bougies **clôturées** d'un timeframe (la dernière bougie en cours est exclue). */
export function closedCandles(
  candles: Candle[] | undefined,
  timeframeMs: number,
  now: number,
): Candle[] {
  if (candles === undefined || candles.length === 0) return [];
  const last = candles[candles.length - 1]!;
  const isComplete = last.bucketStart + timeframeMs <= now;
  return isComplete ? candles : candles.slice(0, -1);
}
