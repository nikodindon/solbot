import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { USDC_MINT } from '../src/constants.js';
import {
  Engine,
  nextUtcMidnight,
  utcDayKey,
  type EngineDeps,
  type EngineMode,
} from '../src/engine/engine.js';
import type { Executor, SwapOutcome } from '../src/execution/executor.js';
import type { PollSummary, PolledPrice } from '../src/market/poller.js';
import { getNumberState, setNumberState, setState, STATE_KEYS } from '../src/state/bot-state.js';
import { openDatabase } from '../src/state/db.js';
import { getRecentEvents } from '../src/state/events.js';
import { runMigrations } from '../src/state/migrations.js';
import {
  getOpenPosition,
  getPositionById,
  openPosition,
  qtyToFloat,
} from '../src/state/positions.js';
import { getRecentRejections } from '../src/state/risk-rejections.js';
import { getRecentSignals } from '../src/state/signals.js';
import { getRecentTrades, insertTrade } from '../src/state/trades.js';
import { replaceWatchlist, type WatchlistItem } from '../src/state/watchlist.js';
import type { DataRequirement, Signal, Strategy } from '../src/strategy/types.js';
import { parseConfig, type Config } from '../src/utils/config.js';

const NOW = 1_750_000_000_000;
const A = 'A'.repeat(44);
const B = 'B'.repeat(44);

function memoryDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

function watchItem(mint: string, symbol: string, rank: number): WatchlistItem {
  return {
    mint,
    symbol,
    name: symbol,
    rank,
    isBase: false,
    isVerified: true,
    organicScore: null,
    liquidityUsd: 1_000_000,
    usdPrice: 1,
    priceChange24h: 0,
    tags: [],
    updatedAt: NOW,
  };
}

function price(usdPrice: number, liquidityUsd = 1_000_000, decimals = 6): PolledPrice {
  return { usdPrice, liquidityUsd, volume24hUsd: null, decimals };
}

function buySignal(overrides: Partial<Signal> = {}): Signal {
  return {
    assetMint: A,
    symbol: 'AAA',
    side: 'buy',
    confidence: 0.9,
    ttlMs: 90_000,
    reason: 'test breakout',
    suggestedStopLossPct: 5,
    ...overrides,
  };
}

function sellSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    assetMint: A,
    symbol: 'AAA',
    side: 'sell',
    confidence: 0.6,
    ttlMs: 90_000,
    reason: 'test croisement',
    ...overrides,
  };
}

function scriptedStrategy(signals: Signal[], requiredData: DataRequirement[] = []): Strategy {
  return { name: 'test', requiredData, evaluate: () => signals };
}

interface Harness {
  db: DatabaseSync;
  engine: Engine;
  prices: Map<string, PolledPrice>;
  stop: { exists: boolean; created: boolean };
  logs: string[];
  config: Config;
}

function harness(
  options: {
    signals?: Signal[];
    configOverrides?: Record<string, unknown>;
    mode?: EngineMode;
    executor?: Executor;
    readLiveCash?: (prices: Map<string, number | null>) => Promise<{
      baseUsd: number;
      solBalanceSol: number;
    }>;
    requiredData?: DataRequirement[];
    assets?: Array<{ mint: string; symbol: string }>;
    stopExists?: boolean;
  } = {},
): Harness {
  const db = memoryDb();
  const assets = options.assets ?? [{ mint: A, symbol: 'AAA' }];
  replaceWatchlist(
    db,
    assets.map((asset, index) => watchItem(asset.mint, asset.symbol, index + 1)),
  );

  const config = parseConfig({
    paper: { initial_usdc: 1000, fill_slippage_bps: 20 },
    ...(options.configOverrides ?? {}),
  });
  const prices = new Map<string, PolledPrice>();
  const stop = { exists: options.stopExists ?? false, created: false };
  const logs: string[] = [];

  const deps: EngineDeps = {
    db,
    config,
    mode: options.mode ?? 'paper',
    strategies: [scriptedStrategy(options.signals ?? [], options.requiredData)],
    weights: new Map([['test', 1]]),
    poll: async (mints): Promise<PollSummary> => ({
      ts: NOW,
      requested: mints.length,
      priced: prices.size,
      volumeCovered: 0,
      ticksInserted: 0,
      candlesUpserted: 0,
      durationMs: 0,
      prices,
    }),
    stopFile: {
      exists: () => stop.exists,
      createIfAbsent: () => {
        stop.exists = true;
        stop.created = true;
      },
    },
    clock: () => NOW,
    onLog: (line) => logs.push(line),
    ...(options.executor === undefined ? {} : { executor: options.executor }),
    ...(options.readLiveCash === undefined ? {} : { readLiveCash: options.readLiveCash }),
  };

  return { db, engine: new Engine(deps), prices, stop, logs, config };
}

function paperCash(db: DatabaseSync): number | null {
  return getNumberState(db, STATE_KEYS.paperCashUsdc);
}

describe('Engine — entrées (paper)', () => {
  it('exécute une entrée virtuelle dimensionnée par le risque', async () => {
    const h = harness({ signals: [buySignal()] });
    h.prices.set(A, price(2));

    const result = await h.engine.runOnce();

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toContain('achat AAA');
    expect(result.rejections).toEqual([]);

    const position = getOpenPosition(h.db, A)!;
    expect(position.symbol).toBe('AAA');
    // 50 $ − frais 10 bps = 49,95 → prix effectif 2,004 → 24,925… unités.
    expect(qtyToFloat(position.qtyRemaining, 6)).toBeCloseTo(49.95 / 2.004, 4);
    expect(position.avgEntryPriceUsd).toBeCloseTo(50 / (49.95 / 2.004), 6);
    expect(position.stopLossPriceUsd).toBeCloseTo(position.avgEntryPriceUsd * 0.95, 6);
    expect(position.takeProfitPriceUsd).toBeCloseTo(position.avgEntryPriceUsd * 1.15, 6);

    // Caisse virtuelle : 1000 − 50.
    expect(paperCash(h.db)).toBeCloseTo(950, 6);
    // NAV ≈ 950 + 49,85 (perte immédiate frais + slippage).
    expect(result.navUsd).toBeCloseTo(999.85, 1);

    const trades = getRecentTrades(h.db);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      mode: 'paper',
      status: 'success',
      inputMint: USDC_MINT,
      outputMint: A,
      strategy: 'test',
      trigger: 'entry',
    });
    expect(getRecentSignals(h.db)[0]).toMatchObject({ side: 'buy', acted: true });
    expect(getRecentEvents(h.db)[0]).toMatchObject({ kind: 'trade_open' });
    h.db.close();
  });

  it('ne transmet au risque qu’une entrée par tick (anti-rafale) et respecte le cooldown', async () => {
    const h = harness({
      signals: [
        buySignal({ confidence: 0.9 }),
        buySignal({ assetMint: B, symbol: 'BBB', confidence: 0.8 }),
      ],
      assets: [
        { mint: A, symbol: 'AAA' },
        { mint: B, symbol: 'BBB' },
      ],
      configOverrides: { risk: { min_time_between_trades_s: 300 } },
    });
    h.prices.set(A, price(1));
    h.prices.set(B, price(1));
    insertTrade(h.db, {
      mode: 'paper',
      status: 'success',
      signature: null,
      requestId: null,
      inputMint: USDC_MINT,
      outputMint: B,
      inAmount: '1000000',
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
      createdAt: NOW - 1_000, // cooldown actif pour B
    });

    const result = await h.engine.runOnce();

    // A (meilleure confiance) est exécuté ; B, sous cooldown, n'est pas
    // transmis (max_entries_per_tick = 1) mais reste journalisé pour audit
    // avec acted = false.
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toContain('achat AAA');
    expect(getOpenPosition(h.db, B)).toBeNull();
    const signalsB = getRecentSignals(h.db).filter((signal) => signal.mint === B);
    expect(signalsB).toHaveLength(1);
    expect(signalsB[0]).toMatchObject({ side: 'buy', acted: false });
    h.db.close();
  });

  it('rejette l’entrée sous cooldown quand elle est transmise', async () => {
    const h = harness({
      signals: [buySignal()],
      configOverrides: { risk: { min_time_between_trades_s: 300 } },
    });
    h.prices.set(A, price(1));
    insertTrade(h.db, {
      mode: 'paper',
      status: 'success',
      signature: null,
      requestId: null,
      inputMint: USDC_MINT,
      outputMint: A,
      inAmount: '1000000',
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
      createdAt: NOW - 1_000,
    });

    const result = await h.engine.runOnce();

    expect(result.entries).toEqual([]);
    expect(result.rejections[0]).toContain('cooldown');
    expect(getRecentRejections(h.db)[0]).toMatchObject({ rule: 'cooldown', side: 'buy' });
    h.db.close();
  });

  it('coupe les entrées quand le kill-switch est actif (fichier STOP)', async () => {
    const h = harness({ signals: [buySignal()], stopExists: true });
    h.prices.set(A, price(1));

    const result = await h.engine.runOnce();

    expect(result.killSwitch).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.rejections[0]).toContain('kill-switch');
    expect(getOpenPosition(h.db, A)).toBeNull();
    expect(getRecentTrades(h.db)).toEqual([]);
    h.db.close();
  });

  it('met les entrées en pause après la perte journalière limite', async () => {
    const h = harness({
      signals: [buySignal()],
      configOverrides: { risk: { daily_loss_limit_pct: 3 } },
    });
    h.prices.set(A, price(1));
    setState(h.db, STATE_KEYS.dayKey, utcDayKey(NOW), NOW);
    setNumberState(h.db, STATE_KEYS.dayStartNavUsd, 1000, NOW);
    setNumberState(h.db, STATE_KEYS.paperCashUsdc, 950, NOW); // NAV 950 → −5 %

    const result = await h.engine.runOnce();

    expect(result.dailyLossPct).toBeCloseTo(5, 6);
    expect(result.pausedUntilMs).toBe(nextUtcMidnight(NOW));
    expect(result.entries).toEqual([]);
    expect(result.rejections[0]).toContain('pause');
    const events = getRecentEvents(h.db);
    expect(events.some((event) => event.kind === 'daily_loss_pause')).toBe(true);
    h.db.close();
  });

  it('refuse une entrée supplémentaire au-delà de max_positions', async () => {
    const h = harness({
      signals: [buySignal({ assetMint: B, symbol: 'BBB' })],
      assets: [
        { mint: A, symbol: 'AAA' },
        { mint: B, symbol: 'BBB' },
      ],
      configOverrides: { risk: { max_positions: 1 } },
    });
    h.prices.set(A, price(1));
    h.prices.set(B, price(1));
    openPosition(h.db, {
      mint: A,
      symbol: 'AAA',
      decimals: 6,
      qty: '1000000',
      priceUsd: 1,
      ts: NOW - 5_000,
    });

    const result = await h.engine.runOnce();

    expect(result.entries).toEqual([]);
    expect(result.rejections[0]).toContain('limite de 1 position');
    expect(getRecentRejections(h.db)[0]).toMatchObject({ rule: 'max_positions' });
    h.db.close();
  });

  it('journalise les signaux non retenus pour audit (achats actionnables)', async () => {
    const h = harness({ signals: [buySignal(), sellSignal()] });
    h.prices.set(A, price(1));

    await h.engine.runOnce();

    // L'achat est actionnable (mint de la watchlist, pas de position) et
    // exécuté ; la vente sur un actif non détenu est ignorée (pas de ligne).
    const signals = getRecentSignals(h.db);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.side).toBe('buy');
    h.db.close();
  });
});

describe('Engine — sorties', () => {
  it('déclenche le stop-loss, clôture la position et crédite la caisse', async () => {
    const h = harness();
    h.prices.set(A, price(1.7));
    const position = openPosition(h.db, {
      mint: A,
      symbol: 'AAA',
      decimals: 6,
      qty: '10000000',
      priceUsd: 2,
      ts: NOW - 1_000,
      stopLossPriceUsd: 1.8,
      takeProfitPriceUsd: 2.4,
    });

    const result = await h.engine.runOnce();

    expect(result.exits).toHaveLength(1);
    expect(result.exits[0]).toContain('stop-loss');
    expect(getOpenPosition(h.db, A)).toBeNull();

    const closed = getPositionById(h.db, position.id)!;
    expect(closed.status).toBe('closed');
    expect(closed.realizedPnlUsd).toBeLessThan(0);

    // Produits : 10 × 1,7 × (1 − 0,002) × (1 − 0,001) = 16,949…
    expect(paperCash(h.db)).toBeCloseTo(1000 + 16.949034, 4);
    expect(getRecentTrades(h.db)[0]).toMatchObject({
      trigger: 'stop_loss',
      inputMint: A,
      outputMint: USDC_MINT,
      mode: 'paper',
    });
    expect(getRecentEvents(h.db)[0]).toMatchObject({ kind: 'trade_close' });
    h.db.close();
  });

  it('déclenche le take-profit', async () => {
    const h = harness();
    h.prices.set(A, price(2.5));
    openPosition(h.db, {
      mint: A,
      symbol: 'AAA',
      decimals: 6,
      qty: '10000000',
      priceUsd: 2,
      ts: NOW - 1_000,
      stopLossPriceUsd: 1.8,
      takeProfitPriceUsd: 2.4,
    });

    const result = await h.engine.runOnce();

    expect(result.exits[0]).toContain('take-profit');
    expect(getRecentTrades(h.db)[0]).toMatchObject({ trigger: 'take_profit' });
    h.db.close();
  });

  it('fait monter le stop avec le trailing et sort au retournement', async () => {
    const h = harness();
    const position = openPosition(h.db, {
      mint: A,
      symbol: 'AAA',
      decimals: 6,
      qty: '10000000',
      priceUsd: 2,
      ts: NOW - 1_000,
      stopLossPriceUsd: 1.9,
      takeProfitPriceUsd: 5,
    });

    // Tick 1 : +10 % → trailing activé (activation 6 %), stop = 2,2 × 0,97.
    h.prices.set(A, price(2.2));
    await h.engine.runOnce();
    const marked = getPositionById(h.db, position.id)!;
    expect(marked.peakPriceUsd).toBeCloseTo(2.2, 10);
    expect(marked.stopLossPriceUsd).toBeCloseTo(2.2 * 0.97, 10);
    expect(marked.status).toBe('open');

    // Tick 2 : 2,10 < 2,134 → sortie trailing.
    h.prices.set(A, price(2.1));
    const result = await h.engine.runOnce();
    expect(result.exits[0]).toContain('trailing stop');
    expect(getRecentTrades(h.db)[0]).toMatchObject({ trigger: 'trailing_stop' });
    h.db.close();
  });

  it('sort sur signal de la stratégie pour une position détenue', async () => {
    const h = harness({ signals: [sellSignal()] });
    h.prices.set(A, price(2));
    openPosition(h.db, {
      mint: A,
      symbol: 'AAA',
      decimals: 6,
      qty: '10000000',
      priceUsd: 1.5,
      ts: NOW - 1_000,
      stopLossPriceUsd: 1,
      takeProfitPriceUsd: 5,
    });

    const result = await h.engine.runOnce();

    expect(result.exits).toHaveLength(1);
    expect(result.exits[0]).toContain('sortie momentum');
    expect(getRecentTrades(h.db)[0]).toMatchObject({ trigger: 'momentum_exit', strategy: 'test' });
    const closed = getRecentSignals(h.db)[0];
    expect(closed).toMatchObject({ side: 'sell', acted: true });
    h.db.close();
  });

  it('laisse les sorties actives malgré le kill-switch', async () => {
    const h = harness({ stopExists: true });
    h.prices.set(A, price(1.7));
    openPosition(h.db, {
      mint: A,
      symbol: 'AAA',
      decimals: 6,
      qty: '10000000',
      priceUsd: 2,
      ts: NOW - 1_000,
      stopLossPriceUsd: 1.8,
      takeProfitPriceUsd: 2.4,
    });

    const result = await h.engine.runOnce();

    expect(result.killSwitch).toBe(true);
    expect(result.exits).toHaveLength(1);
    expect(getOpenPosition(h.db, A)).toBeNull();
    h.db.close();
  });
});

describe('Engine — garde-fous globaux et états', () => {
  it('déclenche le kill-switch drawdown (création du fichier STOP)', async () => {
    const h = harness({ configOverrides: { risk: { max_drawdown_pct: 15 } } });
    setNumberState(h.db, STATE_KEYS.navPeakUsd, 1000, NOW);
    setNumberState(h.db, STATE_KEYS.paperCashUsdc, 800, NOW); // −20 %

    const result = await h.engine.runOnce();

    expect(result.drawdownPct).toBeCloseTo(20, 6);
    expect(h.stop.created).toBe(true);
    expect(result.killSwitch).toBe(true);
    expect(getRecentEvents(h.db).some((event) => event.kind === 'drawdown_kill_switch')).toBe(true);
    h.db.close();
  });

  it('gonfle le pic de NAV et renouvelle l’ancre à la journée UTC', async () => {
    const h = harness();
    setNumberState(h.db, STATE_KEYS.paperCashUsdc, 1200, NOW);
    setState(h.db, STATE_KEYS.dayKey, '2000-01-01', NOW);
    setNumberState(h.db, STATE_KEYS.dayStartNavUsd, 1000, NOW);
    setNumberState(h.db, STATE_KEYS.pausedUntilMs, NOW + 999_999, NOW);

    const result = await h.engine.runOnce();

    expect(getNumberState(h.db, STATE_KEYS.navPeakUsd)).toBeCloseTo(1200, 6);
    expect(getNumberState(h.db, STATE_KEYS.dayStartNavUsd)).toBeCloseTo(1200, 6);
    expect(getNumberState(h.db, STATE_KEYS.pausedUntilMs)).toBeNull();
    expect(result.dailyLossPct).toBe(0);
    h.db.close();
  });

  it('compte les actifs prêts (warm-up momentum)', async () => {
    const h = harness({ requiredData: [{ timeframe: '15m', bars: 27 }] });

    const result = await h.engine.runOnce();

    expect(result.totalAssets).toBe(1);
    expect(result.readyAssets).toBe(0);
    h.db.close();
  });

  it('refuse un moteur live sans lecture on-chain', () => {
    expect(() =>
      harness({ mode: 'live', executor: { swap: async () => ({}) } as unknown as Executor }),
    ).toThrow(/soldes on-chain/);
    expect(() => harness({ mode: 'dry_run' })).toThrow(/Exécuteur/);
  });
});

describe('Engine — dry-run et live', () => {
  it('dry-run : remplit au montant réellement coté et annote le trade', async () => {
    let tradeId = 0;
    const executor = {
      swap: async (): Promise<SwapOutcome> => ({
        mode: 'dry_run',
        status: 'simulated',
        order: { outAmount: '24000000' },
        execute: null,
        simulation: { err: null, unitsConsumed: 1_000, logsTail: [] },
        attempts: [],
        signature: null,
        realizedSlippageBps: null,
        tradeId,
        failure: null,
      }),
    } as unknown as Executor;

    const h = harness({
      mode: 'dry_run',
      executor,
      signals: [buySignal()],
      assets: [{ mint: A, symbol: 'AAA' }],
    });
    tradeId = insertTrade(h.db, {
      mode: 'dry_run',
      status: 'simulated',
      signature: null,
      requestId: 'req-1',
      inputMint: USDC_MINT,
      outputMint: A,
      inAmount: '50000000',
      expectedOutAmount: '24000000',
      outAmount: '24000000',
      router: 'metis',
      feeBps: 10,
      feeMint: USDC_MINT,
      priceImpact: -0.02,
      slippageBps: 50,
      realizedSlippageBps: null,
      errorCode: null,
      errorMessage: null,
      createdAt: NOW - 400_000,
    });
    h.prices.set(A, price(2));

    const result = await h.engine.runOnce();

    expect(result.entries).toHaveLength(1);
    const position = getOpenPosition(h.db, A)!;
    expect(position.qtyRemaining).toBe('24000000');
    expect(position.avgEntryPriceUsd).toBeCloseTo(50 / 24, 6);
    expect(paperCash(h.db)).toBeCloseTo(950, 6);
    expect(getRecentTrades(h.db, 5)[0]).toMatchObject({ strategy: 'test', trigger: 'entry' });
    h.db.close();
  });

  it('dry-run : simulation en erreur → aucune position', async () => {
    const executor = {
      swap: async (): Promise<SwapOutcome> => ({
        mode: 'dry_run',
        status: 'simulated',
        order: { outAmount: '24000000' },
        execute: null,
        simulation: { err: { InstructionError: [0, 'Custom'] }, unitsConsumed: null, logsTail: [] },
        attempts: [],
        signature: null,
        realizedSlippageBps: null,
        tradeId: 42,
        failure: null,
      }),
    } as unknown as Executor;

    const h = harness({ mode: 'dry_run', executor, signals: [buySignal()] });
    h.prices.set(A, price(2));

    const result = await h.engine.runOnce();
    expect(result.entries).toEqual([]);
    expect(getOpenPosition(h.db, A)).toBeNull();
    expect(h.logs.join('\n')).toContain('simulation RPC en erreur');
    h.db.close();
  });

  it('live : soldes RPC comme caisse, position créée depuis le montant exécuté', async () => {
    let tradeId = 0;
    const executor = {
      swap: async (): Promise<SwapOutcome> => ({
        mode: 'live',
        status: 'success',
        order: { outAmount: '24000000' },
        execute: { code: 0, status: 'Success', totalOutputAmount: '23900000' },
        simulation: null,
        attempts: [],
        signature: 'SIG',
        realizedSlippageBps: 3,
        tradeId,
        failure: null,
      }),
    } as unknown as Executor;

    const h = harness({
      mode: 'live',
      executor,
      signals: [buySignal()],
      readLiveCash: async () => ({ baseUsd: 1000, solBalanceSol: 0.1 }),
    });
    tradeId = insertTrade(h.db, {
      mode: 'live',
      status: 'success',
      signature: 'SIG',
      requestId: 'req-1',
      inputMint: USDC_MINT,
      outputMint: A,
      inAmount: '50000000',
      expectedOutAmount: '24000000',
      outAmount: '24000000',
      router: 'metis',
      feeBps: 10,
      feeMint: USDC_MINT,
      priceImpact: -0.02,
      slippageBps: 50,
      realizedSlippageBps: 3,
      errorCode: null,
      errorMessage: null,
      createdAt: NOW - 400_000,
    });
    h.prices.set(A, price(2));

    const result = await h.engine.runOnce();

    expect(result.entries).toHaveLength(1);
    // En fin de tick la caisse reflète l'achat (1000 − 50) ; la lecture RPC
    // suivante fera foi.
    expect(result.cashUsd).toBe(950);
    const position = getOpenPosition(h.db, A)!;
    expect(position.qtyRemaining).toBe('23900000');
    // La caisse virtuelle paper n'est pas touchée en live.
    expect(paperCash(h.db)).toBeNull();
    h.db.close();
  });

  it('live : réserve de gaz insuffisante → entrée refusée', async () => {
    const h = harness({
      mode: 'live',
      executor: { swap: async () => ({}) } as unknown as Executor,
      signals: [buySignal()],
      readLiveCash: async () => ({ baseUsd: 1000, solBalanceSol: 0.01 }),
    });
    h.prices.set(A, price(2));

    const result = await h.engine.runOnce();

    expect(result.entries).toEqual([]);
    expect(result.rejections[0]).toContain('gaz');
    expect(getRecentRejections(h.db)[0]).toMatchObject({ rule: 'gas_reserve' });
    h.db.close();
  });
});

describe('utilitaires de temps', () => {
  it('clé de jour UTC et minuit suivant', () => {
    const ts = Date.UTC(2026, 9, 15, 13, 45, 0);
    expect(utcDayKey(ts)).toBe('2026-10-15');
    expect(nextUtcMidnight(ts)).toBe(Date.UTC(2026, 9, 16, 0, 0, 0));
    expect(nextUtcMidnight(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe(Date.UTC(2027, 0, 1));
  });
});
