import type { DatabaseSync } from 'node:sqlite';

/**
 * Statistiques par chemin d'exécution (Phase 6b) — alimentent `solbot paths`
 * et la bascule automatique (`execution.path: auto`).
 *
 * Seuls les swaps **live** comptent : un dry-run mesure la qualité des devis,
 * pas celle de l'atterrissage. Ne sont comptés comme tentatives que les swaps
 * réellement allés jusqu'à l'exécution — les échecs amont (pas de route,
 * simulation impossible, codes -9100/-9101) ne disent rien du chemin.
 */

export const KNOWN_PATHS = ['meta_aggregator', 'router'] as const;
export type KnownPath = (typeof KNOWN_PATHS)[number];

/** Frais de base du réseau par signature (lamports). */
export const BASE_FEE_LAMPORTS = 5_000;

/** Codes d'échec amont exclus des tentatives (pas de route / simulation). */
const UPSTREAM_ERROR_CODES = [-9100, -9101] as const;

export interface PathStats {
  path: string;
  /** Swaps exécutés (succès + échecs d'envoi/atterrissage). */
  attempts: number;
  successes: number;
  /** Taux de landing (0-1) — `null` si aucune tentative. */
  landingRate: number | null;
  /** Slippage réalisé moyen (bps), succès uniquement. */
  avgSlippageBps: number | null;
  /** Latence moyenne d'atterrissage (ms), succès uniquement (chemin router). */
  avgLandingMs: number | null;
  /** Tip moyen payé (lamports), succès uniquement. */
  avgTipLamports: number | null;
  /**
   * Coût moyen par swap réussi (lamports) : frais de base + frais de priorité
   * (CU × prix CU) + tip. `null` si les composants ne sont pas journalisés
   * (ex. chemin Meta-Aggregator : les frais sont inclus par Jupiter).
   */
  avgCostLamports: number | null;
}

export interface CollectPathStatsOptions {
  /** Fenêtre glissante en jours (défaut : 7). */
  windowDays?: number;
  /** Horodatage de référence (tests). */
  now?: number;
}

interface PathStatsRow {
  path: string;
  attempts: number;
  successes: number;
  avg_slippage_bps: number | null;
  avg_landing_ms: number | null;
  avg_tip_lamports: number | null;
  avg_cost_lamports: number | null;
}

/** Agrège les swaps live par chemin d'exécution sur une fenêtre glissante. */
export function collectPathStats(
  db: DatabaseSync,
  options: CollectPathStatsOptions = {},
): PathStats[] {
  const windowDays = options.windowDays ?? 7;
  const since = (options.now ?? Date.now()) - windowDays * 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT path,
              COUNT(*) AS attempts,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
              AVG(CASE WHEN status = 'success' THEN realized_slippage_bps END) AS avg_slippage_bps,
              AVG(CASE WHEN status = 'success' THEN landing_ms END) AS avg_landing_ms,
              AVG(CASE WHEN status = 'success' THEN tip_lamports END) AS avg_tip_lamports,
              AVG(CASE WHEN status = 'success' AND cu_limit IS NOT NULL THEN
                    COALESCE(tip_lamports, 0) + ${String(BASE_FEE_LAMPORTS)} +
                    CAST((COALESCE(cu_limit, 0) * COALESCE(cu_price_microlamports, 0) + 999999) / 1000000 AS INTEGER)
                  END) AS avg_cost_lamports
         FROM trades
        WHERE mode = 'live'
          AND path IS NOT NULL
          AND created_at >= ?
          AND (status = 'success'
               OR (status = 'failed'
                   AND error_code < 0
                   AND error_code NOT IN (${UPSTREAM_ERROR_CODES.join(', ')})))
        GROUP BY path
        ORDER BY path`,
    )
    .all(since) as unknown as PathStatsRow[];
  return rows.map((row) => {
    const attempts = Number(row.attempts);
    const successes = Number(row.successes);
    return {
      path: row.path,
      attempts,
      successes,
      landingRate: attempts > 0 ? successes / attempts : null,
      avgSlippageBps: row.avg_slippage_bps === null ? null : Number(row.avg_slippage_bps),
      avgLandingMs: row.avg_landing_ms === null ? null : Number(row.avg_landing_ms),
      avgTipLamports: row.avg_tip_lamports === null ? null : Number(row.avg_tip_lamports),
      avgCostLamports: row.avg_cost_lamports === null ? null : Number(row.avg_cost_lamports),
    };
  });
}

export interface PickPathOptions {
  /** Tentatives live minimales par chemin avant de comparer. */
  minSamples?: number;
  /** Écart de taux de landing exigé pour basculer (0,02 = 2 points). */
  rateMargin?: number;
}

/**
 * Décision `auto` — volontairement conservatrice :
 * 1. sans assez d'échantillons des DEUX côtés, on reste sur `meta_aggregator` ;
 * 2. le Router ne l'emporte que si son taux de landing dépasse celui du
 *    Meta-Aggregator au-delà de la marge ;
 * 3. à taux équivalents (écart ≤ marge), le coût moyen départage — mais
 *    seulement si les deux coûts sont connus (le coût Meta est aujourd'hui
 *    inclus par Jupiter et donc inconnu : on garde alors le Meta-Aggregator).
 */
export function pickPath(stats: readonly PathStats[], options: PickPathOptions = {}): KnownPath {
  const minSamples = options.minSamples ?? 20;
  const rateMargin = options.rateMargin ?? 0.02;
  const meta = stats.find((entry) => entry.path === 'meta_aggregator');
  const router = stats.find((entry) => entry.path === 'router');
  if (router === undefined || router.attempts < minSamples) return 'meta_aggregator';
  if (meta === undefined || meta.attempts < minSamples) return 'meta_aggregator';

  const routerRate = router.landingRate ?? 0;
  const metaRate = meta.landingRate ?? 0;
  if (routerRate > metaRate + rateMargin) return 'router';
  if (Math.abs(routerRate - metaRate) <= rateMargin) {
    const routerCost = router.avgCostLamports;
    const metaCost = meta.avgCostLamports;
    if (routerCost !== null && metaCost !== null && routerCost < metaCost) return 'router';
  }
  return 'meta_aggregator';
}
