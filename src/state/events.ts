import type { DatabaseSync } from 'node:sqlite';

export type EventLevel = 'info' | 'warn' | 'error';

export interface EngineEvent {
  id: number;
  ts: number;
  level: EventLevel;
  kind: string;
  message: string;
  details: string | null;
}

/**
 * Journal d'événements du moteur (démarrages/arrêts, kill-switch, réconciliation,
 * erreurs de tick…). Distinct de `trades` (exécutions) et `risk_rejections`
 * (règles de risque) : ici, ce qui arrive au bot lui-même.
 */
export function insertEvent(
  db: DatabaseSync,
  event: {
    level: EventLevel;
    kind: string;
    message: string;
    details?: unknown;
    ts?: number;
  },
): number {
  const result = db
    .prepare('INSERT INTO events (ts, level, kind, message, details) VALUES (?, ?, ?, ?, ?)')
    .run(
      event.ts ?? Date.now(),
      event.level,
      event.kind,
      event.message,
      event.details === undefined ? null : JSON.stringify(event.details),
    ) as unknown as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

interface EventRow {
  id: number;
  ts: number;
  level: string;
  kind: string;
  message: string;
  details: string | null;
}

/** Derniers événements, du plus récent au plus ancien. */
export function getRecentEvents(db: DatabaseSync, limit = 50): EngineEvent[] {
  const rows = db
    .prepare('SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT ?')
    .all(limit) as unknown as EventRow[];
  return rows.map((row) => ({
    id: row.id,
    ts: row.ts,
    level: row.level as EventLevel,
    kind: row.kind,
    message: row.message,
    details: row.details,
  }));
}
