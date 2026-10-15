import { describe, expect, it } from 'vitest';
import { JupiterClient } from '../src/jupiter/client.js';
import { PRICE_BATCH_SIZE, PriceApi } from '../src/jupiter/price.js';

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function priceBody(mints: string[]): Record<string, unknown> {
  return Object.fromEntries(
    mints.map((mint, index) => [
      mint,
      {
        usdPrice: 100 + index,
        liquidity: 1_000_000 + index,
        priceChange24h: 0.5,
        decimals: 9,
        blockId: 42,
        createdAt: new Date().toISOString(),
      },
    ]),
  );
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeApi(fetchImpl: FetchImpl, cacheTtlMs?: number): PriceApi {
  const client = new JupiterClient({
    ratePerSecond: 1000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return cacheTtlMs === undefined ? new PriceApi(client) : new PriceApi(client, cacheTtlMs);
}

/** Client factice qui renvoie un prix pour chaque mint demandé. */
function echoApi(options: { cacheTtlMs?: number } = {}): {
  api: PriceApi;
  urls: URL[];
} {
  const urls: URL[] = [];
  const impl: FetchImpl = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    urls.push(url);
    const ids = (url.searchParams.get('ids') ?? '').split(',').filter((id) => id !== '');
    return jsonResponse(priceBody(ids));
  };
  return { api: makeApi(impl, options.cacheTtlMs), urls };
}

describe('PriceApi', () => {
  it('découpe les demandes en lots de 50 mints', async () => {
    const { api, urls } = echoApi();
    const mints = Array.from({ length: 51 }, (_, index) => `mint-${index}`);

    const prices = await api.getPrices(mints);

    expect(urls).toHaveLength(2);
    expect(prices.size).toBe(51);
    for (const url of urls) {
      const ids = (url.searchParams.get('ids') ?? '').split(',');
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.length).toBeLessThanOrEqual(PRICE_BATCH_SIZE);
    }
  });

  it('dédoublonne les mints demandés', async () => {
    const { api, urls } = echoApi();
    const prices = await api.getPrices(['AAA', 'AAA', 'BBB']);
    expect(prices.size).toBe(2);
    expect(urls).toHaveLength(1);
  });

  it('sert les prix depuis le cache tant que le TTL court', async () => {
    const { api, urls } = echoApi({ cacheTtlMs: 60_000 });

    await api.getPrices(['AAA']);
    await api.getPrices(['AAA']);
    expect(urls).toHaveLength(1);

    await api.getPrices(['AAA'], { useCache: false });
    expect(urls).toHaveLength(2);
  });

  it('omet les mints sans prix renvoyé par l’API', async () => {
    const impl: FetchImpl = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const ids = (url.searchParams.get('ids') ?? '').split(',');
      return jsonResponse(priceBody(ids.slice(0, 1))); // ne renvoie que le premier mint
    };
    const api = makeApi(impl);

    const prices = await api.getPrices(['AAA', 'BBB']);
    expect(prices.size).toBe(1);
    expect(prices.has('AAA')).toBe(true);
    expect(prices.has('BBB')).toBe(false);
  });

  it('ne fait aucun appel pour une liste vide', async () => {
    const { api, urls } = echoApi();
    const prices = await api.getPrices([]);
    expect(prices.size).toBe(0);
    expect(urls).toHaveLength(0);
  });
});
