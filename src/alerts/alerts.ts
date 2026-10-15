import type { DatabaseSync } from 'node:sqlite';
import type { EngineMode } from '../engine/engine.js';
import { getNumberState, setNumberState, STATE_KEYS } from '../state/bot-state.js';
import type { Config } from '../utils/config.js';

/** Règles d'alerte (une par cause, cooldown indépendant). */
export type AlertRule = 'sol_reserve' | 'tick_errors' | 'execute_failures' | 'reconcile_divergence';

export const ALERT_LABELS: Record<AlertRule, string> = {
  sol_reserve: 'réserve de gaz SOL',
  tick_errors: 'RPC / marché en échec',
  execute_failures: 'taux d’échec d’exécution',
  reconcile_divergence: 'divergence de réconciliation',
};

export interface AlertTickContext {
  ts: number;
  mode: EngineMode;
  /** Solde SOL natif (live uniquement ; `null` sinon). */
  solBalanceSol: number | null;
  /** Erreurs de tick consécutives du cycle courant. */
  consecutiveErrors: number;
}

export interface AlertEngineDeps {
  db: DatabaseSync;
  config: Config;
  /** Émission effective (Telegram) — best effort, jamais bloquant. */
  emit: (rule: AlertRule, message: string) => void;
  /** Observabilité (compteur de métriques). */
  onMetrics?: (rule: AlertRule) => void;
  now?: () => number;
}

/**
 * Moteur d'alerting (Phase 5) : règles évaluées à chaque tick — réserve de gaz
 * SOL, RPC/marché en échec, taux d'échec d'exécution, divergence de
 * réconciliation. Anti-spam par règle (`alerts.cooldown_min`), horodaté en base
 * (`alert_last_<règle>`) pour survivre aux redémarrages.
 */
export class AlertEngine {
  constructor(private readonly deps: AlertEngineDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Évalue les règles liées au tick ; retourne celles déclenchées. */
  evaluateTick(ctx: AlertTickContext): AlertRule[] {
    const fired: AlertRule[] = [];
    const { config } = this.deps;
    if (!config.alerts.enabled) return fired;

    if (ctx.consecutiveErrors >= config.alerts.tick_error_threshold) {
      const message =
        `RPC/marché en échec : ${ctx.consecutiveErrors} erreur(s) de tick consécutive(s) ` +
        '(le moteur retente ; arrêt automatique après 5).';
      if (this.raise('tick_errors', message, ctx.ts)) fired.push('tick_errors');
    }

    if (
      ctx.mode === 'live' &&
      ctx.solBalanceSol !== null &&
      ctx.solBalanceSol < config.risk.sol_gas_reserve
    ) {
      const message =
        `réserve de gaz épuisée : ${ctx.solBalanceSol.toFixed(4)} SOL < ` +
        `${config.risk.sol_gas_reserve} SOL — les entrées seront refusées par le risque.`;
      if (this.raise('sol_reserve', message, ctx.ts)) fired.push('sol_reserve');
    }

    const failure = this.executeFailureRate(ctx.ts);
    if (
      failure !== null &&
      failure.total >= config.alerts.execute_failure_min_trades &&
      failure.ratePct >= config.alerts.execute_failure_rate_pct
    ) {
      const message =
        `${failure.ratePct.toFixed(0)} % d'échecs d'exécution ` +
        `(${failure.failed}/${failure.total} trades sur ${config.alerts.execute_failure_window_min} min).`;
      if (this.raise('execute_failures', message, ctx.ts)) fired.push('execute_failures');
    }

    return fired;
  }

  /** Émet une alerte ponctuelle (ex. divergence de réconciliation). */
  raise(rule: AlertRule, message: string, ts = this.now()): boolean {
    const { config, db } = this.deps;
    if (!config.alerts.enabled) return false;
    const cooldownMs = config.alerts.cooldown_min * 60_000;
    const last = getNumberState(db, STATE_KEYS.alertLastPrefix + rule);
    if (last !== null && ts - last < cooldownMs) return false;
    setNumberState(db, STATE_KEYS.alertLastPrefix + rule, ts, ts);
    this.deps.onMetrics?.(rule);
    this.deps.emit(rule, message);
    return true;
  }

  /** Taux d'échec d'exécution sur la fenêtre configurée (`trades.status = failed`). */
  private executeFailureRate(
    ts: number,
  ): { failed: number; total: number; ratePct: number } | null {
    const since = ts - this.deps.config.alerts.execute_failure_window_min * 60_000;
    const row = this.deps.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM trades WHERE created_at >= ?`,
      )
      .get(since) as unknown as { total: number; failed: number | null };
    if (row.total === 0) return null;
    const failed = row.failed ?? 0;
    return { failed, total: row.total, ratePct: (failed / row.total) * 100 };
  }
}
