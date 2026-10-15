import type { DatabaseSync } from 'node:sqlite';
import { AlertEngine, ALERT_LABELS } from '../alerts/alerts.js';
import type { EngineMode, TickResult } from '../engine/engine.js';
import { utcDayKey } from '../engine/engine.js';
import { getNumberState, getState, setState, STATE_KEYS } from '../state/bot-state.js';
import { createBackup, resolveBackupDir } from '../state/backup.js';
import { insertEvent } from '../state/events.js';
import { computePnlSummary, TelegramController } from '../notifications/controller.js';
import {
  formatAlertMessage,
  formatBackupMessage,
  formatDailyReportMessage,
  formatTickErrorMessage,
  formatTradeMessage,
  Notifier,
} from '../notifications/notifier.js';
import {
  TelegramCommandPoller,
  type TelegramCommandController,
} from '../notifications/telegram-commands.js';
import type { TelegramSendResult } from '../notifications/telegram.js';
import { METRIC_HELP, METRICS, MetricsRegistry } from './metrics.js';
import { startMonitoringServer, type HealthSnapshot, type MonitoringServer } from './server.js';
import type { Config, Env } from '../utils/config.js';
import { messageOf } from '../utils/errors.js';

/** Erreur d'un tick, propagée par le moteur pour l'alerting. */
export interface TickErrorInfo {
  consecutive: number;
  message: string;
}

export interface ReconcileSummary {
  adopted: number;
  adjusted: number;
  closed: number;
}

export interface SupervisorOptions {
  root: string;
  db: DatabaseSync;
  config: Config;
  mode: EngineMode;
  env: Env;
  version: string;
  stopFile: { exists: () => boolean; createIfAbsent: () => void };
  /** Le moteur est-il en cours d'arrêt (pour /healthz) ? */
  stopRequested: () => boolean;
  intervalS: number;
  onLog?: (line: string) => void;
  /** Injection de test : envoi Telegram. */
  send?: (input: { token: string; chatId: string; text: string }) => Promise<TelegramSendResult>;
  /** Injection de test : client HTTP (long polling des commandes). */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Superviseur de production (Phase 5) : un objet, quatre rôles —
 * observabilité (métriques + `/healthz`), notifications Telegram (trades,
 * erreurs, rapport quotidien, alertes), commandes entrantes (`/status`,
 * `/pause`, `/kill`…) et maintenance (backup SQLite quotidien, rotation).
 * Toutes les actions sont best effort : une panne de supervision ne doit
 * jamais arrêter le moteur.
 */
export class Supervisor {
  readonly registry = new MetricsRegistry();
  readonly notifier: Notifier;
  private readonly alerts: AlertEngine;
  private server: MonitoringServer | null = null;
  private poller: TelegramCommandPoller | null = null;

  private readonly startedAt: number;
  private ticks = 0;
  private lastTickTs: number | null = null;
  private lastNavUsd: number | null = null;
  private lastOpenCount = 0;
  private lastBackupTs: number | null = null;
  private consecutiveErrors = 0;
  private solBalanceSol: number | null = null;

  constructor(private readonly options: SupervisorOptions) {
    const { config, env } = options;
    this.startedAt = this.now();
    this.notifier = new Notifier({
      enabled: config.notifications.telegram.enabled,
      token: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
      notifyOn: config.notifications.telegram.notify_on,
      ...(options.send === undefined ? {} : { send: options.send }),
      onResult: (kind, result) => {
        this.registry.inc(METRICS.notificationsTotal, METRIC_HELP.notificationsTotal, {
          kind,
          status: result.ok ? 'ok' : 'failed',
        });
      },
      onLog: (line) => this.log(line),
    });
    this.alerts = new AlertEngine({
      db: options.db,
      config,
      emit: (rule, message) => {
        void this.notifier.notify('alert', formatAlertMessage(ALERT_LABELS[rule], message));
      },
      onMetrics: (rule) => {
        this.registry.inc(METRICS.alertsTotal, METRIC_HELP.alertsTotal, { rule });
      },
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private log(line: string): void {
    this.options.onLog?.(line);
  }

  /** Démarre le serveur de supervision et l'écoute des commandes Telegram. */
  async start(): Promise<{ monitoringUrl: string | null; telegramCommands: boolean }> {
    const { config } = this.options;
    if (config.monitoring.enabled) {
      this.server = await startMonitoringServer({
        host: config.monitoring.host,
        port: config.monitoring.port,
        registry: this.registry,
        health: () => this.health(),
        staleAfterS: Math.max(120, this.options.intervalS * 3),
        now: () => this.now(),
      });
    }

    const commandsEnabled =
      this.notifier.configured && config.notifications.telegram.commands_enabled;
    if (commandsEnabled) {
      const token = this.options.env.TELEGRAM_BOT_TOKEN;
      const chatId = this.options.env.TELEGRAM_CHAT_ID;
      if (token !== undefined && chatId !== undefined) {
        const controller: TelegramCommandController = new TelegramController({
          db: this.options.db,
          config,
          mode: this.options.mode,
          stopFile: this.options.stopFile,
          now: () => this.now(),
        });
        this.poller = new TelegramCommandPoller({
          token,
          chatId,
          controller,
          ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
          ...(this.options.send === undefined ? {} : { send: this.options.send }),
          onError: (message) => this.log(`commandes Telegram : ${message}`),
          onLog: (line) => this.log(line),
        });
        this.poller.start();
      }
    }

    return { monitoringUrl: this.server?.url ?? null, telegramCommands: this.poller !== null };
  }

  /** À chaque tick réussi : métriques, notifications de trade, alertes, maintenance. */
  onTick(result: TickResult): void {
    const { mode } = this.options;
    const ts = this.now();
    this.ticks += 1;
    this.consecutiveErrors = 0;
    this.lastTickTs = result.ts;
    this.lastNavUsd = result.navUsd;
    this.lastOpenCount = result.openCount;

    this.registry.inc(METRICS.ticksTotal, METRIC_HELP.ticksTotal);
    if (result.entries.length > 0) {
      this.registry.inc(METRICS.entriesTotal, METRIC_HELP.entriesTotal, {}, result.entries.length);
    }
    if (result.exits.length > 0) {
      this.registry.inc(METRICS.exitsTotal, METRIC_HELP.exitsTotal, {}, result.exits.length);
    }
    this.registry.set(METRICS.navUsd, METRIC_HELP.navUsd, result.navUsd, { mode });
    this.registry.set(METRICS.cashUsd, METRIC_HELP.cashUsd, result.cashUsd, { mode });
    this.registry.set(METRICS.positionsOpen, METRIC_HELP.positionsOpen, result.openCount);
    this.registry.set(METRICS.drawdownPct, METRIC_HELP.drawdownPct, result.drawdownPct);
    this.registry.set(METRICS.dailyLossPct, METRIC_HELP.dailyLossPct, result.dailyLossPct);
    this.registry.set(METRICS.readyAssets, METRIC_HELP.readyAssets, result.readyAssets);

    const tradeMessage = formatTradeMessage(mode, result.entries, result.exits);
    if (tradeMessage !== null) void this.notifier.notify('trade', tradeMessage);

    this.evaluateAlerts(ts, 0);
    this.maybeDailyReport(result, ts);
    this.maybeBackup(ts);
  }

  /** Erreur de tick : métriques + notification + alerting. */
  onTickError(info: TickErrorInfo): void {
    this.registry.inc(METRICS.tickErrorsTotal, METRIC_HELP.tickErrorsTotal);
    void this.notifier.notify(
      'error',
      formatTickErrorMessage(this.options.mode, info.consecutive, 5, info.message),
    );
    this.evaluateAlerts(this.now(), info.consecutive);
  }

  /** Divergence détectée à la réconciliation de démarrage (live). */
  onReconcile(summary: ReconcileSummary): void {
    const actions = summary.adopted + summary.adjusted + summary.closed;
    if (actions === 0) return;
    this.alerts.raise(
      'reconcile_divergence',
      `${summary.adopted} adoptée(s), ${summary.adjusted} ajustée(s), ${summary.closed} clôturée(s) — vérifiez le journal (table events).`,
      this.now(),
    );
  }

  /** Solde SOL natif observé par le moteur (live) — règle « réserve de gaz ». */
  noteSolBalance(solBalanceSol: number): void {
    this.solBalanceSol = solBalanceSol;
  }

  health(): HealthSnapshot {
    const { db } = this.options;
    let dbOk = true;
    try {
      db.prepare('SELECT 1').get();
    } catch {
      dbOk = false;
    }
    return {
      mode: this.options.mode,
      version: this.options.version,
      startedAt: this.startedAt,
      ticks: this.ticks,
      lastTickTs: this.lastTickTs,
      navUsd: this.lastNavUsd,
      openCount: this.lastOpenCount,
      manualPaused: getState(db, STATE_KEYS.manualPaused) === '1',
      stopRequested: this.options.stopRequested(),
      lastBackupTs: this.lastBackupTs,
      dbOk,
    };
  }

  async stop(): Promise<void> {
    await this.poller?.stop();
    await this.server?.close();
  }

  private evaluateAlerts(ts: number, consecutiveErrors: number): void {
    this.alerts.evaluateTick({
      ts,
      mode: this.options.mode,
      solBalanceSol: this.solBalanceSol,
      consecutiveErrors,
    });
  }

  /** Rapport PnL quotidien, une fois par jour UTC après l'heure configurée. */
  private maybeDailyReport(result: TickResult, ts: number): void {
    const { db, config, mode } = this.options;
    if (!this.notifier.active || !this.notifier.allows('daily_report')) return;
    const dayKey = utcDayKey(ts);
    if (getState(db, STATE_KEYS.lastDailyReportDay) === dayKey) return;
    const hour = new Date(ts).getUTCHours();
    if (hour < config.notifications.telegram.daily_report_utc_hour) return;

    const pnl = computePnlSummary(db, ts - 86_400_000);
    setState(db, STATE_KEYS.lastDailyReportDay, dayKey, ts);
    const manualPaused = getState(db, STATE_KEYS.manualPaused) === '1';
    const pausedUntil = getNumberState(db, STATE_KEYS.pausedUntilMs);
    void this.notifier.notify(
      'daily_report',
      formatDailyReportMessage({
        mode,
        dayKey,
        navUsd: result.navUsd,
        netPnlUsd: pnl.realizedPnlUsd,
        closedTrades: pnl.closedTrades,
        feesUsd: pnl.feesUsd,
        openCount: result.openCount,
        paused: manualPaused || (pausedUntil !== null && pausedUntil > ts),
        killSwitch: result.killSwitch,
      }),
    );
    insertEvent(db, {
      level: 'info',
      kind: 'daily_report',
      message: `rapport quotidien envoyé (${dayKey}) : PnL réalisé 24 h ${pnl.realizedPnlUsd.toFixed(2)} $`,
      ts,
    });
  }

  /** Backup SQLite automatique, une fois par jour UTC après l'heure configurée. */
  private maybeBackup(ts: number): void {
    const { db, config, root } = this.options;
    if (!config.backups.enabled) return;
    const dayKey = utcDayKey(ts);
    if (getState(db, STATE_KEYS.lastBackupDay) === dayKey) return;
    const hour = new Date(ts).getUTCHours();
    if (hour < config.backups.daily_utc_hour) return;

    try {
      const dir = resolveBackupDir(root, config.backups.dir);
      const result = createBackup(db, { dir, keep: config.backups.keep, ts });
      setState(db, STATE_KEYS.lastBackupDay, dayKey, ts);
      this.lastBackupTs = result.ts;
      this.registry.inc(METRICS.backupsTotal, METRIC_HELP.backupsTotal, { status: 'ok' });
      void this.notifier.notify('backup', formatBackupMessage(result.path, result.bytes));
      insertEvent(db, {
        level: 'info',
        kind: 'backup',
        message: `sauvegarde SQLite : ${result.path}${result.pruned.length > 0 ? ` (rotation : ${result.pruned.length})` : ''}`,
        ts,
      });
    } catch (error) {
      this.registry.inc(METRICS.backupsTotal, METRIC_HELP.backupsTotal, { status: 'failed' });
      this.log(`backup automatique en échec : ${messageOf(error)}`);
      insertEvent(db, {
        level: 'error',
        kind: 'backup_error',
        message: `backup automatique en échec : ${messageOf(error)}`,
        ts,
      });
    }
  }
}
