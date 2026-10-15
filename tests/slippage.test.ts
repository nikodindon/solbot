import { describe, expect, it } from 'vitest';
import type { CandleUpdate } from '../src/market/ohlcv.js';
import {
  adaptiveSlippageBps,
  adaptiveSlippageBpsFromCandles,
  atrPctFromCandles,
  bumpedSlippageBps,
  failureText,
  isSlippageFailure,
} from '../src/execution/slippage.js';
import { upsertCandles } from '../src/state/market-data.js';
import { openDatabase } from '../src/state/db.js';
import { runMigrations } from '../src/state/migrations.js';

const SOL = 'So11111111111111111111111111111111111111112';
const TF_MS = 900_000;
const OPTIONS = {
  timeframe: '15m' as const,
  period: 2,
  multiplier: 1,
  minBps: 10,
  maxBps: 100,
};

/** Bougie synthétique : amplitude `high - low` autour d'un close stable à 100. */
function candle(index: number, range = 0.3, overrides: Partial<CandleUpdate> = {}): CandleUpdate {
  return {
    mint: SOL,
    timeframe: '15m',
    bucketStart: index * TF_MS,
    open: 100,
    high: 100 + range / 2,
    low: 100 - range / 2,
    close: 100,
    volumeUsd: 1,
    ...overrides,
  };
}

function series(count: number, range = 0.3): CandleUpdate[] {
  return Array.from({ length: count }, (_, index) => candle(index, range));
}

function memoryDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

describe('ATR sur bougies', () => {
  it('calcule l’ATR en fraction du dernier close', () => {
    // Amplitude constante de 0,3 sur un close de 100 → ATR = 0,3 %.
    expect(atrPctFromCandles(series(4), 2, { timeframeMs: TF_MS })).toBeCloseTo(0.003, 9);
  });

  it('exige au moins période + 1 bougies', () => {
    expect(atrPctFromCandles(series(2), 2, { timeframeMs: TF_MS })).toBeNull();
    expect(atrPctFromCandles([], 2, { timeframeMs: TF_MS })).toBeNull();
  });

  it('intègre les gaps (vraie amplitude vs close précédent)', () => {
    // Candle 0 → 1 : gap de +10 (high - prevClose = 10) malgré une amplitude de 0,3.
    const candles = [
      candle(0, 0.3),
      candle(1, 0.3, { open: 110, high: 110, low: 109.5, close: 109.5 }),
    ];
    expect(atrPctFromCandles(candles, 1, { timeframeMs: TF_MS })).toBeCloseTo(10 / 109.5, 9);
  });

  it('écarte une bougie encore en cours quand `now` est fourni', () => {
    const closed = series(3);
    const withOpenBucket = [...closed, candle(3, 50)]; // bougie extrême, pas fermée
    const now = 3 * TF_MS + 1_000;
    expect(adaptiveSlippageBpsFromCandles(withOpenBucket, OPTIONS, now)).toBe(30);
    expect(adaptiveSlippageBpsFromCandles(closed, OPTIONS, now)).toBe(30);
  });
});

describe('borne adaptative', () => {
  it('convertit l’ATR en bps (arrondi supérieur, bornes respectées)', () => {
    expect(adaptiveSlippageBpsFromCandles(series(4), OPTIONS)).toBe(30); // 0,3 % → 30 bps
    expect(adaptiveSlippageBpsFromCandles(series(4, 0.01), OPTIONS)).toBe(10); // plancher min_bps
    expect(adaptiveSlippageBpsFromCandles(series(4, 5), OPTIONS)).toBe(100); // plafond max_bps
  });

  it('applique le multiplicateur', () => {
    expect(adaptiveSlippageBpsFromCandles(series(4), { ...OPTIONS, multiplier: 2 })).toBe(60);
  });

  it('lit les bougies stockées (période 14) et replie sur null sans historique', () => {
    const db = memoryDb();
    expect(adaptiveSlippageBps(db, SOL, { ...OPTIONS, period: 14 })).toBeNull();
    upsertCandles(db, series(16));
    expect(adaptiveSlippageBps(db, SOL, { ...OPTIONS, period: 14 })).toBe(30);
  });
});

describe('élargissement après échec slippage', () => {
  it('multiplie la borne, au moins +1 bps, plafonnée', () => {
    expect(bumpedSlippageBps(30, 2, 100)).toBe(60);
    expect(bumpedSlippageBps(80, 2, 100)).toBe(100);
    expect(bumpedSlippageBps(30, 1, 100)).toBe(31);
  });

  it('détecte les messages de dépassement de slippage', () => {
    expect(isSlippageFailure('ExceededSlippage')).toBe(true);
    expect(isSlippageFailure('Give up: slippage tolerance exceeded')).toBe(true);
    expect(isSlippageFailure('custom program error: 0x1771')).toBe(true);
    expect(isSlippageFailure('{"InstructionError":[3,{"Custom":6001}]}')).toBe(true);
    expect(isSlippageFailure('AccountNotFound')).toBe(false);
    expect(isSlippageFailure('')).toBe(false);
    expect(isSlippageFailure(null)).toBe(false);
    expect(isSlippageFailure(undefined)).toBe(false);
  });
});

describe('failureText', () => {
  it('rend les erreurs RPC structurées lisibles', () => {
    expect(failureText(new Error('boom'))).toBe('boom');
    expect(failureText('simple')).toBe('simple');
    expect(failureText({ InstructionError: [3, { Custom: 6001 }] })).toBe(
      '{"InstructionError":[3,{"Custom":6001}]}',
    );
    expect(failureText(null)).toBe('');
  });
});
