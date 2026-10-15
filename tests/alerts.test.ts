import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { AlertEngine, type AlertRule } from '../src/alerts/alerts.js';
import { USDC_MINT } from '../src/constants.js';
import { getNumberState, STATE_KEYS } from '../src/state/bot-state.js';
import { openDatabase } from '../src/state/db.js';
import { runMigrations } from '../src/state/migrations.js';
import { insertTrade } from '../src/state/trades.js';
import { parseConfig, type Config } from '../src/utils/config.js';

const NOW = 1_750_000_000_000;
const A = 'A'.repeat(44);

function memoryDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

function makeEngine(
  db: DatabaseSync,
  configOverrides: Record<string, unknown> = {},
  now = NOW,
): {
  engine: AlertEngine;
  emitted: Array<{ rule: AlertRule; message: string }>;
  metrics: AlertRule[];
} {
  const config: Config = parseConfig({
    alerts: { cooldown_min: 30, ...((configOverrides.alerts as object) ?? {}) },
    ...configOverrides,
  });
  const emitted: Array<{ rule: AlertRule; message: string }> = [];
  const metrics: AlertRule[] = [];
  const engine = new AlertEngine({
    db,
    config,
    emit: (rule, message) => emitted.push({ rule, message }),
    onMetrics: (rule) => metrics.push(rule),
    now: () => now,
  });
  return { engine, emitted, metrics };
}

function failedTrade(db: DatabaseSync, createdAt: number, status = 'failed'): void {
  insertTrade(db, {
    mode: 'live',
    status: status as 'failed' | 'success',
    signature: null,
    requestId: null,
    inputMint: USDC_MINT,
    outputMint: A,
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
    createdAt,
  });
}

describe('AlertEngine', () => {
  it('alerte sur erreurs de tick consécutives (seuil configuré)', () => {
    const db = memoryDb();
    const { engine, emitted, metrics } = makeEngine(db, {
      alerts: { tick_error_threshold: 2 },
    });

    const fired = engine.evaluateTick({
      ts: NOW,
      mode: 'paper',
      solBalanceSol: null,
      consecutiveErrors: 1,
    });
    expect(fired).toEqual([]);
    expect(emitted).toEqual([]);

    const fired2 = engine.evaluateTick({
      ts: NOW,
      mode: 'paper',
      solBalanceSol: null,
      consecutiveErrors: 2,
    });
    expect(fired2).toEqual(['tick_errors']);
    expect(emitted[0]?.message).toContain('2 erreur(s) de tick consécutive(s)');
    expect(metrics).toEqual(['tick_errors']);
    expect(getNumberState(db, `${STATE_KEYS.alertLastPrefix}tick_errors`)).toBe(NOW);
    db.close();
  });

  it('applique le cooldown par règle (anti-spam persisté)', () => {
    const db = memoryDb();
    const { engine, emitted } = makeEngine(db, { alerts: { cooldown_min: 30 } });
    const ctx = { ts: NOW, mode: 'paper' as const, solBalanceSol: null, consecutiveErrors: 3 };

    expect(engine.evaluateTick(ctx)).toEqual(['tick_errors']);
    expect(engine.evaluateTick({ ...ctx, ts: NOW + 60_000 })).toEqual([]);
    expect(emitted).toHaveLength(1);

    // Après 30 min, la règle peut re-tirer.
    expect(engine.evaluateTick({ ...ctx, ts: NOW + 30 * 60_000 })).toEqual(['tick_errors']);
    expect(emitted).toHaveLength(2);
    db.close();
  });

  it('alerte quand la réserve de gaz SOL passe sous le seuil (live seulement)', () => {
    const db = memoryDb();
    const { engine, emitted } = makeEngine(db, { risk: { sol_gas_reserve: 0.05 } });

    // Paper : jamais (pas de SOL on-chain).
    expect(
      engine.evaluateTick({ ts: NOW, mode: 'paper', solBalanceSol: 0.01, consecutiveErrors: 0 }),
    ).toEqual([]);

    expect(
      engine.evaluateTick({ ts: NOW, mode: 'live', solBalanceSol: 0.08, consecutiveErrors: 0 }),
    ).toEqual([]);

    const fired = engine.evaluateTick({
      ts: NOW,
      mode: 'live',
      solBalanceSol: 0.01,
      consecutiveErrors: 0,
    });
    expect(fired).toEqual(['sol_reserve']);
    expect(emitted[0]?.message).toContain('0.0100 SOL < 0.05 SOL');
    db.close();
  });

  it('alerte sur taux d’échec d’exécution dans la fenêtre (minimum de trades requis)', () => {
    const db = memoryDb();
    const { engine, emitted } = makeEngine(db, {
      alerts: {
        execute_failure_window_min: 60,
        execute_failure_min_trades: 3,
        execute_failure_rate_pct: 30,
      },
    });

    // 2 trades dont 1 échec : sous le minimum de trades → pas d'alerte.
    failedTrade(db, NOW - 1_000, 'failed');
    failedTrade(db, NOW - 2_000, 'success');
    expect(
      engine.evaluateTick({ ts: NOW, mode: 'live', solBalanceSol: null, consecutiveErrors: 0 }),
    ).toEqual([]);

    // 3 trades dont 2 échecs = 66 % ≥ 30 % → alerte.
    failedTrade(db, NOW - 3_000, 'failed');
    const fired = engine.evaluateTick({
      ts: NOW,
      mode: 'live',
      solBalanceSol: null,
      consecutiveErrors: 0,
    });
    expect(fired).toEqual(['execute_failures']);
    expect(emitted[0]?.message).toContain("67 % d'échecs");
    db.close();
  });

  it('ignore les trades hors fenêtre', () => {
    const db = memoryDb();
    const { engine } = makeEngine(db, {
      alerts: {
        execute_failure_window_min: 60,
        execute_failure_min_trades: 1,
        execute_failure_rate_pct: 1,
      },
    });
    failedTrade(db, NOW - 2 * 3_600_000, 'failed');
    expect(
      engine.evaluateTick({ ts: NOW, mode: 'live', solBalanceSol: null, consecutiveErrors: 0 }),
    ).toEqual([]);
    db.close();
  });

  it('raise() émet une alerte ponctuelle avec cooldown (divergence de réconciliation)', () => {
    const db = memoryDb();
    const { engine, emitted } = makeEngine(db);
    expect(engine.raise('reconcile_divergence', '2 clôturée(s)', NOW)).toBe(true);
    expect(engine.raise('reconcile_divergence', '2 clôturée(s)', NOW + 1_000)).toBe(false);
    expect(emitted).toEqual([{ rule: 'reconcile_divergence', message: '2 clôturée(s)' }]);
    db.close();
  });

  it('ne fait rien quand l’alerting est désactivé', () => {
    const db = memoryDb();
    const { engine, emitted } = makeEngine(db, { alerts: { enabled: false } });
    expect(
      engine.evaluateTick({ ts: NOW, mode: 'live', solBalanceSol: 0, consecutiveErrors: 5 }),
    ).toEqual([]);
    expect(engine.raise('sol_reserve', 'x', NOW)).toBe(false);
    expect(emitted).toEqual([]);
    db.close();
  });
});
