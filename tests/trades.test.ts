import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/state/db.js';
import { runMigrations } from '../src/state/migrations.js';
import { getRecentTrades, insertTrade, type TradeRecord } from '../src/state/trades.js';

function record(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    mode: 'live',
    status: 'success',
    signature: 'SIG',
    requestId: 'req-1',
    inputMint: 'In'.padEnd(43, 'x'),
    outputMint: 'Out'.padEnd(43, 'y'),
    inAmount: '50000000',
    expectedOutAmount: '5123456',
    outAmount: '5100000',
    router: 'metis',
    feeBps: 10,
    feeMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    priceImpact: -0.08,
    slippageBps: 50,
    realizedSlippageBps: 4,
    errorCode: null,
    errorMessage: null,
    createdAt: 1_000,
    ...overrides,
  };
}

function memoryDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

describe('trades', () => {
  it('insère et relit un trade complet, id compris', () => {
    const db = memoryDb();
    const id = insertTrade(db, record());

    const trades = getRecentTrades(db);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toEqual({ ...record(), id });
    db.close();
  });

  it('conserve la précision des montants u64 (texte) et l’ordre récent', () => {
    const db = memoryDb();
    const big = '18446744073709551615'; // u64 max
    insertTrade(db, record({ inAmount: big, createdAt: 1 }));
    insertTrade(
      db,
      record({
        status: 'failed',
        signature: null,
        outAmount: null,
        realizedSlippageBps: null,
        errorCode: -1005,
        errorMessage: 'transaction expirée',
        createdAt: 2,
      }),
    );

    const trades = getRecentTrades(db);
    expect(trades[0]?.createdAt).toBe(2);
    expect(trades[0]).toMatchObject({ status: 'failed', errorCode: -1005 });
    expect(trades[1]?.inAmount).toBe(big);
    expect(trades[1]?.signature).toBe('SIG');
    db.close();
  });

  it('respecte la limite de getRecentTrades', () => {
    const db = memoryDb();
    for (let index = 0; index < 5; index++) {
      insertTrade(db, record({ createdAt: index }));
    }
    expect(getRecentTrades(db, 2)).toHaveLength(2);
    expect(getRecentTrades(db, 2)[0]?.createdAt).toBe(4);
    db.close();
  });
});
