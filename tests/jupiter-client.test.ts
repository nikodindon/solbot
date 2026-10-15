import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  JupiterClient,
  defaultRatePerSecond,
  type JupiterClientOptions,
} from '../src/jupiter/client.js';
import { JupiterApiError } from '../src/jupiter/errors.js';

const Schema = z.object({ ok: z.boolean() });

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface RecordedCall {
  url: URL;
  init: RequestInit | undefined;
}

interface FetchRecorder {
  impl: FetchImpl;
  calls: RecordedCall[];
}

/** Enregistreur de fetch typé : capture URL + init et délègue au handler. */
function recorder(
  handler: (call: RecordedCall & { index: number }) => Response | Promise<Response>,
): FetchRecorder {
  const calls: RecordedCall[] = [];
  const impl: FetchImpl = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call: RecordedCall = { url, init };
    calls.push(call);
    return handler({ ...call, index: calls.length - 1 });
  };
  return { impl, calls };
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function makeClient(fetchImpl: FetchImpl, overrides: JupiterClientOptions = {}): JupiterClient {
  return new JupiterClient({
    ratePerSecond: 1000,
    retryBackoffMs: 1,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides,
  });
}

describe('defaultRatePerSecond', () => {
  it('déduit le débit du tier (1 RPS avec clé, 0.5 sans)', () => {
    expect(defaultRatePerSecond('cle-api')).toBe(1);
    expect(defaultRatePerSecond(undefined)).toBe(0.5);
  });
});

describe('JupiterClient', () => {
  it('retourne les données validées', async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      return jsonResponse({ ok: true });
    });
    await expect(client.getJson('/test', Schema)).resolves.toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  it('construit l’URL avec les paramètres et transmet la clé API', async () => {
    const mock = recorder(() => jsonResponse({ ok: true }));
    const client = makeClient(mock.impl, { apiKey: 'ma-cle', baseUrl: 'https://exemple.test/' });
    await client.getJson('/price/v3', Schema, { ids: 'AAA,BBB', limit: 50, ignore: undefined });

    const call = mock.calls[0]!;
    expect(call.url.origin).toBe('https://exemple.test');
    expect(call.url.pathname).toBe('/price/v3');
    expect(call.url.searchParams.get('ids')).toBe('AAA,BBB');
    expect(call.url.searchParams.get('limit')).toBe('50');
    expect(call.url.searchParams.has('ignore')).toBe(false);
    expect(new Headers(call.init?.headers).get('x-api-key')).toBe('ma-cle');
  });

  it('réessaie sur 429 (en honorant x-ratelimit-reset) puis réussit', async () => {
    const mock = recorder((call) =>
      call.index === 0
        ? jsonResponse({ error: 'rate limited' }, 429, { 'x-ratelimit-reset': '0' })
        : jsonResponse({ ok: true }),
    );
    const retries: number[] = [];
    const client = makeClient(mock.impl, {
      onRetry: (info) => retries.push(info.status ?? -1),
    });

    await expect(client.getJson('/test', Schema)).resolves.toEqual({ ok: true });
    expect(mock.calls).toHaveLength(2);
    expect(retries).toEqual([429]);
  });

  it('réessaie sur erreur réseau (TypeError) puis réussit', async () => {
    const mock = recorder((call) => {
      if (call.index === 0) throw new TypeError('fetch failed');
      return jsonResponse({ ok: true });
    });
    const client = makeClient(mock.impl);

    await expect(client.getJson('/test', Schema)).resolves.toEqual({ ok: true });
    expect(mock.calls).toHaveLength(2);
  });

  it('abandonne après épuisement des tentatives sur 5xx', async () => {
    const mock = recorder(() => jsonResponse({ error: 'boom' }, 503));
    const client = makeClient(mock.impl, { retries: 3 });

    await expect(client.getJson('/test', Schema)).rejects.toThrowError(/erreur serveur 503/);
    expect(mock.calls).toHaveLength(3);
  });

  it('échoue immédiatement sur 4xx sans réessayer', async () => {
    const mock = recorder(() => jsonResponse({ error: 'unauthorized' }, 401));
    const client = makeClient(mock.impl);

    const error = await client.getJson('/test', Schema).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JupiterApiError);
    expect((error as JupiterApiError).status).toBe(401);
    expect((error as Error).message).toContain('HTTP 401');
    expect(mock.calls).toHaveLength(1);
  });

  it('rejette une réponse non conforme au schéma (sans réessayer)', async () => {
    const mock = recorder(() => jsonResponse({ ok: 'oui' }));
    const client = makeClient(mock.impl);

    await expect(client.getJson('/test', Schema)).rejects.toThrowError(/schéma invalide/);
    expect(mock.calls).toHaveLength(1);
  });

  it('rejette une réponse non-JSON', async () => {
    const mock = recorder(() => new Response('<html>oups</html>', { status: 200 }));
    const client = makeClient(mock.impl);

    await expect(client.getJson('/test', Schema)).rejects.toThrowError(/non-JSON/);
  });
});
