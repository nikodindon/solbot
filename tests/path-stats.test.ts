import { describe, expect, it } from 'vitest';
import {
  BASE_FEE_LAMPORTS,
  collectPathStats,
  pickPath,
  type PathStats,
} from '../src/execution/path-stats.js';
import { openDatabase } from '../src/state/db.js';
import { runMigrations } from '../src/state/migrations.js';
import { insertTrade, type TradeRecord } from '../src/state/trades.js';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function memoryDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

function seed(db: ReturnType<typeof memoryDb>, overrides: Partial<TradeRecord> = {}): number {
  return insertTrade(db, {
    mode: 'live',
    status: 'success',
    signature: null,
    requestId: null,
    inputMint: SOL,
    outputMint: USDC,
    inAmount: '1000000',
    expectedOutAmount: null,
    outAmount: null,
    router: null,
    feeBps: null,
    feeMint: null,
    priceImpact: null,
    slippageBps: null,
    realizedSlippageBps: null,
    errorCode: null,
    errorMessage: null,
    createdAt: Date.now(),
    ...overrides,
  });
}

describe('collectPathStats', () => {
  it('agrège succès et échecs d’exécution, exclut échecs amont et autres modes', () => {
    const db = memoryDb();
    const now = Date.now();
    seed(db, {
      status: 'success',
      path: 'router',
      createdAt: now,
      cuLimit: 120_000,
      cuPriceMicrolamports: 1000,
      tipLamports: 1_000_000,
      realizedSlippageBps: 40,
      landingMs: 900,
    });
    seed(db, { status: 'failed', errorCode: -9103, path: 'router', createdAt: now });
    seed(db, { status: 'failed', errorCode: -9100, path: 'router', createdAt: now }); // build
    seed(db, { status: 'failed', errorCode: -9101, path: 'router', createdAt: now }); // simulation
    seed(db, { status: 'failed', errorCode: 1, path: 'router', createdAt: now }); // ordre
    seed(db, { status: 'success', mode: 'dry_run', path: 'router', createdAt: now });
    seed(db, { status: 'success', path: null, createdAt: now });

    const stats = collectPathStats(db, { now });

    expect(stats).toHaveLength(1);
    const router = stats[0]!;
    expect(router.path).toBe('router');
    expect(router.attempts).toBe(2);
    expect(router.successes).toBe(1);
    expect(router.landingRate).toBe(0.5);
    expect(router.avgSlippageBps).toBe(40);
    expect(router.avgLandingMs).toBe(900);
    expect(router.avgTipLamports).toBe(1_000_000);
    // 120 000 CU × 1 000 µlamports / 1e6 = 120 lamports + frais de base + tip.
    expect(router.avgCostLamports).toBe(1_000_000 + BASE_FEE_LAMPORTS + 120);
  });

  it('laisse le coût indéterminé sans télémétrie de compute units (chemin meta)', () => {
    const db = memoryDb();
    const now = Date.now();
    seed(db, {
      status: 'success',
      path: 'meta_aggregator',
      createdAt: now,
      realizedSlippageBps: 25,
    });

    const stats = collectPathStats(db, { now });

    expect(stats).toHaveLength(1);
    expect(stats[0]?.avgCostLamports).toBeNull();
    expect(stats[0]?.avgLandingMs).toBeNull();
    expect(stats[0]?.avgSlippageBps).toBe(25);
  });

  it('ignore les swaps hors de la fenêtre glissante', () => {
    const db = memoryDb();
    const now = Date.now();
    seed(db, { status: 'success', path: 'router', createdAt: now - 8 * 86_400_000 });
    expect(collectPathStats(db, { now, windowDays: 7 })).toHaveLength(0);
    expect(collectPathStats(db, { now, windowDays: 30 })).toHaveLength(1);
  });
});

function stats(overrides: Partial<PathStats> & { path: string }): PathStats {
  return {
    attempts: 0,
    successes: 0,
    landingRate: null,
    avgSlippageBps: null,
    avgLandingMs: null,
    avgTipLamports: null,
    avgCostLamports: null,
    ...overrides,
  };
}

const META_OK = stats({
  path: 'meta_aggregator',
  attempts: 25,
  successes: 23,
  landingRate: 0.92,
});

describe('pickPath (bascule automatique)', () => {
  it('reste sur meta_aggregator sans échantillons router suffisants', () => {
    const router = stats({ path: 'router', attempts: 5, successes: 5, landingRate: 1 });
    expect(pickPath([router, META_OK])).toBe('meta_aggregator');
  });

  it('reste sur meta_aggregator sans échantillons meta suffisants', () => {
    const router = stats({ path: 'router', attempts: 25, successes: 25, landingRate: 1 });
    const meta = stats({ path: 'meta_aggregator', attempts: 3, successes: 3, landingRate: 1 });
    expect(pickPath([router, meta])).toBe('meta_aggregator');
  });

  it('reste sur meta_aggregator sans aucune donnée', () => {
    expect(pickPath([])).toBe('meta_aggregator');
  });

  it('bascule sur router quand le taux de landing dépasse la marge', () => {
    const router = stats({ path: 'router', attempts: 25, successes: 25, landingRate: 1 });
    expect(pickPath([router, META_OK])).toBe('router');
  });

  it('ne bascule pas si l’écart de taux reste dans la marge (coût router inconnu)', () => {
    const router = stats({ path: 'router', attempts: 25, successes: 23, landingRate: 0.92 });
    expect(pickPath([router, META_OK])).toBe('meta_aggregator');
  });

  it('à taux équivalents, bascule si le coût router connu est plus faible que celui du meta', () => {
    const router = stats({
      path: 'router',
      attempts: 25,
      successes: 24,
      landingRate: 0.95,
      avgCostLamports: 1_500_000,
    });
    const meta = stats({
      path: 'meta_aggregator',
      attempts: 25,
      successes: 24,
      landingRate: 0.95,
      avgCostLamports: 2_000_000,
    });
    expect(pickPath([router, meta])).toBe('router');
  });

  it('à taux équivalents et coût meta inconnu, reste sur meta_aggregator', () => {
    const router = stats({
      path: 'router',
      attempts: 25,
      successes: 24,
      landingRate: 0.95,
      avgCostLamports: 1_000,
    });
    const meta = stats({
      path: 'meta_aggregator',
      attempts: 25,
      successes: 24,
      landingRate: 0.95,
    });
    expect(pickPath([router, meta])).toBe('meta_aggregator');
  });

  it('router moins fiable → meta_aggregator même avec une marge nulle', () => {
    const router = stats({ path: 'router', attempts: 25, successes: 22, landingRate: 0.88 });
    expect(pickPath([router, META_OK], { rateMargin: 0 })).toBe('meta_aggregator');
  });

  it('accepte une marge nulle quand le router fait strictement mieux', () => {
    const router = stats({ path: 'router', attempts: 25, successes: 24, landingRate: 0.96 });
    expect(pickPath([router, META_OK], { rateMargin: 0 })).toBe('router');
  });
});
