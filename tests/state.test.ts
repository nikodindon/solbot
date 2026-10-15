import { describe, expect, it } from 'vitest';
import {
  deleteState,
  getNumberState,
  getState,
  setNumberState,
  setState,
  STATE_KEYS,
} from '../src/state/bot-state.js';
import { openDatabase } from '../src/state/db.js';
import { getRecentEvents, insertEvent } from '../src/state/events.js';
import { runMigrations } from '../src/state/migrations.js';
import {
  countRejectionsByRuleSince,
  getRecentRejections,
  insertRejection,
} from '../src/state/risk-rejections.js';
import { getRecentSignals, insertSignal, markSignalActed } from '../src/state/signals.js';

function memoryDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

describe('bot_state', () => {
  it('écrit, relit, écrase et supprime des valeurs', () => {
    const db = memoryDb();
    expect(getState(db, 'absent')).toBeNull();
    expect(getNumberState(db, 'absent')).toBeNull();

    setState(db, 'clé', 'valeur', 1_000);
    expect(getState(db, 'clé')).toBe('valeur');

    setState(db, 'clé', 'autre', 2_000);
    expect(getState(db, 'clé')).toBe('autre');

    setNumberState(db, STATE_KEYS.navPeakUsd, 1234.5, 3_000);
    expect(getNumberState(db, STATE_KEYS.navPeakUsd)).toBe(1234.5);

    setState(db, 'pas-un-nombre', 'abc', 4_000);
    expect(getNumberState(db, 'pas-un-nombre')).toBeNull();

    deleteState(db, 'clé');
    expect(getState(db, 'clé')).toBeNull();
    db.close();
  });
});

describe('events', () => {
  it('journalise et relit du plus récent au plus ancien', () => {
    const db = memoryDb();
    insertEvent(db, { level: 'info', kind: 'a', message: 'premier', ts: 1_000 });
    insertEvent(db, {
      level: 'warn',
      kind: 'b',
      message: 'second',
      details: { mint: 'M' },
      ts: 2_000,
    });

    const events = getRecentEvents(db);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'b', level: 'warn', message: 'second' });
    expect(JSON.parse(events[0]!.details!)).toEqual({ mint: 'M' });
    expect(events[1]).toMatchObject({ kind: 'a', details: null });
    db.close();
  });
});

describe('signals', () => {
  it('enregistre un signal et marque son suivi d’effet', () => {
    const db = memoryDb();
    const id = insertSignal(db, {
      ts: 1_000,
      strategy: 'momentum',
      mint: 'M'.repeat(44),
      symbol: 'TEST',
      side: 'buy',
      confidence: 0.8,
      edgeBps: null,
      ttlMs: 90_000,
      reason: 'breakout',
    });
    expect(getRecentSignals(db)[0]).toMatchObject({ id, acted: false, strategy: 'momentum' });

    markSignalActed(db, id);
    expect(getRecentSignals(db)[0]?.acted).toBe(true);
    db.close();
  });
});

describe('risk_rejections', () => {
  it('journalise les rejets et les compte par règle', () => {
    const db = memoryDb();
    const base = {
      mint: 'M'.repeat(44),
      symbol: 'TEST',
      side: 'buy' as const,
      strategy: 'momentum',
      message: 'refusé',
    };
    insertRejection(db, { ...base, ts: 1_000, rule: 'cooldown', metrics: { cooldownS: 300 } });
    insertRejection(db, { ...base, ts: 2_000, rule: 'cooldown' });
    insertRejection(db, { ...base, ts: 3_000, rule: 'kill_switch' });

    const rejections = getRecentRejections(db);
    expect(rejections).toHaveLength(3);
    expect(rejections[0]).toMatchObject({ rule: 'kill_switch', metrics: null });
    expect(rejections[2]?.metrics).toEqual({ cooldownS: 300 });

    const counts = countRejectionsByRuleSince(db, 1_500);
    expect(counts.get('cooldown')).toBe(1);
    expect(counts.get('kill_switch')).toBe(1);
    db.close();
  });
});
