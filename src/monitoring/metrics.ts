/**
 * Registre de métriques minimal au format Prometheus (text exposition 0.0.4).
 * Sans dépendance externe (même philosophie que le reste du projet) :
 * compteurs et jauges avec labels, rendu trié et déterministe — testable.
 */

type MetricType = 'counter' | 'gauge';

interface MetricDef {
  help: string;
  type: MetricType;
}

function labelKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((name) => `${name}=${labels[name]}`)
    .join(',');
}

function formatLabels(labels: Record<string, string>): string {
  const names = Object.keys(labels).sort();
  if (names.length === 0) return '';
  const body = names.map((name) => `${name}="${escapeLabelValue(labels[name] ?? '')}"`).join(',');
  return `{${body}}`;
}

function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? '+Inf' : value < 0 ? '-Inf' : 'NaN';
  return String(value);
}

/**
 * Les noms de métriques suivent la convention `solbot_<sujet>_<unité>`
 * (compteurs suffixés `_total`, durées/tailles suffixées `_seconds`/`_bytes`).
 */
export class MetricsRegistry {
  private readonly defs = new Map<string, MetricDef>();
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly series = new Map<string, { name: string; labels: Record<string, string> }>();

  /** Incrémente un compteur (`value` permet d'ajouter un lot). */
  inc(name: string, help: string, labels: Record<string, string> = {}, value = 1): void {
    this.define(name, 'counter', help);
    const key = `${name}|${labelKey(labels)}`;
    this.series.set(key, { name, labels });
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  /** Fixe la valeur d'une jauge. */
  set(name: string, help: string, value: number, labels: Record<string, string> = {}): void {
    this.define(name, 'gauge', help);
    const key = `${name}|${labelKey(labels)}`;
    this.series.set(key, { name, labels });
    this.gauges.set(key, value);
  }

  /** Valeur courante d'une série (tests et healthcheck). */
  value(name: string, labels: Record<string, string> = {}): number | null {
    const key = `${name}|${labelKey(labels)}`;
    return this.counters.get(key) ?? this.gauges.get(key) ?? null;
  }

  private define(name: string, type: MetricType, help: string): void {
    const existing = this.defs.get(name);
    if (existing !== undefined) {
      if (existing.type !== type) {
        throw new Error(`métrique ${name} déjà définie en ${existing.type} (utilisée en ${type})`);
      }
      return;
    }
    this.defs.set(name, { help, type });
  }

  /** Rend l'ensemble au format Prometheus (séries triées par nom puis labels). */
  render(): string {
    const lines: string[] = [];
    const names = [...this.defs.keys()].sort();
    for (const name of names) {
      const def = this.defs.get(name);
      if (def === undefined) continue;
      lines.push(`# HELP ${name} ${def.help}`);
      lines.push(`# TYPE ${name} ${def.type}`);
      const entries = [...this.series.entries()]
        .filter(([, serie]) => serie.name === name)
        .sort(([keyA], [keyB]) => (keyA < keyB ? -1 : keyA > keyB ? 1 : 0));
      for (const [key, serie] of entries) {
        const value = this.counters.get(key) ?? this.gauges.get(key);
        if (value === undefined) continue;
        lines.push(`${name}${formatLabels(serie.labels)} ${formatValue(value)}`);
      }
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }
}

/** Noms des métriques du moteur — centralisés pour éviter les fautes de frappe. */
export const METRICS = {
  ticksTotal: 'solbot_ticks_total',
  tickErrorsTotal: 'solbot_tick_errors_total',
  navUsd: 'solbot_nav_usd',
  cashUsd: 'solbot_cash_usd',
  positionsOpen: 'solbot_positions_open',
  drawdownPct: 'solbot_drawdown_pct',
  dailyLossPct: 'solbot_daily_loss_pct',
  readyAssets: 'solbot_ready_assets',
  entriesTotal: 'solbot_entries_total',
  exitsTotal: 'solbot_exits_total',
  alertsTotal: 'solbot_alerts_total',
  notificationsTotal: 'solbot_notifications_total',
  backupsTotal: 'solbot_backups_total',
  lastTickTsSeconds: 'solbot_last_tick_ts_seconds',
  uptimeSeconds: 'solbot_uptime_seconds',
} as const;

/** Helpers typés pour éviter de répéter les descriptions. */
export const METRIC_HELP: Record<keyof typeof METRICS, string> = {
  ticksTotal: 'Ticks moteur exécutés depuis le démarrage',
  tickErrorsTotal: 'Erreurs de tick depuis le démarrage',
  navUsd: 'NAV du portefeuille (USD)',
  cashUsd: 'Caisse disponible (USD)',
  positionsOpen: 'Positions ouvertes',
  drawdownPct: 'Drawdown courant (%)',
  dailyLossPct: 'Perte journalière courante (%)',
  readyAssets: 'Actifs prêts pour l’évaluation (données suffisantes)',
  entriesTotal: 'Entrées exécutées',
  exitsTotal: 'Sorties exécutées',
  alertsTotal: 'Alertes émises par règle',
  notificationsTotal: 'Notifications Telegram émises par type et statut',
  backupsTotal: 'Sauvegardes SQLite (succès/échec)',
  lastTickTsSeconds: 'Horodatage Unix (s) du dernier tick',
  uptimeSeconds: 'Uptime du processus (s)',
};
