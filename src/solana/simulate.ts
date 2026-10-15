import { VersionedTransaction, type Connection } from '@solana/web3.js';
import type { SimulateTransaction } from '../execution/executor.js';

/**
 * Simulateur de transaction non signée : `sigVerify` désactivé et blockhash
 * remplacé (le blockhash d'un ordre peut expirer entre `/order` et la
 * simulation). Partagé entre `swap` (Phase 2) et `start` (Phase 3).
 */
export function buildSimulator(connection: Connection): SimulateTransaction {
  return async (transactionBase64) => {
    const transaction = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
    const response = await connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
    });
    const value = response.value;
    return {
      err: value.err ?? null,
      unitsConsumed: value.unitsConsumed ?? null,
      logsTail: (value.logs ?? []).slice(-5),
    };
  };
}
