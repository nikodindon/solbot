/**
 * Tests d'intégration `@integration` — API Jupiter réelle (mainnet uniquement).
 *
 * Désactivés par défaut, y compris en CI. Pour les lancer :
 *
 *   SOLBOT_INTEGRATION=1 npm run test:integration
 *
 * Ils utilisent le wallet du projet courant (`SOLBOT_HOME` ou racine du dépôt)
 * et font de vrais appels `/order` + une simulation RPC — **aucune signature,
 * aucun fonds engagé**. Les échecs de fonds (wallet non financé) sont un
 * résultat d'intégration valide : le code d'erreur 1 de `/order` est vérifié.
 */
import { describe, expect, it } from 'vitest';
import { runSwap } from '../../src/cli/swap.js';
import { getProjectRoot } from '../../src/utils/paths.js';

const enabled = process.env.SOLBOT_INTEGRATION === '1';

describe.skipIf(!enabled)('@integration — Swap V2 mainnet (sans signature)', () => {
  it('obtient une citation réelle puis simule (ou constate l’échec de fonds)', async () => {
    const outcome = await runSwap('SOL', 'USDC', '0.01', {
      dryRun: true,
      root: getProjectRoot(),
    });

    // Une citation exploitable accompagne toujours la réponse /order.
    expect(Number(outcome.order.outAmount)).toBeGreaterThan(0);

    if (outcome.status === 'simulated') {
      // Wallet financé : transaction construite + simulation RPC sans signature.
      expect(outcome.order.transaction).toBeTruthy();
      expect(outcome.simulation?.err).toBeNull();
    } else {
      // Wallet non financé : contrat d'erreur /order vérifié (code 1 = fonds).
      expect(outcome.status).toBe('failed');
      expect(outcome.failure).toMatchObject({ kind: 'order', code: 1 });
    }
  }, 60_000);
});
