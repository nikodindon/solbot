import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { TIMEFRAMES, type Timeframe } from '../market/ohlcv.js';
import { upsertImportedCandles, type ImportedCandleInput } from '../state/imported-candles.js';
import { SolbotError, messageOf } from '../utils/errors.js';
import { sleep } from '../utils/retry.js';

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 3000;
const BACKOFF_MAX_MS = 30_000;

const PoolsResponseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            attributes: z
              .object({
                address: z.string(),
                reserve_in_usd: z.string().optional(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

const OhlcvResponseSchema = z
  .object({
    data: z
      .object({
        attributes: z
          .object({
            ohlcv_list: z.array(z.array(z.number())).default([]),
          })
          .passthrough(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** (unité, agrégat) GeckoTerminal par timeframe interne. */
const GECKO_TIMEFRAME: Record<Timeframe, { unit: 'minute' | 'hour'; aggregate: number }> = {
  '1m': { unit: 'minute', aggregate: 1 },
  '5m': { unit: 'minute', aggregate: 5 },
  '15m': { unit: 'minute', aggregate: 15 },
  '1h': { unit: 'hour', aggregate: 1 },
};

export interface GeckoImportOptions {
  db: DatabaseSync;
  mints: Array<{ mint: string; symbol: string }>;
  timeframe: Timeframe;
  days: number;
  now?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Pause entre requêtes (poliesse rate limit GeckoTerminal), ms. */
  pauseMs?: number;
  onProgress?: (line: string) => void;
}

export interface GeckoImportResult {
  requests: number;
  candles: number;
  mintsImported: number;
  skipped: Array<{ symbol: string; reason: string }>;
}

/**
 * Import d'historique OHLCV via l'API publique GeckoTerminal (sans clé) :
 * pool principal par mint (réserve max), puis pagination de l'OHLCV en USD
 * jusqu'à couvrir `days` jours. Les bougies importées vivent dans
 * `imported_candles` — jamais mélangées aux bougies collectées en live.
 */
export async function importCandlesGecko(options: GeckoImportOptions): Promise<GeckoImportResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  const pauseMs = options.pauseMs ?? 1500;
  const progress = options.onProgress ?? ((): void => {});
  const now = options.now ?? Date.now();
  const fromTs = now - options.days * 86_400_000;
  const gecko = GECKO_TIMEFRAME[options.timeframe];
  if (gecko === undefined) {
    throw new SolbotError(`Timeframe d'import inconnu : « ${options.timeframe} »`);
  }

  let requests = 0;
  let candles = 0;
  let mintsImported = 0;
  const skipped: Array<{ symbol: string; reason: string }> = [];

  for (const { mint, symbol } of options.mints) {
    try {
      const pool = await findMainPool(fetchImpl, mint, sleepImpl, () => {
        requests += 1;
      });
      if (pool === null) {
        skipped.push({ symbol, reason: 'aucun pool trouvé' });
        continue;
      }

      const rows: ImportedCandleInput[] = [];
      let before: number | null = null;
      let pages = 0;
      while (pages < 30) {
        pages += 1;
        const url =
          `${GECKO_BASE}/networks/solana/pools/${pool}/ohlcv/${gecko.unit}` +
          `?aggregate=${gecko.aggregate}&limit=1000&currency=usd` +
          (before === null ? '' : `&before_timestamp=${before}`);
        const response = await fetchGecko(fetchImpl, url, sleepImpl, () => {
          requests += 1;
        });
        if (!response.ok) {
          throw new Error(`GeckoTerminal HTTP ${response.status}`);
        }
        const parsed = OhlcvResponseSchema.parse(await response.json());
        const list = parsed.data?.attributes.ohlcv_list ?? [];
        if (list.length === 0) break;

        let oldest = Number.POSITIVE_INFINITY;
        let kept = 0;
        for (const entry of list) {
          const [seconds, open, high, low, close, volume] = entry as [
            number,
            number,
            number,
            number,
            number,
            number,
          ];
          oldest = Math.min(oldest, seconds * 1000);
          if (seconds * 1000 < fromTs) continue;
          kept += 1;
          rows.push({
            mint,
            timeframe: options.timeframe,
            bucketStart: seconds * 1000,
            open,
            high,
            low,
            close,
            volumeUsd: volume,
            source: 'geckoterminal',
          });
        }
        progress(
          `  ${symbol} : ${rows.length} bougie(s)${kept === 0 ? ' (hors fenêtre)' : ''} · page ${pages}`,
        );
        if (oldest <= fromTs || list.length < 1000) break;
        before = Math.floor(oldest / 1000) - 1;
        await sleepImpl(pauseMs);
      }

      if (rows.length === 0) {
        skipped.push({ symbol, reason: 'aucune bougie dans la fenêtre' });
        continue;
      }
      candles += upsertImportedCandles(options.db, rows, now);
      mintsImported += 1;
      await sleepImpl(pauseMs);
    } catch (error) {
      skipped.push({ symbol, reason: messageOf(error) });
    }
  }

  return { requests, candles, mintsImported, skipped };
}

/**
 * GET GeckoTerminal avec retry sur 429/5xx : backoff exponentiel, en
 * respectant l'en-tête `retry-after` quand il est fourni. Chaque tentative
 * HTTP est comptée (le rapport doit refléter le coût réel).
 */
async function fetchGecko(
  fetchImpl: typeof fetch,
  url: string,
  sleepImpl: (ms: number) => Promise<void>,
  onAttempt: () => void,
): Promise<Response> {
  let response: Response | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    onAttempt();
    response = await fetchImpl(url);
    if (response.ok || (response.status !== 429 && response.status < 500)) return response;
    if (attempt === MAX_ATTEMPTS) return response;
    const retryAfter = Number.parseFloat(response.headers?.get?.('retry-after') ?? '');
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, BACKOFF_MAX_MS)
        : Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
    await sleepImpl(waitMs);
  }
  return response!;
}

/** Pool principal d'un mint : celui à la plus grande réserve (fallback : premier). */
async function findMainPool(
  fetchImpl: typeof fetch,
  mint: string,
  sleepImpl: (ms: number) => Promise<void>,
  onAttempt: () => void,
): Promise<string | null> {
  const response = await fetchGecko(
    fetchImpl,
    `${GECKO_BASE}/networks/solana/tokens/${mint}/pools?page=1`,
    sleepImpl,
    onAttempt,
  );
  if (!response.ok) {
    throw new Error(`GeckoTerminal HTTP ${response.status} (pools de ${mint})`);
  }
  const parsed = PoolsResponseSchema.parse(await response.json());
  if (parsed.data.length === 0) return null;

  let best = parsed.data[0]!;
  let bestReserve = Number.parseFloat(best.attributes.reserve_in_usd ?? '0');
  for (const pool of parsed.data.slice(1)) {
    const reserve = Number.parseFloat(pool.attributes.reserve_in_usd ?? '0');
    if (Number.isFinite(reserve) && reserve > bestReserve) {
      best = pool;
      bestReserve = reserve;
    }
  }
  return best.attributes.address;
}

/** Timeframes d'import acceptés (alignés sur TIMEFRAMES). */
export function importTimeframes(): Timeframe[] {
  return Object.keys(TIMEFRAMES) as Timeframe[];
}
