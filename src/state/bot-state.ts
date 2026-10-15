import type { DatabaseSync } from 'node:sqlite';

/**
 * Petit magasin clé/valeur persistant (état du moteur : pic de NAV, ancre de
 * perte journalière, pause, caisse virtuelle du mode paper…). Les valeurs sont
 * du texte ; des helpers couvrent le cas numérique.
 */
export function getState(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM bot_state WHERE key = ?').get(key) as unknown as
    { value: string } | undefined;
  return row?.value ?? null;
}

export function setState(db: DatabaseSync, key: string, value: string, ts = Date.now()): void {
  db.prepare(
    `INSERT INTO bot_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, ts);
}

export function deleteState(db: DatabaseSync, key: string): void {
  db.prepare('DELETE FROM bot_state WHERE key = ?').run(key);
}

export function getNumberState(db: DatabaseSync, key: string): number | null {
  const raw = getState(db, key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function setNumberState(
  db: DatabaseSync,
  key: string,
  value: number,
  ts = Date.now(),
): void {
  setState(db, key, String(value), ts);
}

/** Clés connues du moteur (évite les fautes de frappe silencieuses). */
export const STATE_KEYS = {
  navPeakUsd: 'nav_peak_usd',
  dayKey: 'day_key',
  dayStartNavUsd: 'day_start_nav_usd',
  pausedUntilMs: 'paused_until_ms',
  paperCashUsdc: 'paper_cash_usdc',
  lastTickTs: 'last_tick_ts',
  engineStartedAt: 'engine_started_at',
  /** Pause manuelle des entrées (`/pause` Telegram, `solbot pause`) — les sorties restent actives. */
  manualPaused: 'manual_paused',
  /** Jour UTC du dernier backup automatique (`YYYY-MM-DD`). */
  lastBackupDay: 'last_backup_day',
  /** Jour UTC du dernier rapport PnL quotidien Telegram. */
  lastDailyReportDay: 'last_daily_report_day',
  /** Préfixe des horodatages d'anti-spam d'alertes (`alert_last_<règle>`). */
  alertLastPrefix: 'alert_last_',
} as const;
