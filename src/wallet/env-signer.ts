import { Keypair, type Transaction, type VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Env } from '../utils/config.js';
import { WalletError } from '../utils/errors.js';
import type { Signer } from './signer.js';

/** Décode une clé privée base58 (64 octets) avec des erreurs explicites. */
export function decodeSecretKey(encoded: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(encoded.trim());
  } catch {
    throw new WalletError("BS58_PRIVATE_KEY n'est pas une chaîne base58 valide", {
      hint: 'Régénérez un wallet avec : npm run solbot -- init --force',
    });
  }
  if (bytes.length !== 64) {
    throw new WalletError(`BS58_PRIVATE_KEY doit décoder 64 octets (reçu : ${bytes.length})`, {
      hint: 'Régénérez un wallet avec : npm run solbot -- init --force',
    });
  }
  return bytes;
}

export function keypairFromSecretKey(encoded: string): Keypair {
  return Keypair.fromSecretKey(decodeSecretKey(encoded));
}

/** Signer local basé sur la clé privée du fichier `.env` (Phase 0). */
export class EnvSigner implements Signer {
  private constructor(private readonly keypair: Keypair) {}

  static fromEnv(env: Pick<Env, 'BS58_PRIVATE_KEY'>): EnvSigner {
    if (!env.BS58_PRIVATE_KEY) {
      throw new WalletError('Aucun wallet configuré (BS58_PRIVATE_KEY absent du .env)', {
        hint: 'Lancez : npm run solbot -- init',
      });
    }
    return new EnvSigner(keypairFromSecretKey(env.BS58_PRIVATE_KEY));
  }

  get address(): string {
    return this.keypair.publicKey.toBase58();
  }

  get publicKey() {
    return this.keypair.publicKey;
  }

  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): T {
    if ('version' in transaction) {
      (transaction as VersionedTransaction).sign([this.keypair]);
    } else {
      (transaction as Transaction).sign(this.keypair);
    }
    return transaction;
  }

  signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): T[] {
    return transactions.map((transaction) => this.signTransaction(transaction));
  }
}
