import type { DatabaseSync } from 'node:sqlite';
import type { EngineMode } from '../engine/engine.js';
import { deleteState, getNumberState, getState, setState, STATE_KEYS } from '../state/bot-state.js';
import { getEquitySeries } from '../state/equity.js';
import { insertEvent } from '../state/events.js';
import { getOpenPositions, qtyToFloat } from '../state/positions.js';
import type { Config } from '../utils/config.js';
import type { TelegramCommandController } from './telegram-commands.js';

export interface ControllerDeps {
  db: DatabaseSync;
  config: Config;
  mode: EngineMode;
  stopFile: { exists: () => boolean; createIfAbsent: () => void };
  now?: () => number;
}

/** Durées lisibles (« 12 s », « 3 min », « 2 h 5 min »). */
export function humanDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  return `${Math.floor(hours / 24)} j ${hours % 24} h`;
}

function formatPrice(value: number): string {
  return value >= 1 ? value.toFixed(4) : value.toPrecision(4);
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)} $`;
}

export interface PnlSummary {
  closedTrades: number;
  realizedPnlUsd: number;
  feesUsd: number;
}

/** PnL réalisé (positions clôturées) + frais depuis `since` — partagé par `/pnl` et le rapport quotidien. */
export function computePnlSummary(db: DatabaseSync, since: number): PnlSummary {
  const closedRow = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(realized_pnl_usd), 0) AS pnl
       FROM positions WHERE status = 'closed' AND closed_at IS NOT NULL AND closed_at >= ?`,
    )
    .get(since) as unknown as { n: number; pnl: number };
  const feeRow = db
    .prepare('SELECT COALESCE(SUM(fee_usd), 0) AS fees FROM trades WHERE created_at >= ?')
    .get(since) as unknown as { fees: number };
  return { closedTrades: closedRow.n, realizedPnlUsd: closedRow.pnl, feesUsd: feeRow.fees };
}

/**
 * Contrôleur des commandes Telegram : lit l'état en base (NAV, positions,
 * PnL), écrit la pause manuelle et le kill-switch. Aucune dépendance au
 * moteur en cours → fonctionne aussi après un redémarrage.
 */
export class TelegramController implements TelegramCommandController {
  constructor(private readonly deps: ControllerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private lastEquity(): { navUsd: number; cashUsd: number; openCount: number; ts: number } | null {
    const series = getEquitySeries(this.deps.db, { mode: this.deps.mode });
    return series.at(-1) ?? null;
  }

  private isPaused(): boolean {
    return getState(this.deps.db, STATE_KEYS.manualPaused) === '1';
  }

  status(): string {
    const { db, config, mode } = this.deps;
    const ts = this.now();
    const lines = [`solbot · ${mode} · statut`];

    const lastTickTs = getNumberState(db, STATE_KEYS.lastTickTs);
    const startedAt = getNumberState(db, STATE_KEYS.engineStartedAt);
    if (lastTickTs !== null) {
      lines.push(
        `dernier tick : il y a ${humanDuration(ts - lastTickTs)}` +
          (startedAt === null ? '' : ` · moteur démarré il y a ${humanDuration(ts - startedAt)}`),
      );
    } else {
      lines.push('dernier tick : aucun (moteur pas encore passé par un cycle)');
    }

    const equity = this.lastEquity();
    lines.push(
      equity === null
        ? 'NAV : aucune courbe enregistrée'
        : `NAV ${equity.navUsd.toFixed(2)} $ · caisse ${equity.cashUsd.toFixed(2)} $ · ${getOpenPositions(db).length} position(s)`,
    );

    const strategies = Object.entries(config.strategies)
      .filter(([, strategy]) => strategy.enabled)
      .map(([name, strategy]) => `${name} ×${strategy.weight}`);
    lines.push(`stratégies : ${strategies.length > 0 ? strategies.join(', ') : 'aucune'}`);

    const flags: string[] = [];
    if (this.isPaused()) flags.push('⏸ entrées en pause (manuelle)');
    const pausedUntil = getNumberState(db, STATE_KEYS.pausedUntilMs);
    if (pausedUntil !== null && pausedUntil > ts) flags.push('⏸ pause perte journalière');
    if (this.deps.stopFile.exists()) flags.push('⛔ kill-switch actif (fichier STOP)');
    if (flags.length > 0) lines.push(flags.join(' · '));
    return lines.join('\n');
  }

  positions(): string {
    const { db } = this.deps;
    const open = getOpenPositions(db);
    if (open.length === 0) return `solbot · ${this.deps.mode} · aucune position ouverte`;
    const lines = [`solbot · ${this.deps.mode} · ${open.length} position(s) ouverte(s)`];
    const ts = this.now();
    for (const position of open) {
      const qty = qtyToFloat(position.qtyRemaining, position.decimals);
      const parts = [
        `${position.symbol} · ${qty.toPrecision(6)} · entrée ${formatPrice(position.avgEntryPriceUsd)} $`,
        `coût ${position.costBasisUsd.toFixed(2)} $`,
      ];
      if (position.stopLossPriceUsd !== null)
        parts.push(`stop ${formatPrice(position.stopLossPriceUsd)} $`);
      if (position.takeProfitPriceUsd !== null)
        parts.push(`TP ${formatPrice(position.takeProfitPriceUsd)} $`);
      if (position.peakPriceUsd !== null) parts.push(`pic ${formatPrice(position.peakPriceUsd)} $`);
      parts.push(`ouverte il y a ${humanDuration(ts - position.openedAt)}`);
      lines.push(`• ${parts.join(' · ')}`);
    }
    return lines.join('\n');
  }

  pnl(args: string[]): string {
    const { db, mode } = this.deps;
    const parsed = args[0] === undefined ? 1 : Number.parseInt(args[0], 10);
    const days = Number.isFinite(parsed) ? Math.min(365, Math.max(1, parsed)) : 1;
    const since = this.now() - days * 86_400_000;

    const pnl = computePnlSummary(db, since);
    const equity = this.lastEquity();
    const lines = [
      `solbot · ${mode} · PnL ${days} j`,
      `réalisé : ${signed(pnl.realizedPnlUsd)} sur ${pnl.closedTrades} clôture(s) · frais ${pnl.feesUsd.toFixed(2)} $`,
      equity === null
        ? 'NAV : aucune courbe enregistrée'
        : `NAV (dernier tick) : ${equity.navUsd.toFixed(2)} $ · positions ouvertes : ${equity.openCount}`,
    ];
    return lines.join('\n');
  }

  pause(): string {
    const { db } = this.deps;
    if (this.isPaused()) return '⏸ déjà en pause manuelle (/resume pour réactiver les entrées)';
    const ts = this.now();
    setState(db, STATE_KEYS.manualPaused, '1', ts);
    insertEvent(db, {
      level: 'warn',
      kind: 'manual_pause',
      message: 'entrées en pause manuelle (commande /pause) — les sorties restent actives',
      ts,
    });
    return '⏸ entrées en pause — les sorties (SL/TP/trailing) restent actives. /resume pour reprendre.';
  }

  resume(): string {
    const { db } = this.deps;
    if (!this.isPaused()) return '▶️ aucune pause manuelle active';
    const ts = this.now();
    deleteState(db, STATE_KEYS.manualPaused);
    insertEvent(db, {
      level: 'info',
      kind: 'manual_resume',
      message: 'reprise des entrées (commande /resume)',
      ts,
    });
    return '▶️ entrées réactivées.';
  }

  kill(): string {
    const { db } = this.deps;
    if (this.deps.stopFile.exists()) {
      return '⛔ kill-switch déjà actif (fichier STOP présent). Supprimez le fichier STOP pour réarmer.';
    }
    const ts = this.now();
    this.deps.stopFile.createIfAbsent();
    insertEvent(db, {
      level: 'warn',
      kind: 'kill_switch',
      message: 'kill-switch activé (commande /kill) — fichier STOP créé, entrées coupées',
      ts,
    });
    return '⛔ kill-switch activé — fichier STOP créé : entrées coupées, sorties toujours exécutées.';
  }

  help(): string {
    return [
      'solbot · commandes',
      '/status — état du moteur (NAV, dernier tick, pauses, kill-switch)',
      '/positions — positions ouvertes (entrée, stop, TP, pic)',
      '/pnl [jours] — PnL réalisé et frais (défaut : 1 j)',
      '/pause — suspend les entrées (les sorties restent actives)',
      '/resume — réactive les entrées',
      '/kill — active le kill-switch (fichier STOP)',
      '/help — cette aide',
    ].join('\n');
  }
}
