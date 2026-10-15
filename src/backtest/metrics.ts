/**
 * Métriques de performance (Phase 4) — définitions stables et testées :
 * PnL net, win rate, profit factor, drawdown max, Sharpe simplifié,
 * turnover, frais. Toutes les métriques non calculables valent `null`
 * (jamais de valeur trompeuse).
 */

export interface EquitySample {
  ts: number;
  navUsd: number;
}

export interface ClosedPositionSample {
  realizedPnlUsd: number;
  closedAt: number;
}

export interface TradeSample {
  notionalUsd: number;
  feeUsd: number | null;
}

export interface PerformanceMetrics {
  initialNavUsd: number;
  finalNavUsd: number;
  netPnlUsd: number;
  netPnlPct: number;
  days: number;
  /** Positions clôturées dans la fenêtre. */
  trades: number;
  wins: number;
  losses: number;
  /** % de gagnantes parmi les positions non nulles ; `null` si aucune. */
  winRatePct: number | null;
  grossProfitUsd: number;
  grossLossUsd: number;
  /** PnL brut gagnant / PnL brut perdant ; `null` si aucune perte. */
  profitFactor: number | null;
  /** Drawdown max depuis le pic de NAV ; `null` si trop peu de points. */
  maxDrawdownPct: number | null;
  /** Sharpe annualisé (√365) sur rendements quotidiens ; `null` si indéfini. */
  sharpe: number | null;
  /** Notionnel total échangé / NAV moyen (rotation du capital). */
  turnover: number;
  turnoverPerDay: number;
  feesUsd: number;
  avgTradeUsd: number;
}

const EPSILON = 1e-9;

export function computeMetrics(input: {
  equity: EquitySample[];
  closedPositions: ClosedPositionSample[];
  trades: TradeSample[];
  initialUsd: number;
  days: number;
}): PerformanceMetrics {
  const equity = input.equity;
  const finalNavUsd = equity.length > 0 ? equity[equity.length - 1]!.navUsd : input.initialUsd;
  const netPnlUsd = finalNavUsd - input.initialUsd;
  const netPnlPct = input.initialUsd > 0 ? (netPnlUsd / input.initialUsd) * 100 : 0;

  let wins = 0;
  let losses = 0;
  let grossProfitUsd = 0;
  let grossLossUsd = 0;
  for (const position of input.closedPositions) {
    if (position.realizedPnlUsd > EPSILON) {
      wins += 1;
      grossProfitUsd += position.realizedPnlUsd;
    } else if (position.realizedPnlUsd < -EPSILON) {
      losses += 1;
      grossLossUsd += -position.realizedPnlUsd;
    }
  }
  const decided = wins + losses;

  const totalNotional = input.trades.reduce((sum, trade) => sum + Math.abs(trade.notionalUsd), 0);
  const avgNav =
    equity.length > 0
      ? equity.reduce((sum, point) => sum + point.navUsd, 0) / equity.length
      : input.initialUsd;
  const turnover = avgNav > 0 ? totalNotional / avgNav : 0;

  return {
    initialNavUsd: input.initialUsd,
    finalNavUsd,
    netPnlUsd,
    netPnlPct,
    days: input.days,
    trades: input.closedPositions.length,
    wins,
    losses,
    winRatePct: decided > 0 ? (wins / decided) * 100 : null,
    grossProfitUsd,
    grossLossUsd,
    profitFactor: grossLossUsd > 0 ? grossProfitUsd / grossLossUsd : null,
    maxDrawdownPct: maxDrawdownPct(equity),
    sharpe: sharpeDaily(equity),
    turnover,
    turnoverPerDay: input.days > 0 ? turnover / input.days : turnover,
    feesUsd: input.trades.reduce((sum, trade) => sum + (trade.feeUsd ?? 0), 0),
    avgTradeUsd: input.trades.length > 0 ? totalNotional / input.trades.length : 0,
  };
}

/** Drawdown max (%) depuis le pic de NAV ; `null` si moins de deux points. */
export function maxDrawdownPct(equity: EquitySample[]): number | null {
  if (equity.length < 2) return null;
  let peak = equity[0]!.navUsd;
  let worst = 0;
  for (const point of equity) {
    if (point.navUsd > peak) peak = point.navUsd;
    if (peak > 0) {
      const drawdown = ((peak - point.navUsd) / peak) * 100;
      if (drawdown > worst) worst = drawdown;
    }
  }
  return worst;
}

/**
 * Sharpe simplifié : rendements des dernières NAV de chaque jour UTC,
 * moyenne / écart-type (population) × √365. `null` si moins de deux jours
 * ou si la volatilité est nulle.
 */
export function sharpeDaily(equity: EquitySample[]): number | null {
  if (equity.length < 2) return null;
  const lastByDay = new Map<string, number>();
  for (const point of equity) {
    lastByDay.set(new Date(point.ts).toISOString().slice(0, 10), point.navUsd);
  }
  const closes = [...lastByDay.values()];
  if (closes.length < 3) return null;

  const returns: number[] = [];
  for (let index = 1; index < closes.length; index++) {
    const previous = closes[index - 1]!;
    if (!(previous > 0)) continue;
    returns.push(closes[index]! / previous - 1);
  }
  if (returns.length < 2) return null;

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  const sigma = Math.sqrt(variance);
  if (!(sigma > 0)) return null;
  return (mean / sigma) * Math.sqrt(365);
}
