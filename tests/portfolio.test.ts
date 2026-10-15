import { describe, expect, it } from 'vitest';
import { Portfolio } from '../src/portfolio/portfolio.js';
import { openDatabase } from '../src/state/db.js';
import { runMigrations } from '../src/state/migrations.js';
import {
  getOpenPosition,
  getOpenPositions,
  getPositionById,
  getPositionLots,
  openPosition,
  addToPosition,
  qtyToFloat,
  reducePositionFifo,
  updatePositionMarks,
} from '../src/state/positions.js';

function memoryDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

const MINT = 'M'.repeat(44);

describe('positions (FIFO)', () => {
  it('ouvre une position avec un premier lot et un pic initial', () => {
    const db = memoryDb();
    const position = openPosition(db, {
      mint: MINT,
      symbol: 'TEST',
      decimals: 6,
      qty: '100000000', // 100 unités
      priceUsd: 1,
      ts: 1_000,
      stopLossPriceUsd: 0.9,
      takeProfitPriceUsd: 1.2,
    });

    expect(position).toMatchObject({
      mint: MINT,
      status: 'open',
      qty: '100000000',
      qtyRemaining: '100000000',
      avgEntryPriceUsd: 1,
      costBasisUsd: 100,
      realizedPnlUsd: 0,
      peakPriceUsd: 1,
      stopLossPriceUsd: 0.9,
      takeProfitPriceUsd: 1.2,
    });
    expect(getPositionLots(db, position.id)).toHaveLength(1);
    db.close();
  });

  it('augmente une position existante (prix moyen pondéré, lot ajouté)', () => {
    const db = memoryDb();
    const first = openPosition(db, {
      mint: MINT,
      symbol: 'TEST',
      decimals: 6,
      qty: '100000000',
      priceUsd: 1,
      ts: 1_000,
    });
    const merged = openPosition(db, {
      mint: MINT,
      symbol: 'TEST',
      decimals: 6,
      qty: '100000000',
      priceUsd: 1.5,
      ts: 2_000,
    });

    expect(merged.id).toBe(first.id);
    expect(qtyToFloat(merged.qtyRemaining, 6)).toBe(200);
    expect(merged.costBasisUsd).toBeCloseTo(250, 10);
    expect(merged.avgEntryPriceUsd).toBeCloseTo(1.25, 10);
    expect(getPositionLots(db, merged.id)).toHaveLength(2);
    db.close();
  });

  it('vend en FIFO : le lot le plus ancien part en premier', () => {
    const db = memoryDb();
    const position = openPosition(db, {
      mint: MINT,
      symbol: 'TEST',
      decimals: 6,
      qty: '100000000',
      priceUsd: 1,
      ts: 1_000,
    });
    addToPosition(db, position.id, { qty: '100000000', priceUsd: 1.2, ts: 2_000 });

    // Vente de 150 unités à 1,5 $ : 100 × (1,5 − 1,0) + 50 × (1,5 − 1,2) = 65 $.
    const { position: reduced, realizedPnlUsd } = reducePositionFifo(db, position.id, {
      qty: '150000000',
      sellPriceUsd: 1.5,
      ts: 3_000,
    });

    expect(realizedPnlUsd).toBeCloseTo(65, 10);
    expect(qtyToFloat(reduced.qtyRemaining, 6)).toBe(50);
    expect(reduced.costBasisUsd).toBeCloseTo(60, 10); // 50 restantes à 1,2 $
    expect(reduced.avgEntryPriceUsd).toBeCloseTo(1.2, 10);
    expect(reduced.status).toBe('open');
    expect(reduced.realizedPnlUsd).toBeCloseTo(65, 10);

    const lots = getPositionLots(db, position.id);
    expect(lots).toHaveLength(1);
    expect(qtyToFloat(lots[0]!.qty, 6)).toBe(50);
    expect(lots[0]!.priceUsd).toBe(1.2);
    db.close();
  });

  it('clôture la position quand tout est vendu', () => {
    const db = memoryDb();
    const position = openPosition(db, {
      mint: MINT,
      symbol: 'TEST',
      decimals: 6,
      qty: '1000000',
      priceUsd: 2,
      ts: 1_000,
    });
    const { position: closed, realizedPnlUsd } = reducePositionFifo(db, position.id, {
      qty: '1000000',
      sellPriceUsd: 2.5,
      ts: 2_000,
    });

    expect(realizedPnlUsd).toBeCloseTo(0.5, 10);
    expect(closed.status).toBe('closed');
    expect(closed.qtyRemaining).toBe('0');
    expect(closed.closedAt).toBe(2_000);
    expect(getOpenPositions(db)).toEqual([]);
    expect(getOpenPosition(db, MINT)).toBeNull();
    expect(getPositionById(db, position.id)?.status).toBe('closed');
    db.close();
  });

  it('refuse une vente supérieure à la position', () => {
    const db = memoryDb();
    const position = openPosition(db, {
      mint: MINT,
      symbol: 'TEST',
      decimals: 6,
      qty: '1000000',
      priceUsd: 2,
      ts: 1_000,
    });
    expect(() =>
      reducePositionFifo(db, position.id, { qty: '2000000', sellPriceUsd: 2, ts: 2_000 }),
    ).toThrow(/position restante/);
    db.close();
  });

  it('met à jour les marques (pic, stop)', () => {
    const db = memoryDb();
    const position = openPosition(db, {
      mint: MINT,
      symbol: 'TEST',
      decimals: 6,
      qty: '1000000',
      priceUsd: 1,
      ts: 1_000,
    });
    updatePositionMarks(db, position.id, { peakPriceUsd: 1.5, stopLossPriceUsd: 1.3, ts: 2_000 });
    const updated = getPositionById(db, position.id)!;
    expect(updated.peakPriceUsd).toBe(1.5);
    expect(updated.stopLossPriceUsd).toBe(1.3);
    expect(updated.takeProfitPriceUsd).toBeNull();
    db.close();
  });
});

describe('Portfolio', () => {
  it('calcule NAV, PnL latent et PnL réalisé cumulé', () => {
    const db = memoryDb();
    const portfolio = new Portfolio(db);
    openPosition(db, {
      mint: MINT,
      symbol: 'TEST',
      decimals: 6,
      qty: '100000000',
      priceUsd: 1,
      ts: 1_000,
    });

    const snapshot = portfolio.snapshot({
      cashUsd: 900,
      prices: new Map([[MINT, 1.2]]),
      ts: 5_000,
    });

    expect(snapshot.openCount).toBe(1);
    expect(snapshot.positionsValueUsd).toBeCloseTo(120, 10);
    expect(snapshot.navUsd).toBeCloseTo(1020, 10);
    expect(snapshot.unrealizedPnlUsd).toBeCloseTo(20, 10);
    expect(snapshot.positions[0]).toMatchObject({ priceUsd: 1.2, valueUsd: 120 });
    expect(snapshot.positions[0]!.unrealizedPnlPct).toBeCloseTo(20, 10);
    db.close();
  });

  it('gère un prix manquant (valeur et PnL latents à zéro)', () => {
    const db = memoryDb();
    const portfolio = new Portfolio(db);
    openPosition(db, {
      mint: MINT,
      symbol: 'TEST',
      decimals: 6,
      qty: '100000000',
      priceUsd: 1,
      ts: 1_000,
    });

    const snapshot = portfolio.snapshot({ cashUsd: 10, prices: new Map(), ts: 5_000 });
    expect(snapshot.positionsValueUsd).toBe(0);
    expect(snapshot.navUsd).toBe(10);
    expect(snapshot.positions[0]!.priceUsd).toBeNull();
    expect(snapshot.positions[0]!.unrealizedPnlUsd).toBe(0);
    db.close();
  });
});
