import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/state/market-data.js';
import {
  MomentumStrategy,
  momentumRequiredBars,
  parseMomentumParams,
} from '../src/strategy/momentum.js';

const MINT = 'M'.repeat(44);
const TF_MS = 900_000;
const BASE_TS = 1_750_000_000_000 - (1_750_000_000_000 % TF_MS);

/**
 * Série calibrée (cf. calibration du 15/10) : tendance haussière en dents de
 * scie qui maintiendra EMA12 > EMA26 avec un RSI en zone neutre, puis une
 * dernière bougie en breakout + volume. `volumeMult` contrôle la confirmation
 * de volume ; `up`/`down` l'inclinaison de la tendance.
 */
function makeCandles(options: {
  up: number;
  down: number;
  period: number;
  count: number;
  breakout: number;
  volumeMult: number;
}): Candle[] {
  const candles: Candle[] = [];
  let close = 100;
  for (let index = 0; index < options.count; index++) {
    const isLast = index === options.count - 1;
    const step = isLast
      ? 0
      : index % options.period === options.period - 1
        ? -options.down
        : options.up;
    close = close + step;
    let closeValue = close;
    if (isLast) {
      const priorHigh = Math.max(...candles.slice(-20).map((entry) => entry.high));
      closeValue = priorHigh * (1 + options.breakout);
    }
    candles.push({
      mint: MINT,
      timeframe: '15m',
      bucketStart: BASE_TS + index * TF_MS,
      open: closeValue * 0.999,
      high: closeValue * 1.001,
      low: closeValue * 0.999,
      close: closeValue,
      tickCount: 30,
      volumeUsd: isLast ? 1000 * options.volumeMult : 1000,
    });
    close = closeValue;
  }
  return candles;
}

function evaluate(candles: Candle[], priceUsd = 0) {
  const strategy = new MomentumStrategy(parseMomentumParams({}, '15m'));
  return {
    strategy,
    signals: strategy.evaluate({
      ts: BASE_TS + (candles.length + 1) * TF_MS, // toutes les bougies sont clôturées
      assets: [
        {
          mint: MINT,
          symbol: 'TEST',
          priceUsd,
          liquidityUsd: 1_000_000,
          candles: { '15m': candles },
        },
      ],
    }),
  };
}

describe('parseMomentumParams', () => {
  it('applique les défauts et refuse les paramètres invalides', () => {
    const params = parseMomentumParams({}, '15m');
    expect(params).toMatchObject({
      ema_fast: 12,
      ema_slow: 26,
      breakout_lookback: 20,
      volume_mult: 1.5,
    });
    expect(momentumRequiredBars(params)).toBe(27);

    expect(() => parseMomentumParams({}, '7m')).toThrow(/Timeframe/);
    expect(() => parseMomentumParams({ ema_fast: 1 }, '15m')).toThrow(/ema_fast/);
    expect(() => parseMomentumParams({ volume_mult: -1 }, '15m')).toThrow(/volume_mult/);
  });
});

describe('MomentumStrategy', () => {
  const good = { up: 0.4, down: 0.3, period: 2, count: 32, breakout: 0.004, volumeMult: 2.5 };

  it('émet un achat sur breakout confirmé (tendance + RSI + volume)', () => {
    const { signals } = evaluate(makeCandles(good));
    expect(signals).toHaveLength(1);
    const signal = signals[0]!;
    expect(signal.side).toBe('buy');
    expect(signal.confidence).toBeGreaterThan(0.5);
    expect(signal.confidence).toBeLessThanOrEqual(1);
    expect(signal.suggestedStopLossPct).toBeGreaterThanOrEqual(1);
    expect(signal.suggestedStopLossPct).toBeLessThanOrEqual(50);
    expect(signal.reason).toContain('breakout');
    expect(signal.reason).toContain('EMA12>EMA26');
    expect(signal.ttlMs).toBeGreaterThan(0);
  });

  it('ne confirme pas le breakout sans volume', () => {
    const { signals } = evaluate(makeCandles({ ...good, volumeMult: 1 }));
    expect(signals).toEqual([]);
  });

  it('abstient sans assez de bougies clôturées', () => {
    const { signals } = evaluate(makeCandles({ ...good, count: 10 }));
    expect(signals).toEqual([]);
  });

  it('émet une vente quand la tendance EMA s’inverse', () => {
    const { signals } = evaluate(makeCandles({ ...good, up: 0.2, down: 0.5 }));
    expect(signals).toHaveLength(1);
    expect(signals[0]!.side).toBe('sell');
    expect(signals[0]!.reason).toContain('tendance EMA baissière');
  });

  it('utilise le prix spot du snapshot quand il est fourni', () => {
    const candles = makeCandles(good);
    const last = candles.at(-1)!;
    const { signals } = evaluate(candles, last.close * 100);
    expect(signals[0]!.side).toBe('buy');
  });

  it('ignore la bougie en cours de formation', () => {
    const candles = makeCandles({ ...good, up: 0.2, down: 0.5 }); // tendance baissière → vente
    const now = BASE_TS + candles.length * TF_MS + 60_000;
    // Bougie en cours démesurément haussière : si elle était prise en compte,
    // la tendance ne serait plus baissière. Elle doit être ignorée.
    const inProgress: Candle = {
      ...candles.at(-1)!,
      bucketStart: BASE_TS + candles.length * TF_MS,
      close: 999,
      high: 999,
      low: 990,
      volumeUsd: 999_999,
    };
    const strategy = new MomentumStrategy(parseMomentumParams({}, '15m'));
    const signals = strategy.evaluate({
      ts: now,
      assets: [
        {
          mint: MINT,
          symbol: 'TEST',
          priceUsd: 999,
          liquidityUsd: 1_000_000,
          candles: { '15m': [...candles, inProgress] },
        },
      ],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.side).toBe('sell');
  });
});
