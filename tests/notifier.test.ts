import { describe, expect, it } from 'vitest';
import {
  formatAlertMessage,
  formatBackupMessage,
  formatDailyReportMessage,
  formatTickErrorMessage,
  formatTradeMessage,
  Notifier,
} from '../src/notifications/notifier.js';

describe('Notifier', () => {
  it('envoie quand activé, configuré et autorisé pour le type', async () => {
    const sent: string[] = [];
    const notifier = new Notifier({
      enabled: true,
      token: 'TOKEN',
      chatId: '42',
      notifyOn: ['trade'],
      send: async (input) => {
        sent.push(input.text);
        return { ok: true, description: null };
      },
    });
    expect(notifier.active).toBe(true);
    const result = await notifier.notify('trade', 'coucou');
    expect(result).toMatchObject({ ok: true });
    expect(sent).toEqual(['coucou']);
  });

  it('filtre par notify_on, enabled, et exige token + chat id', async () => {
    const sent: string[] = [];
    const send = async (): Promise<{ ok: boolean; description: string | null }> => {
      sent.push('appel');
      return { ok: true, description: null };
    };
    const filtered = new Notifier({
      enabled: true,
      token: 'T',
      chatId: '42',
      notifyOn: ['trade'],
      send,
    });
    expect(await filtered.notify('error', 'x')).toBeNull();

    const disabled = new Notifier({
      enabled: false,
      token: 'T',
      chatId: '42',
      notifyOn: ['trade'],
      send,
    });
    expect(disabled.active).toBe(false);
    expect(await disabled.notify('trade', 'x')).toBeNull();

    const unconfigured = new Notifier({
      enabled: true,
      token: undefined,
      chatId: '42',
      notifyOn: ['trade'],
      send,
    });
    expect(unconfigured.configured).toBe(false);
    expect(await unconfigured.notify('trade', 'x')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('reste best effort : un échec d’envoi est journalisé, jamais levé', async () => {
    const logs: string[] = [];
    const results: string[] = [];
    const notifier = new Notifier({
      enabled: true,
      token: 'T',
      chatId: '42',
      notifyOn: ['error'],
      send: async () => ({ ok: false, description: 'chat introuvable' }),
      onLog: (line) => logs.push(line),
      onResult: (kind, result) => results.push(`${kind}:${result.ok}`),
    });
    const result = await notifier.notify('error', 'boom');
    expect(result).toMatchObject({ ok: false });
    expect(logs).toEqual(['notification error en échec : chat introuvable']);
    expect(results).toEqual(['error:false']);
  });
});

describe('formats de notification', () => {
  it('compose le message de trade (null si aucune action)', () => {
    expect(formatTradeMessage('paper', [], [])).toBeNull();
    const message = formatTradeMessage(
      'paper',
      ['achat AAA 50.00 $ → 24.925 (test)'],
      ['vente BBB (take_profit) : 52.00 $, PnL +2.00 $'],
    );
    expect(message).toContain('solbot · paper · trade');
    expect(message).toContain('🟢 achat AAA 50.00 $ → 24.925 (test)');
    expect(message).toContain('🔴 vente BBB (take_profit)');
  });

  it('compose l’erreur de tick, le rapport quotidien, les alertes et les backups', () => {
    expect(formatTickErrorMessage('live', 2, 5, 'RPC timeout')).toBe(
      '🚨 solbot · live · erreur de tick (2/5)\nRPC timeout',
    );

    const report = formatDailyReportMessage({
      mode: 'paper',
      dayKey: '2026-10-15',
      navUsd: 1001.23,
      netPnlUsd: 1.23,
      closedTrades: 4,
      feesUsd: 0.45,
      openCount: 2,
      paused: true,
      killSwitch: false,
    });
    expect(report).toContain('📊 solbot · paper · rapport quotidien (2026-10-15)');
    expect(report).toContain('PnL réalisé 24 h : +1.23 $ (4 clôture(s)) · frais 0.45 $');
    expect(report).toContain('NAV : 1001.23 $ · positions ouvertes : 2');
    expect(report).toContain('⏸ entrées en pause');

    const loss = formatDailyReportMessage({
      mode: 'paper',
      dayKey: '2026-10-15',
      navUsd: null,
      netPnlUsd: -3.5,
      closedTrades: 0,
      feesUsd: 0,
      openCount: 0,
      paused: false,
      killSwitch: true,
    });
    expect(loss).toContain('PnL réalisé 24 h : -3.50 $');
    expect(loss).toContain('NAV : n/d');
    expect(loss).toContain('⛔ kill-switch actif');

    expect(formatAlertMessage('réserve de gaz SOL', '0.01 SOL')).toBe(
      '⚠️ solbot · alerte réserve de gaz SOL\n0.01 SOL',
    );
    expect(formatBackupMessage('/tmp/x.sqlite', 2048)).toBe(
      '💾 backup SQLite : /tmp/x.sqlite (2.0 Ko)',
    );
  });
});
