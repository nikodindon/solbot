import { describe, expect, it } from 'vitest';
import { ticksToCandleUpdates } from '../src/market/ohlcv.js';
import { countTicks, getCandles, insertTicks, upsertCandles } from '../src/state/market-data.js';
import { currentSchemaVersion, runMigrations } from '../src/state/migrations.js';
import { openDatabase } from '../src/state/db.js';
import {
  getWatchlist,
  replaceWatchlist,
  toWatchlistItems,
  type WatchlistItem,
} from '../src/state/watchlist.js';

function memoryDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

describe('migrations', () => {
  it('applique les migrations une seule fois et_versionne', () => {
    const db = openDatabase(':memory:');
    expect(runMigrations(db)).toBe(5);
    expect(runMigrations(db)).toBe(0);
    expect(currentSchemaVersion(db)).toBe(5);
    expect(currentSchemaVersion(openDatabase(':memory:'))).toBe(0);
    db.close();
  });

  it('crée les tables du moteur (v3), de la Phase 4 (v4) et de la Phase 6 (v5)', () => {
    const db = memoryDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as unknown as { name: string }).name);
    for (const table of [
      'arbitrations',
      'backtest_equity',
      'backtest_runs',
      'bot_state',
      'equity_curve',
      'events',
      'imported_candles',
      'position_lots',
      'positions',
      'risk_rejections',
      'signals',
    ]) {
      expect(tables).toContain(table);
    }
    const tickColumns = db
      .prepare('PRAGMA table_info(price_ticks)')
      .all()
      .map((row) => (row as unknown as { name: string }).name);
    expect(tickColumns).toContain('volume_24h_usd');
    const tradeColumns = db
      .prepare('PRAGMA table_info(trades)')
      .all()
      .map((row) => (row as unknown as { name: string }).name);
    expect(tradeColumns).toEqual(
      expect.arrayContaining([
        'strategy',
        'trigger',
        'fee_usd',
        'path',
        'cu_limit',
        'cu_price_microlamports',
        'tip_lamports',
        'landing',
        'landing_ms',
      ]),
    );
    const positionColumns = db
      .prepare('PRAGMA table_info(positions)')
      .all()
      .map((row) => (row as unknown as { name: string }).name);
    expect(positionColumns).toContain('mode');
    db.close();
  });
});

describe('watchlist', () => {
  it('remplace intégralement la watchlist et relit dans l’ordre des rangs', () => {
    const db = memoryDb();
    const items: WatchlistItem[] = [
      {
        mint: 'A'.repeat(44),
        symbol: 'SOL',
        name: 'Wrapped SOL',
        rank: 1,
        isBase: true,
        isVerified: true,
        organicScore: null,
        liquidityUsd: 900_000_000,
        usdPrice: 147.5,
        priceChange24h: 1.2,
        tags: ['verified'],
        updatedAt: 111,
      },
      {
        mint: 'B'.repeat(44),
        symbol: 'BONK',
        name: 'Bonk',
        rank: 2,
        isBase: false,
        isVerified: true,
        organicScore: 88.5,
        liquidityUsd: 5_000_000,
        usdPrice: null,
        priceChange24h: null,
        tags: [],
        updatedAt: 111,
      },
    ];

    replaceWatchlist(db, items);
    expect(getWatchlist(db)).toEqual(items);

    replaceWatchlist(db, [items[1]!]); // le scan reconstruit la table à chaque fois
    const reloaded = getWatchlist(db);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.mint).toBe(items[1]!.mint);
    db.close();
  });

  it('convertit les tokens de l’univers en lignes de watchlist', () => {
    const items = toWatchlistItems([
      {
        id: 'S'.repeat(44),
        name: 'Wrapped SOL',
        symbol: 'SOL',
        isVerified: true,
        organicScore: null,
        liquidity: 1_000_000_000,
        usdPrice: 147.5,
        stats24h: { priceChange: 2.5 },
        tags: ['verified'],
      } as never,
    ]);

    expect(items).toEqual([
      {
        mint: 'S'.repeat(44),
        symbol: 'SOL',
        name: 'Wrapped SOL',
        rank: 1,
        isBase: false,
        isVerified: true,
        organicScore: null,
        liquidityUsd: 1_000_000_000,
        usdPrice: 147.5,
        priceChange24h: 2.5,
        tags: ['verified'],
        updatedAt: expect.any(Number),
      },
    ]);
  });
});

describe('price_ticks & candles', () => {
  it('persiste les ticks et agrège les bougies (open figé, high/low élargis, close = dernier)', () => {
    const db = memoryDb();
    const mint = 'M'.repeat(44);

    const ticks = [
      { mint, usdPrice: 10, liquidityUsd: 1, priceChange24h: null, blockId: 1, ts: 1_000_000 },
      { mint, usdPrice: 12, liquidityUsd: 1, priceChange24h: null, blockId: 2, ts: 1_000_500 },
      { mint, usdPrice: 9, liquidityUsd: 1, priceChange24h: null, blockId: 3, ts: 1_001_000 },
      { mint, usdPrice: 11, liquidityUsd: 1, priceChange24h: null, blockId: 4, ts: 1_060_000 },
    ];

    insertTicks(db, ticks);
    upsertCandles(db, ticksToCandleUpdates(ticks));

    expect(countTicks(db, mint)).toBe(4);

    const candles = getCandles(db, mint, '1m');
    expect(candles).toHaveLength(2);

    const [first, second] = candles;
    expect(first).toMatchObject({
      open: 10,
      high: 12,
      low: 9,
      close: 9,
      tickCount: 3,
    });
    expect(second).toMatchObject({ open: 11, high: 11, low: 11, close: 11, tickCount: 1 });
    expect(first!.bucketStart % 60_000).toBe(0);
    expect(second!.bucketStart).toBe(first!.bucketStart + 60_000);

    // Les autres timeframes sont alimentés par les mêmes ticks.
    expect(getCandles(db, mint, '15m').length).toBeGreaterThan(0);
    expect(getCandles(db, mint, '1h')).toHaveLength(1);
    db.close();
  });

  it('respecte la limite de getCandles (les plus récentes d’abord, inversées en sortie)', () => {
    const db = memoryDb();
    const mint = 'N'.repeat(44);
    const ticks = Array.from({ length: 5 }, (_, index) => ({
      mint,
      usdPrice: 100 + index,
      liquidityUsd: null,
      priceChange24h: null,
      blockId: null,
      ts: index * 60_000,
    }));

    insertTicks(db, ticks);
    upsertCandles(db, ticksToCandleUpdates(ticks));

    const lastTwo = getCandles(db, mint, '1m', 2);
    expect(lastTwo).toHaveLength(2);
    expect(lastTwo[0]!.open).toBe(103);
    expect(lastTwo[1]!.open).toBe(104);
    db.close();
  });

  it('ignore les listes vides', () => {
    const db = memoryDb();
    expect(() => insertTicks(db, [])).not.toThrow();
    expect(() => upsertCandles(db, [])).not.toThrow();
    db.close();
  });
});
