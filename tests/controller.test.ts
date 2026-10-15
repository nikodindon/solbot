import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { USDC_MINT } from '../src/constants.js';
import {
  computePnlSummary,
  humanDuration,
  TelegramController,
} from '../src/notifications/controller.js';
import { getState, setNumberState, setState, STATE_KEYS } from '../src/state/bot-state.js';
import { openDatabase } from '../src/state/db.js';
import { insertEquityPoint } from '../src/state/equity.js';
import { getRecentEvents } from '../src/state/events.js';
import { runMigrations } from '../src/state/migrations.js';
import { openPosition } from '../src/state/positions.js';
import { insertTrade } from '../src/state/trades.js';
import { parseConfig } from '../src/utils/config.js';

const NOW = 1_750_000_000_000;
const A = 'A'.repeat(44);

function memoryDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

function makeController(db: DatabaseSync, stop = { exists: false }): TelegramController {
  return new TelegramController({
    db,
    config: parseConfig({}),
    mode: 'paper',
    stopFile: {
      exists: () => stop.exists,
      createIfAbsent: () => {
        stop.exists = true;
      },
    },
    now: () => NOW,
  });
}

describe('humanDuration', () => {
  it('formate en unités lisibles', () => {
    expect(humanDuration(12_000)).toBe('12 s');
    expect(humanDuration(3 * 60_000)).toBe('3 min');
    expect(humanDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2 h 5 min');
    expect(humanDuration(30 * 3_600_000)).toBe('1 j 6 h');
  });
});

describe('TelegramController', () => {
  it('/status résume dernier tick, NAV, positions et stratégies', () => {
    const db = memoryDb();
    setNumberState(db, STATE_KEYS.lastTickTs, NOW - 15_000, NOW);
    setNumberState(db, STATE_KEYS.engineStartedAt, NOW - 7_200_000, NOW);
    insertEquityPoint(db, {
      mode: 'paper',
      ts: NOW - 15_000,
      navUsd: 1001.5,
      cashUsd: 900,
      positionsValueUsd: 101.5,
      openCount: 1,
    });
    openPosition(db, {
      mint: A,
      symbol: 'AAA',
      decimals: 6,
      qty: '1000000',
      priceUsd: 100,
      ts: NOW - 60_000,
      mode: 'paper',
    });

    const status = makeController(db).status();
    expect(status).toContain('solbot · paper · statut');
    expect(status).toContain('il y a 15 s');
    expect(status).toContain('démarré il y a 2 h');
    expect(status).toContain('NAV 1001.50 $ · caisse 900.00 $ · 1 position(s)');
    expect(status).toContain('momentum ×');
    db.close();
  });

  it('/status signale la pause manuelle et le kill-switch', () => {
    const db = memoryDb();
    setState(db, STATE_KEYS.manualPaused, '1', NOW);
    const status = makeController(db, { exists: true }).status();
    expect(status).toContain('⏸ entrées en pause (manuelle)');
    expect(status).toContain('⛔ kill-switch actif (fichier STOP)');
    db.close();
  });

  it('/positions liste les positions ouvertes', () => {
    const db = memoryDb();
    openPosition(db, {
      mint: A,
      symbol: 'AAA',
      decimals: 6,
      qty: '1000000',
      priceUsd: 1,
      ts: NOW - 3_600_000,
      stopLossPriceUsd: 0.95,
      takeProfitPriceUsd: 1.15,
      mode: 'paper',
    });
    const text = makeController(db).positions();
    expect(text).toContain('1 position(s) ouverte(s)');
    expect(text).toContain('AAA');
    expect(text).toContain('stop 0.9500 $');
    expect(text).toContain('TP 1.1500 $');
    expect(text).toContain('ouverte il y a 1 h');
    db.close();
  });

  it('/positions répond « aucune » sans position', () => {
    const db = memoryDb();
    expect(makeController(db).positions()).toContain('aucune position ouverte');
    db.close();
  });

  it('/pnl agrège clôtures et frais sur la fenêtre', () => {
    const db = memoryDb();
    db.prepare(
      `INSERT INTO positions
         (mint, symbol, decimals, status, qty, qty_remaining, avg_entry_price_usd,
          cost_basis_usd, realized_pnl_usd, opened_at, updated_at, closed_at, mode)
       VALUES (?, 'AAA', 6, 'closed', '1000000', '0', 1, 0, 2.5, ?, ?, ?, 'paper')`,
    ).run(A, NOW - 3_600_000, NOW - 60_000, NOW - 60_000);
    insertTrade(db, {
      mode: 'paper',
      status: 'success',
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
      feeUsd: 0.2,
      createdAt: NOW - 60_000,
    });

    expect(computePnlSummary(db, NOW - 86_400_000)).toEqual({
      closedTrades: 1,
      realizedPnlUsd: 2.5,
      feesUsd: 0.2,
    });

    const text = makeController(db).pnl(['1']);
    expect(text).toContain('PnL 1 j');
    expect(text).toContain('réalisé : +2.50 $ sur 1 clôture(s) · frais 0.20 $');
    // Fenêtre trop courte : la clôture d'il y a 1 h reste dedans, mais un PnL sur 365 j fonctionne aussi.
    expect(makeController(db).pnl([])).toContain('PnL 1 j');
    db.close();
  });

  it('/pause et /resume persistent l’état et journalisent', () => {
    const db = memoryDb();
    const controller = makeController(db);

    expect(controller.pause()).toContain('en pause');
    expect(getState(db, STATE_KEYS.manualPaused)).toBe('1');
    expect(getRecentEvents(db)[0]).toMatchObject({ kind: 'manual_pause' });
    expect(controller.pause()).toContain('déjà en pause');

    expect(controller.resume()).toContain('réactivées');
    expect(getState(db, STATE_KEYS.manualPaused)).toBeNull();
    expect(getRecentEvents(db)[0]).toMatchObject({ kind: 'manual_resume' });
    expect(controller.resume()).toContain('aucune pause');
    db.close();
  });

  it('/kill crée le fichier STOP une seule fois', () => {
    const db = memoryDb();
    const stop = { exists: false };
    const controller = makeController(db, stop);

    expect(controller.kill()).toContain('kill-switch activé');
    expect(stop.exists).toBe(true);
    expect(getRecentEvents(db)[0]).toMatchObject({ kind: 'kill_switch' });
    expect(controller.kill()).toContain('déjà actif');
    db.close();
  });

  it('/help liste toutes les commandes', () => {
    const db = memoryDb();
    const help = makeController(db).help();
    for (const command of [
      '/status',
      '/positions',
      '/pnl',
      '/pause',
      '/resume',
      '/kill',
      '/help',
    ]) {
      expect(help).toContain(command);
    }
    db.close();
  });
});
