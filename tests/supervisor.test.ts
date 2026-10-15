import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TickResult } from '../src/engine/engine.js';
import { Supervisor } from '../src/monitoring/supervisor.js';
import { listBackups } from '../src/state/backup.js';
import { openDatabase } from '../src/state/db.js';
import { runMigrations } from '../src/state/migrations.js';
import { parseConfig, parseEnv, type Config } from '../src/utils/config.js';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const tempDirs: string[] = [];
const supervisors: Array<{ stop: () => Promise<void> }> = [];
const dbs: Array<{ close: () => void }> = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solbot-supervisor-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.stop();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tick(partial: Partial<TickResult> = {}): TickResult {
  return {
    ts: NOW,
    navUsd: 1000,
    cashUsd: 1000,
    positionsValueUsd: 0,
    openCount: 0,
    drawdownPct: 0,
    dailyLossPct: 0,
    killSwitch: false,
    pausedUntilMs: null,
    manualPaused: false,
    entries: [],
    exits: [],
    rejections: [],
    readyAssets: 1,
    totalAssets: 1,
    ...partial,
  };
}

function make(
  options: {
    overrides?: Record<string, unknown>;
    mutate?: (config: Config) => void;
    mode?: 'paper' | 'dry_run' | 'live';
  } = {},
): {
  supervisor: Supervisor;
  sends: string[];
  config: Config;
  root: string;
} {
  const db = openDatabase(':memory:');
  runMigrations(db);
  dbs.push(db);
  const root = tempDir();
  const config = parseConfig({
    monitoring: { enabled: false },
    alerts: { tick_error_threshold: 1 },
    backups: { enabled: false },
    notifications: {
      telegram: {
        enabled: true,
        commands_enabled: false,
        // Par défaut dans les tests : pas de rapport quotidien (heure 23 > 12).
        daily_report_utc_hour: 23,
        notify_on: ['trade', 'error', 'daily_report', 'alert', 'backup'],
      },
    },
    ...(options.overrides ?? {}),
  });
  options.mutate?.(config);

  const sends: string[] = [];
  const supervisor = new Supervisor({
    root,
    db,
    config,
    mode: options.mode ?? 'paper',
    env: parseEnv({ TELEGRAM_BOT_TOKEN: 'TOKEN', TELEGRAM_CHAT_ID: '42' }),
    version: 'test',
    stopFile: { exists: () => false, createIfAbsent: () => undefined },
    stopRequested: () => false,
    intervalS: 30,
    send: async (input) => {
      sends.push(input.text);
      return { ok: true, description: null };
    },
    fetchImpl: (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    now: () => NOW,
  });
  supervisors.push(supervisor);
  return { supervisor, sends, config, root };
}

describe('Supervisor — observabilité et notifications', () => {
  it('met à jour métriques et health, notifie les trades', () => {
    const { supervisor, sends } = make();

    supervisor.onTick(
      tick({ entries: ['achat AAA 50.00 $ → 24.925 (test)'], navUsd: 999.5, cashUsd: 950 }),
    );

    expect(supervisor.registry.value('solbot_ticks_total')).toBe(1);
    expect(supervisor.registry.value('solbot_entries_total')).toBe(1);
    expect(supervisor.registry.value('solbot_nav_usd', { mode: 'paper' })).toBe(999.5);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('🟢 achat AAA');

    expect(supervisor.health()).toMatchObject({
      mode: 'paper',
      version: 'test',
      ticks: 1,
      lastTickTs: NOW,
      navUsd: 999.5,
      dbOk: true,
      stopRequested: false,
    });
  });

  it('notifie les erreurs de tick et déclenche l’alerte RPC', () => {
    const { supervisor, sends } = make();

    supervisor.onTickError({ consecutive: 3, message: 'timeout RPC' });

    expect(supervisor.registry.value('solbot_tick_errors_total')).toBe(1);
    expect(supervisor.registry.value('solbot_alerts_total', { rule: 'tick_errors' })).toBe(1);
    expect(sends.some((text) => text.includes('🚨') && text.includes('timeout RPC'))).toBe(true);
    expect(sends.some((text) => text.includes('alerte RPC / marché en échec'))).toBe(true);
  });

  it('envoie le rapport quotidien une seule fois par jour UTC', () => {
    const { supervisor, sends } = make({
      overrides: {
        notifications: {
          telegram: {
            enabled: true,
            commands_enabled: false,
            daily_report_utc_hour: 0,
            notify_on: ['daily_report'],
          },
        },
      },
    });

    supervisor.onTick(tick());
    supervisor.onTick(tick());

    const reports = sends.filter((text) => text.includes('📊'));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('rapport quotidien (2026-10-15)');
  });

  it('crée le backup quotidien une seule fois par jour', () => {
    const backupsDir = path.join(tempDir(), 'backups');
    const { supervisor } = make({
      overrides: { backups: { enabled: true, dir: backupsDir, keep: 2, daily_utc_hour: 0 } },
    });

    supervisor.onTick(tick());
    supervisor.onTick(tick());

    expect(listBackups(backupsDir)).toHaveLength(1);
    expect(supervisor.registry.value('solbot_backups_total', { status: 'ok' })).toBe(1);
    expect(supervisor.health().lastBackupTs).toBe(NOW);
  });
});

describe('Supervisor — serveur et commandes', () => {
  it('démarre le serveur de supervision (port éphémère) et répond /healthz', async () => {
    const { supervisor } = make({
      overrides: { monitoring: { enabled: true, host: '127.0.0.1' } },
      mutate: (config) => {
        config.monitoring.port = 0;
      },
    });

    const started = await supervisor.start();
    expect(started.monitoringUrl).not.toBeNull();
    expect(started.telegramCommands).toBe(false);

    const response = await fetch(`${started.monitoringUrl}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; mode: string };
    expect(body.status).toBe('ok');
    expect(body.mode).toBe('paper');
  });

  it('démarre l’écoute des commandes Telegram quand configurée', async () => {
    const { supervisor } = make({
      overrides: {
        notifications: { telegram: { enabled: true, commands_enabled: true } },
      },
    });

    const started = await supervisor.start();
    expect(started.telegramCommands).toBe(true);
  });
});
