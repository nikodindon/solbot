import type { DatabaseSync } from 'node:sqlite';
import { SOL_MINT, USDC_MINT } from '../constants.js';
import type { TokenInfo } from '../jupiter/tokens.js';

export interface WatchlistItem {
  mint: string;
  symbol: string;
  name: string;
  rank: number;
  isBase: boolean;
  isVerified: boolean;
  organicScore: number | null;
  liquidityUsd: number | null;
  usdPrice: number | null;
  priceChange24h: number | null;
  tags: string[];
  updatedAt: number;
}

interface WatchlistRow {
  mint: string;
  symbol: string;
  name: string;
  rank: number;
  is_base: number;
  is_verified: number;
  organic_score: number | null;
  liquidity_usd: number | null;
  usd_price: number | null;
  price_change_24h: number | null;
  tags: string | null;
  updated_at: number;
}

/** Convertit les tokens de l'univers en lignes de watchlist (rang = ordre d'affichage). */
export function toWatchlistItems(tokens: TokenInfo[], now = Date.now()): WatchlistItem[] {
  return tokens.map((token, index) => ({
    mint: token.id,
    symbol: token.symbol,
    name: token.name,
    rank: index + 1,
    isBase: token.id === SOL_MINT || token.id === USDC_MINT,
    isVerified: token.isVerified ?? false,
    organicScore: token.organicScore ?? null,
    liquidityUsd: token.liquidity ?? null,
    usdPrice: token.usdPrice ?? null,
    priceChange24h: token.stats24h?.priceChange ?? null,
    tags: token.tags ?? [],
    updatedAt: now,
  }));
}

/** Remplace intégralement la watchlist (chaque `scan` reconstruit l'univers). */
export function replaceWatchlist(db: DatabaseSync, items: WatchlistItem[]): void {
  const insert = db.prepare(`
    INSERT INTO watchlist
      (mint, symbol, name, rank, is_base, is_verified, organic_score,
       liquidity_usd, usd_price, price_change_24h, tags, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM watchlist');
    for (const item of items) {
      insert.run(
        item.mint,
        item.symbol,
        item.name,
        item.rank,
        item.isBase ? 1 : 0,
        item.isVerified ? 1 : 0,
        item.organicScore,
        item.liquidityUsd,
        item.usdPrice,
        item.priceChange24h,
        JSON.stringify(item.tags),
        item.updatedAt,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getWatchlist(db: DatabaseSync): WatchlistItem[] {
  const rows = db
    .prepare('SELECT * FROM watchlist ORDER BY rank ASC')
    .all() as unknown as WatchlistRow[];
  return rows.map((row) => ({
    mint: row.mint,
    symbol: row.symbol,
    name: row.name,
    rank: row.rank,
    isBase: row.is_base === 1,
    isVerified: row.is_verified === 1,
    organicScore: row.organic_score,
    liquidityUsd: row.liquidity_usd,
    usdPrice: row.usd_price,
    priceChange24h: row.price_change_24h,
    tags: parseTags(row.tags),
    updatedAt: row.updated_at,
  }));
}

function parseTags(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch {
    return [];
  }
}
