import { VersionedTransaction, type Connection } from '@solana/web3.js';
import type { SimulateTransaction } from '../execution/executor.js';
import { SolbotError } from '../utils/errors.js';

interface SimulationValue {
  err: unknown;
  unitsConsumed?: number | null;
  logs?: string[] | null;
}

/**
 * Simulateur de transaction non signée : `sigVerify` désactivé et blockhash
 * remplacé (le blockhash d'un ordre peut expirer entre `/order` et la
 * simulation). Partagé entre `swap` (Phase 2), `start` (Phase 3) et le chemin
 * Router (Phase 6).
 *
 * Les transactions v1 (Phase 6c) passent par un appel JSON-RPC direct transmis
 * en base64 : web3.js 1.99 sait les lire mais pas les re-sérialiser.
 */
export function buildSimulator(connection: Connection): SimulateTransaction {
  return async (transactionBase64) => {
    const transaction = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
    const value =
      transaction.message.version === 1
        ? await simulateV1Raw(connection, transactionBase64)
        : (
            await connection.simulateTransaction(transaction, {
              sigVerify: false,
              replaceRecentBlockhash: true,
              commitment: 'confirmed',
            })
          ).value;
    return {
      err: value.err ?? null,
      unitsConsumed: value.unitsConsumed ?? null,
      logsTail: (value.logs ?? []).slice(-5),
    };
  };
}

/** Simulation JSON-RPC d'une transaction v1 (les octets base64 passent tels quels). */
async function simulateV1Raw(
  connection: Connection,
  transactionBase64: string,
): Promise<SimulationValue> {
  let response: Response;
  try {
    response = await fetch(connection.rpcEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'simulateTransaction',
        params: [
          transactionBase64,
          {
            encoding: 'base64',
            sigVerify: false,
            replaceRecentBlockhash: true,
            commitment: 'confirmed',
          },
        ],
      }),
    });
  } catch (error) {
    throw new SolbotError(
      `simulation v1 : RPC injoignable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!response.ok) {
    throw new SolbotError(`simulation v1 : RPC en erreur (HTTP ${response.status})`);
  }
  const payload = (await response.json().catch(() => null)) as {
    result?: { value?: SimulationValue };
    error?: { message?: string } | undefined;
  } | null;
  if (payload === null) throw new SolbotError('simulation v1 : réponse RPC illisible');
  if (payload.error !== undefined) {
    throw new SolbotError(`simulation v1 refusée : ${payload.error.message ?? 'erreur RPC'}`);
  }
  const value = payload.result?.value;
  if (value === undefined) throw new SolbotError('simulation v1 : réponse RPC inattendue');
  return value;
}
