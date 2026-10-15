import type { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';

/**
 * Abstrait la source de signature des transactions.
 *
 * Implémentation Phase 0 : `EnvSigner` (clé privée dans `.env`).
 * Implémentations futures (Phase 7) : keystore chiffré, service distant, KMS.
 * Tout le code qui signe passe par cette interface — la migration sera indolore.
 */
export interface Signer {
  /** Adresse publique base58 du wallet. */
  readonly address: string;
  /** Clé publique (web3.js). */
  readonly publicKey: PublicKey;
  /** Signe la transaction fournie (en place) et la retourne. */
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): T;
  /** Signe un lot de transactions (en place) et le retourne. */
  signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): T[];
}
