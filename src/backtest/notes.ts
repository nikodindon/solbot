import type { PerformanceMetrics } from './metrics.js';

/** Note lisible sur la validité d'un backtest au regard du garde-fou live. */
export function computeBacktestGuardNote(
  input: { conclusive: boolean; metrics: PerformanceMetrics },
  guardMinDays: number,
): string {
  if (input.conclusive) {
    return `✔ concluant (${input.metrics.days.toFixed(1)} j ≥ ${guardMinDays} j requis)`;
  }
  return `⚠ non concluant (${input.metrics.days.toFixed(1)} j < ${guardMinDays} j requis)`;
}
