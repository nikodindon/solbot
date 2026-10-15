import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type PublicKey,
  type Transaction,
} from '@solana/web3.js';
import { Executor, type SimulateTransaction } from '../src/execution/executor.js';
import { ROUTER_CODES } from '../src/execution/router.js';
import { JupiterApiError } from '../src/jupiter/errors.js';
import {
  BuildResponseSchema,
  OrderResponseSchema,
  type BuildParams,
  type BuildResponse,
  type OrderParams,
  type OrderResponse,
  type SwapApi,
} from '../src/jupiter/swap.js';
import type { LandingConfirmation, LandingTarget } from '../src/solana/landing.js';
import { openDatabase } from '../src/state/db.js';
import { runMigrations } from '../src/state/migrations.js';
import { getRecentTrades, insertTrade, type TradeRecord } from '../src/state/trades.js';
import { parseConfig, type Config } from '../src/utils/config.js';
import type { Signer } from '../src/wallet/signer.js';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BLOCKHASH_BYTES = Array.from(bs58.decode('11111111111111111111111111111111'));

const payer = Keypair.generate();

function makeBuild(overrides: Record<string, unknown> = {}): BuildResponse {
  return BuildResponseSchema.parse({
    inputMint: SOL,
    outputMint: USDC,
    inAmount: '100000000',
    outAmount: '200000000',
    swapMode: 'ExactIn',
    slippageBps: 50,
    computeBudgetInstructions: [],
    setupInstructions: [],
    swapInstruction: {
      programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      accounts: [{ pubkey: payer.publicKey.toBase58(), isWritable: true, isSigner: true }],
      data: '',
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

function routerConfig(execution: Record<string, unknown> = {}): Config {
  return parseConfig({ execution: { path: 'router', retry_backoff_ms: 50, ...execution } });
}

function memoryDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

function makeSigner(): { signer: Signer; signCount: () => number } {
  let count = 0;
  const signTransaction = <T extends Transaction | VersionedTransaction>(transaction: T): T => {
    count += 1;
    if ('version' in transaction) {
      (transaction as VersionedTransaction).sign([payer]);
    }
    return transaction;
  };
  return {
    signer: {
      address: payer.publicKey.toBase58(),
      publicKey: payer.publicKey,
      signTransaction,
      signAllTransactions: (transactions) => transactions.map(signTransaction),
    },
    signCount: () => count,
  };
}

function makeSimulate(
  result: { err: unknown; unitsConsumed: number | null } = { err: null, unitsConsumed: 100_000 },
): SimulateTransaction {
  return async () => ({ err: result.err, unitsConsumed: result.unitsConsumed, logsTail: [] });
}

interface BuildStub {
  api: SwapApi;
  buildCalls: BuildParams[];
}

/** Stub SwapApi Router : rejoue une séquence de builds (le dernier est répété), ou lève. */
function makeBuildApi(sequence: Array<BuildResponse | Error>): BuildStub {
  const buildCalls: BuildParams[] = [];
  let index = 0;
  const api = {
    getOrder: () => {
      throw new Error('getOrder ne doit pas être appelé sur le chemin router');
    },
    execute: () => {
      throw new Error('execute ne doit pas être appelé sur le chemin router');
    },
    getBuild: async (params: BuildParams) => {
      buildCalls.push(params);
      const item = sequence[Math.min(index, sequence.length - 1)]!;
      index += 1;
      if (item instanceof Error) throw item;
      return item;
    },
  };
  return { api: api as unknown as SwapApi, buildCalls };
}

function makeLanding(
  options: {
    confirm?: Partial<LandingConfirmation> | Error;
    tip?: LandingTarget['tip'];
    prepare?: LandingTarget['prepare'];
  } = {},
) {
  const send = vi.fn(async () => ({ signature: 'sig-router-1' }));
  const confirm = vi.fn(async (): Promise<LandingConfirmation> => {
    if (options.confirm instanceof Error) throw options.confirm;
    return {
      err: null,
      slot: 123,
      outAmountBaseUnits: '190000000',
      feeLamports: 5000,
      ...options.confirm,
    };
  });
  const landing: LandingTarget = {
    name: 'test',
    ...(options.tip === undefined ? {} : { tip: options.tip }),
    ...(options.prepare === undefined ? {} : { prepare: options.prepare }),
    send,
    confirm,
  };
  return { landing, send, confirm };
}

/** Stub SwapApi bi-chemin : `/order` (meta) et `/build` (router) disponibles. */
function makeDualApi(
  buildSequence: Array<BuildResponse | Error>,
  order: OrderResponse,
): { api: SwapApi; buildCalls: BuildParams[]; orderCalls: OrderParams[] } {
  const buildCalls: BuildParams[] = [];
  const orderCalls: OrderParams[] = [];
  let index = 0;
  const api = {
    getOrder: async (params: OrderParams) => {
      orderCalls.push(params);
      return order;
    },
    execute: () => {
      throw new Error('execute ne doit pas être appelé en dry-run');
    },
    getBuild: async (params: BuildParams) => {
      buildCalls.push(params);
      const item = buildSequence[Math.min(index, buildSequence.length - 1)]!;
      index += 1;
      if (item instanceof Error) throw item;
      return item;
    },
  };
  return { api: api as unknown as SwapApi, buildCalls, orderCalls };
}

/** Commande `/order` valide (transaction v0 minimale non signée). */
function makeOrder(overrides: Record<string, unknown> = {}): OrderResponse {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message();
  const transaction = Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
  return OrderResponseSchema.parse({
    inAmount: '100000000',
    outAmount: '200000000',
    router: 'metis',
    transaction,
    requestId: 'req-auto',
    lastValidBlockHeight: '340123456',
    slippageBps: 50,
    feeBps: 10,
    priceImpact: -0.08,
    ...overrides,
  });
}

/** Insère un trade live synthétique (statistiques A/B). */
function seedTrade(db: DatabaseSync, overrides: Partial<TradeRecord> = {}): void {
  insertTrade(db, {
    mode: 'live',
    status: 'success',
    signature: null,
    requestId: null,
    inputMint: SOL,
    outputMint: USDC,
    inAmount: '100000000',
    expectedOutAmount: null,
    outAmount: null,
    router: null,
    feeBps: null,
    feeMint: null,
    priceImpact: null,
    slippageBps: null,
    realizedSlippageBps: null,
    errorCode: null,
    errorMessage: null,
    createdAt: Date.now(),
    ...overrides,
  });
}

function autoConfig(execution: Record<string, unknown> = {}): Config {
  return parseConfig({ execution: { path: 'auto', retry_backoff_ms: 50, ...execution } });
}

const REQUEST = { inputMint: SOL, outputMint: USDC, amountBaseUnits: 100_000_000n };

describe('Executor Router — dry-run', () => {
  it('assemble, simule et journalise le chemin router sans signature', async () => {
    const db = memoryDb();
    const { api, buildCalls } = makeBuildApi([makeBuild()]);
    const { signer, signCount } = makeSigner();
    const executor = new Executor({
      swapApi: api,
      config: routerConfig(),
      signer,
      simulate: makeSimulate(),
      db,
    });

    const outcome = await executor.swap(REQUEST, 'dry_run');

    expect(outcome.status).toBe('simulated');
    expect(outcome.path).toBe('router');
    expect(outcome.router?.cuLimit).toBe(120_000);
    expect(outcome.simulation?.unitsConsumed).toBe(100_000);
    expect(outcome.order.outAmount).toBe('200000000');
    expect(signCount()).toBe(0);

    expect(buildCalls).toHaveLength(1);
    expect(buildCalls[0]?.slippageBps).toBe('rtse');
    expect(buildCalls[0]?.computeUnitPricePercentile).toBe('high');
    expect(buildCalls[0]?.maxAccounts).toBe(64);
    expect(buildCalls[0]?.mode).toBeUndefined();
    expect(buildCalls[0]?.tipAmount).toBeUndefined();

    const trades = getRecentTrades(db);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      mode: 'dry_run',
      status: 'simulated',
      path: 'router',
      cuLimit: 120_000,
      tipLamports: null,
      landing: null,
    });
  });

  it('journalise un dry-run dont la simulation échoue (aucun envoi)', async () => {
    const db = memoryDb();
    const { api } = makeBuildApi([makeBuild()]);
    const { signer, signCount } = makeSigner();
    const executor = new Executor({
      swapApi: api,
      config: routerConfig(),
      signer,
      simulate: makeSimulate({ err: { InstructionError: [0, 'Custom'] }, unitsConsumed: null }),
      db,
    });

    const outcome = await executor.swap(REQUEST, 'dry_run');

    expect(outcome.status).toBe('simulated');
    expect(outcome.simulation?.err).not.toBeNull();
    expect(outcome.router?.cuLimit).toBe(1_400_000); // pas de mesure CU → maximum réseau
    expect(signCount()).toBe(0);
    expect(getRecentTrades(db)[0]?.errorMessage).toBeTruthy();
  });
});

describe('Executor Router — live', () => {
  it('signe, atterrit, confirme et calcule le slippage réalisé', async () => {
    const db = memoryDb();
    const { api } = makeBuildApi([makeBuild()]);
    const { signer, signCount } = makeSigner();
    const { landing, send, confirm } = makeLanding();
    const executor = new Executor({
      swapApi: api,
      config: routerConfig(),
      signer,
      simulate: makeSimulate(),
      landing,
      db,
    });

    const outcome = await executor.swap(REQUEST, 'live');

    expect(outcome.status).toBe('success');
    expect(outcome.signature).toBe('sig-router-1');
    expect(outcome.realizedSlippageBps).toBe(500); // 200 → 190 unités de base (−5 %)
    expect(outcome.router?.landing).toBe('test');
    expect(outcome.router?.landingMs).toBeGreaterThanOrEqual(0);
    expect(outcome.execute?.totalOutputAmount).toBe('190000000');
    expect(signCount()).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);

    const trades = getRecentTrades(db);
    expect(trades[0]).toMatchObject({
      mode: 'live',
      status: 'success',
      path: 'router',
      landing: 'test',
      outAmount: '190000000',
      expectedOutAmount: '200000000',
    });
  });

  it('re-cote quand la simulation échoue puis échoue après épuisement', async () => {
    const db = memoryDb();
    const { api, buildCalls } = makeBuildApi([makeBuild()]);
    const { signer } = makeSigner();
    const { landing, send } = makeLanding();
    const executor = new Executor({
      swapApi: api,
      config: routerConfig({ retries: 1 }),
      signer,
      simulate: makeSimulate({ err: { InstructionError: [1, 'Custom'] }, unitsConsumed: null }),
      landing,
      db,
    });

    const outcome = await executor.swap(REQUEST, 'live');

    expect(outcome.status).toBe('failed');
    expect(outcome.failure?.code).toBe(ROUTER_CODES.simulation);
    expect(buildCalls).toHaveLength(2);
    expect(send).not.toHaveBeenCalled();
    expect(getRecentTrades(db)[0]).toMatchObject({ status: 'failed', errorCode: -9101 });
  });

  it('échoue proprement quand la transaction est rejetée on-chain', async () => {
    const db = memoryDb();
    const { api } = makeBuildApi([makeBuild()]);
    const { signer } = makeSigner();
    const { landing, send } = makeLanding({
      confirm: { err: { InstructionError: [3, { Custom: 6001 }] } },
    });
    const executor = new Executor({
      swapApi: api,
      config: routerConfig({ retries: 0 }),
      signer,
      simulate: makeSimulate(),
      landing,
      db,
    });

    const outcome = await executor.swap(REQUEST, 'live');

    expect(outcome.status).toBe('failed');
    expect(outcome.failure?.code).toBe(ROUTER_CODES.landing);
    expect(send).toHaveBeenCalledTimes(1);
    expect(outcome.attempts[0]?.signature).toBe('sig-router-1');
    expect(getRecentTrades(db)[0]).toMatchObject({ status: 'failed', errorCode: -9103 });
  });

  it('ne réessaie jamais quand la confirmation est incertaine', async () => {
    const db = memoryDb();
    const { api, buildCalls } = makeBuildApi([makeBuild()]);
    const { signer } = makeSigner();
    const { landing, send } = makeLanding({ confirm: new Error('timeout') });
    const executor = new Executor({
      swapApi: api,
      config: routerConfig({ retries: 2 }),
      signer,
      simulate: makeSimulate(),
      landing,
      db,
    });

    const outcome = await executor.swap(REQUEST, 'live');

    expect(outcome.status).toBe('failed');
    expect(outcome.failure?.code).toBe(ROUTER_CODES.confirmUnknown);
    expect(send).toHaveBeenCalledTimes(1);
    expect(buildCalls).toHaveLength(1);
    expect(outcome.failure?.label).toMatch(/vérifiez/);
  });
});

describe('Executor Router — entrées invalides', () => {
  it('échoue sans réessayer sur un /build définitif (HTTP 400), sans trade journalisé', async () => {
    const db = memoryDb();
    const error = new JupiterApiError('HTTP 400', { status: 400, endpoint: '/swap/v2/build' });
    const { api, buildCalls } = makeBuildApi([error]);
    const { signer } = makeSigner();
    const executor = new Executor({
      swapApi: api,
      config: routerConfig({ retries: 2 }),
      signer,
      simulate: makeSimulate(),
      landing: makeLanding().landing,
      db,
    });

    const outcome = await executor.swap(REQUEST, 'live');

    expect(outcome.status).toBe('failed');
    expect(outcome.failure?.code).toBe(ROUTER_CODES.build);
    expect(buildCalls).toHaveLength(1);
    expect(outcome.tradeId).toBeNull();
    expect(getRecentTrades(db)).toHaveLength(0);
  });

  it('refuse le chemin router sans simulateur (live compris)', async () => {
    const { api } = makeBuildApi([makeBuild()]);
    const { signer } = makeSigner();
    const executor = new Executor({
      swapApi: api,
      config: routerConfig(),
      signer,
      landing: makeLanding().landing,
    });
    await expect(executor.swap(REQUEST, 'live')).rejects.toThrow(/Router/);
  });

  it('refuse le live router sans cible d’atterrissage', async () => {
    const { api } = makeBuildApi([makeBuild()]);
    const { signer } = makeSigner();
    const executor = new Executor({
      swapApi: api,
      config: routerConfig(),
      signer,
      simulate: makeSimulate(),
    });
    await expect(executor.swap(REQUEST, 'live')).rejects.toThrow(/atterrissage/);
  });
});

describe('Executor Router — tips (Phase 6b)', () => {
  it('honore le tip minimal imposé par la cible d’atterrissage (tx.jup : 0,001 SOL)', async () => {
    const db = memoryDb();
    const { api, buildCalls } = makeBuildApi([makeBuild()]);
    const { signer } = makeSigner();
    const { landing } = makeLanding({ tip: { minLamports: 1_000_000 } });
    const executor = new Executor({
      swapApi: api,
      config: routerConfig(),
      signer,
      simulate: makeSimulate(),
      landing,
      db,
    });

    const outcome = await executor.swap(REQUEST, 'live');

    expect(outcome.status).toBe('success');
    expect(buildCalls[0]?.tipAmount).toBe(1_000_000);
    expect(buildCalls[0]?.forJitoBundle).toBeUndefined();
    expect(outcome.router?.tipLamports).toBe(1_000_000);
    expect(getRecentTrades(db)[0]?.tipLamports).toBe(1_000_000);
  });

  it('prépare un virement de tip Jito dédié (build taillé Jito, tip ajouté par le bot)', async () => {
    const db = memoryDb();
    const { api, buildCalls } = makeBuildApi([makeBuild()]);
    const { signer } = makeSigner();
    const tipAccount = Keypair.generate().publicKey;
    const prepare = vi.fn(async (request: { taker: PublicKey; lamports: number }) => [
      SystemProgram.transfer({
        fromPubkey: request.taker,
        toPubkey: tipAccount,
        lamports: request.lamports,
      }),
    ]);
    let simulatedTx: string | null = null;
    const simulate: SimulateTransaction = async (transaction) => {
      simulatedTx = transaction;
      return { err: null, unitsConsumed: 100_000, logsTail: [] };
    };
    const { landing } = makeLanding({
      tip: { minLamports: 1_000, forJitoBundle: true },
      prepare,
    });
    const executor = new Executor({
      swapApi: api,
      config: routerConfig(),
      signer,
      simulate,
      landing,
      db,
    });

    const outcome = await executor.swap(REQUEST, 'live');

    expect(outcome.status).toBe('success');
    expect(buildCalls[0]?.forJitoBundle).toBe(true);
    expect(buildCalls[0]?.tipAmount).toBeUndefined();
    expect(prepare).toHaveBeenCalledWith({ taker: payer.publicKey, lamports: 1_000 });
    expect(outcome.router?.tipLamports).toBe(1_000);

    // La transaction signée (capturée à la simulation) porte bien le virement.
    expect(simulatedTx).not.toBeNull();
    const transaction = VersionedTransaction.deserialize(Buffer.from(simulatedTx!, 'base64'));
    const keys = transaction.message.staticAccountKeys;
    const last = transaction.message.compiledInstructions.at(-1)!;
    expect(keys[last.programIdIndex]?.equals(SystemProgram.programId)).toBe(true);
    expect(Buffer.from(last.data).readBigUInt64LE(4)).toBe(1_000n);
  });
});

describe('Executor — bascule automatique (path: auto)', () => {
  it('reste sur meta_aggregator sans échantillons live', async () => {
    const db = memoryDb();
    const { api, buildCalls, orderCalls } = makeDualApi([makeBuild()], makeOrder());
    const { signer } = makeSigner();
    const executor = new Executor({
      swapApi: api,
      config: autoConfig(),
      signer,
      simulate: makeSimulate(),
      db,
    });

    const outcome = await executor.swap(REQUEST, 'dry_run');

    expect(outcome.status).toBe('simulated');
    expect(outcome.path).toBe('meta_aggregator');
    expect(orderCalls).toHaveLength(1);
    expect(buildCalls).toHaveLength(0);
  });

  it('bascule sur router quand les statistiques live le favorisent', async () => {
    const db = memoryDb();
    for (let i = 0; i < 25; i++) seedTrade(db, { path: 'router' });
    for (let i = 0; i < 23; i++) seedTrade(db, { path: 'meta_aggregator' });
    for (let i = 0; i < 2; i++) {
      seedTrade(db, {
        path: 'meta_aggregator',
        status: 'failed',
        errorCode: -1,
        errorMessage: 'échec',
      });
    }
    const { api, buildCalls, orderCalls } = makeDualApi([makeBuild()], makeOrder());
    const { signer } = makeSigner();
    const executor = new Executor({
      swapApi: api,
      config: autoConfig(),
      signer,
      simulate: makeSimulate(),
      db,
    });

    const outcome = await executor.swap(REQUEST, 'dry_run');

    expect(outcome.status).toBe('simulated');
    expect(outcome.path).toBe('router');
    expect(buildCalls).toHaveLength(1);
    expect(orderCalls).toHaveLength(0);
  });

  it('revient sur meta_aggregator si l’avantage du router reste dans la marge', async () => {
    const db = memoryDb();
    for (let i = 0; i < 24; i++) seedTrade(db, { path: 'router' });
    seedTrade(db, {
      path: 'router',
      status: 'failed',
      errorCode: -9103,
      errorMessage: 'atterrissage',
    });
    for (let i = 0; i < 25; i++) seedTrade(db, { path: 'meta_aggregator' });
    const { api, orderCalls } = makeDualApi([makeBuild()], makeOrder());
    const { signer } = makeSigner();
    const executor = new Executor({
      swapApi: api,
      config: autoConfig(),
      signer,
      simulate: makeSimulate(),
      db,
    });

    const outcome = await executor.swap(REQUEST, 'dry_run');

    expect(outcome.path).toBe('meta_aggregator');
    expect(orderCalls).toHaveLength(1);
  });
});
