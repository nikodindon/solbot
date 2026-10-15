import type { Config } from '../utils/config.js';
import { SolbotError } from '../utils/errors.js';
import { MomentumStrategy, parseMomentumParams } from './momentum.js';
import type { Strategy } from './types.js';

/**
 * Registre des stratégies : instancie celles activées dans `config.yaml`.
 * Les stratégies prévues mais non implémentées (Phases 4/7) échouent
 * explicitement si on tente de les activer — pas d'échec silencieux.
 */
export function buildStrategies(config: Config): Strategy[] {
  const strategies: Strategy[] = [];

  const momentum = config.strategies.momentum;
  if (momentum.enabled) {
    strategies.push(
      new MomentumStrategy(parseMomentumParams(momentum.params, momentum.timeframe ?? '15m')),
    );
  }

  const unimplemented: Array<[string, boolean, string]> = [
    ['mean_reversion', config.strategies.mean_reversion.enabled, 'Phase 4'],
    ['dca_rotation', config.strategies.dca_rotation.enabled, 'Phase 4'],
    ['copy_trade', config.strategies.copy_trade.enabled, 'Phase 7'],
  ];
  for (const [name, enabled, phase] of unimplemented) {
    if (enabled) {
      throw new SolbotError(
        `Stratégie « ${name} » activée dans config.yaml mais pas encore implémentée (${phase})`,
        { hint: `Passez strategies.${name}.enabled à false.` },
      );
    }
  }

  if (strategies.length === 0) {
    throw new SolbotError('Aucune stratégie activée dans config.yaml', {
      hint: 'Activez au moins strategies.momentum.enabled: true.',
    });
  }
  return strategies;
}

/** Pondérations par nom de stratégie (arbitrage du Signal Engine). */
export function strategyWeights(config: Config): Map<string, number> {
  return new Map([
    ['momentum', config.strategies.momentum.weight],
    ['mean_reversion', config.strategies.mean_reversion.weight],
    ['dca_rotation', config.strategies.dca_rotation.weight],
    ['copy_trade', config.strategies.copy_trade.weight],
  ]);
}
