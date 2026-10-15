import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export interface CreatedWallet {
  keypair: Keypair;
  address: string;
  /** Clé privée 64 octets encodée base58 (format compatible Phantom). */
  secretKeyBase58: string;
}

/** Génère un nouveau wallet ed25519. Utilisé uniquement par `solbot init`. */
export function createWallet(): CreatedWallet {
  const keypair = Keypair.generate();
  return {
    keypair,
    address: keypair.publicKey.toBase58(),
    secretKeyBase58: bs58.encode(keypair.secretKey),
  };
}
