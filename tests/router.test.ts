import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { ComputeBudgetProgram, Keypair, SystemProgram } from '@solana/web3.js';
import {
  COMPUTE_UNIT_LIMIT_MAX,
  addressLookupTablesFromBuild,
  apiInstructionToWeb3,
  buildRouterTransaction,
  clampComputeUnitPrice,
  computeUnitLimitFromSimulation,
  decodeComputeUnitPrice,
} from '../src/execution/router.js';
import { BuildResponseSchema, type BuildResponse } from '../src/jupiter/swap.js';

const payer = Keypair.generate();
const BLOCKHASH_BYTES = Array.from(bs58.decode('11111111111111111111111111111111'));

function priceInstruction(priceMicroLamports: number) {
  const data = Buffer.alloc(9);
  data[0] = 3; // setComputeUnitPrice
  data.writeBigUInt64LE(BigInt(priceMicroLamports), 1);
  return {
    programId: ComputeBudgetProgram.programId.toBase58(),
    accounts: [],
    data: data.toString('base64'),
  };
}

function makeBuild(overrides: Record<string, unknown> = {}): BuildResponse {
  return BuildResponseSchema.parse({
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    inAmount: '100000000',
    outAmount: '200000000',
    swapMode: 'ExactIn',
    slippageBps: 50,
    priceImpactPct: '0.0001',
    computeBudgetInstructions: [priceInstruction(10_000)],
    setupInstructions: [],
    swapInstruction: {
      programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      accounts: [{ pubkey: payer.publicKey.toBase58(), isWritable: true, isSigner: true }],
      data: Buffer.from([1, 2, 3]).toString('base64'),
    },
    cleanupInstruction: null,
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress: null,
    transactionVersion: 0,
    blockhashWithMetadata: { blockhash: BLOCKHASH_BYTES, lastValidBlockHeight: 123456 },
    ...overrides,
  });
}

describe('décodage et plafond du prix des CU', () => {
  it('décode setComputeUnitPrice (opcode 3, u64 little-endian)', () => {
    expect(decodeComputeUnitPrice(Buffer.from(priceInstruction(12345).data, 'base64'))).toBe(12345);
    expect(decodeComputeUnitPrice(Buffer.from([1, 2, 3]))).toBeNull();
    expect(decodeComputeUnitPrice(Buffer.alloc(9))).toBeNull();
  });

  it('plafonne le prix au-dessus du plafond, laisse le reste intact', () => {
    const capped = clampComputeUnitPrice(priceInstruction(500_000), 100_000);
    expect(decodeComputeUnitPrice(Buffer.from(capped.data, 'base64'))).toBe(100_000);

    const original = priceInstruction(50_000);
    expect(clampComputeUnitPrice(original, 100_000)).toBe(original);

    const notPrice = {
      programId: ComputeBudgetProgram.programId.toBase58(),
      accounts: [],
      data: Buffer.from([2, 1, 2, 3, 4]).toString('base64'),
    };
    expect(clampComputeUnitPrice(notPrice, 1)).toBe(notPrice);
  });
});

describe('computeUnitLimitFromSimulation', () => {
  it('applique le buffer 1,2× et plafonne à 1,4 M', () => {
    expect(computeUnitLimitFromSimulation(100_000)).toBe(120_000);
    expect(computeUnitLimitFromSimulation(100_001)).toBe(120_002);
    expect(computeUnitLimitFromSimulation(100_000, 1.5)).toBe(150_000);
    expect(computeUnitLimitFromSimulation(1_300_000)).toBe(COMPUTE_UNIT_LIMIT_MAX);
  });

  it('retombe sur le maximum réseau sans mesure de simulation', () => {
    expect(computeUnitLimitFromSimulation(null)).toBe(COMPUTE_UNIT_LIMIT_MAX);
    expect(computeUnitLimitFromSimulation(undefined)).toBe(COMPUTE_UNIT_LIMIT_MAX);
    expect(computeUnitLimitFromSimulation(0)).toBe(COMPUTE_UNIT_LIMIT_MAX);
  });
});

describe('apiInstructionToWeb3', () => {
  it('convertit programme, comptes et données', () => {
    const account = Keypair.generate().publicKey;
    const instruction = apiInstructionToWeb3({
      programId: SystemProgram.programId.toBase58(),
      accounts: [{ pubkey: account.toBase58(), isWritable: true, isSigner: false }],
      data: Buffer.from([9, 8]).toString('base64'),
    });
    expect(instruction.programId.equals(SystemProgram.programId)).toBe(true);
    expect(instruction.keys).toHaveLength(1);
    expect(instruction.keys[0]?.pubkey.equals(account)).toBe(true);
    expect(instruction.keys[0]?.isWritable).toBe(true);
    expect(instruction.keys[0]?.isSigner).toBe(false);
    expect(Buffer.from(instruction.data)).toEqual(Buffer.from([9, 8]));
  });
});

describe('addressLookupTablesFromBuild', () => {
  it('reconstruit les tables (clé + adresses), vide si absentes', () => {
    const altKey = Keypair.generate().publicKey;
    const address = Keypair.generate().publicKey;
    const tables = addressLookupTablesFromBuild({ [altKey.toBase58()]: [address.toBase58()] });
    expect(tables).toHaveLength(1);
    expect(tables[0]?.key.equals(altKey)).toBe(true);
    expect(tables[0]?.state.addresses).toHaveLength(1);
    expect(tables[0]?.state.addresses[0]?.equals(address)).toBe(true);
    expect(addressLookupTablesFromBuild(null)).toEqual([]);
    expect(addressLookupTablesFromBuild(undefined)).toEqual([]);
  });
});

describe('buildRouterTransaction', () => {
  it('assemble : limite CU, budget, swap, blockhash et compteurs', () => {
    const built = buildRouterTransaction({
      build: makeBuild(),
      payerKey: payer.publicKey,
      cuLimit: 250_000,
    });

    expect(built.cuLimit).toBe(250_000);
    expect(built.cuPriceMicrolamports).toBe(10_000);
    expect(built.blockhash).toBe('11111111111111111111111111111111');
    expect(built.lastValidBlockHeight).toBe(123456);
    expect(built.instructionCount).toBe(2); // budget + swap (hors limite du bot)

    const message = built.transaction.message;
    const first = message.compiledInstructions[0]!;
    const firstProgram = message.staticAccountKeys[first.programIdIndex]!;
    expect(firstProgram.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(first.data[0]).toBe(2); // setComputeUnitLimit
    expect(Buffer.from(first.data).readUInt32LE(1)).toBe(250_000);
  });

  it('plafonne le prix des CU du budget quand un plafond est fourni', () => {
    const built = buildRouterTransaction({
      build: makeBuild({ computeBudgetInstructions: [priceInstruction(500_000)] }),
      payerKey: payer.publicKey,
      cuLimit: 100_000,
      cuPriceCapMicrolamports: 50_000,
    });
    expect(built.cuPriceMicrolamports).toBe(50_000);
  });

  it('utilise les tables d’adresses du build', () => {
    const altKey = Keypair.generate().publicKey;
    const looked = Keypair.generate().publicKey;
    const build = makeBuild({
      swapInstruction: {
        programId: SystemProgram.programId.toBase58(),
        accounts: [{ pubkey: looked.toBase58(), isWritable: false, isSigner: false }],
        data: '',
      },
      addressesByLookupTableAddress: { [altKey.toBase58()]: [looked.toBase58()] },
    });
    const built = buildRouterTransaction({ build, payerKey: payer.publicKey, cuLimit: 100_000 });
    const lookups = built.transaction.message.addressTableLookups;
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.accountKey.equals(altKey)).toBe(true);
  });

  it('inclut le tip quand /build en fournit un', () => {
    const tipRecipient = Keypair.generate().publicKey;
    const built = buildRouterTransaction({
      build: makeBuild({
        tipInstruction: {
          programId: SystemProgram.programId.toBase58(),
          accounts: [
            { pubkey: payer.publicKey.toBase58(), isWritable: true, isSigner: true },
            { pubkey: tipRecipient.toBase58(), isWritable: true, isSigner: false },
          ],
          data: '',
        },
      }),
      payerKey: payer.publicKey,
      cuLimit: 100_000,
    });
    expect(built.instructionCount).toBe(3); // budget + swap + tip
  });

  it('refuse un build sans blockhash, sans swap ou en erreur', () => {
    expect(() =>
      buildRouterTransaction({
        build: makeBuild({ blockhashWithMetadata: undefined }),
        payerKey: payer.publicKey,
        cuLimit: 1,
      }),
    ).toThrow(/blockhash/);

    expect(() =>
      buildRouterTransaction({
        build: makeBuild({ swapInstruction: null }),
        payerKey: payer.publicKey,
        cuLimit: 1,
      }),
    ).toThrow(/instruction de swap/);

    expect(() =>
      buildRouterTransaction({
        build: makeBuild({ swapInstruction: { error: 'no route found' } }),
        payerKey: payer.publicKey,
        cuLimit: 1,
      }),
    ).toThrow(/no route found/);
  });

  it('ordonne limite, budget, setup, swap, cleanup, other', () => {
    const setupId = Keypair.generate().publicKey.toBase58();
    const swapId = Keypair.generate().publicKey.toBase58();
    const cleanupId = Keypair.generate().publicKey.toBase58();
    const otherId = Keypair.generate().publicKey.toBase58();
    const built = buildRouterTransaction({
      build: makeBuild({
        computeBudgetInstructions: [priceInstruction(10_000)],
        setupInstructions: [{ programId: setupId, accounts: [], data: '' }],
        swapInstruction: { programId: swapId, accounts: [], data: '' },
        cleanupInstruction: { programId: cleanupId, accounts: [], data: '' },
        otherInstructions: [{ programId: otherId, accounts: [], data: '' }],
      }),
      payerKey: payer.publicKey,
      cuLimit: 100_000,
    });
    const message = built.transaction.message;
    const programs = message.compiledInstructions.map((instruction) =>
      message.staticAccountKeys[instruction.programIdIndex]!.toBase58(),
    );
    expect(programs).toEqual([
      ComputeBudgetProgram.programId.toBase58(),
      ComputeBudgetProgram.programId.toBase58(),
      setupId,
      swapId,
      cleanupId,
      otherId,
    ]);
  });
});
