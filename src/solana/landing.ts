import type { Connection, PublicKey } from '@solana/web3.js';
import { SOL_MINT } from '../constants.js';

/**
 * Atterrissage des transactions signées (Phase 6, chemin Router).
 *
 * Le chemin Meta-Aggregator délègue l'envoi à Jupiter (`/execute`) ; le chemin
 * Router envoie lui-même. `LandingTarget` isole la cible d'envoi (RPC propre
 * ici ; infra Jupiter `tx.jup.ag` et Jito prévues en 6b) et `confirm` renvoie
 * le résultat on-chain — dont le montant réellement reçu, pour le PnL.
 */

export interface LandingContext {
  blockhash: string;
  lastValidBlockHeight: number;
  /** Mint de sortie attendu (calcul du montant reçu). */
  outputMint: string;
  /** Wallet taker/signataire (calcul du montant reçu). */
  taker: string;
}

export interface LandingSendResult {
  signature: string;
}

export interface LandingConfirmation {
  /** `null` = confirmée sans erreur on-chain. */
  err: unknown;
  slot: number | null;
  /** Montant réellement reçu sur `outputMint` (unités de base), si déductible. */
  outAmountBaseUnits: string | null;
  feeLamports: number | null;
}

export interface LandingTarget {
  readonly name: string;
  send(signedBase64: string, context: LandingContext): Promise<LandingSendResult>;
  confirm(signature: string, context: LandingContext): Promise<LandingConfirmation>;
}

export interface TokenBalanceLike {
  mint: string;
  owner?: string | undefined;
  uiTokenAmount: { amount: string };
}

/** Forme minimale d'une transaction confirmée (`getTransaction`) — testable sans RPC. */
export interface ConfirmedTransactionLike {
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: ReadonlyArray<TokenBalanceLike | undefined | null> | null;
    postTokenBalances?: ReadonlyArray<TokenBalanceLike | undefined | null> | null;
  } | null;
  transaction: {
    message: {
      staticAccountKeys?: readonly PublicKey[] | undefined;
      accountKeys?: readonly PublicKey[] | undefined;
    };
  };
}

/**
 * Montant reçu déduit des balances de la transaction confirmée :
 * - token SPL : delta des post/pré-balances du taker pour `outputMint` ;
 * - SOL natif : delta de lamports du taker + frais payés (best-effort — les
 *   variations de rent des ATA sont lissées par la réconciliation au démarrage).
 */
export function outputAmountFromTransaction(
  transaction: ConfirmedTransactionLike | null,
  taker: string,
  outputMint: string,
): string | null {
  const meta = transaction?.meta ?? null;
  if (meta === null) return null;
  if (meta.err !== null && meta.err !== undefined) return null;

  if (outputMint !== SOL_MINT) {
    const total = (
      balances: ReadonlyArray<TokenBalanceLike | undefined | null> | null | undefined,
    ): bigint => {
      let sum = 0n;
      for (const balance of balances ?? []) {
        if (balance === undefined || balance === null) continue;
        if (balance.mint !== outputMint || balance.owner !== taker) continue;
        sum += BigInt(balance.uiTokenAmount.amount);
      }
      return sum;
    };
    const delta = total(meta.postTokenBalances) - total(meta.preTokenBalances);
    return delta > 0n ? delta.toString() : null;
  }

  const message = transaction?.transaction.message;
  const keys = message?.staticAccountKeys ?? message?.accountKeys ?? [];
  const index = keys.findIndex((key) => key.toBase58() === taker);
  if (index < 0) return null;
  const delta = BigInt(meta.postBalances[index] ?? 0) - BigInt(meta.preBalances[index] ?? 0);
  const received = delta + BigInt(meta.fee);
  return received > 0n ? received.toString() : null;
}

/** Envoi et confirmation via notre propre nœud RPC (sans infra Jupiter). */
export class RpcLanding implements LandingTarget {
  readonly name = 'rpc';

  constructor(private readonly connection: Connection) {}

  async send(signedBase64: string): Promise<LandingSendResult> {
    const signature = await this.connection.sendRawTransaction(
      Buffer.from(signedBase64, 'base64'),
      { skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' },
    );
    return { signature };
  }

  async confirm(signature: string, context: LandingContext): Promise<LandingConfirmation> {
    const confirmation = await this.connection.confirmTransaction(
      {
        signature,
        blockhash: context.blockhash,
        lastValidBlockHeight: context.lastValidBlockHeight,
      },
      'confirmed',
    );
    const transaction = await this.connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    const meta = transaction?.meta ?? null;
    return {
      err: confirmation.value.err ?? meta?.err ?? null,
      slot: confirmation.context.slot,
      outAmountBaseUnits: outputAmountFromTransaction(
        transaction,
        context.taker,
        context.outputMint,
      ),
      feeLamports: meta?.fee ?? null,
    };
  }
}
