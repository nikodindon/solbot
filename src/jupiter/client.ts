import type { z } from 'zod';
import { JUPITER_API_BASE } from '../constants.js';
import { TokenBucket } from '../utils/rate-limit.js';
import { sleep } from '../utils/retry.js';
import { messageOf } from '../utils/errors.js';
import { JupiterApiError } from './errors.js';

export interface RetryInfo {
  endpoint: string;
  attempt: number;
  delayMs: number;
  status?: number;
  reason: string;
}

export interface JupiterClientOptions {
  apiKey?: string | undefined;
  /** Requêtes/seconde. Défaut : 1 avec clé API, 0.5 sans clé (keyless). */
  ratePerSecond?: number;
  /** Timeout dur par requête (défaut : 10 000 ms). */
  timeoutMs?: number;
  /** Nombre total de tentatives (défaut : 3). */
  retries?: number;
  /** Base du backoff exponentiel en ms (défaut : 500). */
  retryBackoffMs?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  onRetry?: (info: RetryInfo) => void;
}

/** Débit par défaut selon la présence d'une clé API (tiers Jupiter). */
export function defaultRatePerSecond(apiKey?: string): number {
  return apiKey ? 1 : 0.5;
}

/** Erreur interne marquant un échec retryable (429 / 5xx). */
class RetryableHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof RetryableHttpError) return true;
  // Erreurs réseau de fetch (TypeError) et timeouts (AbortSignal.timeout → TimeoutError).
  if (error instanceof TypeError) return true;
  return error instanceof Error && error.name === 'TimeoutError';
}

/**
 * Client HTTP minimal pour l'API Jupiter : `x-api-key`, timeout, retry avec backoff
 * sur 429/5xx, budget de débit (token bucket) et validation zod des réponses.
 */
export class JupiterClient {
  readonly rateLimiter: TokenBucket;

  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBackoffMs: number;
  private readonly onRetry: ((info: RetryInfo) => void) | undefined;

  constructor(options: JupiterClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retries = options.retries ?? 3;
    this.retryBackoffMs = options.retryBackoffMs ?? 500;
    this.baseUrl = (options.baseUrl ?? JUPITER_API_BASE).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onRetry = options.onRetry;
    this.rateLimiter = new TokenBucket(
      options.ratePerSecond ?? defaultRatePerSecond(options.apiKey),
    );
  }

  /** GET + validation zod. Lève une `JupiterApiError` après épuisement des tentatives. */
  async getJson<T>(
    path: string,
    schema: z.ZodType<T>,
    params: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      await this.rateLimiter.acquire();
      try {
        return await this.requestOnce(url, path, schema);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt >= this.retries) break;

        const backoffMs = this.retryBackoffMs * 2 ** (attempt - 1);
        const jitterMs = Math.floor(Math.random() * 100);
        const delayMs =
          error instanceof RetryableHttpError && error.retryAfterMs !== undefined
            ? Math.min(error.retryAfterMs, 60_000)
            : Math.min(backoffMs + jitterMs, 60_000);

        this.onRetry?.({
          endpoint: path,
          attempt,
          delayMs,
          ...(error instanceof RetryableHttpError ? { status: error.status } : {}),
          reason: messageOf(error),
        });
        await sleep(delayMs);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new JupiterApiError(`échec de requête ${path} : ${messageOf(lastError)}`, {
          endpoint: path,
        });
  }

  private async requestOnce<T>(url: URL, endpoint: string, schema: z.ZodType<T>): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;

    const response = await this.fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.status === 429) {
      const reset = Number.parseFloat(response.headers.get('x-ratelimit-reset') ?? '');
      const retryAfterMs = Number.isFinite(reset) && reset >= 0 ? reset * 1000 : undefined;
      throw new RetryableHttpError(429, retryAfterMs, `rate limit atteint (${endpoint})`);
    }
    if (response.status >= 500) {
      throw new RetryableHttpError(
        response.status,
        undefined,
        `erreur serveur ${response.status} (${endpoint})`,
      );
    }
    if (!response.ok) {
      throw new JupiterApiError(`l'API Jupiter a répondu HTTP ${response.status} sur ${endpoint}`, {
        status: response.status,
        endpoint,
        ...(response.status === 401 || response.status === 403
          ? { hint: 'Vérifiez JUPITER_API_KEY (https://developers.jup.ag/portal)' }
          : {}),
      });
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      throw new JupiterApiError(`réponse non-JSON de ${endpoint}`, { endpoint, cause: error });
    }

    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new JupiterApiError(`réponse inattendue de ${endpoint} (schéma invalide)`, {
        endpoint,
        ...(first ? { hint: `${first.path.join('.') || '(racine)'} : ${first.message}` } : {}),
      });
    }
    return parsed.data;
  }
}
