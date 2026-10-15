import { describe, expect, it } from 'vitest';
import { importCandlesGecko } from '../src/backtest/import-gecko.js';
import { openDatabase } from '../src/state/db.js';
import { getImportedCandles } from '../src/state/imported-candles.js';
import { runMigrations } from '../src/state/migrations.js';

const MINT = 'A'.repeat(44);
const NOW = 1_750_000_000_000;

function memoryDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function poolsBody(pools: Array<{ address: string; reserve: string }>): unknown {
  return {
    data: pools.map((pool) => ({
      attributes: { address: pool.address, reserve_in_usd: pool.reserve },
    })),
  };
}

function ohlcvBody(list: number[][]): unknown {
  return { data: { attributes: { ohlcv_list: list } } };
}

interface Recorder {
  urls: string[];
  fetchImpl: typeof fetch;
}

function recorder(handler: (url: string, call: number) => Response): Recorder {
  const urls: string[] = [];
  let ohlcvCalls = 0;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    urls.push(url);
    const call = url.includes('/ohlcv/') ? ++ohlcvCalls : 0;
    return handler(url, call);
  }) as typeof fetch;
  return { urls, fetchImpl };
}

describe('import GeckoTerminal', () => {
  it('choisit le pool à la plus grande réserve et importe les bougies de la fenêtre', async () => {
    const db = memoryDb();
    const seconds = Math.floor(NOW / 1000);
    const t1 = seconds - 3600;
    const t0 = t1 - 900;
    const { urls, fetchImpl } = recorder((url) =>
      url.includes('/ohlcv/')
        ? response(
            ohlcvBody([
              [t0, 1, 1.1, 0.9, 1.05, 100],
              [t1, 1.05, 1.2, 1.04, 1.1, 50],
            ]),
          )
        : response(
            poolsBody([
              { address: 'pool-low', reserve: '100' },
              { address: 'pool-high', reserve: '900' },
            ]),
          ),
    );

    const result = await importCandlesGecko({
      db,
      mints: [{ mint: MINT, symbol: 'AAA' }],
      timeframe: '15m',
      days: 1,
      now: NOW,
      fetchImpl,
      sleepImpl: async () => undefined,
    });

    expect(result).toEqual({ requests: 2, candles: 2, mintsImported: 1, skipped: [] });
    expect(urls[0]).toContain(`/networks/solana/tokens/${MINT}/pools`);
    expect(urls[1]).toContain('/networks/solana/pools/pool-high/ohlcv/minute');
    expect(urls[1]).toContain('aggregate=15');
    expect(urls[1]).toContain('currency=usd');

    const candles = getImportedCandles(db, MINT, '15m');
    expect(candles).toHaveLength(2);
    expect(candles[0]).toMatchObject({ bucketStart: t0 * 1000, close: 1.05, volumeUsd: 100 });
    expect(candles[1]).toMatchObject({ bucketStart: t1 * 1000, close: 1.1 });
    db.close();
  });

  it('pagine tant que la page la plus ancienne n’atteint pas la fenêtre', async () => {
    const db = memoryDb();
    const seconds = Math.floor(NOW / 1000);
    const spacing = 900;
    const page1: number[][] = [];
    for (let index = 0; index < 1000; index++) {
      page1.push([seconds - 900 - index * spacing, 1, 1, 1, 1, 0]);
    }
    const old1 = seconds - spacing * 1300;
    const old2 = seconds - spacing * 1301;

    const { urls, fetchImpl } = recorder((url, call) =>
      url.includes('/ohlcv/')
        ? response(
            ohlcvBody(
              call === 1
                ? page1
                : [
                    [old1, 2, 2, 2, 2, 0],
                    [old2, 2, 2, 2, 2, 0],
                  ],
            ),
          )
        : response(poolsBody([{ address: 'pool-main', reserve: '500' }])),
    );

    const result = await importCandlesGecko({
      db,
      mints: [{ mint: MINT, symbol: 'AAA' }],
      timeframe: '15m',
      days: 30,
      now: NOW,
      fetchImpl,
      sleepImpl: async () => undefined,
    });

    expect(result.requests).toBe(3);
    expect(result.candles).toBe(1002);
    expect(urls[2]).toContain(`before_timestamp=${seconds - spacing * 1000 - 1}`);
    expect(getImportedCandles(db, MINT, '15m')).toHaveLength(1002);
    db.close();
  });

  it('réessaie après un HTTP 429 avant de réussir', async () => {
    const db = memoryDb();
    const seconds = Math.floor(NOW / 1000);
    let poolCalls = 0;
    const urls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/ohlcv/')) {
        return response(ohlcvBody([[seconds - 3600, 1, 1, 1, 1, 5]]));
      }
      poolCalls += 1;
      if (poolCalls === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: () => '2' },
          json: () => Promise.resolve({}),
        } as unknown as Response;
      }
      return response(poolsBody([{ address: 'pool-ok', reserve: '100' }]));
    }) as typeof fetch;

    const sleeps: number[] = [];
    const result = await importCandlesGecko({
      db,
      mints: [{ mint: MINT, symbol: 'AAA' }],
      timeframe: '15m',
      days: 1,
      now: NOW,
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(sleeps).toEqual([2000, 1500]); // retry-after 2 s, puis pause de politesse
    expect(result.requests).toBe(3); // 429 + retry + ohlcv
    expect(result.mintsImported).toBe(1);
    expect(result.candles).toBe(1);
    expect(urls[1]).toContain('/tokens/'); // second essai sur le même endpoint (pools)
    db.close();
  });

  it('marque le mint comme ignoré sans pool ou sur erreur HTTP', async () => {
    const db = memoryDb();
    const empty = recorder(() => response(poolsBody([])));
    const noPool = await importCandlesGecko({
      db,
      mints: [{ mint: MINT, symbol: 'AAA' }],
      timeframe: '15m',
      days: 1,
      now: NOW,
      fetchImpl: empty.fetchImpl,
      sleepImpl: async () => undefined,
    });
    expect(noPool.skipped).toEqual([{ symbol: 'AAA', reason: 'aucun pool trouvé' }]);
    expect(noPool.requests).toBe(1);

    const failing = recorder(() => response({}, false, 500));
    const httpError = await importCandlesGecko({
      db,
      mints: [{ mint: MINT, symbol: 'AAA' }],
      timeframe: '15m',
      days: 1,
      now: NOW,
      fetchImpl: failing.fetchImpl,
      sleepImpl: async () => undefined,
    });
    expect(httpError.skipped[0]?.reason).toContain('HTTP 500');
    expect(httpError.candles).toBe(0);
    db.close();
  });

  it('ignore un mint dont les bougies sont invalides (OHLC nul)', async () => {
    const db = memoryDb();
    const seconds = Math.floor(NOW / 1000);
    const { fetchImpl } = recorder((url) =>
      url.includes('/ohlcv/')
        ? response(ohlcvBody([[seconds - 3600, 1, 1, 0, 1, 10]]))
        : response(poolsBody([{ address: 'pool-main', reserve: '500' }])),
    );

    const result = await importCandlesGecko({
      db,
      mints: [{ mint: MINT, symbol: 'AAA' }],
      timeframe: '15m',
      days: 1,
      now: NOW,
      fetchImpl,
      sleepImpl: async () => undefined,
    });

    expect(result.candles).toBe(0);
    expect(result.mintsImported).toBe(0);
    expect(result.skipped[0]?.reason).toContain('invalide');
    expect(getImportedCandles(db, MINT, '15m')).toHaveLength(0);
    db.close();
  });
});
