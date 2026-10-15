import { Command } from 'commander';
import { collectPathStats, pickPath, type PathStats } from '../execution/path-stats.js';
import { openDatabase, resolveDatabasePath } from '../state/db.js';
import { runMigrations } from '../state/migrations.js';
import { loadConfig, type Config } from '../utils/config.js';
import { getProjectRoot } from '../utils/paths.js';
import { fail, ICONS, parseIntOption, printHeader } from './ui.js';

export interface PathsCliOptions {
  /** Fenêtre d'analyse en jours (défaut : `execution.auto.window_days`). */
  days?: string;
  /** Répertoire racine (défaut : racine du projet). */
  root?: string;
}

/**
 * `solbot paths` : comparaison A/B des chemins d'exécution (Phase 6b) sur les
 * swaps **live** — taux de landing, slippage moyen, latence moyenne, coût
 * moyen — et recommandation de la bascule automatique (`execution.path: auto`).
 *
 * Les swaps paper/dry-run sont exclus : ils mesurent la qualité des devis, pas
 * celle de l'atterrissage.
 */
export async function runPathsCli(options: PathsCliOptions = {}): Promise<void> {
  const root = options.root ?? getProjectRoot();
  const { config } = loadConfig({ root });
  const windowDays =
    options.days === undefined
      ? config.execution.auto.window_days
      : parseIntOption(options.days, '--days', 1, 365);

  const db = openDatabase(resolveDatabasePath(root, config.database.path));
  runMigrations(db);
  try {
    const stats = collectPathStats(db, { windowDays });
    printPathsReport(stats, windowDays, config);
  } finally {
    db.close();
  }
}

function printPathsReport(stats: readonly PathStats[], windowDays: number, config: Config): void {
  printHeader(`solbot paths — chemins d'exécution (${windowDays} derniers jours, swaps live)`);

  const rows = ['meta_aggregator', 'router'].map((path) => {
    const entry = stats.find((candidate) => candidate.path === path);
    return [
      path,
      entry === undefined ? '0' : String(entry.attempts),
      entry?.landingRate === null || entry === undefined
        ? '—'
        : `${(entry.landingRate * 100).toFixed(1)} %`,
      entry?.avgSlippageBps === null || entry === undefined
        ? '—'
        : `${Math.round(entry.avgSlippageBps)} bps`,
      entry?.avgLandingMs === null || entry === undefined
        ? '—'
        : `${Math.round(entry.avgLandingMs)} ms`,
      entry?.avgCostLamports === null || entry === undefined
        ? 'n/d'
        : `${(entry.avgCostLamports / 1e9).toFixed(6)} SOL`,
    ];
  });
  console.log(
    renderTable(
      ['Chemin', 'Swaps', 'Taux landing', 'Slippage moy.', 'Latence moy.', 'Coût moy.'],
      rows,
    ),
  );

  const totalAttempts = stats.reduce((sum, entry) => sum + entry.attempts, 0);
  if (totalAttempts === 0) {
    console.log(
      `\n  ${ICONS.warn} aucun swap live mesuré — lancez l'A/B avec « solbot swap … --live --path router » puis « --path meta_aggregator ».`,
    );
    return;
  }

  const recommended = pickPath(stats, {
    minSamples: config.execution.auto.min_samples,
    rateMargin: config.execution.auto.rate_margin,
  });
  console.log(
    `\n  ${ICONS.ok} recommandation (auto) : ${recommended} — ${recommendationReason(stats, recommended, config)}`,
  );

  if (config.execution.path === 'auto') {
    console.log(
      `  ${ICONS.ok} bascule automatique active (fenêtre ${String(config.execution.auto.window_days)} j, min. ${String(config.execution.auto.min_samples)} swaps/chemin, marge ${String(config.execution.auto.rate_margin * 100)} pts).`,
    );
  } else {
    console.log(
      `  ${ICONS.warn} chemin configuré : ${config.execution.path} — passez « execution.path: auto » pour la bascule automatique.`,
    );
  }
}

function recommendationReason(
  stats: readonly PathStats[],
  recommended: string,
  config: Config,
): string {
  const minSamples = config.execution.auto.min_samples;
  const meta = stats.find((entry) => entry.path === 'meta_aggregator');
  const router = stats.find((entry) => entry.path === 'router');
  if (recommended === 'router') return 'taux de landing supérieur au meta-aggregator';
  if (router === undefined || router.attempts < minSamples) {
    return `échantillons router insuffisants (min. ${String(minSamples)} swaps live)`;
  }
  if (meta === undefined || meta.attempts < minSamples) {
    return `échantillons meta_aggregator insuffisants (min. ${String(minSamples)} swaps live)`;
  }
  return 'meta-aggregator au moins aussi fiable (taux de landing et coût)';
}

/** Tableau texte simple : première colonne à gauche, chiffres à droite. */
function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const format = (cells: readonly string[]): string =>
    cells
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0),
      )
      .join('  ');
  return [
    `  ${format([...headers])}`,
    `  ${headers.map((_, column) => '─'.repeat(widths[column] ?? 0)).join('  ')}`,
    ...rows.map((row) => `  ${format(row)}`),
  ].join('\n');
}

export function pathsCommand(): Command {
  return new Command('paths')
    .description(
      "Compare les chemins d'exécution (taux de landing, slippage, latence, coût) — A/B Phase 6",
    )
    .option('--days <n>', 'fenêtre d’analyse en jours (défaut : execution.auto.window_days)')
    .option('--root <chemin>', 'répertoire racine (défaut : racine du projet)')
    .action(async (options: { days?: string; root?: string }) => {
      try {
        await runPathsCli({
          ...(options.days === undefined ? {} : { days: options.days }),
          ...(options.root === undefined ? {} : { root: options.root }),
        });
      } catch (error) {
        fail(error);
      }
    });
}
