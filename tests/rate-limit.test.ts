import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../src/utils/rate-limit.js';

describe('TokenBucket', () => {
  it('autorise le burst initial sans attendre', async () => {
    const bucket = new TokenBucket(10, 3);
    const startedAt = Date.now();
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    expect(Date.now() - startedAt).toBeLessThan(50);
    expect(bucket.stats.acquired).toBe(3);
    expect(bucket.stats.waits).toBe(0);
  });

  it('attend le rechargement une fois le burst épuisé', async () => {
    const bucket = new TokenBucket(100, 1); // 10 ms par jeton
    await bucket.acquire();
    const startedAt = Date.now();
    await bucket.acquire();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(8);
    expect(bucket.stats.waits).toBe(1);
    expect(bucket.stats.totalWaitMs).toBeGreaterThan(0);
  });

  it('lisse une rafale de jetons au débit configuré', async () => {
    const bucket = new TokenBucket(100, 1);
    const startedAt = Date.now();
    for (let index = 0; index < 4; index++) await bucket.acquire();
    // 1 jeton immédiat + 3 × ~10 ms
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
    expect(bucket.stats.acquired).toBe(4);
  });

  it('rejette un débit nul ou négatif', () => {
    expect(() => new TokenBucket(0)).toThrowError(/ratePerSecond/);
    expect(() => new TokenBucket(-1)).toThrowError(/ratePerSecond/);
  });
});
