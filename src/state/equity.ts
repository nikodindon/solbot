import type { DatabaseSync } from 'node:sqlite';

export interface EquityPointInput {
  mode: string;
  ts: number;
  navUsd: number;
  cashUsd: number;
  positionsValueUsd: number;
  openCount: number;
}

export interface EquityPoint {
  ts: number;
  navUsd: number;
  cashUsd: number;
  positionsValueUsd: number;
  openCount: number;
}

/** Ajoute un point de courbe d'equity (un par tick moteur). */
export function insertEquityPoint(db: DatabaseSync, point: EquityPointInput): void {
  db.prepare(
    `INSERT INTO equity_curve (mode, ts, nav_usd, cash_usd, positions_value_usd, open_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    point.mode,
    point.ts,
    point.navUsd,
    point.cashUsd,
    point.positionsValueUsd,
    point.openCount,
  );
}

/** Série d'equity (croissante en `ts`), filtrable par mode et fenêtre. */
export function getEquitySeries(
  db: DatabaseSync,
  options: { mode?: string; fromTs?: number; toTs?: number } = {},
): EquityPoint[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.mode !== undefined) {
    where.push('mode = ?');
    params.push(options.mode);
  }
  if (options.fromTs !== undefined) {
    where.push('ts >= ?');
    params.push(options.fromTs);
  }
  if (options.toTs !== undefined) {
    where.push('ts <= ?');
    params.push(options.toTs);
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT ts, nav_usd, cash_usd, positions_value_usd, open_count FROM equity_curve${clause} ORDER BY ts, id`,
    )
    .all(...params) as unknown as Array<{
    ts: number;
    nav_usd: number;
    cash_usd: number;
    positions_value_usd: number;
    open_count: number;
  }>;
  return rows.map((row) => ({
    ts: row.ts,
    navUsd: row.nav_usd,
    cashUsd: row.cash_usd,
    positionsValueUsd: row.positions_value_usd,
    openCount: row.open_count,
  }));
}
