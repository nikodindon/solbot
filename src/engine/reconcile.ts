import type { DatabaseSync } from 'node:sqlite';
import { insertEvent } from '../state/events.js';
import {
  addToPosition,
  getOpenPositions,
  openPosition,
  reducePositionFifo,
  qtyToFloat,
} from '../state/positions.js';

/** Solde on-chain d'un token SPL (unités de base, texte u64). */
export interface ChainBalance {
  mint: string;
  symbol: string;
  amount: string;
  decimals: number;
}

export interface ReconcileResult {
  /** Mints adoptés (présents on-chain, absents de la base). */
  adopted: string[];
  /** Mints dont la quantité a été ajustée. */
  adjusted: string[];
  /** Mints dont la position a été clôturée (absents on-chain). */
  closed: string[];
  /** Actions ignorées faute de prix (position conservée telle quelle). */
  skipped: string[];
}

/**
 * Réconciliation au démarrage (mode live) : la chaîne fait foi. Les positions
 * locales sont comparées aux soldes RPC — adoptées, ajustées ou clôturées, avec
 * FIFO pour préserver le cost basis lors des réductions. Chaque action est
 * journalisée dans `events`. Le portefeuille virtuel (paper/dry-run) n'est
 * jamais réconcilié : sa source de vérité est la base locale.
 */
export function reconcileBalances(options: {
  db: DatabaseSync;
  /** Tokens SPL détenus (hors SOL natif et hors devise de base). */
  balances: ChainBalance[];
  /** Devise de base (cash, pas une position) — ex. USDC. */
  baseMint: string;
  prices: Map<string, number | null>;
  defaultStopLossPct: number;
  defaultTakeProfitPct: number;
  ts: number;
}): ReconcileResult {
  const { db, ts } = options;
  const result: ReconcileResult = { adopted: [], adjusted: [], closed: [], skipped: [] };

  const chain = new Map(
    options.balances
      .filter((balance) => balance.mint !== options.baseMint && BigInt(balance.amount) > 0n)
      .map((balance) => [balance.mint, balance]),
  );

  // 1. Positions locales : ajuster ou clôturer selon la chaîne.
  for (const position of getOpenPositions(db)) {
    const onChain = chain.get(position.mint);
    const chainQty = onChain === undefined ? 0n : BigInt(onChain.amount);
    const dbQty = BigInt(position.qtyRemaining);
    if (chainQty === dbQty) {
      chain.delete(position.mint);
      continue;
    }

    const price = priceFor(options.prices, position.mint) ?? position.avgEntryPriceUsd;
    if (chainQty < dbQty) {
      const missing = (dbQty - chainQty).toString();
      const reduction = reducePositionFifo(db, position.id, {
        qty: missing,
        sellPriceUsd: price,
        ts,
      });
      const action = chainQty === 0n ? 'closed' : 'adjusted';
      result[action].push(position.mint);
      insertEvent(db, {
        level: 'warn',
        kind: `reconcile_${action}`,
        message:
          chainQty === 0n
            ? `position ${position.symbol} absente on-chain : clôturée (PnL réalisé ${reduction.realizedPnlUsd.toFixed(2)} $)`
            : `position ${position.symbol} réduite de ${qtyToFloat(missing, position.decimals)} (chaîne : ${qtyToFloat(chainQty.toString(), position.decimals)})`,
        details: {
          mint: position.mint,
          dbQty: dbQty.toString(),
          chainQty: chainQty.toString(),
          priceUsd: price,
          realizedPnlUsd: reduction.realizedPnlUsd,
        },
        ts,
      });
    } else {
      const extra = (chainQty - dbQty).toString();
      addToPosition(db, position.id, { qty: extra, priceUsd: price, ts });
      result.adjusted.push(position.mint);
      insertEvent(db, {
        level: 'warn',
        kind: 'reconcile_adjust',
        message: `position ${position.symbol} augmentée de ${qtyToFloat(extra, position.decimals)} (chaîne : ${qtyToFloat(chainQty.toString(), position.decimals)})`,
        details: {
          mint: position.mint,
          dbQty: dbQty.toString(),
          chainQty: chainQty.toString(),
          priceUsd: price,
        },
        ts,
      });
    }
    chain.delete(position.mint);
  }

  // 2. Tokens on-chain sans position locale : adopter.
  for (const balance of chain.values()) {
    const price = priceFor(options.prices, balance.mint);
    const symbol = balance.symbol === '' ? balance.mint.slice(0, 6) : balance.symbol;
    if (price === null || price <= 0) {
      result.skipped.push(balance.mint);
      insertEvent(db, {
        level: 'warn',
        kind: 'reconcile_skip',
        message: `token ${symbol} détenu on-chain mais prix indisponible : adoption ignorée`,
        details: { mint: balance.mint, amount: balance.amount },
        ts,
      });
      continue;
    }
    openPosition(db, {
      mint: balance.mint,
      symbol,
      decimals: balance.decimals,
      qty: balance.amount,
      priceUsd: price,
      ts,
      stopLossPriceUsd: price * (1 - options.defaultStopLossPct / 100),
      takeProfitPriceUsd: price * (1 + options.defaultTakeProfitPct / 100),
    });
    result.adopted.push(balance.mint);
    insertEvent(db, {
      level: 'info',
      kind: 'reconcile_adopt',
      message: `position ${symbol} adoptée depuis la chaîne (${qtyToFloat(balance.amount, balance.decimals)} @ ${price} $)`,
      details: { mint: balance.mint, amount: balance.amount, priceUsd: price },
      ts,
    });
  }

  return result;
}

function priceFor(prices: Map<string, number | null>, mint: string): number | null {
  const price = prices.get(mint);
  return price === undefined ? null : price;
}
