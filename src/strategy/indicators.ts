import type { Candle } from '../state/market-data.js';

/**
 * Indicateurs techniques déterministes, sans dépendance externe.
 * Toutes les fonctions retournent `null` quand l'historique est insuffisant —
 * jamais de valeurs approximatives silencieuses.
 */

/** Série EMA complète (le premier point = `values[0]`). */
export function emaSeries(values: number[], period: number): number[] {
  if (period < 1) throw new Error(`période EMA invalide : ${period}`);
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const series = [values[0]!];
  for (let index = 1; index < values.length; index++) {
    const previous = series[index - 1]!;
    series.push(values[index]! * k + previous * (1 - k));
  }
  return series;
}

/** Dernière valeur EMA, ou `null` si la série est vide. */
export function ema(values: number[], period: number): number | null {
  const series = emaSeries(values, period);
  return series.length === 0 ? null : series[series.length - 1]!;
}

/** RSI de Wilder (lissage exponentiel), ou `null` si moins de `period + 1` valeurs. */
export function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index++) {
    const change = values[index]! - values[index - 1]!;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let index = period + 1; index < values.length; index++) {
    const change = values[index]! - values[index - 1]!;
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** ATR de Wilder sur les bougies (true range lissé), ou `null` si insuffisant. */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trueRanges: number[] = [];
  for (let index = 1; index < candles.length; index++) {
    const current = candles[index]!;
    const previousClose = candles[index - 1]!.close;
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previousClose),
        Math.abs(current.low - previousClose),
      ),
    );
  }

  // Première moyenne simple puis lissage de Wilder.
  let value = 0;
  for (let index = 0; index < period; index++) value += trueRanges[index]!;
  value /= period;
  for (let index = period; index < trueRanges.length; index++) {
    value = (value * (period - 1) + trueRanges[index]!) / period;
  }
  return value;
}

/** Plus haute valeur d'une fenêtre (les `count` dernières valeurs, ou `null`). */
export function highest(values: number[], count: number): number | null {
  if (count < 1 || values.length < count) return null;
  const window = values.slice(-count);
  return Math.max(...window);
}

/** Médiane (copie triée, valeurs non finies ignorées) ; `null` si aucune valeur. */
export function median(values: number[]): number | null {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 === 0 ? (clean[middle - 1]! + clean[middle]!) / 2 : clean[middle]!;
}

/** Moyenne arithmétique (valeurs finies uniquement) ; `null` si aucune valeur. */
export function average(values: number[]): number | null {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length === 0) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

/**
 * Écart-type de population (valeurs finies uniquement) ; `null` si aucune
 * valeur. Une seule valeur → `0`.
 */
export function stdev(values: number[]): number | null {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length === 0) return null;
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  const variance = clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / clean.length;
  return Math.sqrt(variance);
}
