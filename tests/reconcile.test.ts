import { describe, expect, it } from 'vitest';
import { reconcileBalances, type ChainBalance } from '../src/engine/reconcile.js';
import { openDatabase } from '../src/state/db.js';
import { getRecentEvents } from '../src/state/events.js';
import { runMigrations } from '../src/state/migrations.js';
import {
  getOpenPosition,
  getPositionById,
  getPositionLots,
  openPosition,
  qtyToFloat,
} from '../src/state/positions.js';

const MINT = 'M'.repeat(44);
const EXTRA = 'E'.repeat(44);
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NOW = 1_750_000_000_000;

function memoryDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

function balance(overrides: Partial<ChainBalance> = {}): ChainBalance {
  return { mint: MINT, symbol: 'TEST', amount: '100000000', decimals: 6, ...overrides };
}

function options(
  db: ReturnType<typeof memoryDb>,
  balances: ChainBalance[],
  prices = new Map<string, number | null>([[MINT, 1.2]]),
) {
  return {
    db,
    balances,
    baseMint: USDC,
    prices,
    defaultStopLossPct: 8,
    defaultTakeProfitPct: 15,
    ts: NOW,
  };
}

describe('reconcileBalances', () => {
  it('ne touche à rien quand la chaîne et la base concordent', () => {
    const db = memoryDb();
    openPosition(db, {
      mint: MINT,
      symbol: 'TEST',
      decimals: 6,
      qty: '100000000',
      priceUsd: 1,
      ts: 1,
    });

    const result = reconcileBalances(options(db, [balance()]));
    expect(result).toEqual({ adopted: [], adjusted: [], closed: [], skipped: [] });
    expect(getOpenPosition(db, MINT)?.qtyRemaining).toBe('100000000');
    db.close();
  });

  it('réduit la position quand la chaîne détient moins (FIFO, PnL réalisé)', () => {
    const db = memoryDb();
    const position = openPosition(db, {
      mint: MINT,
      symbol: 'TEST',
      decimals: 6,
      qty: '100000000',
      priceUsd: 1,
      ts: 1,
    });

    const result = reconcileBalances(options(db, [balance({ amount: '60000000' })]));
    expect(result.adjusted).toEqual([MINT]);

    const reduced = getPositionById(db, position.id)!;
    expect(qtyToFloat(reduced.qtyRemaining, 6)).toBe(60);
    expect(reduced.realizedPnlUsd).toBeCloseTo(8, 10); // 40 × (1,2 − 1,0)
    expect(getRecentEvents(db)[0]).toMatchObject({ kind: 'reconcile_adjusted' });
    db.close();
  });

  it('clôture une position absente de la chaîne', () => {
    const db = memoryDb();
    const position = openPosition(db, {
      mint: MINT,
      symbol: 'TEST',
      decimals: 6,
      qty: '100000000',
      priceUsd: 1,
      ts: 1,
    });

    const result = reconcileBalances(options(db, []));
    expect(result.closed).toEqual([MINT]);
    expect(getPositionById(db, position.id)?.status).toBe('closed');
    expect(getOpenPosition(db, MINT)).toBeNull();
    expect(getRecentEvents(db)[0]).toMatchObject({ kind: 'reconcile_closed' });
    db.close();
  });

  it('augmente la position quand la chaîne détient plus', () => {
    const db = memoryDb();
    const position = openPosition(db, {
      mint: MINT,
      symbol: 'TEST',
      decimals: 6,
      qty: '100000000',
      priceUsd: 1,
      ts: 1,
    });

    const result = reconcileBalances(options(db, [balance({ amount: '150000000' })]));
    expect(result.adjusted).toEqual([MINT]);
    const updated = getPositionById(db, position.id)!;
    expect(qtyToFloat(updated.qtyRemaining, 6)).toBe(150);
    expect(updated.costBasisUsd).toBeCloseTo(160, 10); // 100 $ + 50 × 1,2 $
    expect(getPositionLots(db, position.id)).toHaveLength(2);
    db.close();
  });

  it('adopte un token détenu on-chain sans position locale (stop/tp par défaut)', () => {
    const db = memoryDb();
    const result = reconcileBalances(
      options(
        db,
        [balance({ mint: EXTRA, symbol: 'EXTRA', amount: '5000000' })],
        new Map([[EXTRA, 2]]),
      ),
    );

    expect(result.adopted).toEqual([EXTRA]);
    const adopted = getOpenPosition(db, EXTRA)!;
    expect(qtyToFloat(adopted.qtyRemaining, 6)).toBe(5);
    expect(adopted.avgEntryPriceUsd).toBe(2);
    expect(adopted.stopLossPriceUsd).toBeCloseTo(1.84, 10); // −8 %
    expect(adopted.takeProfitPriceUsd).toBeCloseTo(2.3, 10); // +15 %
    expect(getRecentEvents(db)[0]).toMatchObject({ kind: 'reconcile_adopt' });
    db.close();
  });

  it('ignore la devise de base et les soldes nuls', () => {
    const db = memoryDb();
    const result = reconcileBalances(
      options(db, [
        balance({ mint: USDC, symbol: 'USDC', amount: '10000000' }),
        balance({ mint: EXTRA, symbol: 'EXTRA', amount: '0' }),
      ]),
    );
    expect(result).toEqual({ adopted: [], adjusted: [], closed: [], skipped: [] });
    db.close();
  });

  it('n’adopte pas un token sans prix (événement de skip)', () => {
    const db = memoryDb();
    const result = reconcileBalances(
      options(db, [balance({ mint: EXTRA, symbol: 'EXTRA' })], new Map()),
    );
    expect(result.skipped).toEqual([EXTRA]);
    expect(getOpenPosition(db, EXTRA)).toBeNull();
    expect(getRecentEvents(db)[0]).toMatchObject({ kind: 'reconcile_skip' });
    db.close();
  });
});
