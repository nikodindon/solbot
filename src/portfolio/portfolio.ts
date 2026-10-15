import type { DatabaseSync } from 'node:sqlite';
import { getOpenPositions, qtyToFloat, type PositionRow } from '../state/positions.js';

/** Position enrichie du dernier prix connu. */
export interface PositionView extends PositionRow {
  priceUsd: number | null;
  valueUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
}

export interface PortfolioSnapshot {
  ts: number;
  /** Liquidités (USDC en paper, solde RPC en live) — fournies par l'appelant. */
  cashUsd: number;
  positionsValueUsd: number;
  /** NAV = liquidités + valeur des positions. */
  navUsd: number;
  unrealizedPnlUsd: number;
  /** PnL réalisé cumulé (positions ouvertes et clôturées). */
  realizedPnlUsd: number;
  openCount: number;
  positions: PositionView[];
}

/**
 * Vue portefeuille : les positions vivent en base (source de vérité locale),
 * le Portfolio ne fait que les valoriser (mark-to-market) et calculer le NAV.
 * La trésorerie est injectée par l'appelant : caisse virtuelle en paper,
 * soldes RPC réconciliés en live.
 */
export class Portfolio {
  constructor(private readonly db: DatabaseSync) {}

  openPositions(): PositionRow[] {
    return getOpenPositions(this.db);
  }

  positionFor(mint: string): PositionRow | null {
    return this.openPositions().find((position) => position.mint === mint) ?? null;
  }

  /** Valeur courante d'une position (unités UI × prix). */
  static valueUsd(position: PositionRow, priceUsd: number | null): number {
    if (priceUsd === null) return 0;
    return qtyToFloat(position.qtyRemaining, position.decimals) * priceUsd;
  }

  /**
   * Instantané complet : valeur par position, PnL latent (valeur − cost basis
   * FIFO restant), PnL réalisé cumulé et NAV.
   */
  snapshot(input: {
    cashUsd: number;
    prices: Map<string, number | null>;
    ts?: number;
  }): PortfolioSnapshot {
    const positions = this.openPositions();
    let positionsValueUsd = 0;
    let unrealizedPnlUsd = 0;
    let realizedPnlUsd = 0;

    const views: PositionView[] = positions.map((position) => {
      const priceUsd = input.prices.get(position.mint) ?? null;
      const valueUsd = Portfolio.valueUsd(position, priceUsd);
      const unrealized = priceUsd === null ? 0 : valueUsd - position.costBasisUsd;
      const pct = position.costBasisUsd > 0 ? (unrealized / position.costBasisUsd) * 100 : 0;
      positionsValueUsd += valueUsd;
      unrealizedPnlUsd += unrealized;
      realizedPnlUsd += position.realizedPnlUsd;
      return {
        ...position,
        priceUsd,
        valueUsd,
        unrealizedPnlUsd: unrealized,
        unrealizedPnlPct: pct,
      };
    });

    return {
      ts: input.ts ?? Date.now(),
      cashUsd: input.cashUsd,
      positionsValueUsd,
      navUsd: input.cashUsd + positionsValueUsd,
      unrealizedPnlUsd,
      realizedPnlUsd,
      openCount: positions.length,
      positions: views,
    };
  }
}
