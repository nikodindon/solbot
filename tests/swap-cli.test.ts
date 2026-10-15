import { describe, expect, it } from 'vitest';
import { swapExitCode } from '../src/cli/swap.js';
import type { SwapOutcome } from '../src/execution/executor.js';

function outcome(partial: Partial<SwapOutcome>): SwapOutcome {
  return {
    mode: 'dry_run',
    status: 'simulated',
    order: {} as never,
    execute: null,
    simulation: null,
    attempts: [],
    signature: null,
    realizedSlippageBps: null,
    tradeId: null,
    failure: null,
    ...partial,
  };
}

describe('swapExitCode', () => {
  it('retourne 0 pour un swap exécuté ou une simulation propre', () => {
    expect(swapExitCode(outcome({ status: 'success' }))).toBe(0);
    expect(
      swapExitCode(outcome({ simulation: { err: null, unitsConsumed: 1, logsTail: [] } })),
    ).toBe(0);
    // mode paper sans simulation (ne devrait pas arriver, mais neutre)
    expect(swapExitCode(outcome({ simulation: null }))).toBe(0);
  });

  it('retourne 1 pour un échec ou une simulation en erreur', () => {
    expect(
      swapExitCode(
        outcome({
          status: 'failed',
          failure: { kind: 'order', label: 'fonds insuffisants', code: 1 },
        }),
      ),
    ).toBe(1);
    expect(
      swapExitCode(
        outcome({
          simulation: {
            err: { InstructionError: [0, 'Custom'] },
            unitsConsumed: 100,
            logsTail: [],
          },
        }),
      ),
    ).toBe(1);
  });
});
