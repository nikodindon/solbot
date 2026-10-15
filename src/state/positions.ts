import type { DatabaseSync } from 'node:sqlite';
import { SolbotError } from '../utils/errors.js';

export type PositionStatus = 'open' | 'closed';

export interface PositionRow {
  id: number;
  mint: string;
  symbol: string;
  decimals: number;
  status: PositionStatus;
  /** Quantité totale entrée (unités de base, texte u64). */
  qty: string;
  /** Quantité encore détenue. */
  qtyRemaining: string;
  avgEntryPriceUsd: number;
  /** Coût des unités restantes (l'unité vendue sort du cost basis, FIFO). */
  costBasisUsd: number;
  realizedPnlUsd: number;
  /** Plus haut prix observé depuis l'entrée — ancre du trailing stop. */
  peakPriceUsd: number | null;
  stopLossPriceUsd: number | null;
  takeProfitPriceUsd: number | null;
  openedAt: number;
  updatedAt: number;
  closedAt: number | null;
}

interface PositionDbRow {
  id: number;
  mint: string;
  symbol: string;
  decimals: number;
  status: string;
  qty: string;
  qty_remaining: string;
  avg_entry_price_usd: number;
  cost_basis_usd: number;
  realized_pnl_usd: number;
  peak_price_usd: number | null;
  stop_loss_price_usd: number | null;
  take_profit_price_usd: number | null;
  opened_at: number;
  updated_at: number;
  closed_at: number | null;
}

interface LotRow {
  id: number;
  position_id: number;
  qty: string;
  price_usd: number;
  ts: number;
}

function toDomain(row: PositionDbRow): PositionRow {
  return {
    id: row.id,
    mint: row.mint,
    symbol: row.symbol,
    decimals: row.decimals,
    status: row.status as PositionStatus,
    qty: row.qty,
    qtyRemaining: row.qty_remaining,
    avgEntryPriceUsd: row.avg_entry_price_usd,
    costBasisUsd: row.cost_basis_usd,
    realizedPnlUsd: row.realized_pnl_usd,
    peakPriceUsd: row.peak_price_usd,
    stopLossPriceUsd: row.stop_loss_price_usd,
    takeProfitPriceUsd: row.take_profit_price_usd,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

/** Quantité (unités de base, texte) → nombre décimal (unités UI). */
export function qtyToFloat(qty: string, decimals: number): number {
  return Number(qty) / 10 ** decimals;
}

export function getOpenPositions(db: DatabaseSync): PositionRow[] {
  const rows = db
    .prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at, id")
    .all() as unknown as PositionDbRow[];
  return rows.map(toDomain);
}

export function getOpenPosition(db: DatabaseSync, mint: string): PositionRow | null {
  const row = db
    .prepare("SELECT * FROM positions WHERE mint = ? AND status = 'open' ORDER BY id DESC LIMIT 1")
    .get(mint) as unknown as PositionDbRow | undefined;
  return row === undefined ? null : toDomain(row);
}

export function getPositionById(db: DatabaseSync, id: number): PositionRow | null {
  const row = db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as unknown as
    PositionDbRow | undefined;
  return row === undefined ? null : toDomain(row);
}

/** Lots restants d'une position (ordre FIFO), exposé pour les tests et l'audit. */
export function getPositionLots(
  db: DatabaseSync,
  positionId: number,
): Array<{ id: number; qty: string; priceUsd: number; ts: number }> {
  const rows = db
    .prepare('SELECT * FROM position_lots WHERE position_id = ? ORDER BY ts, id')
    .all(positionId) as unknown as LotRow[];
  return rows.map((row) => ({ id: row.id, qty: row.qty, priceUsd: row.price_usd, ts: row.ts }));
}

export interface OpenPositionInput {
  mint: string;
  symbol: string;
  decimals: number;
  /** Quantité en unités de base (texte entier). */
  qty: string;
  priceUsd: number;
  ts: number;
  stopLossPriceUsd?: number | null;
  takeProfitPriceUsd?: number | null;
}

/**
 * Ouvre une position — ou l'augmente si une position ouverte existe déjà pour
 * ce mint (ajout de lot, prix moyen recalculé).
 */
export function openPosition(db: DatabaseSync, input: OpenPositionInput): PositionRow {
  const qty = validateQty(input.qty);
  if (!(input.priceUsd > 0)) {
    throw new SolbotError(`Prix d'entrée invalide pour ${input.symbol} : ${input.priceUsd}`);
  }

  const existing = getOpenPosition(db, input.mint);
  if (existing !== null) {
    return addToPosition(db, existing.id, { qty, priceUsd: input.priceUsd, ts: input.ts });
  }

  const qtyFloat = qtyToFloat(qty, input.decimals);
  const costBasisUsd = qtyFloat * input.priceUsd;
  const result = db
    .prepare(
      `INSERT INTO positions
        (mint, symbol, decimals, status, qty, qty_remaining, avg_entry_price_usd, cost_basis_usd,
         realized_pnl_usd, peak_price_usd, stop_loss_price_usd, take_profit_price_usd,
         opened_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.mint,
      input.symbol,
      input.decimals,
      qty,
      qty,
      input.priceUsd,
      costBasisUsd,
      input.priceUsd, // le pic démarre au prix d'entrée
      input.stopLossPriceUsd ?? null,
      input.takeProfitPriceUsd ?? null,
      input.ts,
      input.ts,
    ) as unknown as { lastInsertRowid: number | bigint };

  const positionId = Number(result.lastInsertRowid);
  db.prepare('INSERT INTO position_lots (position_id, qty, price_usd, ts) VALUES (?, ?, ?, ?)').run(
    positionId,
    qty,
    input.priceUsd,
    input.ts,
  );
  return getPositionById(db, positionId)!;
}

/** Ajoute un lot à une position ouverte et recalcule le prix moyen. */
export function addToPosition(
  db: DatabaseSync,
  positionId: number,
  input: { qty: string; priceUsd: number; ts: number },
): PositionRow {
  const position = getPositionById(db, positionId);
  if (position === null) throw new SolbotError(`Position ${positionId} introuvable`);
  const qty = validateQty(input.qty);
  if (!(input.priceUsd > 0)) throw new SolbotError(`Prix de lot invalide : ${input.priceUsd}`);

  const addedFloat = qtyToFloat(qty, position.decimals);
  const newQty = (BigInt(position.qty) + BigInt(qty)).toString();
  const newRemaining = (BigInt(position.qtyRemaining) + BigInt(qty)).toString();
  const newCostBasis = position.costBasisUsd + addedFloat * input.priceUsd;
  const remainingFloat = qtyToFloat(newRemaining, position.decimals);
  const avgEntry = remainingFloat > 0 ? newCostBasis / remainingFloat : input.priceUsd;

  db.exec('BEGIN');
  try {
    db.prepare(
      'INSERT INTO position_lots (position_id, qty, price_usd, ts) VALUES (?, ?, ?, ?)',
    ).run(positionId, qty, input.priceUsd, input.ts);
    db.prepare(
      `UPDATE positions SET qty = ?, qty_remaining = ?, cost_basis_usd = ?,
         avg_entry_price_usd = ?, updated_at = ? WHERE id = ?`,
    ).run(newQty, newRemaining, newCostBasis, avgEntry, input.ts, positionId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getPositionById(db, positionId)!;
}

export interface ReduceResult {
  position: PositionRow;
  /** PnL réalisé sur cette vente (FIFO). */
  realizedPnlUsd: number;
}

/**
 * Vend une quantité d'une position ouverte : consomme les lots les plus anciens
 * (FIFO) et comptabilise le PnL réalisé lot par lot. Clôt la position si tout
 * est vendu.
 */
export function reducePositionFifo(
  db: DatabaseSync,
  positionId: number,
  input: { qty: string; sellPriceUsd: number; ts: number },
): ReduceResult {
  const position = getPositionById(db, positionId);
  if (position === null) throw new SolbotError(`Position ${positionId} introuvable`);
  if (position.status !== 'open') throw new SolbotError(`Position ${positionId} déjà clôturée`);

  const sold = validateQty(input.qty);
  const remaining = BigInt(position.qtyRemaining);
  if (BigInt(sold) > remaining) {
    throw new SolbotError(
      `Vente ${sold} > position restante ${position.qtyRemaining} (${position.symbol})`,
    );
  }
  if (!(input.sellPriceUsd > 0)) {
    throw new SolbotError(`Prix de vente invalide : ${input.sellPriceUsd}`);
  }

  const lots = db
    .prepare('SELECT * FROM position_lots WHERE position_id = ? ORDER BY ts, id')
    .all(positionId) as unknown as LotRow[];

  let toSell = BigInt(sold);
  let realizedPnlUsd = 0;
  let costBasisUsd = position.costBasisUsd;

  db.exec('BEGIN');
  try {
    for (const lot of lots) {
      if (toSell === 0n) break;
      const lotQty = BigInt(lot.qty);
      const take = lotQty <= toSell ? lotQty : toSell;
      const takeFloat = qtyToFloat(take.toString(), position.decimals);
      realizedPnlUsd += takeFloat * (input.sellPriceUsd - lot.price_usd);
      costBasisUsd -= takeFloat * lot.price_usd;
      toSell -= take;

      if (take === lotQty) {
        db.prepare('DELETE FROM position_lots WHERE id = ?').run(lot.id);
      } else {
        db.prepare('UPDATE position_lots SET qty = ? WHERE id = ?').run(
          (lotQty - take).toString(),
          lot.id,
        );
      }
    }

    const newRemaining = (remaining - BigInt(sold)).toString();
    const remainingFloat = qtyToFloat(newRemaining, position.decimals);
    const newAvg =
      remainingFloat > 0 ? Math.max(0, costBasisUsd) / remainingFloat : position.avgEntryPriceUsd;
    const closed = newRemaining === '0';

    db.prepare(
      `UPDATE positions SET
         qty_remaining = ?, cost_basis_usd = ?, avg_entry_price_usd = ?,
         realized_pnl_usd = realized_pnl_usd + ?, status = ?, closed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      newRemaining,
      Math.max(0, costBasisUsd),
      newAvg,
      realizedPnlUsd,
      closed ? 'closed' : 'open',
      closed ? input.ts : null,
      input.ts,
      positionId,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { position: getPositionById(db, positionId)!, realizedPnlUsd };
}

/** Met à jour les marques de suivi (pic trailing, niveaux de stop). */
export function updatePositionMarks(
  db: DatabaseSync,
  positionId: number,
  marks: {
    peakPriceUsd?: number;
    stopLossPriceUsd?: number | null;
    takeProfitPriceUsd?: number | null;
    ts?: number;
  },
): void {
  const position = getPositionById(db, positionId);
  if (position === null) throw new SolbotError(`Position ${positionId} introuvable`);
  db.prepare(
    `UPDATE positions SET peak_price_usd = ?, stop_loss_price_usd = ?, take_profit_price_usd = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    marks.peakPriceUsd ?? position.peakPriceUsd,
    marks.stopLossPriceUsd === undefined ? position.stopLossPriceUsd : marks.stopLossPriceUsd,
    marks.takeProfitPriceUsd === undefined ? position.takeProfitPriceUsd : marks.takeProfitPriceUsd,
    marks.ts ?? Date.now(),
    positionId,
  );
}

function validateQty(qty: string): string {
  if (!/^\d+$/.test(qty) || BigInt(qty) <= 0n) {
    throw new SolbotError(
      `Quantité invalide : « ${qty} » (entier positif en unités de base attendu)`,
    );
  }
  return qty;
}
