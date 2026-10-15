import type { DatabaseSync } from 'node:sqlite';
import { SOL_MINT, USDC_MINT } from '../constants.js';
import type { Executor } from '../execution/executor.js';
import { PaperBroker, toBaseUnitsFloor } from '../execution/paper-broker.js';
import { TIMEFRAMES, type Timeframe } from '../market/ohlcv.js';
import type { PollSummary } from '../market/poller.js';
import { Portfolio, type PortfolioSnapshot } from '../portfolio/portfolio.js';
import { RiskManager, type RiskContext } from '../risk/risk-manager.js';
import {
  deleteState,
  getNumberState,
  getState,
  setNumberState,
  setState,
  STATE_KEYS,
} from '../state/bot-state.js';
import { insertEvent } from '../state/events.js';
import { getCandles, type Candle } from '../state/market-data.js';
import {
  openPosition,
  reducePositionFifo,
  updatePositionMarks,
  qtyToFloat,
  type PositionRow,
} from '../state/positions.js';
import { insertSignal, markSignalActed } from '../state/signals.js';
import { insertTrade, annotateTrade, lastTradeTsForMint } from '../state/trades.js';
import { getWatchlist } from '../state/watchlist.js';
import {
  closedCandles,
  type AssetSnapshot,
  type MarketSnapshot,
  type Signal,
  type Strategy,
} from '../strategy/types.js';
import type { Config } from '../utils/config.js';
import { SolbotError, messageOf } from '../utils/errors.js';
import { sleep } from '../utils/retry.js';

export type EngineMode = 'paper' | 'dry_run' | 'live';

const MAX_CONSECUTIVE_ERRORS = 5;

export interface EngineDeps {
  db: DatabaseSync;
  config: Config;
  mode: EngineMode;
  strategies: Strategy[];
  /** Pondération par nom de stratégie (arbitrage des signaux). */
  weights: Map<string, number>;
  /** Un cycle de marché : prix + volumes → ticks/bougies, retourne les prix du cycle. */
  poll: (mints: string[]) => Promise<PollSummary>;
  /** Requis en dry_run/live : swaps réels (simulés en dry-run, signés en live). */
  executor?: Executor;
  /** Requis en live : soldes on-chain (devise de base en USD + SOL natif). */
  readLiveCash?: (
    prices: Map<string, number | null>,
  ) => Promise<{ baseUsd: number; solBalanceSol: number }>;
  /** Fichier STOP (kill-switch manuel et drawdown max). */
  stopFile: { exists: () => boolean; createIfAbsent: () => void };
  clock?: () => number;
  onLog?: (line: string) => void;
}

export interface TickResult {
  ts: number;
  navUsd: number;
  cashUsd: number;
  positionsValueUsd: number;
  openCount: number;
  drawdownPct: number;
  dailyLossPct: number;
  killSwitch: boolean;
  pausedUntilMs: number | null;
  entries: string[];
  exits: string[];
  rejections: string[];
  /** Actifs de la watchlist prêts pour l'évaluation (données suffisantes). */
  readyAssets: number;
  totalAssets: number;
}

export interface EngineRunOptions {
  once?: boolean;
  durationS?: number;
  intervalS?: number;
  onTick?: (result: TickResult) => void;
}

export interface EngineSummary {
  ticks: number;
  startedAt: number;
  endedAt: number;
  stopReason: 'once' | 'duration' | 'requested' | 'error';
}

interface ProducedSignal {
  signal: Signal;
  strategy: string;
  id?: number;
}

/**
 * Moteur autonome mono-stratégie (Phase 3) : un tick = snapshot marché →
 * valorisation du portefeuille → sorties (stop-loss, take-profit, trailing,
 * signal de sortie) → entrées arbitrées et contrôlées par le RiskManager.
 * Un seul trade en vol à la fois (boucle séquentielle + verrou explicite).
 */
export class Engine {
  private readonly portfolio: Portfolio;
  private readonly risk: RiskManager;
  private readonly broker: PaperBroker;
  private stopRequested = false;
  private tradeInFlight = false;
  /** Variation de caisse (USD) des trades exécutés pendant le tick courant — live. */
  private tickCashDeltaUsd = 0;

  constructor(private readonly deps: EngineDeps) {
    if ((deps.mode === 'live' || deps.mode === 'dry_run') && deps.executor === undefined) {
      throw new SolbotError(
        `Exécuteur requis en mode ${deps.mode} (aucun exécuteur fourni au moteur)`,
        { hint: 'Erreur interne du CLI — contactez les logs de démarrage.' },
      );
    }
    if (deps.mode === 'live' && deps.readLiveCash === undefined) {
      throw new SolbotError('Lecture des soldes on-chain requise en mode live');
    }
    this.portfolio = new Portfolio(deps.db);
    this.risk = new RiskManager(deps.db, deps.config);
    this.broker = new PaperBroker(deps.config.paper.fill_slippage_bps);
  }

  requestStop(): void {
    this.stopRequested = true;
  }

  get stopping(): boolean {
    return this.stopRequested;
  }

  private now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  private log(line: string): void {
    this.deps.onLog?.(line);
  }

  private base(): { mint: string; decimals: number; symbol: string } {
    return this.deps.config.base_currency === 'SOL'
      ? { mint: SOL_MINT, decimals: 9, symbol: 'SOL' }
      : { mint: USDC_MINT, decimals: 6, symbol: 'USDC' };
  }

  /** Boucle principale : tick → pause → tick… jusqu'à `once`, durée écoulée ou arrêt. */
  async run(options: EngineRunOptions = {}): Promise<EngineSummary> {
    const { db, config, mode } = this.deps;
    const intervalS = options.intervalS ?? config.loop_interval_s;
    const deadline = options.durationS === undefined ? null : this.now() + options.durationS * 1000;
    const startedAt = this.now();
    let ticks = 0;
    let consecutiveErrors = 0;
    let stopReason: EngineSummary['stopReason'] = 'requested';

    insertEvent(db, {
      level: 'info',
      kind: 'engine_start',
      message: `démarrage du moteur — mode ${mode}, intervalle ${intervalS} s, ${this.deps.strategies.length} stratégie(s)`,
      ts: startedAt,
    });

    while (!this.stopRequested) {
      const tickStart = this.now();
      try {
        const result = await this.runOnce();
        ticks += 1;
        consecutiveErrors = 0;
        options.onTick?.(result);
      } catch (error) {
        consecutiveErrors += 1;
        const message = messageOf(error);
        insertEvent(db, {
          level: 'error',
          kind: 'tick_error',
          message,
          ts: this.now(),
        });
        this.log(`erreur de tick (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}) : ${message}`);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          stopReason = 'error';
          break;
        }
      }

      if (options.once === true) {
        stopReason = 'once';
        break;
      }
      if (deadline !== null && this.now() >= deadline) {
        stopReason = 'duration';
        break;
      }
      await this.waitUntil(tickStart + intervalS * 1000);
    }
    if (this.stopRequested && stopReason === 'requested') stopReason = 'requested';

    const endedAt = this.now();
    const reasonLabels: Record<EngineSummary['stopReason'], string> = {
      once: 'tick unique terminé',
      duration: 'durée écoulée',
      requested: 'arrêt demandé',
      error: 'erreur fatale',
    };
    insertEvent(db, {
      level: 'info',
      kind: 'engine_stop',
      message: `arrêt du moteur (${reasonLabels[stopReason]}) — ${ticks} tick(s)`,
      ts: endedAt,
    });
    return { ticks, startedAt, endedAt, stopReason };
  }

  /** Un cycle complet : marché → portefeuille → sorties → entrées. */
  async runOnce(): Promise<TickResult> {
    const { db, config, mode } = this.deps;
    const ts = this.now();
    const base = this.base();

    // ── 1. Marché (watchlist ∪ positions ∪ {devise de base, SOL}) ─────────
    const watchlist = getWatchlist(db);
    const watchlistMints = new Set(watchlist.map((item) => item.mint));
    const startPositions = this.portfolio.openPositions();
    const heldMints = new Set(startPositions.map((position) => position.mint));
    const mints = [
      ...new Set([
        ...watchlist.map((item) => item.mint),
        ...startPositions.map((position) => position.mint),
        base.mint,
        SOL_MINT,
      ]),
    ];
    const poll = await this.deps.poll(mints);

    const prices = new Map<string, number | null>();
    for (const [mint, info] of poll.prices) prices.set(mint, info.usdPrice);
    if (!prices.has(base.mint)) {
      prices.set(base.mint, base.mint === USDC_MINT ? 1 : null);
    }
    const solPriceUsd = prices.get(SOL_MINT) ?? null;
    const basePriceUsd = base.mint === USDC_MINT ? 1 : solPriceUsd;
    this.tickCashDeltaUsd = 0;

    // ── 2. Trésorerie (virtuelle en paper/dry-run, RPC en live) ────────────
    let cashUsd: number;
    let solBalanceSol: number | null = null;
    if (mode === 'live') {
      const live = await this.deps.readLiveCash!(prices);
      cashUsd = live.baseUsd;
      solBalanceSol = live.solBalanceSol;
    } else {
      cashUsd = this.virtualCash();
    }

    // ── 3. Valorisation + garde-fous globaux ───────────────────────────────
    const snapshot = this.portfolio.snapshot({ cashUsd, prices, ts });
    const peak = Math.max(
      getNumberState(db, STATE_KEYS.navPeakUsd) ?? snapshot.navUsd,
      snapshot.navUsd,
    );
    if (getNumberState(db, STATE_KEYS.navPeakUsd) !== peak) {
      setNumberState(db, STATE_KEYS.navPeakUsd, peak, ts);
    }
    const drawdownPct = peak > 0 ? Math.max(0, ((peak - snapshot.navUsd) / peak) * 100) : 0;

    const dayKey = utcDayKey(ts);
    if (getState(db, STATE_KEYS.dayKey) !== dayKey) {
      setState(db, STATE_KEYS.dayKey, dayKey, ts);
      setNumberState(db, STATE_KEYS.dayStartNavUsd, snapshot.navUsd, ts);
      deleteState(db, STATE_KEYS.pausedUntilMs);
      insertEvent(db, {
        level: 'info',
        kind: 'day_rollover',
        message: `nouvelle journée UTC (${dayKey}) : ancre NAV ${snapshot.navUsd.toFixed(2)} $`,
        ts,
      });
    }
    const dayStartNav = getNumberState(db, STATE_KEYS.dayStartNavUsd) ?? snapshot.navUsd;
    const dailyLossPct =
      dayStartNav > 0 ? Math.max(0, ((dayStartNav - snapshot.navUsd) / dayStartNav) * 100) : 0;

    let pausedUntilMs = getNumberState(db, STATE_KEYS.pausedUntilMs);
    if (pausedUntilMs !== null && pausedUntilMs <= ts) {
      deleteState(db, STATE_KEYS.pausedUntilMs);
      pausedUntilMs = null;
      insertEvent(db, {
        level: 'info',
        kind: 'daily_pause_lifted',
        message: 'fin de la pause perte journalière — entrées réautorisées',
        ts,
      });
    }
    if (dailyLossPct >= config.risk.daily_loss_limit_pct && pausedUntilMs === null) {
      pausedUntilMs = nextUtcMidnight(ts);
      setNumberState(db, STATE_KEYS.pausedUntilMs, pausedUntilMs, ts);
      insertEvent(db, {
        level: 'warn',
        kind: 'daily_loss_pause',
        message: `perte journalière ${dailyLossPct.toFixed(2)} % ≥ ${config.risk.daily_loss_limit_pct} % : entrées en pause jusqu'à minuit UTC`,
        ts,
      });
    }

    if (drawdownPct >= config.risk.max_drawdown_pct && !this.deps.stopFile.exists()) {
      this.deps.stopFile.createIfAbsent();
      insertEvent(db, {
        level: 'error',
        kind: 'drawdown_kill_switch',
        message: `drawdown ${drawdownPct.toFixed(2)} % ≥ ${config.risk.max_drawdown_pct} % : kill-switch déclenché (fichier STOP créé)`,
        ts,
      });
    }
    const killSwitch = this.deps.stopFile.exists();

    // ── 4. Signaux des stratégies (une évaluation par tick) ────────────────
    const assetList = buildAssetList(watchlist, startPositions);
    const market = this.buildMarket(assetList, poll, ts);
    const produced = this.evaluateStrategies(market);

    const actionableSells: ProducedSignal[] = [];
    const actionableBuys: ProducedSignal[] = [];
    for (const item of produced) {
      const { signal } = item;
      if (signal.side === 'sell') {
        if (heldMints.has(signal.assetMint)) actionableSells.push(item);
      } else if (
        !heldMints.has(signal.assetMint) &&
        watchlistMints.has(signal.assetMint) &&
        signal.assetMint !== base.mint &&
        signal.assetMint !== SOL_MINT
      ) {
        actionableBuys.push(item);
      }
    }
    for (const item of [...actionableSells, ...actionableBuys]) {
      item.id = this.recordSignal(item, ts);
    }

    // ── 5. Sorties : la garde de sortie a priorité sur toute entrée ────────
    const exits: string[] = [];
    const rejections: string[] = [];
    const sellSignals = new Map(actionableSells.map((item) => [item.signal.assetMint, item]));

    for (const position of startPositions) {
      const price = prices.get(position.mint) ?? null;
      if (price === null || !(price > 0)) continue;
      if (basePriceUsd === null) {
        this.log(`sortie ${position.symbol} reportée : prix ${base.symbol} indisponible`);
        continue;
      }
      const plan = this.exitPlan(position, price, sellSignals.get(position.mint), ts);
      if (plan === null) continue;

      const decision = this.risk.checkExit(
        {
          mint: position.mint,
          symbol: position.symbol,
          strategy: plan.strategy,
          trigger: plan.trigger,
          qtyBaseUnits: position.qtyRemaining,
          priceUsd: price,
        },
        this.buildRiskContext({ ts, snapshot, solBalanceSol }),
      );
      if (!decision.allowed) {
        rejections.push(`sortie ${position.symbol} refusée : ${decision.message}`);
        if (plan.signalId !== undefined) markSignalActed(db, plan.signalId);
        continue;
      }
      if (plan.signalId !== undefined) markSignalActed(db, plan.signalId);
      const line = await this.executeExit(
        position,
        plan.trigger,
        plan.strategy,
        price,
        basePriceUsd,
      );
      if (line !== null) exits.push(line);
    }

    // ── 6. Entrées : arbitrage puis contrôles de risque ────────────────────
    const entries: string[] = [];
    if (killSwitch) {
      if (actionableBuys.length > 0) {
        rejections.push(
          `entrées coupées (kill-switch actif) : ${actionableBuys.length} signal(aux) ignoré(s)`,
        );
      }
    } else if (pausedUntilMs !== null && pausedUntilMs > ts) {
      if (actionableBuys.length > 0) {
        rejections.push(
          `entrées en pause (perte journalière) : ${actionableBuys.length} signal(aux) ignoré(s)`,
        );
      }
    } else {
      const candidates = actionableBuys
        .map((item) => ({
          item,
          score: item.signal.confidence * (this.deps.weights.get(item.strategy) ?? 1),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, config.engine.max_entries_per_tick);

      const lastTradeTsByMint = new Map<string, number>();
      for (const candidate of candidates) {
        const lastTs = lastTradeTsForMint(db, candidate.item.signal.assetMint);
        if (lastTs !== null) lastTradeTsByMint.set(candidate.item.signal.assetMint, lastTs);
      }

      for (const candidate of candidates) {
        const { item } = candidate;
        const mint = item.signal.assetMint;
        const info = poll.prices.get(mint);
        const price = prices.get(mint) ?? 0;
        const decision = this.risk.checkEntry(
          {
            mint,
            symbol: item.signal.symbol,
            strategy: item.strategy,
            priceUsd: price,
            liquidityUsd: info?.liquidityUsd ?? null,
          },
          this.buildRiskContext({ ts, snapshot, solBalanceSol, lastTradeTsByMint }),
        );
        if (item.id !== undefined) markSignalActed(db, item.id);
        if (!decision.allowed) {
          rejections.push(`entrée ${item.signal.symbol} refusée : ${decision.message}`);
          continue;
        }
        const line = await this.executeEntry(item, decision.sizeUsd, price, poll, solPriceUsd);
        if (line !== null) entries.push(line);
      }
    }

    // La valeur du tick est recalculée après les trades : NAV, caisse et
    // positions reflètent l'état en fin de cycle (le risque, lui, a contrôlé
    // sur le snapshot d'entrée de tick).
    const finalCashUsd =
      mode === 'live' ? Math.max(0, cashUsd + this.tickCashDeltaUsd) : this.virtualCash();
    const finalSnapshot = this.portfolio.snapshot({
      cashUsd: finalCashUsd,
      prices,
      ts: this.now(),
    });

    return {
      ts,
      navUsd: finalSnapshot.navUsd,
      cashUsd: finalCashUsd,
      positionsValueUsd: finalSnapshot.positionsValueUsd,
      openCount: finalSnapshot.openCount,
      drawdownPct,
      dailyLossPct,
      killSwitch,
      pausedUntilMs,
      entries,
      exits,
      rejections,
      readyAssets: this.readyAssets(market, ts, watchlistMints),
      totalAssets: watchlist.length,
    };
  }

  /* ────────────────────────────────────────────────────────────────────────
   * Helpers publics au tick
   * ──────────────────────────────────────────────────────────────────────── */

  private buildRiskContext(input: {
    ts: number;
    snapshot: PortfolioSnapshot;
    solBalanceSol: number | null;
    lastTradeTsByMint?: Map<string, number>;
  }): RiskContext {
    const { db } = this.deps;
    const exposureByMint = new Map<string, number>();
    for (const view of input.snapshot.positions) {
      exposureByMint.set(view.mint, (exposureByMint.get(view.mint) ?? 0) + view.valueUsd);
    }
    return {
      now: input.ts,
      navUsd: input.snapshot.navUsd,
      killSwitch: this.deps.stopFile.exists(),
      pausedUntilMs: getNumberState(db, STATE_KEYS.pausedUntilMs),
      openPositions: this.portfolio.openPositions(),
      exposureByMint,
      lastTradeTsByMint: input.lastTradeTsByMint ?? new Map(),
      cashAvailableUsd: this.cashAvailableUsd(input.snapshot.cashUsd),
      solBalanceSol: input.solBalanceSol,
    };
  }

  /** Liquidités mobilisables : en SOL, la réserve de gaz n'est pas dépensable. */
  private cashAvailableUsd(cashUsd: number): number {
    return Math.max(0, cashUsd);
  }

  private virtualCash(): number {
    const { db, config } = this.deps;
    const current = getNumberState(db, STATE_KEYS.paperCashUsdc);
    if (current === null) {
      setNumberState(db, STATE_KEYS.paperCashUsdc, config.paper.initial_usdc, this.now());
      return config.paper.initial_usdc;
    }
    return current;
  }

  private addVirtualCash(deltaUsd: number): void {
    setNumberState(
      this.deps.db,
      STATE_KEYS.paperCashUsdc,
      this.virtualCash() + deltaUsd,
      this.now(),
    );
  }

  private recordSignal(item: ProducedSignal, ts: number): number {
    const { signal } = item;
    return insertSignal(this.deps.db, {
      ts,
      strategy: item.strategy,
      mint: signal.assetMint,
      symbol: signal.symbol,
      side: signal.side,
      confidence: signal.confidence,
      edgeBps: signal.edgeEstimateBps ?? null,
      ttlMs: signal.ttlMs,
      reason: signal.reason,
    });
  }

  private evaluateStrategies(market: MarketSnapshot): ProducedSignal[] {
    const produced: ProducedSignal[] = [];
    for (const strategy of this.deps.strategies) {
      try {
        for (const signal of strategy.evaluate(market)) {
          produced.push({ signal, strategy: strategy.name });
        }
      } catch (error) {
        this.log(`stratégie ${strategy.name} en erreur : ${messageOf(error)}`);
      }
    }
    return produced;
  }

  private buildMarket(
    assets: Array<{ mint: string; symbol: string }>,
    poll: PollSummary,
    ts: number,
  ): MarketSnapshot {
    const { db } = this.deps;
    const needed = new Map<Timeframe, number>();
    for (const strategy of this.deps.strategies) {
      for (const requirement of strategy.requiredData) {
        needed.set(
          requirement.timeframe,
          Math.max(needed.get(requirement.timeframe) ?? 0, requirement.bars + 2),
        );
      }
    }

    const snapshots: AssetSnapshot[] = assets.map((asset) => {
      const candles: Partial<Record<Timeframe, Candle[]>> = {};
      for (const [timeframe, limit] of needed) {
        candles[timeframe] = getCandles(db, asset.mint, timeframe, limit);
      }
      const info = poll.prices.get(asset.mint);
      return {
        mint: asset.mint,
        symbol: asset.symbol,
        priceUsd: info?.usdPrice ?? 0,
        liquidityUsd: info?.liquidityUsd ?? null,
        candles,
      };
    });
    return { ts, assets: snapshots };
  }

  private readyAssets(market: MarketSnapshot, ts: number, watchlistMints: Set<string>): number {
    let ready = 0;
    for (const asset of market.assets) {
      if (!watchlistMints.has(asset.mint)) continue;
      const allReady = this.deps.strategies.every((strategy) =>
        strategy.requiredData.every((requirement) => {
          const candles = closedCandles(
            asset.candles[requirement.timeframe],
            TIMEFRAMES[requirement.timeframe],
            ts,
          );
          return candles.length >= requirement.bars;
        }),
      );
      if (allReady) ready += 1;
    }
    return ready;
  }

  /** Détermine le motif de sortie : stop-loss, take-profit, trailing, signal. */
  private exitPlan(
    position: PositionRow,
    price: number,
    sellSignal: ProducedSignal | undefined,
    ts: number,
  ): { trigger: string; strategy: string; signalId?: number } | null {
    const { db, config } = this.deps;
    const entry = position.avgEntryPriceUsd;
    const peakBefore = position.peakPriceUsd ?? entry;
    const peak = Math.max(peakBefore, price);
    const { activation_pct, retrace_pct } = config.risk.trailing_stop;
    const trailingActive = peak >= entry * (1 + activation_pct / 100);
    const trailingStop = trailingActive ? peak * (1 - retrace_pct / 100) : null;

    let stop = position.stopLossPriceUsd;
    if (trailingStop !== null && (stop === null || trailingStop > stop)) stop = trailingStop;

    if (peak !== peakBefore || stop !== position.stopLossPriceUsd) {
      updatePositionMarks(db, position.id, {
        peakPriceUsd: peak,
        stopLossPriceUsd: stop,
        ts,
      });
    }

    if (stop !== null && price <= stop) {
      const trailing = trailingStop !== null && stop === trailingStop;
      return { trigger: trailing ? 'trailing_stop' : 'stop_loss', strategy: 'risk' };
    }
    if (position.takeProfitPriceUsd !== null && price >= position.takeProfitPriceUsd) {
      return { trigger: 'take_profit', strategy: 'risk' };
    }
    if (sellSignal !== undefined) {
      return {
        trigger: 'momentum_exit',
        strategy: sellSignal.strategy,
        ...(sellSignal.id === undefined ? {} : { signalId: sellSignal.id }),
      };
    }
    return null;
  }

  /* ────────────────────────────────────────────────────────────────────────
   * Exécution
   * ──────────────────────────────────────────────────────────────────────── */

  private async executeEntry(
    item: ProducedSignal,
    sizeUsd: number,
    priceUsd: number,
    poll: PollSummary,
    solPriceUsd: number | null,
  ): Promise<string | null> {
    const { db, config, mode } = this.deps;
    const base = this.base();
    const mint = item.signal.assetMint;
    const info = poll.prices.get(mint);
    if (info === undefined) return null;
    const decimals = info.decimals;
    if (decimals === null) {
      this.log(`entrée ${item.signal.symbol} ignorée : décimales inconnues`);
      return null;
    }
    const basePriceUsd = base.mint === USDC_MINT ? 1 : solPriceUsd;
    if (basePriceUsd === null || !(basePriceUsd > 0)) {
      this.log(`entrée ${item.signal.symbol} ignorée : prix ${base.symbol} indisponible`);
      return null;
    }
    const amountBaseUnits = toBaseUnitsFloor(sizeUsd / basePriceUsd, base.decimals);
    if (amountBaseUnits === '0') return null;
    const spendUsd = (Number(amountBaseUnits) / 10 ** base.decimals) * basePriceUsd;

    const stopPct = item.signal.suggestedStopLossPct ?? config.risk.stop_loss_pct;
    const tpPct = config.risk.take_profit_pct;

    return this.withTradeLock(async () => {
      let qtyBaseUnits: string;
      let tradeId: number | null;

      if (mode === 'paper') {
        const fill = this.broker.buy({
          spendBaseUnits: amountBaseUnits,
          inputMint: base.mint,
          inputDecimals: base.decimals,
          inputPriceUsd: basePriceUsd,
          outputMint: mint,
          outputDecimals: decimals,
          priceUsd,
        });
        if (BigInt(fill.outAmount) <= 0n) return null;
        qtyBaseUnits = fill.outAmount;
        this.addVirtualCash(-spendUsd);
        tradeId = insertTrade(db, {
          mode: 'paper',
          status: 'success',
          signature: null,
          requestId: null,
          inputMint: base.mint,
          outputMint: mint,
          inAmount: amountBaseUnits,
          expectedOutAmount: fill.outAmount,
          outAmount: fill.outAmount,
          router: null,
          feeBps: fill.feeBps,
          feeMint: base.mint,
          priceImpact: null,
          slippageBps: fill.slippageBps,
          realizedSlippageBps: null,
          errorCode: null,
          errorMessage: null,
          createdAt: this.now(),
          strategy: item.strategy,
          trigger: 'entry',
        });
      } else {
        const outcome = await this.deps.executor!.swap(
          { inputMint: base.mint, outputMint: mint, amountBaseUnits: BigInt(amountBaseUnits) },
          mode,
        );
        tradeId = outcome.tradeId;
        if (outcome.status !== 'success' && outcome.status !== 'simulated') {
          this.log(`entrée ${item.signal.symbol} échouée (${outcome.failure?.label ?? 'inconnu'})`);
          return null;
        }
        if (mode === 'dry_run' && outcome.simulation?.err != null) {
          this.log(`entrée ${item.signal.symbol} : simulation RPC en erreur — non remplie`);
          return null;
        }
        const picked = pickOutputAmount(outcome);
        if (picked === null || BigInt(picked) <= 0n) {
          this.log(`entrée ${item.signal.symbol} : montant de sortie indisponible`);
          return null;
        }
        qtyBaseUnits = picked;
        if (mode === 'dry_run') this.addVirtualCash(-spendUsd);
        if (mode === 'live') this.tickCashDeltaUsd -= spendUsd;
      }

      if (tradeId !== null && mode !== 'paper') {
        annotateTrade(db, tradeId, { strategy: item.strategy, trigger: 'entry' });
      }

      const qtyFloat = qtyToFloat(qtyBaseUnits, decimals);
      const entryPriceUsd = spendUsd / qtyFloat;
      openPosition(db, {
        mint,
        symbol: item.signal.symbol,
        decimals,
        qty: qtyBaseUnits,
        priceUsd: entryPriceUsd,
        ts: this.now(),
        stopLossPriceUsd: entryPriceUsd * (1 - stopPct / 100),
        takeProfitPriceUsd: entryPriceUsd * (1 + tpPct / 100),
      });
      insertEvent(db, {
        level: 'info',
        kind: 'trade_open',
        message: `entrée ${item.signal.symbol} ${spendUsd.toFixed(2)} $ (${item.strategy}, stop ${stopPct.toFixed(1)} %)`,
        details: { mint, qty: qtyBaseUnits, entryPriceUsd, mode },
        ts: this.now(),
      });
      return `achat ${item.signal.symbol} ${spendUsd.toFixed(2)} $ → ${qtyFloat.toPrecision(6)} (${item.strategy})`;
    });
  }

  private async executeExit(
    position: PositionRow,
    trigger: string,
    strategy: string,
    priceUsd: number,
    basePriceUsd: number,
  ): Promise<string | null> {
    const { db, mode } = this.deps;
    const base = this.base();
    const qtyBaseUnits = position.qtyRemaining;
    const qtyFloat = qtyToFloat(qtyBaseUnits, position.decimals);
    if (qtyFloat <= 0) return null;

    return this.withTradeLock(async () => {
      let proceedsUsd: number;
      let tradeId: number | null;

      if (mode === 'paper') {
        const fill = this.broker.sell({
          qtyBaseUnits,
          tokenMint: position.mint,
          tokenDecimals: position.decimals,
          outputMint: base.mint,
          outputDecimals: base.decimals,
          outputPriceUsd: basePriceUsd,
          priceUsd,
        });
        proceedsUsd = (Number(fill.outAmount) / 10 ** base.decimals) * basePriceUsd;
        this.addVirtualCash(proceedsUsd);
        tradeId = insertTrade(db, {
          mode: 'paper',
          status: 'success',
          signature: null,
          requestId: null,
          inputMint: position.mint,
          outputMint: base.mint,
          inAmount: qtyBaseUnits,
          expectedOutAmount: fill.outAmount,
          outAmount: fill.outAmount,
          router: null,
          feeBps: fill.feeBps,
          feeMint: base.mint,
          priceImpact: null,
          slippageBps: fill.slippageBps,
          realizedSlippageBps: null,
          errorCode: null,
          errorMessage: null,
          createdAt: this.now(),
          strategy,
          trigger,
        });
      } else {
        const outcome = await this.deps.executor!.swap(
          {
            inputMint: position.mint,
            outputMint: base.mint,
            amountBaseUnits: BigInt(qtyBaseUnits),
          },
          mode,
        );
        tradeId = outcome.tradeId;
        if (outcome.status !== 'success' && outcome.status !== 'simulated') {
          this.log(`sortie ${position.symbol} échouée (${outcome.failure?.label ?? 'inconnu'})`);
          return null;
        }
        if (mode === 'dry_run' && outcome.simulation?.err != null) {
          this.log(`sortie ${position.symbol} : simulation RPC en erreur — position conservée`);
          return null;
        }
        const received = pickOutputAmount(outcome);
        if (received === null) {
          this.log(`sortie ${position.symbol} : montant reçu indisponible`);
          return null;
        }
        proceedsUsd = (Number(received) / 10 ** base.decimals) * basePriceUsd;
        if (mode === 'dry_run') this.addVirtualCash(proceedsUsd);
        if (mode === 'live') this.tickCashDeltaUsd += proceedsUsd;
      }

      if (tradeId !== null && mode !== 'paper') {
        annotateTrade(db, tradeId, { strategy, trigger });
      }

      const sellPriceUsd = proceedsUsd / qtyFloat;
      const reduction = reducePositionFifo(db, position.id, {
        qty: qtyBaseUnits,
        sellPriceUsd,
        ts: this.now(),
      });
      insertEvent(db, {
        level: 'info',
        kind: 'trade_close',
        message: `sortie ${position.symbol} (${TRIGGER_LABELS[trigger] ?? trigger}) : PnL réalisé ${reduction.realizedPnlUsd >= 0 ? '+' : ''}${reduction.realizedPnlUsd.toFixed(2)} $`,
        details: { mint: position.mint, trigger, qty: qtyBaseUnits, sellPriceUsd, mode },
        ts: this.now(),
      });
      return `vente ${position.symbol} (${TRIGGER_LABELS[trigger] ?? trigger}) : ${proceedsUsd.toFixed(2)} $, PnL ${reduction.realizedPnlUsd >= 0 ? '+' : ''}${reduction.realizedPnlUsd.toFixed(2)} $`;
    });
  }

  /** Verrou mono-trade : un seul swap en vol, jamais deux (anti-rafale structurel). */
  private async withTradeLock<T>(task: () => Promise<T>): Promise<T> {
    if (this.tradeInFlight) {
      throw new SolbotError(
        'verrou de trade déjà pris — la boucle moteur ne doit jamais paralléliser',
      );
    }
    this.tradeInFlight = true;
    try {
      return await task();
    } finally {
      this.tradeInFlight = false;
    }
  }

  private async waitUntil(deadline: number): Promise<void> {
    while (!this.stopRequested && this.now() < deadline) {
      await sleep(Math.min(250, Math.max(1, deadline - this.now())));
    }
  }
}

/** Sélection de la quantité de sortie d'un swap (réel ou simulé). */
function pickOutputAmount(outcome: {
  order: { totalOutputAmount?: string | null | undefined; outAmount?: string | undefined };
  execute: { totalOutputAmount?: string | null | undefined } | null;
}): string | null {
  const fromExecute = outcome.execute?.totalOutputAmount;
  if (fromExecute !== undefined && fromExecute !== null && fromExecute !== '') return fromExecute;
  const fromOrder = outcome.order.totalOutputAmount ?? outcome.order.outAmount;
  return fromOrder === undefined || fromOrder === null || fromOrder === '' ? null : fromOrder;
}

const TRIGGER_LABELS: Record<string, string> = {
  entry: 'entrée',
  stop_loss: 'stop-loss',
  take_profit: 'take-profit',
  trailing_stop: 'trailing stop',
  momentum_exit: 'sortie momentum',
};

function buildAssetList(
  watchlist: Array<{ mint: string; symbol: string }>,
  positions: PositionRow[],
): Array<{ mint: string; symbol: string }> {
  const assets = new Map<string, string>();
  for (const item of watchlist) assets.set(item.mint, item.symbol);
  for (const position of positions) {
    if (!assets.has(position.mint)) assets.set(position.mint, position.symbol);
  }
  return [...assets].map(([mint, symbol]) => ({ mint, symbol }));
}

/** Clé de jour UTC (`YYYY-MM-DD`), base de l'ancre de perte journalière. */
export function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Minuit UTC suivant (fin de la pause perte journalière). */
export function nextUtcMidnight(ts: number): number {
  const date = new Date(ts);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}
