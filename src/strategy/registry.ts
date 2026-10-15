import type { Config, StrategyConfig } from '../utils/config.js';
import { SolbotError } from '../utils/errors.js';
import { DcaRotationStrategy, parseDcaRotationParams } from './dca-rotation.js';
import { MeanReversionStrategy, parseMeanReversionParams } from './mean-reversion.js';
import { MomentumStrategy, parseMomentumParams } from './momentum.js';
import type { Strategy } from './types.js';

/**
 * Registre des stratégies : instancie celles activées dans `config.yaml`.
 * Les stratégies prévues mais non implémentées (Phase 7) échouent
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

  const meanReversion = config.strategies.mean_reversion;
  if (meanReversion.enabled) {
    strategies.push(
      new MeanReversionStrategy(
        parseMeanReversionParams(meanReversion.params, meanReversion.timeframe ?? '15m'),
      ),
    );
  }

  const dcaRotation = config.strategies.dca_rotation;
  if (dcaRotation.enabled) {
    strategies.push(
      new DcaRotationStrategy(parseDcaRotationParams(dcaRotation.params, config.base_currency)),
    );
  }

  if (config.strategies.copy_trade.enabled) {
    throw new SolbotError(
      'Stratégie « copy_trade » activée dans config.yaml mais pas encore implémentée (Phase 7)',
      { hint: 'Passez strategies.copy_trade.enabled à false.' },
    );
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

export interface StrategyDescriptor {
  name: string;
  weight: number;
  timeframe: string | null;
  params: Record<string, unknown>;
}

/**
 * Description canonique des stratégies **activées** (nom, poids, timeframe,
 * paramètres). Sert d'empreinte pour le garde-fou live : un backtest ne vaut
 * que pour le jeu de paramètres exact avec lequel il a été exécuté.
 */
export function strategySetDescriptor(config: Config): StrategyDescriptor[] {
  const descriptors: StrategyDescriptor[] = [];
  const entries: Array<[string, StrategyConfig]> = [
    ['dca_rotation', config.strategies.dca_rotation],
    ['mean_reversion', config.strategies.mean_reversion],
    ['momentum', config.strategies.momentum],
  ];
  for (const [name, strategy] of entries) {
    if (!strategy.enabled) continue;
    descriptors.push({
      name,
      weight: strategy.weight,
      timeframe: strategy.timeframe ?? null,
      params: strategy.params,
    });
  }
  return descriptors;
}
