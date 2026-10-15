import { Connection, type Commitment } from '@solana/web3.js';
import type { Env } from '../utils/config.js';
import { RpcError } from '../utils/errors.js';
import { retry, withTimeout } from '../utils/retry.js';

export interface RpcProbe {
  url: string;
  latencyMs: number;
  solanaCore: string;
  slot: number;
}

export function createConnection(url: string, commitment: Commitment = 'confirmed'): Connection {
  return new Connection(url, {
    commitment,
    confirmTransactionInitialTimeout: 60_000,
  });
}

/** Ping du RPC : version + slot, chronométré, avec timeout dur. */
export async function probeRpc(connection: Connection, timeoutMs = 7_500): Promise<RpcProbe> {
  const start = Date.now();
  const [version, slot] = await withTimeout(
    Promise.all([connection.getVersion(), connection.getSlot('confirmed')]),
    timeoutMs,
    `RPC ${connection.rpcEndpoint} ne répond pas`,
  );
  return {
    url: connection.rpcEndpoint,
    latencyMs: Date.now() - start,
    solanaCore: String(version['solana-core'] ?? 'inconnu'),
    slot,
  };
}

export interface ResolvedConnection {
  connection: Connection;
  url: string;
  usedFallback: boolean;
  probe: RpcProbe;
}

/**
 * Résout la connexion RPC active : primaire (2 tentatives), puis secours optionnel.
 * Lève une RpcError avec un indice si aucun endpoint ne répond.
 */
export async function resolveConnection(env: Env, timeoutMs = 7_500): Promise<ResolvedConnection> {
  const primary = createConnection(env.SOLANA_RPC_URL);
  try {
    const probe = await retry(() => probeRpc(primary, timeoutMs), {
      attempts: 2,
      baseDelayMs: 250,
    });
    return { connection: primary, url: env.SOLANA_RPC_URL, usedFallback: false, probe };
  } catch (primaryError) {
    if (env.SOLANA_RPC_URL_FALLBACK) {
      const fallback = createConnection(env.SOLANA_RPC_URL_FALLBACK);
      try {
        const probe = await probeRpc(fallback, timeoutMs);
        return {
          connection: fallback,
          url: env.SOLANA_RPC_URL_FALLBACK,
          usedFallback: true,
          probe,
        };
      } catch (fallbackError) {
        throw new RpcError('RPC principal et RPC de secours injoignables', {
          hint: 'Vérifiez SOLANA_RPC_URL / SOLANA_RPC_URL_FALLBACK et votre connexion réseau.',
          cause: fallbackError,
        });
      }
    }
    throw new RpcError(`RPC injoignable : ${env.SOLANA_RPC_URL}`, {
      hint: "Vérifiez l'URL SOLANA_RPC_URL (l'endpoint public peut être rate-limité) et votre connexion.",
      cause: primaryError,
    });
  }
}
