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
  /**
   * Signature ed25519 brute d'un message (transactions Solana v1 via
   * `@solana/kit`, Phase 6c) : web3.js ne sait pas signer les transactions v1.
   * Optionnel — seuls les signers locaux l'implémentent aujourd'hui ;
   * `execution.router.transaction_version: 1` l'exige.
   */
  signBytes?(message: Uint8Array): Promise<Uint8Array>;
}
