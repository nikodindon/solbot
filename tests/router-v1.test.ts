import { describe, expect, it } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import { AccountRole, getTransactionDecoder } from '@solana/kit';
import { Keypair, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import {
  buildRouterTransactionV1,
  effectiveCuPriceMicrolamports,
  priorityFeeLamports,
  web3InstructionToKit,
} from '../src/execution/router-v1.js';
import { BuildResponseSchema, type BuildResponse } from '../src/jupiter/swap.js';
import { EnvSigner } from '../src/wallet/env-signer.js';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const BLOCKHASH_BYTES = Array.from(bs58.decode('11111111111111111111111111111111'));

const payer = Keypair.generate();
const signer = EnvSigner.fromEnv({ BS58_PRIVATE_KEY: bs58.encode(payer.secretKey) });

function makeBuildV1(overrides: Record<string, unknown> = {}): BuildResponse {
  return BuildResponseSchema.parse({
    inputMint: SOL,
    outputMint: USDC,
    inAmount: '100000000',
    outAmount: '200000000',
    swapMode: 'ExactIn',
    slippageBps: 50,
    computeBudgetInstructions: [],
    setupInstructions: [
      {
        programId: JUPITER_PROGRAM,
        accounts: [{ pubkey: payer.publicKey.toBase58(), isWritable: false, isSigner: false }],
        data: 'AQID',
      },
    ],
    swapInstruction: {
      programId: JUPITER_PROGRAM,
      accounts: [{ pubkey: payer.publicKey.toBase58(), isWritable: true, isSigner: true }],
      data: 'BAUG',
    },
    cleanupInstruction: null,
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress: {},
    computeUnitPrice: '1000',
    transactionVersion: 1,
    blockhashWithMetadata: { blockhash: BLOCKHASH_BYTES, lastValidBlockHeight: 123456 },
    ...overrides,
  });
}

describe('router v1 — conversions', () => {
  it('prix des CU effectif (micro-lamports) après plafond', () => {
    expect(effectiveCuPriceMicrolamports(undefined)).toBeNull();
    expect(effectiveCuPriceMicrolamports('0')).toBeNull();
    expect(effectiveCuPriceMicrolamports('1000')).toBe(1000);
    expect(effectiveCuPriceMicrolamports('1000', 500)).toBe(500);
    expect(effectiveCuPriceMicrolamports('300', 500)).toBe(300);
  });

  it('frais de priorité v1 en lamports totaux', () => {
    expect(priorityFeeLamports(null, 200_000)).toBe(0n);
    expect(priorityFeeLamports(1000, 200_000)).toBe(200n);
    expect(priorityFeeLamports(1000, 1_400_000)).toBe(1400n);
    expect(priorityFeeLamports(500, 200_001)).toBe(101n); // arrondi supérieur
  });

  it('convertit une instruction web3 en instruction kit (rôles préservés)', () => {
    const to = Keypair.generate().publicKey;
    const instruction = web3InstructionToKit(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: to,
        lamports: 42,
      }),
    );
    expect(instruction.programAddress).toBe(SystemProgram.programId.toBase58());
    expect(instruction.accounts).toEqual([
      { address: payer.publicKey.toBase58(), role: AccountRole.WRITABLE_SIGNER },
      { address: to.toBase58(), role: AccountRole.WRITABLE },
    ]);
    expect(Buffer.from(instruction.data!).readBigUInt64LE(4)).toBe(42n);
  });
});

describe('router v1 — assemblage', () => {
  it('construit un message v1 avec budget sur la config (pas d’instructions budget)', () => {
    const assembled = buildRouterTransactionV1({
      build: makeBuildV1(),
      payerAddress: signer.address,
      cuLimit: 200_000,
    });

    const parsed = VersionedTransaction.deserialize(Buffer.from(assembled.probeBase64, 'base64'));
    expect((parsed.message as { version?: unknown }).version).toBe(1);
    expect(parsed.message.addressTableLookups).toEqual([]);

    const config = (
      parsed.message as unknown as {
        transactionConfig: {
          computeUnitLimit: number;
          priorityFee: number;
          loadedAccountsDataSizeLimit: number;
        };
      }
    ).transactionConfig;
    // 1000 µlamports/CU × 200 000 CU ÷ 1e6 = 200 lamports.
    expect(config.computeUnitLimit).toBe(200_000);
    expect(config.priorityFee).toBe(200);
    expect(config.loadedAccountsDataSizeLimit).toBe(64 * 1024 * 1024);

    expect(assembled.cuPriceMicrolamports).toBe(1000);
    expect(assembled.blockhash).toBe('11111111111111111111111111111111');
    expect(assembled.lastValidBlockHeight).toBe(123456);
    expect(assembled.instructionCount).toBe(2); // setup + swap

    const programs = parsed.message.compiledInstructions.map((instruction) =>
      parsed.message.staticAccountKeys[instruction.programIdIndex]?.toBase58(),
    );
    expect(programs).toEqual([JUPITER_PROGRAM, JUPITER_PROGRAM]);
    expect(Buffer.from(parsed.message.compiledInstructions[0]!.data)).toEqual(
      Buffer.from('AQID', 'base64'),
    );
  });

  it('plafonne le prix des CU avant conversion en frais de priorité', () => {
    const assembled = buildRouterTransactionV1({
      build: makeBuildV1(),
      payerAddress: signer.address,
      cuLimit: 200_000,
      cuPriceCapMicrolamports: 500,
    });
    expect(assembled.cuPriceMicrolamports).toBe(500);
    const parsed = VersionedTransaction.deserialize(Buffer.from(assembled.probeBase64, 'base64'));
    expect(
      (parsed.message as unknown as { transactionConfig: { priorityFee: number } })
        .transactionConfig.priorityFee,
    ).toBe(100);
  });

  it('ajoute les instructions supplémentaires (tip Jito) en fin de transaction', () => {
    const tipAccount = Keypair.generate().publicKey;
    const assembled = buildRouterTransactionV1({
      build: makeBuildV1(),
      payerAddress: signer.address,
      cuLimit: 300_000,
      additionalInstructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: tipAccount,
          lamports: 1_000_000,
        }),
      ],
    });

    const parsed = VersionedTransaction.deserialize(Buffer.from(assembled.probeBase64, 'base64'));
    expect(assembled.instructionCount).toBe(3);
    const last = parsed.message.compiledInstructions.at(-1)!;
    expect(
      parsed.message.staticAccountKeys[last.programIdIndex]?.equals(SystemProgram.programId),
    ).toBe(true);
    expect(Buffer.from(last.data).readBigUInt64LE(4)).toBe(1_000_000n);
    const keys = last.accountKeyIndexes.map((index) =>
      parsed.message.staticAccountKeys[index]?.toBase58(),
    );
    expect(keys).toEqual([payer.publicKey.toBase58(), tipAccount.toBase58()]);
  });

  it('signe le message (ed25519) et renvoie la signature locale', async () => {
    const assembled = buildRouterTransactionV1({
      build: makeBuildV1(),
      payerAddress: signer.address,
      cuLimit: 200_000,
    });

    const signed = await assembled.sign((message) => signer.signBytes(message));

    const decoded = getTransactionDecoder().decode(
      new Uint8Array(Buffer.from(signed.signedBase64, 'base64')),
    );
    const signatureBytes = (decoded.signatures as Record<string, Uint8Array>)[signer.address];
    expect(signatureBytes).toBeDefined();
    expect(bs58.encode(signatureBytes!)).toBe(signed.signature);

    // La signature valide bien le message avec la clé publique du wallet.
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(payer.publicKey.toBytes()),
      ]),
      format: 'der',
      type: 'spki',
    });
    const messageBytes = Buffer.from(Uint8Array.from(decoded.messageBytes));
    expect(verify(null, messageBytes, publicKey, signatureBytes!)).toBe(true);
  });

  it('refuse un build sans blockhash exploitable', () => {
    expect(() =>
      buildRouterTransactionV1({
        build: makeBuildV1({ blockhashWithMetadata: undefined }),
        payerAddress: signer.address,
        cuLimit: 200_000,
      }),
    ).toThrow(/blockhash/);
  });
});
