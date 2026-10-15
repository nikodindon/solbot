import { describe, expect, it, vi } from 'vitest';
import { Keypair, SystemProgram, type Connection } from '@solana/web3.js';
import {
  JitoLanding,
  JupiterTxLanding,
  LandingSendError,
  RpcLanding,
  TX_JUP_URL,
  createLandingTarget,
} from '../src/solana/landing.js';
import { SolbotError } from '../src/utils/errors.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const taker = Keypair.generate().publicKey;
const takerB58 = taker.toBase58();

const CONTEXT = {
  blockhash: '11111111111111111111111111111111',
  lastValidBlockHeight: 123456,
  outputMint: USDC,
  taker: takerB58,
  signature: 'SigLocale1111111111111111111111111111111111',
};

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

function bodyOf(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

function headerOf(call: RecordedCall, name: string): string | undefined {
  return (call.init?.headers as Record<string, string> | undefined)?.[name];
}

/** Connexion RPC factice : confirmation réussie + reçu USDC (1 000 → 2 501 000). */
function fakeConnection() {
  const confirmTransaction = vi.fn(async () => ({
    context: { slot: 321 },
    value: { err: null },
  }));
  const getTransaction = vi.fn(async () => ({
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1_000_000_000],
      postBalances: [999_995_000],
      preTokenBalances: [{ mint: USDC, owner: takerB58, uiTokenAmount: { amount: '1000' } }],
      postTokenBalances: [{ mint: USDC, owner: takerB58, uiTokenAmount: { amount: '2501000' } }],
    },
    transaction: { message: { staticAccountKeys: [taker] } },
  }));
  return {
    connection: { confirmTransaction, getTransaction } as unknown as Connection,
    confirmTransaction,
    getTransaction,
  };
}

describe('RpcLanding', () => {
  it('envoie via sendRawTransaction (preflight activé) puis confirme sur le RPC', async () => {
    const sendRawTransaction = vi.fn(async () => 'SigRpc1');
    const { confirmTransaction, getTransaction } = fakeConnection();
    const connection = {
      sendRawTransaction,
      confirmTransaction,
      getTransaction,
    } as unknown as Connection;
    const landing = new RpcLanding(connection);

    const sent = await landing.send('QUJD');
    expect(sent).toEqual({ signature: 'SigRpc1' });
    expect(sendRawTransaction).toHaveBeenCalledWith(Buffer.from('QUJD', 'base64'), {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: 'confirmed',
    });

    const confirmation = await landing.confirm('SigRpc1', CONTEXT);
    expect(confirmation).toMatchObject({
      err: null,
      slot: 321,
      outAmountBaseUnits: '2500000',
      feeLamports: 5000,
    });
    expect(confirmTransaction).toHaveBeenCalledWith(
      { signature: 'SigRpc1', blockhash: CONTEXT.blockhash, lastValidBlockHeight: 123456 },
      'confirmed',
    );
  });
});

describe('JupiterTxLanding (tx.jup.ag)', () => {
  function makeLanding(
    handler: (call: RecordedCall & { index: number }) => Response | Promise<Response>,
  ) {
    const { impl, calls } = recorder(handler);
    const landing = new JupiterTxLanding({
      connection: fakeConnection().connection,
      apiKey: 'cle-jup',
      fetchImpl: impl as unknown as typeof fetch,
    });
    return { landing, calls };
  }

  it('envoie en JSON-RPC sendTransaction avec la clé API, sans skipPreflight', async () => {
    const { landing, calls } = makeLanding(() =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: CONTEXT.signature }),
    );

    const sent = await landing.send('QUJD', CONTEXT);

    expect(sent).toEqual({ signature: CONTEXT.signature });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.href).toBe(`${TX_JUP_URL}/`);
    expect(headerOf(calls[0]!, 'x-api-key')).toBe('cle-jup');
    expect(headerOf(calls[0]!, 'content-type')).toBe('application/json');
    const body = bodyOf(calls[0]!);
    expect(body['method']).toBe('sendTransaction');
    expect(body['params']).toEqual(['QUJD', { encoding: 'base64' }]);
  });

  it('refuse une signature renvoyée différente de la signature locale', async () => {
    const { landing } = makeLanding(() =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: 'SigAutre111' }),
    );
    await expect(landing.send('QUJD', CONTEXT)).rejects.toThrow(/signature renvoyée inattendue/);
  });

  it('classe un refus JSON-RPC (tip manquant) comme échec d’envoi définitif', async () => {
    const { landing } = makeLanding(() =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32602, message: 'Transaction must include a Jupiter tip instruction' },
      }),
    );
    const error = await landing.send('QUJD', CONTEXT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LandingSendError);
    await expect(landing.send('QUJD', CONTEXT)).rejects.toThrow(/Jupiter tip instruction/);
  });

  it('classe HTTP 400 comme définitif mais laisse HTTP 500 incertain', async () => {
    const { landing: rejected } = makeLanding(() => new Response('nope', { status: 400 }));
    const rejectedError = await rejected.send('QUJD', CONTEXT).catch((caught: unknown) => caught);
    expect(rejectedError).toBeInstanceOf(LandingSendError);

    const { landing: unknown } = makeLanding(() => new Response('boom', { status: 500 }));
    const unknownError = await unknown.send('QUJD', CONTEXT).catch((caught: unknown) => caught);
    expect(unknownError).toBeInstanceOf(SolbotError);
    expect(unknownError).not.toBeInstanceOf(LandingSendError);
  });

  it('confirme via notre RPC (tx.jup.ag est en envoi seul)', async () => {
    const { connection, confirmTransaction } = fakeConnection();
    const landing = new JupiterTxLanding({ connection, apiKey: 'cle-jup' });
    const confirmation = await landing.confirm('SigLocale111', CONTEXT);
    expect(confirmation.outAmountBaseUnits).toBe('2500000');
    expect(confirmTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('JitoLanding', () => {
  const tipAccount = Keypair.generate().publicKey.toBase58();

  function makeLanding(
    handler: (call: RecordedCall & { index: number }) => Response | Promise<Response>,
  ) {
    const { impl, calls } = recorder(handler);
    const { connection, confirmTransaction } = fakeConnection();
    const landing = new JitoLanding({
      connection,
      fetchImpl: impl as unknown as typeof fetch,
      baseUrl: 'https://jito.test',
      bundleWaitMs: 25,
      pollIntervalMs: 1,
    });
    return { landing, calls, confirmTransaction };
  }

  it('prépare un virement de tip vers un compte Jito (récupéré puis mis en cache)', async () => {
    const { landing, calls } = makeLanding(() => jsonResponse({ result: [tipAccount] }));

    const instructions = await landing.prepare({ taker, lamports: 1_000_000 });
    await landing.prepare({ taker, lamports: 500 });

    expect(calls).toHaveLength(1); // getTipAccounts mis en cache
    expect(calls[0]?.url.href).toBe('https://jito.test/api/v1/bundles');
    expect(bodyOf(calls[0]!)['method']).toBe('getTipAccounts');
    expect(instructions).toHaveLength(1);
    const instruction = instructions[0]!;
    expect(instruction.programId.equals(SystemProgram.programId)).toBe(true);
    expect(instruction.keys[0]?.pubkey.equals(taker)).toBe(true);
    expect(instruction.keys[1]?.pubkey.toBase58()).toBe(tipAccount);
    expect(Buffer.from(instruction.data).readBigUInt64LE(4)).toBe(1_000_000n);
  });

  it('refuse une réponse getTipAccounts invalide (jamais de compte en dur)', async () => {
    const { landing } = makeLanding(() => jsonResponse({ result: [] }));
    await expect(landing.prepare({ taker, lamports: 1000 })).rejects.toThrow(
      /getTipAccounts invalide/,
    );
  });

  it('envoie la transaction en bundle et retient l’identifiant', async () => {
    const { landing, calls } = makeLanding(() => jsonResponse({ result: 'BundleId1' }));

    const sent = await landing.send('QUJD', CONTEXT);

    expect(sent).toEqual({ signature: CONTEXT.signature, bundleId: 'BundleId1' });
    const body = bodyOf(calls[0]!);
    expect(body['method']).toBe('sendBundle');
    expect(body['params']).toEqual([['QUJD']]);
  });

  it('un bundle « Failed » est un échec définitif : aucun appel RPC de confirmation', async () => {
    const { landing, calls, confirmTransaction } = makeLanding(() =>
      jsonResponse({ result: { value: [{ bundle_id: 'B1', status: 'Failed' }] } }),
    );

    const confirmation = await landing.confirm('Sig1', CONTEXT, {
      signature: 'Sig1',
      bundleId: 'B1',
    });

    expect(confirmation.err).toMatch(/non retenu/);
    expect(confirmation.outAmountBaseUnits).toBeNull();
    expect(confirmTransaction).not.toHaveBeenCalled();
    expect(bodyOf(calls[0]!)['method']).toBe('getInflightBundleStatuses');
  });

  it('un bundle « Landed » bascule sur la confirmation RPC et remonte le reçu', async () => {
    const { landing, confirmTransaction } = makeLanding(() =>
      jsonResponse({ result: { value: [{ bundle_id: 'B2', status: 'Landed' }] } }),
    );

    const confirmation = await landing.confirm('Sig2', CONTEXT, {
      signature: 'Sig2',
      bundleId: 'B2',
    });

    expect(confirmation).toMatchObject({
      err: null,
      slot: 321,
      outAmountBaseUnits: '2500000',
    });
    expect(confirmTransaction).toHaveBeenCalledTimes(1);
  });

  it('au-delà de la fenêtre d’observation, la confirmation RPC tranche (jamais de réessai aveugle)', async () => {
    const { landing, calls, confirmTransaction } = makeLanding(() =>
      jsonResponse({ result: { value: [{ bundle_id: 'B3', status: 'Pending' }] } }),
    );

    const confirmation = await landing.confirm('Sig3', CONTEXT, {
      signature: 'Sig3',
      bundleId: 'B3',
    });

    expect(confirmTransaction).toHaveBeenCalledTimes(1);
    expect(confirmation.err).toBeNull();
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('si l’observation du bundle échoue, la confirmation RPC prend le relais sans erreur', async () => {
    const { landing, confirmTransaction } = makeLanding(
      () => new Response('nope', { status: 503 }),
    );

    const confirmation = await landing.confirm('Sig4', CONTEXT, {
      signature: 'Sig4',
      bundleId: 'B4',
    });

    expect(confirmation.err).toBeNull();
    expect(confirmTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('createLandingTarget', () => {
  it('construit la cible demandée, avec les contraintes de tip attendues', () => {
    const { connection } = fakeConnection();
    expect(createLandingTarget({ choice: 'rpc', connection }).name).toBe('rpc');

    const txJup = createLandingTarget({ choice: 'tx_jup', connection, apiKey: 'cle' });
    expect(txJup.name).toBe('tx_jup');
    expect(txJup.tip).toEqual({ minLamports: 1_000_000 });

    const jito = createLandingTarget({ choice: 'jito', connection });
    expect(jito.name).toBe('jito');
    expect(jito.tip).toEqual({ minLamports: 1_000, forJitoBundle: true });
  });

  it('exige JUPITER_API_KEY pour tx.jup.ag', () => {
    const { connection } = fakeConnection();
    expect(() => createLandingTarget({ choice: 'tx_jup', connection })).toThrow(/JUPITER_API_KEY/);
  });
});
