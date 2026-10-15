import { describe, expect, it, vi } from 'vitest';
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Transaction,
} from '@solana/web3.js';
import {
  Executor,
  computeRealizedSlippageBps,
  type SimulateTransaction,
  type SwapExecutionMode,
} from '../src/execution/executor.js';
import {
  OrderResponseSchema,
  type ExecuteResponse,
  type OrderParams,
  type OrderResponse,
  type SwapApi,
} from '../src/jupiter/swap.js';
import { openDatabase } from '../src/state/db.js';
import { runMigrations } from '../src/state/migrations.js';
import { getRecentTrades } from '../src/state/trades.js';
import { parseConfig, type Config } from '../src/utils/config.js';
import type { Signer } from '../src/wallet/signer.js';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Payeur des transactions de test — partagé par le Signer stub et les fixtures. */
const payer = Keypair.generate();

function txBase64(): string {
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
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}

const TX = txBase64();

function testConfig(execution: Record<string, unknown> = {}): Config {
  return parseConfig({ execution: { retry_backoff_ms: 50, ...execution } });
}

function makeSigner(onSign?: () => void): Signer {
  const signTransaction = <T extends Transaction | VersionedTransaction>(transaction: T): T => {
    onSign?.();
    if ('version' in transaction) {
      (transaction as VersionedTransaction).sign([payer]);
    }
    return transaction;
  };
  return {
    address: payer.publicKey.toBase58(),
    publicKey: payer.publicKey,
    signTransaction,
    signAllTransactions: (transactions) => transactions.map(signTransaction),
  };
}

function memoryDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

function makeOrder(overrides: Record<string, unknown> = {}): OrderResponse {
  return OrderResponseSchema.parse({
    inAmount: '50000000',
    outAmount: '5123456',
    router: 'metis',
    transaction: TX,
    requestId: 'req-1',
    lastValidBlockHeight: '340123456',
    slippageBps: 50,
    feeBps: 10,
    priceImpact: -0.08,
    ...overrides,
  });
}

interface ExecuteRequest {
  signedTransaction: string;
  requestId: string;
  lastValidBlockHeight?: number;
}

interface SwapApiStub {
  api: SwapApi;
  orderCalls: OrderParams[];
  executeCalls: ExecuteRequest[];
}

/** Stub SwapApi : rejoue les ordres/exécutions fournis (le dernier est répété). */
function makeSwapApi(orders: OrderResponse[], executes: ExecuteResponse[]): SwapApiStub {
  let orderIndex = 0;
  let executeIndex = 0;
  const orderCalls: OrderParams[] = [];
  const executeCalls: ExecuteRequest[] = [];

  const api = {
    async getOrder(params: OrderParams): Promise<OrderResponse> {
      orderCalls.push(params);
      return orders[Math.min(orderIndex++, orders.length - 1)]!;
    },
    async execute(request: ExecuteRequest): Promise<ExecuteResponse> {
      executeCalls.push(request);
      return executes[Math.min(executeIndex++, executes.length - 1)]!;
    },
  } as unknown as SwapApi;

  return { api, orderCalls, executeCalls };
}

const REQUEST = { inputMint: SOL, outputMint: USDC, amountBaseUnits: 50_000_000n };

describe('Executor — paper/dry-run', () => {
  for (const mode of ['dry_run', 'paper'] as const satisfies readonly SwapExecutionMode[]) {
    it(`mode ${mode} : simule sans signer, aucune exécution, journalise le résultat`, async () => {
      const db = memoryDb();
      let signs = 0;
      const simulate = vi.fn<SimulateTransaction>(async () => ({
        err: null,
        unitsConsumed: 1234,
        logsTail: ['Program log: ok'],
      }));
      const { api, executeCalls, orderCalls } = makeSwapApi([makeOrder()], []);
      const executor = new Executor({
        swapApi: api,
        config: testConfig(),
        signer: makeSigner(() => {
          signs += 1;
        }),
        simulate,
        db,
      });

      const outcome = await executor.swap(REQUEST, mode);

      expect(outcome.status).toBe('simulated');
      expect(outcome.mode).toBe(mode);
      expect(outcome.simulation).toMatchObject({ unitsConsumed: 1234 });
      expect(signs).toBe(0);
      expect(executeCalls).toHaveLength(0);
      expect(simulate).toHaveBeenCalledWith(TX);
      expect(orderCalls[0]).toMatchObject({
        amount: '50000000',
        taker: payer.publicKey.toBase58(),
      });
      // execution.slippage = 'rtse' (défaut) → aucun slippageBps transmis
      expect(orderCalls[0]?.slippageBps).toBeUndefined();

      const trades = getRecentTrades(db);
      expect(trades).toHaveLength(1);
      expect(trades[0]).toMatchObject({
        mode,
        status: 'simulated',
        inputMint: SOL,
        outputMint: USDC,
        inAmount: '50000000',
        expectedOutAmount: '5123456',
        router: 'metis',
        errorMessage: null,
      });
      db.close();
    });
  }

  it('transmet le slippage configuré et les routeurs exclus', async () => {
    const db = memoryDb();
    const { api, orderCalls } = makeSwapApi([makeOrder()], []);
    const simulate: SimulateTransaction = async () => ({
      err: null,
      unitsConsumed: null,
      logsTail: [],
    });
    const executor = new Executor({
      swapApi: api,
      config: testConfig({ slippage: 75, exclude_routers: ['jupiterz', 'okx'] }),
      signer: makeSigner(),
      simulate,
      db,
    });

    await executor.swap(REQUEST, 'dry_run');
    expect(orderCalls[0]?.slippageBps).toBe(75);
    expect(orderCalls[0]?.excludeRouters).toEqual(['jupiterz', 'okx']);

    // priorité au slippage de la requête (--max-slippage-bps)
    await executor.swap({ ...REQUEST, slippageBps: 120 }, 'dry_run');
    expect(orderCalls[1]?.slippageBps).toBe(120);
    db.close();
  });

  it('journalise l’erreur de simulation sans lever', async () => {
    const db = memoryDb();
    const simulate: SimulateTransaction = async () => ({
      err: { InstructionError: [0, { Custom: 1 }] },
      unitsConsumed: 5000,
      logsTail: [],
    });
    const { api } = makeSwapApi([makeOrder()], []);
    const executor = new Executor({
      swapApi: api,
      config: testConfig(),
      signer: makeSigner(),
      simulate,
      db,
    });

    const outcome = await executor.swap(REQUEST, 'dry_run');
    expect(outcome.status).toBe('simulated');
    expect(outcome.simulation?.err).not.toBeNull();
    expect(getRecentTrades(db)[0]?.errorMessage).not.toBeNull();
    db.close();
  });
});

describe('Executor — live', () => {
  it('signe, soumet, et journalise signature + slippage réalisé', async () => {
    const db = memoryDb();
    let signs = 0;
    const { api, executeCalls } = makeSwapApi(
      [makeOrder()],
      [
        {
          status: 'Success',
          code: 0,
          signature: 'SIGabc',
          totalInputAmount: '50000000',
          totalOutputAmount: '5100000',
        },
      ],
    );
    const executor = new Executor({
      swapApi: api,
      config: testConfig(),
      signer: makeSigner(() => {
        signs += 1;
      }),
      db,
    });

    const outcome = await executor.swap(REQUEST, 'live');

    expect(signs).toBe(1);
    expect(outcome.status).toBe('success');
    expect(outcome.signature).toBe('SIGabc');
    // (5123456 - 5100000) / 5123456 → 45 bps de slippage réalisé (moins bon que la citation)
    expect(outcome.realizedSlippageBps).toBe(45);
    expect(outcome.attempts).toEqual([
      { attempt: 1, requestId: 'req-1', code: 0, label: 'succès', signature: 'SIGabc' },
    ]);

    const [request] = executeCalls;
    expect(request?.requestId).toBe('req-1');
    expect(request?.lastValidBlockHeight).toBe(340123456);
    const submitted = VersionedTransaction.deserialize(
      Buffer.from(request!.signedTransaction, 'base64'),
    );
    expect(submitted.signatures[0]!.some((byte) => byte !== 0)).toBe(true);

    const trades = getRecentTrades(db);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      mode: 'live',
      status: 'success',
      signature: 'SIGabc',
      outAmount: '5100000',
      realizedSlippageBps: 45,
      errorCode: null,
    });
    db.close();
  });

  it('re-quote après -1005 (blockhash périmé) puis réussit — seul le succès est journalisé', async () => {
    const db = memoryDb();
    const { api, orderCalls, executeCalls } = makeSwapApi(
      [makeOrder({ requestId: 'req-1' }), makeOrder({ requestId: 'req-2' })],
      [
        { status: 'Failed', code: -1005, error: 'Blockhash not found' },
        { status: 'Success', code: 0, signature: 'SIG2', totalOutputAmount: '5123456' },
      ],
    );
    const executor = new Executor({ swapApi: api, config: testConfig(), signer: makeSigner(), db });

    const outcome = await executor.swap(REQUEST, 'live');

    expect(outcome.status).toBe('success');
    expect(outcome.signature).toBe('SIG2');
    expect(orderCalls).toHaveLength(2);
    expect(executeCalls).toHaveLength(2);
    expect(executeCalls[1]?.requestId).toBe('req-2');
    expect(outcome.attempts.map((attempt) => attempt.code)).toEqual([-1005, 0]);
    expect(outcome.realizedSlippageBps).toBe(0);

    const trades = getRecentTrades(db);
    expect(trades).toHaveLength(1);
    expect(trades[0]?.status).toBe('success');
    db.close();
  });

  it('abandonne immédiatement sur un code fatal (-1002)', async () => {
    const db = memoryDb();
    const { api, orderCalls, executeCalls } = makeSwapApi(
      [makeOrder()],
      [{ status: 'Failed', code: -1002, error: 'Invalid transaction' }],
    );
    const executor = new Executor({ swapApi: api, config: testConfig(), signer: makeSigner(), db });

    const outcome = await executor.swap(REQUEST, 'live');

    expect(outcome.status).toBe('failed');
    expect(outcome.failure).toMatchObject({ kind: 'execute', code: -1002 });
    expect(outcome.failure?.label).toMatch(/invalide/);
    expect(orderCalls).toHaveLength(1);
    expect(executeCalls).toHaveLength(1);

    const trades = getRecentTrades(db);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ status: 'failed', errorCode: -1002 });
    db.close();
  });

  it('épuise les tentatives sur des échecs transitoires (-1000) puis abandonne', async () => {
    const db = memoryDb();
    const { api, orderCalls, executeCalls } = makeSwapApi(
      [makeOrder()],
      [{ status: 'Failed', code: -1000, error: 'Failed to land' }],
    );
    const executor = new Executor({
      swapApi: api,
      config: testConfig({ retries: 2 }),
      signer: makeSigner(),
      db,
    });

    const outcome = await executor.swap(REQUEST, 'live');

    expect(outcome.status).toBe('failed');
    expect(outcome.failure).toMatchObject({ kind: 'execute', code: -1000 });
    expect(orderCalls).toHaveLength(3); // 1 + 2 retries
    expect(executeCalls).toHaveLength(3);
    expect(outcome.attempts).toHaveLength(3);
    db.close();
  });

  it('appelle onQuote à chaque ordre obtenu', async () => {
    const db = memoryDb();
    const quotes: number[] = [];
    const { api } = makeSwapApi([makeOrder()], []);
    const simulate: SimulateTransaction = async () => ({
      err: null,
      unitsConsumed: null,
      logsTail: [],
    });
    const executor = new Executor({
      swapApi: api,
      config: testConfig(),
      signer: makeSigner(),
      simulate,
      db,
      onQuote: (_order, attempt) => {
        quotes.push(attempt);
      },
    });

    await executor.swap(REQUEST, 'dry_run');
    expect(quotes).toEqual([1]);
    db.close();
  });
});

describe('Executor — échec /order', () => {
  it('transaction vide + errorCode 1 : échec propre, journalisé, aucune simulation', async () => {
    const db = memoryDb();
    const simulate = vi.fn<SimulateTransaction>(async () => ({
      err: null,
      unitsConsumed: null,
      logsTail: [],
    }));
    const { api, executeCalls } = makeSwapApi(
      [makeOrder({ transaction: '', errorCode: 1, errorMessage: 'Insufficient funds' })],
      [],
    );
    const executor = new Executor({
      swapApi: api,
      config: testConfig(),
      signer: makeSigner(),
      simulate,
      db,
    });

    const outcome = await executor.swap(REQUEST, 'dry_run');

    expect(outcome.status).toBe('failed');
    expect(outcome.failure).toMatchObject({ kind: 'order', code: 1 });
    expect(outcome.failure?.hint).toMatch(/montant|wallet/);
    expect(simulate).not.toHaveBeenCalled();
    expect(executeCalls).toHaveLength(0);

    const trades = getRecentTrades(db);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ status: 'failed', errorCode: 1, mode: 'dry_run' });
    expect(trades[0]?.errorMessage).toMatch(/fonds insuffisants/);
    db.close();
  });

  it('refuse le chemin router sans simulateur et le montant nul', async () => {
    const { api } = makeSwapApi([makeOrder()], []);
    const executor = new Executor({
      swapApi: api,
      config: parseConfig({ execution: { path: 'router' } }),
      signer: makeSigner(),
    });
    await expect(executor.swap(REQUEST, 'live')).rejects.toThrowError(/Router/);

    const executor2 = new Executor({ swapApi: api, config: testConfig(), signer: makeSigner() });
    await expect(
      executor2.swap({ ...REQUEST, amountBaseUnits: 0n }, 'dry_run'),
    ).rejects.toThrowError(/strictement positif/);
  });

  it('refuse paper/dry-run sans fonction de simulation', async () => {
    const { api } = makeSwapApi([makeOrder()], []);
    const executor = new Executor({ swapApi: api, config: testConfig(), signer: makeSigner() });
    await expect(executor.swap(REQUEST, 'dry_run')).rejects.toThrowError(/Simulation RPC/);
  });
});

describe('Executor — re-cotation sur échec slippage (Phase 6c)', () => {
  const SLIPPAGE_FAILURE: ExecuteResponse = {
    status: 'Failed',
    code: -1000,
    error: 'ExceededSlippage',
    signature: null,
    totalOutputAmount: null,
  };
  const SUCCESS: ExecuteResponse = {
    status: 'Success',
    code: 0,
    signature: 'SIG2',
    totalOutputAmount: '5123456',
    error: null,
  };

  it('élargit la borne configurée après un échec de type slippage', async () => {
    const db = memoryDb();
    const { api, orderCalls } = makeSwapApi(
      [makeOrder({ requestId: 'req-1' }), makeOrder({ requestId: 'req-2' })],
      [SLIPPAGE_FAILURE, SUCCESS],
    );
    const executor = new Executor({
      swapApi: api,
      config: testConfig({ slippage: 50, retries: 1 }),
      signer: makeSigner(),
      db,
    });

    const outcome = await executor.swap(REQUEST, 'live');

    expect(outcome.status).toBe('success');
    expect(orderCalls.map((call) => call.slippageBps)).toEqual([50, 100]);
    db.close();
  });

  it('ne touche pas une borne explicitement fournie par la requête', async () => {
    const db = memoryDb();
    const { api, orderCalls } = makeSwapApi(
      [makeOrder({ requestId: 'req-1' }), makeOrder({ requestId: 'req-2' })],
      [SLIPPAGE_FAILURE, SUCCESS],
    );
    const executor = new Executor({
      swapApi: api,
      config: testConfig({ slippage: 50, retries: 1 }),
      signer: makeSigner(),
      db,
    });

    const outcome = await executor.swap({ ...REQUEST, slippageBps: 40 }, 'live');

    expect(outcome.status).toBe('success');
    expect(orderCalls.map((call) => call.slippageBps)).toEqual([40, 40]);
    db.close();
  });

  it('laisse RTSE re-coter de lui-même (aucune borne transmise)', async () => {
    const db = memoryDb();
    const { api, orderCalls } = makeSwapApi(
      [makeOrder({ requestId: 'req-1' }), makeOrder({ requestId: 'req-2' })],
      [SLIPPAGE_FAILURE, SUCCESS],
    );
    const executor = new Executor({
      swapApi: api,
      config: testConfig({ retries: 1 }),
      signer: makeSigner(),
      db,
    });

    const outcome = await executor.swap(REQUEST, 'live');

    expect(outcome.status).toBe('success');
    expect(orderCalls.map((call) => call.slippageBps)).toEqual([undefined, undefined]);
    db.close();
  });
});

describe('computeRealizedSlippageBps', () => {
  it('calcule le slippage réalisé vs outAmount attendu', () => {
    expect(computeRealizedSlippageBps('5123456', '5100000')).toBe(45);
    expect(computeRealizedSlippageBps('5123456', '5123456')).toBe(0);
    // exécution meilleure que la citation → négatif
    expect(computeRealizedSlippageBps('1000000', '1010000')).toBe(-100);
  });

  it('retourne null si données manquantes ou invalides', () => {
    expect(computeRealizedSlippageBps(undefined, '1000')).toBeNull();
    expect(computeRealizedSlippageBps('1000', null)).toBeNull();
    expect(computeRealizedSlippageBps('0', '1000')).toBeNull();
    expect(computeRealizedSlippageBps('abc', '1000')).toBeNull();
  });
});
