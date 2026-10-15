import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  outputAmountFromTransaction,
  type ConfirmedTransactionLike,
} from '../src/solana/landing.js';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const taker = Keypair.generate().publicKey;
const takerB58 = taker.toBase58();
const other = Keypair.generate().publicKey;

function confirmed(overrides: {
  meta?: Partial<ConfirmedTransactionLike['meta']> | null;
  keys?: ConfirmedTransactionLike['transaction']['message'];
}): ConfirmedTransactionLike {
  const meta =
    overrides.meta === null
      ? null
      : {
          err: null,
          fee: 5000,
          preBalances: [1_000_000_000, 0],
          postBalances: [1_000_000_000, 0],
          preTokenBalances: [],
          postTokenBalances: [],
          ...overrides.meta,
        };
  return {
    meta,
    transaction: { message: overrides.keys ?? { staticAccountKeys: [taker, other] } },
  };
}

describe('outputAmountFromTransaction — token SPL', () => {
  it('calcule le delta des balances du taker pour le mint de sortie', () => {
    const transaction = confirmed({
      meta: {
        preTokenBalances: [{ mint: USDC, owner: takerB58, uiTokenAmount: { amount: '1000000' } }],
        postTokenBalances: [{ mint: USDC, owner: takerB58, uiTokenAmount: { amount: '3500000' } }],
      },
    });
    expect(outputAmountFromTransaction(transaction, takerB58, USDC)).toBe('2500000');
  });

  it('ignore les balances d’autres owners ou d’autres mints', () => {
    const transaction = confirmed({
      meta: {
        preTokenBalances: [
          { mint: USDC, owner: other.toBase58(), uiTokenAmount: { amount: '9999999' } },
          { mint: SOL, owner: takerB58, uiTokenAmount: { amount: '5' } },
        ],
        postTokenBalances: [
          { mint: USDC, owner: other.toBase58(), uiTokenAmount: { amount: '1' } },
          { mint: SOL, owner: takerB58, uiTokenAmount: { amount: '10' } },
        ],
      },
    });
    expect(outputAmountFromTransaction(transaction, takerB58, USDC)).toBeNull();
  });

  it('retourne null sans gain (aucune réception)', () => {
    const transaction = confirmed({
      meta: {
        preTokenBalances: [{ mint: USDC, owner: takerB58, uiTokenAmount: { amount: '5000' } }],
        postTokenBalances: [{ mint: USDC, owner: takerB58, uiTokenAmount: { amount: '5000' } }],
      },
    });
    expect(outputAmountFromTransaction(transaction, takerB58, USDC)).toBeNull();
  });
});

describe('outputAmountFromTransaction — SOL natif', () => {
  it('calcule le delta de lamports du taker, frais réintégrés', () => {
    const transaction = confirmed({
      meta: {
        fee: 5000,
        preBalances: [1_000_000_000, 42],
        postBalances: [1_500_000_000, 42],
      },
    });
    expect(outputAmountFromTransaction(transaction, takerB58, SOL)).toBe('500005000');
  });

  it('retourne null si le taker n’est pas dans la transaction', () => {
    const transaction = confirmed({
      meta: { preBalances: [1, 2], postBalances: [3, 4] },
      keys: { staticAccountKeys: [other, other] },
    });
    expect(outputAmountFromTransaction(transaction, takerB58, SOL)).toBeNull();
  });
});

describe('outputAmountFromTransaction — cas limites', () => {
  it('retourne null sans méta ou si la transaction a échoué', () => {
    expect(outputAmountFromTransaction(null, takerB58, USDC)).toBeNull();
    expect(outputAmountFromTransaction(confirmed({ meta: null }), takerB58, USDC)).toBeNull();
    expect(
      outputAmountFromTransaction(
        confirmed({ meta: { err: { InstructionError: [0, 'Custom'] } } }),
        takerB58,
        USDC,
      ),
    ).toBeNull();
  });
});
