import { sleep } from './retry.js';

export interface TokenBucketStats {
  acquired: number;
  waits: number;
  totalWaitMs: number;
}

/**
 * Token bucket pour respecter les rate limits de l'API Jupiter
 * (Keyless 0.5 RPS, Free 1 RPS, Developer 10, Launch 50, Pro 150).
 *
 * - Le « burst » initial autorise `ceil(ratePerSecond)` requêtes immédiates.
 * - Les appels concurrents se sérialisent naturellement (JS mono-thread + await).
 */
export class TokenBucket {
  private available: number;
  private lastRefillMs: number;
  private readonly burst: number;
  readonly stats: TokenBucketStats = { acquired: 0, waits: 0, totalWaitMs: 0 };

  constructor(
    readonly ratePerSecond: number,
    burstTokens?: number,
  ) {
    if (!(ratePerSecond > 0)) throw new Error('ratePerSecond doit être > 0');
    this.burst = Math.max(1, burstTokens ?? Math.ceil(ratePerSecond));
    this.available = this.burst;
    this.lastRefillMs = Date.now();
  }

  private refill(now: number): void {
    const elapsedMs = now - this.lastRefillMs;
    if (elapsedMs <= 0) return;
    this.available = Math.min(this.burst, this.available + (elapsedMs * this.ratePerSecond) / 1000);
    this.lastRefillMs = now;
  }

  /** Attend qu'un jeton soit disponible, puis le consomme. */
  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.refill(now);
      if (this.available >= 1) {
        this.available -= 1;
        this.stats.acquired += 1;
        return;
      }
      const waitMs = Math.max(1, Math.ceil(((1 - this.available) / this.ratePerSecond) * 1000) + 1);
      this.stats.waits += 1;
      this.stats.totalWaitMs += waitMs;
      await sleep(waitMs);
    }
  }
}
