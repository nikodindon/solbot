import { afterEach, describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../src/monitoring/metrics.js';
import {
  startMonitoringServer,
  type HealthSnapshot,
  type MonitoringServer,
} from '../src/monitoring/server.js';

const NOW = 1_750_000_000_000;

function snapshot(partial: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    mode: 'paper',
    version: '0.6.0-test',
    startedAt: NOW - 60_000,
    ticks: 12,
    lastTickTs: NOW - 1_000,
    navUsd: 1000,
    openCount: 0,
    manualPaused: false,
    stopRequested: false,
    lastBackupTs: null,
    dbOk: true,
    ...partial,
  };
}

const servers: MonitoringServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function start(partial: Partial<HealthSnapshot> = {}, staleAfterS = 120): Promise<string> {
  const registry = new MetricsRegistry();
  registry.inc('solbot_ticks_total', 'Ticks', {}, 12);
  const server = await startMonitoringServer({
    host: '127.0.0.1',
    port: 0,
    registry,
    health: () => snapshot(partial),
    staleAfterS,
    now: () => NOW,
  });
  servers.push(server);
  return server.url;
}

describe('serveur de supervision', () => {
  it('expose /healthz ok quand le dernier tick est frais', async () => {
    const url = await start();
    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.mode).toBe('paper');
    expect(body.last_tick_age_s).toBe(1);
    expect(body.db).toBe('ok');
  });

  it('renvoie 503 stale quand le dernier tick est trop vieux', async () => {
    const url = await start({ lastTickTs: NOW - 600_000 });
    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe('stale');
  });

  it('renvoie 503 degraded quand la base est indisponible', async () => {
    const url = await start({ dbOk: false });
    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');
    expect(body.db).toBe('unavailable');
  });

  it('expose /metrics (Prometheus) avec uptime et dernier tick recalculés', async () => {
    const url = await start();
    const response = await fetch(`${url}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const text = await response.text();
    expect(text).toContain('solbot_ticks_total 12');
    expect(text).toContain('solbot_uptime_seconds 60');
    expect(text).toContain(`solbot_last_tick_ts_seconds ${Math.round((NOW - 1_000) / 1000)}`);
  });

  it('répond 404 sur une route inconnue et 405 sur une méthode non GET', async () => {
    const url = await start();
    expect((await fetch(`${url}/inconnu`)).status).toBe(404);
    expect((await fetch(`${url}/healthz`, { method: 'POST' })).status).toBe(405);
  });
});
