import type { DatabaseSync } from 'node:sqlite';
import { SOL_MINT, USDC_MINT } from '../constants.js';
import type { Executor } from '../execution/executor.js';
import { PaperBroker, toBaseUnitsFloor, type PaperCosts } from '../execution/paper-broker.js';
import { TIMEFRAMES, type Timeframe } from '../market/ohlcv.js';
import type { PollSummary } from '../market/poller.js';
import { Portfolio, type PortfolioSnapshot } from '../portfolio/portfolio.js';
import { MIN_NOTIONAL_USD, RiskManager, type RiskContext } from '../risk/risk-manager.js';
import { insertArbitration, type ArbitrationCandidate } from '../state/arbitrations.js';
import {
  deleteState,
  getNumberState,
  getState,
  setNumberState,
  setState,
  STATE_KEYS,
} from '../state/bot-state.js';
import { insertEquityPoint } from '../state/equity.js';
import { insertEvent } from '../state/events.js';
import { getCandles, type Candle } from '../state/market-data.js';
import {
  openPosition,
  reducePositionFifo,
  updatePositionMarks,
  markPartialTakeProfit,
  qtyToFloat,
  type PositionRow,
} from '../state/positions.js';
import { insertSignal, markSignalActed } from '../state/signals.js';
import { insertTrade, annotateTrade, lastTradeTsForMint } from '../state/trades.js';
import { getWatchlist } from '../state/watchlist.js';
import { rankSignals, type RankedGroup } from '../strategy/arbitration.js';
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
  /** Coûts paper (défaut : bloc `paper` de la config) — surchargés par le backtest. */
  costs?: PaperCosts;
  /** Source d'historique des bougies (défaut : base locale) — rejeu du backtest. */
  getCandles?: (mint: string, timeframe: Timeframe, limit: number) => Candle[];
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
  /** Pause manuelle des entrées (`/pause`) — les sorties restent actives. */
  manualPaused: boolean;
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
  /** Erreur d'un tick (le moteur retente tant que < MAX_CONSECUTIVE_ERRORS). */
  onError?: (info: { consecutive: number; message: string }) => void;
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
  private readonly paperCosts: PaperCosts;
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
    const paper = deps.config.paper;
    this.paperCosts = deps.costs ?? {
      fillSlippageBps: paper.fill_slippage_bps,
      impactK: paper.impact_k,
      priorityFeeSol: paper.priority_fee_sol,
      feeBpsOverride: paper.fee_bps_override,
    };
    this.broker = new PaperBroker(this.paperCosts);
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
        options.onError?.({ consecutive: consecutiveErrors, message });
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

    // Pause manuelle (`/pause` Telegram) : persistée en base, sorties actives.
    const manualPaused = getState(db, STATE_KEYS.manualPaused) === '1';
    const entriesPaused = manualPaused || (pausedUntilMs !== null && pausedUntilMs > ts);

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
    const market = this.buildMarket(assetList, poll, ts, snapshot);
    const produced = this.evaluateStrategies(market);

    const actionableSells: ProducedSignal[] = [];
    const actionableBuys: ProducedSignal[] = [];
    for (const item of produced) {
      const { signal } = item;
      if (signal.side === 'sell') {
        if (heldMints.has(signal.assetMint)) actionableSells.push(item);
      } else {
        if (signal.assetMint === base.mint) continue;
        const tradable = watchlistMints.has(signal.assetMint) || signal.assetMint === SOL_MINT;
        if (!tradable) continue;
        // Ajout à une position existante : uniquement si la stratégie l'autorise
        // explicitement (grille, DCA) — jamais d'empilement silencieux.
        if (heldMints.has(signal.assetMint) && signal.allowAdd !== true) continue;
        actionableBuys.push(item);
      }
    }
    for (const item of [...actionableSells, ...actionableBuys]) {
      item.id = this.recordSignal(item, ts);
    }

    // ── 4b. Arbitrage inter-stratégies (score = confiance × poids × edge) ──
    const sellGroups = rankSignals(
      actionableSells.map((item) => ({
        strategy: item.strategy,
        weight: this.deps.weights.get(item.strategy) ?? 1,
        signal: item.signal,
      })),
    );
    const buyGroups = rankSignals(
      actionableBuys.map((item) => ({
        strategy: item.strategy,
        weight: this.deps.weights.get(item.strategy) ?? 1,
        signal: item.signal,
      })),
    );
    const winnerOf = (items: ProducedSignal[], group: RankedGroup): ProducedSignal | undefined =>
      items.find((item) => item.signal === group.candidates[0]?.signal);
    const sellByMint = new Map<string, { winner: ProducedSignal; group: RankedGroup }>();
    for (const group of sellGroups) {
      const winner = winnerOf(actionableSells, group);
      if (winner !== undefined) sellByMint.set(group.mint, { winner, group });
    }
    /** Journalise la décision d'arbitrage d'un groupe (gagnant + écartés). */
    const journalGroup = (group: RankedGroup, reason: string, chosen: boolean): void => {
      const top = group.candidates[0];
      const candidates: ArbitrationCandidate[] = group.candidates.map((candidate, index) => ({
        strategy: candidate.strategy,
        confidence: candidate.signal.confidence,
        edgeBps: candidate.signal.edgeEstimateBps ?? null,
        weight: candidate.weight,
        score: candidate.score,
        chosen: chosen && index === 0,
        reason: chosen
          ? index === 0
            ? 'best_score'
            : 'lower_score'
          : index === 0
            ? reason
            : 'lower_score',
      }));
      insertArbitration(db, {
        ts,
        mint: group.mint,
        symbol: group.symbol,
        side: group.side,
        chosenStrategy: chosen ? (top?.strategy ?? null) : null,
        chosenScore: chosen ? (top?.score ?? null) : null,
        candidates,
        reason,
      });
    };

    // ── 5. Sorties : la garde de sortie a priorité sur toute entrée ────────
    const exits: string[] = [];
    const rejections: string[] = [];

    for (const { group } of sellByMint.values()) {
      journalGroup(group, 'best_score', true);
    }

    for (const position of startPositions) {
      const price = prices.get(position.mint) ?? null;
      if (price === null || !(price > 0)) continue;
      if (basePriceUsd === null) {
        this.log(`sortie ${position.symbol} reportée : prix ${base.symbol} indisponible`);
        continue;
      }
      const arbitrated = sellByMint.get(position.mint);
      const plan = this.exitPlan(position, price, arbitrated?.winner, ts);
      if (plan === null) continue;

      const decision = this.risk.checkExit(
        {
          mint: position.mint,
          symbol: position.symbol,
          strategy: plan.strategy,
          trigger: plan.trigger,
          qtyBaseUnits: plan.qtyBaseUnits,
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
      const info = poll.prices.get(position.mint);
      const line = await this.executeExit(
        position,
        plan.trigger,
        plan.strategy,
        price,
        basePriceUsd,
        plan.qtyBaseUnits,
        info?.liquidityUsd ?? null,
        solPriceUsd,
      );
      if (line !== null) {
        if (plan.partialTakeProfit === true) {
          markPartialTakeProfit(db, position.id, this.now());
        }
        exits.push(line);
      }
    }

    // ── 6. Entrées : arbitrage puis contrôles de risque ────────────────────
    const entries: string[] = [];
    if (killSwitch || entriesPaused) {
      if (buyGroups.length > 0) {
        rejections.push(
          killSwitch
            ? `entrées coupées (kill-switch actif) : ${buyGroups.length} signal(aux) ignoré(s)`
            : manualPaused
              ? `entrées en pause manuelle : ${buyGroups.length} signal(aux) ignoré(s)`
              : `entrées en pause (perte journalière) : ${buyGroups.length} signal(aux) ignoré(s)`,
        );
        for (const group of buyGroups) {
          journalGroup(
            group,
            killSwitch ? 'kill_switch' : manualPaused ? 'manual_pause' : 'daily_loss_pause',
            false,
          );
        }
      }
    } else {
      const chosen: RankedGroup[] = [];
      for (const group of buyGroups) {
        if (sellByMint.has(group.mint)) {
          // Conflit achat/vente sur un même actif : la sortie prime (README section 8).
          journalGroup(group, 'exit_priority', false);
          continue;
        }
        if (chosen.length >= config.engine.max_entries_per_tick) {
          journalGroup(group, 'cap_reached', false);
          continue;
        }
        journalGroup(group, 'best_score', true);
        chosen.push(group);
      }

      const lastTradeTsByMint = new Map<string, number>();
      for (const group of chosen) {
        const lastTs = lastTradeTsForMint(db, group.mint);
        if (lastTs !== null) lastTradeTsByMint.set(group.mint, lastTs);
      }

      for (const group of chosen) {
        const item = winnerOf(actionableBuys, group);
        if (item === undefined) continue;
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
        // Plafond suggéré par la stratégie (DCA/grille) : borné par le risque.
        let sizeUsd = decision.sizeUsd;
        const hint = item.signal.suggestedSizeUsd;
        if (hint !== undefined) {
          sizeUsd = Math.min(sizeUsd, hint);
          if (sizeUsd < MIN_NOTIONAL_USD) {
            this.log(
              `entrée ${item.signal.symbol} ignorée : plafond stratégie ${hint.toFixed(2)} $ sous le minimum`,
            );
            continue;
          }
        }
        const line = await this.executeEntry(item, sizeUsd, price, poll, solPriceUsd);
        if (line !== null) entries.push(line);
      }
    }

    // La valeur du tick est recalculée après les trades : NAV, caisse et
    // positions reflètent l'état en fin de cycle (le risque, lui, a contrôlé
    // sur le snapshot d'entrée de tick).
    const finalCashUsd =
      mode === 'live' ? Math.max(0, cashUsd + this.tickCashDeltaUsd) : this.virtualCash();
    const finalTs = this.now();
    const finalSnapshot = this.portfolio.snapshot({ cashUsd: finalCashUsd, prices, ts: finalTs });
    insertEquityPoint(db, {
      mode,
      ts: finalTs,
      navUsd: finalSnapshot.navUsd,
      cashUsd: finalCashUsd,
      positionsValueUsd: finalSnapshot.positionsValueUsd,
      openCount: finalSnapshot.openCount,
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
      manualPaused,
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

  /** Priority fee modélisé (USD) d'un swap, converti depuis SOL. */
  private tradeFlatFeeUsd(solPriceUsd: number | null): number {
    const feeSol = this.paperCosts.priorityFeeSol;
    if (!(feeSol > 0) || solPriceUsd === null || !(solPriceUsd > 0)) return 0;
    return feeSol * solPriceUsd;
  }

  /** Historique des bougies : base locale par défaut, source injectée en backtest. */
  private candleHistory(mint: string, timeframe: Timeframe, limit: number): Candle[] {
    if (this.deps.getCandles !== undefined) return this.deps.getCandles(mint, timeframe, limit);
    return getCandles(this.deps.db, mint, timeframe, limit);
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
    snapshot: PortfolioSnapshot,
  ): MarketSnapshot {
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
        candles[timeframe] = this.candleHistory(asset.mint, timeframe, limit);
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
    const portfolio = {
      navUsd: snapshot.navUsd,
      cashUsd: snapshot.cashUsd,
      valueByMint: new Map(snapshot.positions.map((view) => [view.mint, view.valueUsd])),
      positionsByMint: new Map(
        snapshot.positions.map((view) => [
          view.mint,
          {
            qtyRemaining: view.qtyRemaining,
            decimals: view.decimals,
            avgEntryPriceUsd: view.avgEntryPriceUsd,
          },
        ]),
      ),
    };
    return { ts, assets: snapshots, portfolio };
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
    arbitrated: ProducedSignal | undefined,
    ts: number,
  ): {
    trigger: string;
    strategy: string;
    signalId?: number;
    qtyBaseUnits: string;
    /** true → marquer le TP partiel comme exécuté après la vente. */
    partialTakeProfit?: boolean;
  } | null {
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
      return {
        trigger: trailing ? 'trailing_stop' : 'stop_loss',
        strategy: 'risk',
        qtyBaseUnits: position.qtyRemaining,
      };
    }
    if (position.takeProfitPriceUsd !== null && price >= position.takeProfitPriceUsd) {
      return { trigger: 'take_profit', strategy: 'risk', qtyBaseUnits: position.qtyRemaining };
    }
    const partial = config.risk.partial_take_profit;
    if (partial.enabled && !position.partialTpTaken) {
      const partialLevel = entry * (1 + partial.pct / 100);
      if (price >= partialLevel) {
        return {
          trigger: 'partial_take_profit',
          strategy: 'risk',
          qtyBaseUnits: sellQuantity(position, partial.fraction),
          partialTakeProfit: true,
        };
      }
    }
    if (arbitrated !== undefined) {
      return {
        trigger: `${arbitrated.strategy}_exit`,
        strategy: arbitrated.strategy,
        ...(arbitrated.id === undefined ? {} : { signalId: arbitrated.id }),
        qtyBaseUnits: sellQuantity(position, arbitrated.signal.sellPortion),
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
          liquidityUsd: info.liquidityUsd,
          flatFeeUsd: this.tradeFlatFeeUsd(solPriceUsd),
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
          feeUsd: fill.feeUsd + fill.flatFeeUsd,
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
        mode,
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
    qtyBaseUnits: string,
    liquidityUsd: number | null,
    solPriceUsd: number | null,
  ): Promise<string | null> {
    const { db, mode } = this.deps;
    const base = this.base();
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
          liquidityUsd,
          flatFeeUsd: this.tradeFlatFeeUsd(solPriceUsd),
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
          feeUsd: fill.feeUsd + fill.flatFeeUsd,
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

/** Quantité d'une sortie partielle : portion de la position restante (≥ 1 unité). */
function sellQuantity(position: PositionRow, portion: number | undefined): string {
  if (portion === undefined || portion >= 1) return position.qtyRemaining;
  const remaining = BigInt(position.qtyRemaining);
  const raw = BigInt(Math.floor(Number(remaining) * Math.min(1, Math.max(0.01, portion))));
  const qty = raw < 1n ? 1n : raw > remaining ? remaining : raw;
  return qty.toString();
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
  partial_take_profit: 'prise de profit partielle',
  trailing_stop: 'trailing stop',
  momentum_exit: 'sortie momentum',
  mean_reversion_exit: 'sortie mean-reversion',
  dca_rotation_exit: 'allègement rotation',
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
