import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SolbotError } from '../utils/errors.js';
import { METRICS } from './metrics.js';
import type { MetricsRegistry } from './metrics.js';

/** État exposé par `/healthz` (healthcheck Docker/systemd et supervision). */
export interface HealthSnapshot {
  mode: string;
  version: string;
  startedAt: number;
  ticks: number;
  lastTickTs: number | null;
  navUsd: number | null;
  openCount: number;
  manualPaused: boolean;
  stopRequested: boolean;
  lastBackupTs: number | null;
  dbOk: boolean;
}

export interface MonitoringServerDeps {
  host: string;
  port: number;
  registry: MetricsRegistry;
  /** Snapshot recalculé à chaque requête (jamais de cache). */
  health: () => HealthSnapshot;
  /** Âge maximal (s) du dernier tick avant de déclarer le moteur « stale » (503). */
  staleAfterS: number;
  now?: () => number;
}

export interface MonitoringServer {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

interface HealthPayload {
  status: 'ok' | 'stale' | 'degraded';
  mode: string;
  version: string;
  uptime_s: number;
  ticks: number;
  last_tick_at: string | null;
  last_tick_age_s: number | null;
  nav_usd: number | null;
  positions_open: number;
  paused: boolean;
  kill_switch: boolean;
  last_backup_at: string | null;
  db: 'ok' | 'unavailable';
}

function computeHealth(
  snapshot: HealthSnapshot,
  now: number,
  staleAfterS: number,
): {
  payload: HealthPayload;
  statusCode: number;
} {
  const ageMs = snapshot.lastTickTs === null ? null : Math.max(0, now - snapshot.lastTickTs);
  const ageS = ageMs === null ? null : Math.round((ageMs / 1000) * 10) / 10;
  const uptimeS = Math.max(0, Math.round((now - snapshot.startedAt) / 1000));

  let status: HealthPayload['status'] = 'ok';
  if (!snapshot.dbOk) {
    status = 'degraded';
  } else if (ageS !== null && ageS > staleAfterS) {
    status = 'stale';
  } else if (ageS === null && uptimeS > staleAfterS) {
    // Aucun tick après un délai anormal : le moteur ne progresse pas.
    status = 'stale';
  }

  const payload: HealthPayload = {
    status,
    mode: snapshot.mode,
    version: snapshot.version,
    uptime_s: uptimeS,
    ticks: snapshot.ticks,
    last_tick_at: snapshot.lastTickTs === null ? null : new Date(snapshot.lastTickTs).toISOString(),
    last_tick_age_s: ageS,
    nav_usd: snapshot.navUsd,
    positions_open: snapshot.openCount,
    paused: snapshot.manualPaused,
    kill_switch: snapshot.stopRequested,
    last_backup_at:
      snapshot.lastBackupTs === null ? null : new Date(snapshot.lastBackupTs).toISOString(),
    db: snapshot.dbOk ? 'ok' : 'unavailable',
  };
  return { payload, statusCode: status === 'ok' ? 200 : 503 };
}

/**
 * Serveur HTTP local (aucune authentification, écoute par défaut sur
 * 127.0.0.1) : `/healthz` pour Docker/systemd, `/metrics` au format
 * Prometheus — consommable tel quel par scrape.
 */
export async function startMonitoringServer(deps: MonitoringServerDeps): Promise<MonitoringServer> {
  const now = deps.now ?? Date.now;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method !== 'GET') {
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('méthode non autorisée\n');
      return;
    }

    if (url.pathname === '/metrics') {
      // Uptime et fraîcheur du dernier tick sont recalculés au scrape.
      const snapshot = deps.health();
      deps.registry.set(
        METRICS.uptimeSeconds,
        'Uptime du processus (s)',
        Math.max(0, Math.round((now() - snapshot.startedAt) / 1000)),
      );
      if (snapshot.lastTickTs !== null) {
        deps.registry.set(
          METRICS.lastTickTsSeconds,
          'Horodatage Unix (s) du dernier tick',
          Math.round(snapshot.lastTickTs / 1000),
        );
      }
      response.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      });
      response.end(deps.registry.render());
      return;
    }

    if (url.pathname === '/healthz' || url.pathname === '/') {
      const { payload, statusCode } = computeHealth(deps.health(), now(), deps.staleAfterS);
      response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
      response.end(`${JSON.stringify(payload)}\n`);
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('introuvable — endpoints : /healthz, /metrics\n');
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(deps.port, deps.host);
    });
  } catch (error) {
    throw new SolbotError(
      `Impossible de démarrer le serveur de supervision sur ${deps.host}:${deps.port} (${error instanceof Error ? error.message : String(error)})`,
      {
        hint: 'Changez monitoring.port dans config.yaml (ou désactivez monitoring.enabled).',
        cause: error,
      },
    );
  }

  const address = server.address() as AddressInfo;
  const host =
    address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
  return {
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
