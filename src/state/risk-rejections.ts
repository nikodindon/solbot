import type { DatabaseSync } from 'node:sqlite';

export interface RiskRejection {
  ts: number;
  mint: string;
  symbol: string;
  side: 'buy' | 'sell';
  strategy: string;
  /** Règle déclenchée (kill_switch, cooldown, sizing…). */
  rule: string;
  message: string;
  metrics?: Record<string, number | string | null>;
}

interface RejectionRow {
  id: number;
  ts: number;
  mint: string;
  symbol: string;
  side: string;
  strategy: string;
  rule: string;
  message: string;
  metrics: string | null;
}

export type StoredRejection = Omit<RiskRejection, 'metrics'> & {
  id: number;
  metrics: Record<string, number | string | null> | null;
};

/** Journalise un rejet de risque (chaque refus est motivé en base). */
export function insertRejection(db: DatabaseSync, rejection: RiskRejection): number {
  const result = db
    .prepare(
      `INSERT INTO risk_rejections (ts, mint, symbol, side, strategy, rule, message, metrics)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rejection.ts,
      rejection.mint,
      rejection.symbol,
      rejection.side,
      rejection.strategy,
      rejection.rule,
      rejection.message,
      rejection.metrics === undefined ? null : JSON.stringify(rejection.metrics),
    ) as unknown as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

export function getRecentRejections(db: DatabaseSync, limit = 50): StoredRejection[] {
  const rows = db
    .prepare('SELECT * FROM risk_rejections ORDER BY ts DESC, id DESC LIMIT ?')
    .all(limit) as unknown as RejectionRow[];
  return rows.map((row) => ({
    id: row.id,
    ts: row.ts,
    mint: row.mint,
    symbol: row.symbol,
    side: row.side as 'buy' | 'sell',
    strategy: row.strategy,
    rule: row.rule,
    message: row.message,
    metrics:
      row.metrics === null
        ? null
        : (JSON.parse(row.metrics) as Record<string, number | string | null>),
  }));
}

/** Compteur de rejets par règle depuis un timestamp (rapport de tick). */
export function countRejectionsByRuleSince(db: DatabaseSync, since: number): Map<string, number> {
  const rows = db
    .prepare(
      'SELECT rule, COUNT(*) AS count FROM risk_rejections WHERE ts >= ? GROUP BY rule ORDER BY count DESC',
    )
    .all(since) as unknown as { rule: string; count: number }[];
  return new Map(rows.map((row) => [row.rule, row.count]));
}
