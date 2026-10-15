import { describe, expect, it } from 'vitest';
import { JupiterClient } from '../src/jupiter/client.js';
import {
  describeExecuteError,
  describeOrderFailure,
  routerLabel,
  SwapApi,
} from '../src/jupiter/swap.js';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TAKER = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface RecordedCall {
  url: URL;
  init: RequestInit | undefined;
}

function recorder(
  handler: (call: RecordedCall & { index: number }) => Response | Promise<Response>,
): { impl: FetchImpl; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl: FetchImpl = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call: RecordedCall = { url, init };
    calls.push(call);
    return handler({ ...call, index: calls.length - 1 });
  };
  return { impl, calls };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeApi(fetchImpl: FetchImpl): SwapApi {
  const client = new JupiterClient({
    apiKey: 'cle-test',
    ratePerSecond: 1000,
    retryBackoffMs: 1,
    baseUrl: 'https://api.exemple.test',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return new SwapApi(client);
}

const ORDER_FIXTURE = {
  mode: 'ultra',
  inputMint: SOL,
  outputMint: USDC,
  inAmount: '50000000',
  outAmount: '5123456',
  inUsdValue: 5.16,
  outUsdValue: 5.12,
  priceImpact: -0.08,
  otherAmountThreshold: '5072221',
  swapMode: 'ExactIn',
  slippageBps: 50,
  routePlan: [
    {
      swapInfo: { label: 'Meteora DLMM', inAmount: '50000000', outAmount: '5123456' },
      percent: 100,
    },
  ],
  feeMint: USDC,
  feeBps: 10,
  router: 'metis',
  transactionVersion: 0,
  transaction: 'AQAAAA==',
  lastValidBlockHeight: '340123456',
  gasless: false,
  requestId: 'req-abc',
  taker: TAKER,
  totalTime: 0.42,
};

describe('SwapApi.getOrder', () => {
  it('construit la requête (taker, slippage, routeurs exclus) et parse la réponse', async () => {
    const mock = recorder(() => jsonResponse(ORDER_FIXTURE));
    const api = makeApi(mock.impl);

    const order = await api.getOrder({
      inputMint: SOL,
      outputMint: USDC,
      amount: '50000000',
      taker: TAKER,
      slippageBps: 50,
      excludeRouters: ['jupiterz', 'okx'],
    });

    expect(order.outAmount).toBe('5123456');
    expect(order.router).toBe('metis');
    expect(order.requestId).toBe('req-abc');
    expect(order.transaction).toBe('AQAAAA==');
    expect(order.priceImpact).toBe(-0.08);
    expect(order.feeBps).toBe(10);
    expect(order.routePlan?.[0]?.swapInfo?.label).toBe('Meteora DLMM');

    const call = mock.calls[0]!;
    expect(call.url.origin).toBe('https://api.exemple.test');
    expect(call.url.pathname).toBe('/swap/v2/order');
    expect(call.url.searchParams.get('inputMint')).toBe(SOL);
    expect(call.url.searchParams.get('outputMint')).toBe(USDC);
    expect(call.url.searchParams.get('amount')).toBe('50000000');
    expect(call.url.searchParams.get('taker')).toBe(TAKER);
    expect(call.url.searchParams.get('slippageBps')).toBe('50');
    expect(call.url.searchParams.get('excludeRouters')).toBe('jupiterz,okx');
    expect(call.url.searchParams.has('receiver')).toBe(false);
  });

  it('omet les paramètres optionnels absents', async () => {
    const mock = recorder(() => jsonResponse(ORDER_FIXTURE));
    const api = makeApi(mock.impl);
    await api.getOrder({ inputMint: SOL, outputMint: USDC, amount: '1', taker: TAKER });

    const call = mock.calls[0]!;
    expect(call.url.searchParams.has('slippageBps')).toBe(false);
    expect(call.url.searchParams.has('excludeRouters')).toBe(false);
    expect(call.url.searchParams.has('priorityFeeLamports')).toBe(false);
  });

  it('parse un échec de construction (transaction vide + errorCode) sans lever', async () => {
    const mock = recorder(() =>
      jsonResponse({
        ...ORDER_FIXTURE,
        transaction: '',
        errorCode: 1,
        errorMessage: 'Insufficient funds',
      }),
    );
    const api = makeApi(mock.impl);

    const order = await api.getOrder({
      inputMint: SOL,
      outputMint: USDC,
      amount: '50000000',
      taker: TAKER,
    });
    expect(order.transaction).toBe('');
    expect(order.errorCode).toBe(1);
    expect(order.errorMessage).toBe('Insufficient funds');
  });

  it('tolère des champs inconnus et l’absence de outAmount (défaut « 0 »)', async () => {
    const { outAmount: _omitted, ...withoutOut } = ORDER_FIXTURE;
    const mock = recorder(() => jsonResponse({ ...withoutOut, nouveauChamp: { x: 1 } }));
    const api = makeApi(mock.impl);

    const order = await api.getOrder({
      inputMint: SOL,
      outputMint: USDC,
      amount: '1',
      taker: TAKER,
    });
    expect(order.outAmount).toBe('0');
  });
});

describe('SwapApi.execute', () => {
  it('poste la transaction signée et parse le résultat', async () => {
    const mock = recorder(() =>
      jsonResponse({
        status: 'Success',
        code: 0,
        signature: '5sig',
        totalInputAmount: '50000000',
        totalOutputAmount: '5100000',
      }),
    );
    const api = makeApi(mock.impl);

    const result = await api.execute({
      signedTransaction: 'U0lHTkVE',
      requestId: 'req-abc',
      lastValidBlockHeight: 340123456,
    });

    expect(result.status).toBe('Success');
    expect(result.code).toBe(0);
    expect(result.totalOutputAmount).toBe('5100000');

    const call = mock.calls[0]!;
    expect(call.init?.method).toBe('POST');
    expect(call.url.pathname).toBe('/swap/v2/execute');
    expect(new Headers(call.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(call.init?.body))).toEqual({
      signedTransaction: 'U0lHTkVE',
      requestId: 'req-abc',
      lastValidBlockHeight: 340123456,
    });
  });

  it('parse un échec d’exécution (code négatif, champs absents)', async () => {
    const mock = recorder(() =>
      jsonResponse({ status: 'Failed', code: -1005, error: 'Blockhash not found' }),
    );
    const api = makeApi(mock.impl);

    const result = await api.execute({ signedTransaction: 'U0lHTkVE', requestId: 'req-abc' });
    expect(result.status).toBe('Failed');
    expect(result.code).toBe(-1005);
    expect(result.signature ?? null).toBeNull();
  });
});

describe('describeOrderFailure', () => {
  it('interprète les codes 1/2/3 de l’agrégateur', () => {
    expect(describeOrderFailure('metis', 1).label).toMatch(/fonds insuffisants/);
    expect(describeOrderFailure('metis', 1).hint).toMatch(/Réduisez le montant/);
    expect(describeOrderFailure('metis', 2).label).toMatch(/frais de réseau/);
    expect(describeOrderFailure('dflow', 3).label).toMatch(/gasless/);
  });

  it('interprète les codes 1/2/3 du RFQ JupiterZ', () => {
    expect(describeOrderFailure('jupiterz', 1).label).toMatch(/RFQ/);
    expect(describeOrderFailure('jupiterz', 2).label).toMatch(/ATA|associé/);
    expect(describeOrderFailure('jupiterz', 3).label).toMatch(/market maker/);
  });

  it('retombe sur un libellé générique', () => {
    expect(describeOrderFailure(undefined, undefined).label).toMatch(/code inconnu/);
    expect(describeOrderFailure('metis', 42).label).toMatch(/code 42/);
  });
});

describe('describeExecuteError', () => {
  it('classe les codes transitoires en re-quote', () => {
    for (const code of [-1, -1000, -1001, -1004, -1005, -2000, -2001, -2003, -2004]) {
      expect(describeExecuteError(code).strategy).toBe('requote');
    }
    expect(describeExecuteError(-1005).hint).toMatch(/relancez|frais/i);
  });

  it('classe les codes fatals en abandon', () => {
    for (const code of [-2, -3, -1002, -1003, -2002]) {
      expect(describeExecuteError(code).strategy).toBe('abort');
    }
  });

  it('abandonne sur un code inconnu', () => {
    const info = describeExecuteError(-9999);
    expect(info.strategy).toBe('abort');
    expect(info.label).toMatch(/-9999/);
  });
});

describe('routerLabel', () => {
  it('traduit les routeurs connus', () => {
    expect(routerLabel('metis')).toBe('Metis (on-chain)');
    expect(routerLabel('jupiterz')).toBe('JupiterZ (RFQ)');
    expect(routerLabel('inconnu')).toBe('inconnu');
    expect(routerLabel(undefined)).toBe('—');
  });
});
