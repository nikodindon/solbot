import {
  ComputeBudgetProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { WalletError } from '../src/utils/errors.js';
import { createWallet } from '../src/wallet/create.js';
import { EnvSigner, decodeSecretKey, keypairFromSecretKey } from '../src/wallet/env-signer.js';

const FAKE_BLOCKHASH = '11111111111111111111111111111111';

function catchError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('création et chargement du wallet', () => {
  it('fait un aller-retour base58 ↔ Keypair', () => {
    const wallet = createWallet();
    const keypair = keypairFromSecretKey(wallet.secretKeyBase58);
    expect(keypair.publicKey.toBase58()).toBe(wallet.address);
    expect(decodeSecretKey(wallet.secretKeyBase58)).toHaveLength(64);
  });

  it('rejette une clé non base58 avec une erreur typée', () => {
    expect(catchError(() => decodeSecretKey('pas base58 !!!'))).toBeInstanceOf(WalletError);
  });

  it('rejette une clé de mauvaise taille avec un message explicite', () => {
    const error = catchError(() => decodeSecretKey('3u'));
    expect(error).toBeInstanceOf(WalletError);
    expect((error as Error).message).toContain('64');
  });
});

describe('EnvSigner', () => {
  it("échoue avec un message actionnable quand aucun wallet n'est configuré", () => {
    const error = catchError(() => EnvSigner.fromEnv({}));
    expect(error).toBeInstanceOf(WalletError);
    expect((error as WalletError).hint).toContain('init');
  });

  it('signe une transaction legacy', () => {
    const wallet = createWallet();
    const signer = EnvSigner.fromEnv({ BS58_PRIVATE_KEY: wallet.secretKeyBase58 });
    const transaction = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 }),
    );
    transaction.feePayer = signer.publicKey;
    transaction.recentBlockhash = FAKE_BLOCKHASH;

    signer.signTransaction(transaction);

    expect(transaction.signatures).toHaveLength(1);
    expect(transaction.verifySignatures()).toBe(true);
  });

  it('signe une transaction versionnée (v0)', () => {
    const wallet = createWallet();
    const signer = EnvSigner.fromEnv({ BS58_PRIVATE_KEY: wallet.secretKeyBase58 });
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: FAKE_BLOCKHASH,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 })],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);

    signer.signTransaction(transaction);

    const signature = transaction.signatures[0];
    expect(signature).toBeDefined();
    expect(signature?.some((byte) => byte !== 0)).toBe(true);
    expect(keypairFromSecretKey(wallet.secretKeyBase58).publicKey.equals(signer.publicKey)).toBe(
      true,
    );
  });

  it('signe un lot de transactions', () => {
    const wallet = createWallet();
    const signer = EnvSigner.fromEnv({ BS58_PRIVATE_KEY: wallet.secretKeyBase58 });
    const makeTransaction = (): Transaction => {
      const transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 }),
      );
      transaction.feePayer = signer.publicKey;
      transaction.recentBlockhash = FAKE_BLOCKHASH;
      return transaction;
    };

    const signed = signer.signAllTransactions([makeTransaction(), makeTransaction()]);

    expect(signed).toHaveLength(2);
    expect(signed.every((transaction) => transaction.verifySignatures())).toBe(true);
  });
});
