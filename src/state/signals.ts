import type { DatabaseSync } from 'node:sqlite';

export interface SignalRecord {
  ts: number;
  strategy: string;
  mint: string;
  symbol: string;
  side: 'buy' | 'sell';
  confidence: number;
  edgeBps: number | null;
  ttlMs: number;
  reason: string;
}

interface SignalRow {
  id: number;
  ts: number;
  strategy: string;
  mint: string;
  symbol: string;
  side: string;
  confidence: number;
  edge_bps: number | null;
  ttl_ms: number;
  reason: string;
  acted: number;
}

export type StoredSignal = SignalRecord & { id: number; acted: boolean };

/** Enregistre un signal candidat (audit : signal → décision → trade). */
export function insertSignal(db: DatabaseSync, signal: SignalRecord): number {
  const result = db
    .prepare(
      `INSERT INTO signals (ts, strategy, mint, symbol, side, confidence, edge_bps, ttl_ms, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      signal.ts,
      signal.strategy,
      signal.mint,
      signal.symbol,
      signal.side,
      signal.confidence,
      signal.edgeBps,
      signal.ttlMs,
      signal.reason,
    ) as unknown as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

/** Marque un signal comme suivi d'effet (exécuté ou déclencheur d'un rejet motivé). */
export function markSignalActed(db: DatabaseSync, id: number): void {
  db.prepare('UPDATE signals SET acted = 1 WHERE id = ?').run(id);
}

export function getRecentSignals(db: DatabaseSync, limit = 50): StoredSignal[] {
  const rows = db
    .prepare('SELECT * FROM signals ORDER BY ts DESC, id DESC LIMIT ?')
    .all(limit) as unknown as SignalRow[];
  return rows.map((row) => ({
    id: row.id,
    ts: row.ts,
    strategy: row.strategy,
    mint: row.mint,
    symbol: row.symbol,
    side: row.side as 'buy' | 'sell',
    confidence: row.confidence,
    edgeBps: row.edge_bps,
    ttlMs: row.ttl_ms,
    reason: row.reason,
    acted: row.acted === 1,
  }));
}
