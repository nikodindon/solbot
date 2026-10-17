import { afterEach, describe, expect, it } from 'vitest';
import { USDC_MINT } from '../src/constants.js';
import {
  buildOverview,
  renderDashboardHtml,
  startDashboardServer,
  type DashboardContext,
  type DashboardServer,
} from '../src/monitoring/dashboard.js';
import { setNumberState, setState, STATE_KEYS } from '../src/state/bot-state.js';
import { openDatabase } from '../src/state/db.js';
import { insertEquityPoint } from '../src/state/equity.js';
import { insertEvent } from '../src/state/events.js';
import { insertTicks, upsertCandles } from '../src/state/market-data.js';
import { runMigrations } from '../src/state/migrations.js';
import { openPosition } from '../src/state/positions.js';
import { insertRejection } from '../src/state/risk-rejections.js';
import { insertSignal } from '../src/state/signals.js';
import { insertTrade, type TradeRecord } from '../src/state/trades.js';
import { replaceWatchlist, type WatchlistItem } from '../src/state/watchlist.js';

const NOW = Date.UTC(2026, 9, 17, 8, 40, 0);
const TOKEN_A = 'TokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_B = 'TokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const dbs: Array<{ close: () => void }> = [];
const servers: DashboardServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const db of dbs.splice(0)) db.close();
});

function watchItem(mint: string, symbol: string, rank: number): WatchlistItem {
  return {
    mint,
    symbol,
    name: symbol,
    rank,
    isBase: mint === USDC_MINT,
    isVerified: true,
    organicScore: 80,
    liquidityUsd: 5_000_000,
    usdPrice: 1,
    priceChange24h: -3.5,
    tags: [],
    updatedAt: NOW,
  };
}

function tradeRecord(partial: Partial<TradeRecord>): TradeRecord {
  return {
    mode: 'paper',
    status: 'success',
    signature: null,
    requestId: null,
    inputMint: USDC_MINT,
    outputMint: TOKEN_A,
    inAmount: '49000000',
    expectedOutAmount: null,
    outAmount: null,
    router: null,
    feeBps: null,
    feeMint: null,
    priceImpact: null,
    slippageBps: null,
    realizedSlippageBps: null,
    errorCode: null,
    errorMessage: null,
    createdAt: NOW,
    strategy: 'momentum',
    trigger: 'entry',
    feeUsd: 0.05,
    ...partial,
  };
}

function seededDb(): ReturnType<typeof openDatabase> {
  const db = openDatabase(':memory:');
  runMigrations(db);
  dbs.push(db);

  replaceWatchlist(db, [
    watchItem(USDC_MINT, 'USDC', 1),
    watchItem(TOKEN_A, 'AAA', 2),
    watchItem(TOKEN_B, 'BBB', 3),
  ]);

  // Prix : AAA à 0,04 $ (entrée 0,0363794 → P&L latent positif).
  insertTicks(db, [
    {
      mint: TOKEN_A,
      usdPrice: 0.04,
      liquidityUsd: 5_000_000,
      priceChange24h: -3.5,
      blockId: 1,
      ts: NOW,
    },
    {
      mint: TOKEN_B,
      usdPrice: 2,
      liquidityUsd: 1_000_000,
      priceChange24h: 1.2,
      blockId: 1,
      ts: NOW,
    },
  ]);

  // AAA prêt (2 bougies ≥ 2 requises), BBB en chauffe (1 seule).
  const candle = (mint: string, index: number) => ({
    mint,
    timeframe: '15m' as const,
    bucketStart: index * 900_000,
    open: 1,
    high: 1.1,
    low: 0.9,
    close: 1,
    volumeUsd: 1000,
  });
  upsertCandles(db, [candle(TOKEN_A, 0), candle(TOKEN_A, 1), candle(TOKEN_B, 0)]);

  // Position ouverte sur AAA : 1000 unités (dec 6) à 0,0363794 → coût 0,0364 $… non,
  // qty 1_000_000_000 (dec 6 = 1000 tokens) à 0,05 → coût 50 $.
  openPosition(db, {
    mint: TOKEN_A,
    symbol: 'AAA',
    decimals: 6,
    qty: '1000000000',
    priceUsd: 0.05,
    ts: NOW - 3600_000,
    stopLossPriceUsd: 0.045,
    takeProfitPriceUsd: 0.06,
  });

  // Position fermée : réalisé -1,25 $.
  const closed = openPosition(db, {
    mint: TOKEN_B,
    symbol: 'BBB',
    decimals: 9,
    qty: '1000000000',
    priceUsd: 2,
    ts: NOW - 7200_000,
  });
  db.prepare(
    "UPDATE positions SET status = 'closed', qty_remaining = '0', realized_pnl_usd = -1.25, closed_at = ? WHERE id = ?",
  ).run(NOW - 3600_000, closed.id);

  insertEquityPoint(db, {
    mode: 'paper',
    ts: NOW - 30_000,
    navUsd: 995,
    cashUsd: 945,
    positionsValueUsd: 50,
    openCount: 1,
  });
  insertEquityPoint(db, {
    mode: 'paper',
    ts: NOW,
    navUsd: 990,
    cashUsd: 945,
    positionsValueUsd: 45,
    openCount: 1,
  });

  setNumberState(db, STATE_KEYS.navPeakUsd, 1000, NOW);
  setNumberState(db, STATE_KEYS.dayStartNavUsd, 996, NOW);
  setState(db, STATE_KEYS.manualPaused, '0', NOW);

  insertTrade(db, tradeRecord({ createdAt: NOW - 120_000, trigger: 'entry' }));
  insertTrade(
    db,
    tradeRecord({
      createdAt: NOW - 60_000,
      inputMint: TOKEN_A,
      outputMint: USDC_MINT,
      inAmount: '1000000000',
      outAmount: '38000000',
      trigger: 'stop_loss',
      strategy: 'risk',
    }),
  );
  insertSignal(db, {
    ts: NOW - 130_000,
    strategy: 'momentum',
    mint: TOKEN_A,
    symbol: 'AAA',
    side: 'buy',
    confidence: 0.72,
    edgeBps: 42,
    ttlMs: 60_000,
    reason: 'cassure + volume',
  });
  insertRejection(db, {
    ts: NOW - 125_000,
    mint: TOKEN_B,
    symbol: 'BBB',
    side: 'buy',
    strategy: 'momentum',
    rule: 'max_positions',
    message: 'limite de 6 positions atteinte',
  });
  insertEvent(db, { level: 'info', kind: 'trade_open', message: 'entrée AAA', ts: NOW - 120_000 });

  return db;
}

function context(db: ReturnType<typeof openDatabase>): DashboardContext {
  return {
    db,
    root: '/tmp/solbot-dashboard-test',
    version: '9.9.9',
    mode: 'paper',
    baseCurrency: 'USDC',
    initialUsdc: 1000,
    requirements: [{ timeframe: '15m', bars: 2 }],
    recentLimit: 25,
    now: () => NOW,
  };
}

interface Overview {
  engine: {
    mode: string;
    version: string;
    alive: boolean;
    lastTickAgeS: number | null;
    ticks: number;
  };
  nav: {
    usd: number | null;
    cashUsd: number | null;
    peakUsd: number | null;
    drawdownPct: number | null;
    dayPnlPct: number | null;
    sinceStartPct: number | null;
  };
  stats: {
    closed: number;
    wins: number;
    losses: number;
    realizedPnlUsd: number;
    openCount: number;
  };
  positions: Array<{
    symbol: string;
    qty: number;
    valueUsd: number | null;
    pnlUsd: number | null;
    pnlPct: number | null;
  }>;
  trades: Array<{
    side: string;
    symbol: string;
    amountUsd: number | null;
    trigger: string | null;
  }>;
  signals: Array<{ symbol: string }>;
  rejections: Array<{ rule: string }>;
  events: Array<{ kind: string }>;
  watchlist: {
    total: number;
    ready: number;
    items: Array<{ symbol: string; ready: boolean; priceUsd: number | null }>;
  };
  equity: unknown[];
  flags: { manualPaused: boolean; killSwitch: boolean };
}

function overviewOf(db: ReturnType<typeof openDatabase>): Overview {
  return buildOverview(context(db)) as unknown as Overview;
}

describe('Dashboard — vue d’ensemble', () => {
  it('agrège NAV, positions, stats, listes et disponibilité des données', () => {
    const db = seededDb();
    const overview = overviewOf(db);

    expect(overview.engine.mode).toBe('paper');
    expect(overview.engine.version).toBe('9.9.9');
    expect(overview.engine.alive).toBe(true);
    expect(overview.engine.lastTickAgeS).toBe(0);
    expect(overview.engine.ticks).toBe(2);

    expect(overview.nav.usd).toBeCloseTo(990, 6);
    expect(overview.nav.cashUsd).toBeCloseTo(945, 6);
    expect(overview.nav.peakUsd).toBeCloseTo(1000, 6);
    expect(overview.nav.drawdownPct).toBeCloseTo(1, 6);
    expect(overview.nav.dayPnlPct).toBeCloseTo(-0.6024, 3);
    expect(overview.nav.sinceStartPct).toBeCloseTo(-1, 6);

    // Position AAA : 1000 tokens × 0,04 $ = 40 $ ; coût 50 $ → latent -10 $.
    expect(overview.positions).toHaveLength(1);
    const position = overview.positions[0];
    expect(position!.symbol).toBe('AAA');
    expect(position!.qty).toBeCloseTo(1000, 6);
    expect(position!.valueUsd).toBeCloseTo(40, 6);
    expect(position!.pnlUsd).toBeCloseTo(-10, 6);
    expect(position!.pnlPct).toBeCloseTo(-20, 6);

    expect(overview.stats.closed).toBe(1);
    expect(overview.stats.wins).toBe(0);
    expect(overview.stats.losses).toBe(1);
    expect(overview.stats.realizedPnlUsd).toBeCloseTo(-1.25, 6);
    expect(overview.stats.openCount).toBe(1);

    // Trade d'achat : 49 000 000 (USDC, 6 déc) = 49 $ ; vente : 38 $.
    const buy = overview.trades.find((t) => t.side === 'buy');
    const sell = overview.trades.find((t) => t.side === 'sell');
    expect(buy!.symbol).toBe('AAA');
    expect(buy!.amountUsd).toBeCloseTo(49, 6);
    expect(buy!.trigger).toBe('entry');
    expect(sell!.symbol).toBe('AAA');
    expect(sell!.amountUsd).toBeCloseTo(38, 6);
    expect(sell!.trigger).toBe('stop_loss');

    expect(overview.signals[0]!.symbol).toBe('AAA');
    expect(overview.rejections[0]!.rule).toBe('max_positions');
    expect(overview.events[0]!.kind).toBe('trade_open');

    // AAA prêt, BBB en chauffe → 1/3 (USDC sans bougies compte comme non prêt).
    expect(overview.watchlist.total).toBe(3);
    expect(overview.watchlist.ready).toBe(1);
    const aaa = overview.watchlist.items.find((w) => w.symbol === 'AAA');
    expect(aaa!.ready).toBe(true);
    expect(aaa!.priceUsd).toBeCloseTo(0.04, 6);

    expect(overview.equity).toHaveLength(2);
    expect(overview.flags.manualPaused).toBe(false);
    expect(overview.flags.killSwitch).toBe(false);
  });

  it('gère une base vide sans exception', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    dbs.push(db);
    const overview = overviewOf(db);
    expect(overview.engine.ticks).toBe(0);
    expect(overview.engine.alive).toBe(false);
    expect(overview.positions).toEqual([]);
    expect(overview.watchlist.total).toBe(0);
  });
});

describe('Dashboard — serveur HTTP', () => {
  it('sert la page, l’API JSON et /healthz', async () => {
    const db = seededDb();
    const server = await startDashboardServer({
      host: '127.0.0.1',
      port: 0,
      context: context(db),
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('solbot');
    expect(html).toContain('/api/overview');

    const api = await fetch(`${base}/api/overview`);
    expect(api.status).toBe(200);
    const payload = (await api.json()) as unknown as Overview;
    expect(payload.engine.mode).toBe('paper');
    expect(payload.nav.usd).toBeCloseTo(990, 6);

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect((await health.json()) as unknown).toEqual({ status: 'ok' });

    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);

    const post = await fetch(`${base}/api/overview`, { method: 'POST' });
    expect(post.status).toBe(405);
  });

  it('renvoie 503 quand le moteur est arrêté (dernier tick ancien)', async () => {
    const db = seededDb();
    const server = await startDashboardServer({
      host: '127.0.0.1',
      port: 0,
      context: {
        ...context(db),
        // Dernier tick ~3 h avant « maintenant » → stale.
        now: () => NOW + 3 * 3600 * 1000,
      },
    });
    servers.push(server);
    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(health.status).toBe(503);
  });
});

describe('Dashboard — HTML', () => {
  it('produit une page autonome (aucune ressource externe)', () => {
    const html = renderDashboardHtml();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('http://');
    expect(html).toContain('/api/overview');
  });
});
