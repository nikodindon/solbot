import type { DatabaseSync } from 'node:sqlite';

/** Candidat d'arbitrage journalisé (une ligne par stratégie en lice). */
export interface ArbitrationCandidate {
  strategy: string;
  confidence: number;
  edgeBps: number | null;
  weight: number;
  score: number;
  chosen: boolean;
  /** best_score | lower_score | cap_reached | exit_priority */
  reason: string;
}

export interface ArbitrationRecord {
  ts: number;
  mint: string;
  symbol: string;
  side: 'buy' | 'sell';
  chosenStrategy: string | null;
  chosenScore: number | null;
  candidates: ArbitrationCandidate[];
  /**
   * Motif global de la décision : best_score (retenu), cap_reached (plafond
   * d'entrées/tick), exit_priority (une sortie prime), kill_switch,
   * daily_loss_pause.
   */
  reason: string;
}

/** Journalise une décision d'arbitrage (Phase 4) — audit signal → exécution. */
export function insertArbitration(db: DatabaseSync, record: ArbitrationRecord): number {
  const result = db
    .prepare(
      `INSERT INTO arbitrations
         (ts, mint, symbol, side, chosen_strategy, chosen_score, candidates, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.ts,
      record.mint,
      record.symbol,
      record.side,
      record.chosenStrategy,
      record.chosenScore,
      JSON.stringify(record.candidates),
      record.reason,
    ) as unknown as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

/** Répartition des décisions d'arbitrage par motif (diagnostic). */
export function countArbitrationsByReason(
  db: DatabaseSync,
): Array<{ reason: string; count: number }> {
  return db
    .prepare(
      'SELECT reason, COUNT(*) AS count FROM arbitrations GROUP BY reason ORDER BY count DESC',
    )
    .all() as unknown as Array<{ reason: string; count: number }>;
}
