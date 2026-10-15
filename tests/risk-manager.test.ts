import { describe, expect, it } from 'vitest';
import { RiskManager, type RiskContext } from '../src/risk/risk-manager.js';
import { openDatabase } from '../src/state/db.js';
import { runMigrations } from '../src/state/migrations.js';
import { openPosition } from '../src/state/positions.js';
import { getRecentRejections } from '../src/state/risk-rejections.js';
import { parseConfig, type Config } from '../src/utils/config.js';

const MINT = 'M'.repeat(44);
const NOW = 1_750_000_000_000;

function memoryDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

function testConfig(overrides: Record<string, unknown> = {}): Config {
  return parseConfig({ risk: { sol_gas_reserve: 0.05, ...overrides } });
}

function context(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    now: NOW,
    navUsd: 1000,
    killSwitch: false,
    pausedUntilMs: null,
    openPositions: [],
    exposureByMint: new Map(),
    lastTradeTsByMint: new Map(),
    cashAvailableUsd: 1000,
    solBalanceSol: null,
    ...overrides,
  };
}

const entry = {
  mint: MINT,
  symbol: 'TEST',
  strategy: 'momentum',
  priceUsd: 1,
  liquidityUsd: 1_000_000,
};

describe('RiskManager.checkEntry', () => {
  it('autorise et dimensionne (min des plafonds)', () => {
    const db = memoryDb();
    const risk = new RiskManager(db, testConfig());
    // NAV 1000 : max_position 5 % = 50 ; liquidité 1 M → impact 1 % ≈ 5 000 $ ;
    // caisse 1 000 → le plafond contraignant est 50 $.
    const decision = risk.checkEntry(entry, context());
    expect(decision).toEqual({ allowed: true, sizeUsd: 50 });
    db.close();
  });

  it('refuse quand le kill-switch est actif et journalise le rejet', () => {
    const db = memoryDb();
    const risk = new RiskManager(db, testConfig());
    const decision = risk.checkEntry(entry, context({ killSwitch: true }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.rule).toBe('kill_switch');
    expect(getRecentRejections(db)).toHaveLength(1);
    expect(getRecentRejections(db)[0]).toMatchObject({ rule: 'kill_switch', side: 'buy' });
    db.close();
  });

  it('refuse pendant la pause perte journalière', () => {
    const db = memoryDb();
    const risk = new RiskManager(db, testConfig());
    const decision = risk.checkEntry(entry, context({ pausedUntilMs: NOW + 60_000 }));
    expect(decision).toMatchObject({ allowed: false, rule: 'daily_loss_pause' });
    db.close();
  });

  it('refuse les prix invalides et les liquidités inconnues', () => {
    const db = memoryDb();
    const risk = new RiskManager(db, testConfig());
    expect(risk.checkEntry({ ...entry, priceUsd: 0 }, context())).toMatchObject({
      allowed: false,
      rule: 'invalid_price',
    });
    expect(risk.checkEntry({ ...entry, liquidityUsd: null }, context())).toMatchObject({
      allowed: false,
      rule: 'unknown_liquidity',
    });
    db.close();
  });

  it('refuse au-delà du nombre max de positions', () => {
    const db = memoryDb();
    const risk = new RiskManager(db, testConfig({ max_positions: 1 }));
    const existing = openPosition(db, {
      mint: 'A'.repeat(44),
      symbol: 'A',
      decimals: 6,
      qty: '1000000',
      priceUsd: 1,
      ts: NOW,
    });
    const decision = risk.checkEntry(entry, context({ openPositions: [existing] }));
    expect(decision).toMatchObject({ allowed: false, rule: 'max_positions' });
    db.close();
  });

  it('refuse quand l’exposition par actif est saturée', () => {
    const db = memoryDb();
    const risk = new RiskManager(db, testConfig());
    // Exposition 200 $ (20 % du NAV) > plafond actif 15 % → aucune place.
    const decision = risk.checkEntry(entry, context({ exposureByMint: new Map([[MINT, 200]]) }));
    expect(decision).toMatchObject({ allowed: false, rule: 'exposure_cap' });
    db.close();
  });

  it('refuse pendant le cooldown anti-churn', () => {
    const db = memoryDb();
    const risk = new RiskManager(db, testConfig({ min_time_between_trades_s: 300 }));
    const decision = risk.checkEntry(
      entry,
      context({ lastTradeTsByMint: new Map([[MINT, NOW - 100_000]]) }),
    );
    expect(decision).toMatchObject({ allowed: false, rule: 'cooldown' });
    expect(getRecentRejections(db)[0]?.message).toContain('cooldown');
    db.close();
  });

  it('refuse quand la réserve de gaz est entamée (live)', () => {
    const db = memoryDb();
    const risk = new RiskManager(db, testConfig({ sol_gas_reserve: 0.05 }));
    const decision = risk.checkEntry(entry, context({ solBalanceSol: 0.01 }));
    expect(decision).toMatchObject({ allowed: false, rule: 'gas_reserve' });
    db.close();
  });

  it('refuse un notionnel sous le minimum', () => {
    const db = memoryDb();
    const risk = new RiskManager(db, testConfig());
    const decision = risk.checkEntry(entry, context({ navUsd: 2, cashAvailableUsd: 2 }));
    expect(decision).toMatchObject({ allowed: false, rule: 'size_too_small' });
    db.close();
  });

  it('applique le plafond d’impact prix via la liquidité', () => {
    const db = memoryDb();
    const risk = new RiskManager(db, testConfig({ max_price_impact_pct: 1 }));
    // Liquidité 10 000 $ → notionnel max ≈ 10 000 × 1 % / 2 = 50 $.
    const decision = risk.checkEntry({ ...entry, liquidityUsd: 10_000 }, context());
    expect(decision).toEqual({ allowed: true, sizeUsd: 50 });
    db.close();
  });
});

describe('RiskManager.checkExit', () => {
  const exit = {
    mint: MINT,
    symbol: 'TEST',
    strategy: 'risk',
    trigger: 'stop_loss',
    qtyBaseUnits: '1000000',
    priceUsd: 1,
  };

  it('autorise une sortie même avec kill-switch actif (priorité absolue)', () => {
    const db = memoryDb();
    const risk = new RiskManager(db, testConfig());
    expect(risk.checkExit(exit, context({ killSwitch: true }))).toEqual({
      allowed: true,
      sizeUsd: 0,
    });
    db.close();
  });

  it('refuse un prix invalide ou une quantité nulle', () => {
    const db = memoryDb();
    const risk = new RiskManager(db, testConfig());
    expect(risk.checkExit({ ...exit, priceUsd: 0 }, context())).toMatchObject({
      allowed: false,
      rule: 'invalid_price',
    });
    expect(risk.checkExit({ ...exit, qtyBaseUnits: '0' }, context())).toMatchObject({
      allowed: false,
      rule: 'empty_position',
    });
    db.close();
  });
});
