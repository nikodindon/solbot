import { SOL_MINT, USDC_MINT } from '../constants.js';
import type { TokenInfo, TokensApi } from '../jupiter/tokens.js';
import type { Config } from '../utils/config.js';

export interface UniverseExclusions {
  duplicates: number;
  blacklist: number;
  whitelist: number;
  unverified: number;
  liquidity: number;
  organicScore: number;
  age: number;
}

export interface UniverseResult {
  /** Actifs de base (SOL, USDC) en tête, puis sélection triée. */
  watchlist: TokenInfo[];
  /** Nombre de candidats examinés avant filtrage. */
  candidates: number;
  source: 'category' | 'whitelist';
  exclusions: UniverseExclusions;
}

/**
 * Applique les filtres d'univers (config.yaml → `universe:`) puis trie de façon
 * déterministe : score organic ↓, liquidité ↓, symbole ↑. Tronqué à `max_watchlist`.
 */
export function filterUniverse(
  tokens: TokenInfo[],
  config: Config,
  now = Date.now(),
): { selected: TokenInfo[]; exclusions: UniverseExclusions } {
  const universe = config.universe;
  const blacklist = new Set(universe.blacklist_mints);
  const whitelist =
    universe.whitelist_mints.length > 0 ? new Set(universe.whitelist_mints) : undefined;

  const exclusions: UniverseExclusions = {
    duplicates: 0,
    blacklist: 0,
    whitelist: 0,
    unverified: 0,
    liquidity: 0,
    organicScore: 0,
    age: 0,
  };

  const seen = new Set<string>();
  const selected: TokenInfo[] = [];

  for (const token of tokens) {
    if (seen.has(token.id)) {
      exclusions.duplicates += 1;
      continue;
    }
    seen.add(token.id);

    if (blacklist.has(token.id)) {
      exclusions.blacklist += 1;
      continue;
    }
    if (whitelist !== undefined && !whitelist.has(token.id)) {
      exclusions.whitelist += 1;
      continue;
    }
    if (universe.verified_only && token.isVerified !== true) {
      exclusions.unverified += 1;
      continue;
    }
    if ((token.liquidity ?? 0) < universe.min_liquidity_usd) {
      exclusions.liquidity += 1;
      continue;
    }
    if ((token.organicScore ?? 0) < universe.min_organic_score) {
      exclusions.organicScore += 1;
      continue;
    }
    if (!meetsMinAge(token, universe.min_age_hours, now)) {
      exclusions.age += 1;
      continue;
    }

    selected.push(token);
  }

  selected.sort(compareTokens);
  return { selected: selected.slice(0, universe.max_watchlist), exclusions };
}

/** Tri stable et reproductible : organic score ↓, liquidité ↓, symbole ↑. */
export function compareTokens(a: TokenInfo, b: TokenInfo): number {
  const byOrganic = (b.organicScore ?? 0) - (a.organicScore ?? 0);
  if (byOrganic !== 0) return byOrganic;
  const byLiquidity = (b.liquidity ?? 0) - (a.liquidity ?? 0);
  if (byLiquidity !== 0) return byLiquidity;
  return a.symbol.localeCompare(b.symbol);
}

function meetsMinAge(token: TokenInfo, minAgeHours: number, now: number): boolean {
  if (minAgeHours <= 0) return true;
  const createdAt = token.firstPool?.createdAt;
  if (createdAt === undefined) return true; // pas d'info d'âge → on ne bloque pas
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return true;
  return now - created >= minAgeHours * 3_600_000;
}

/**
 * Construit l'univers effectif :
 * - si `universe.whitelist_mints` est renseigné → recherche ciblée sur ces mints ;
 * - sinon → classement Jupiter (`category`/`interval`), puis filtres locaux ;
 * - en mode catégorie, SOL et USDC sont toujours ajoutés en tête de watchlist
 *   (Jupiter les exclut des classements ; le bot en a besoin comme actifs de base).
 */
export async function resolveUniverse(
  tokensApi: TokensApi,
  config: Config,
  now = Date.now(),
): Promise<UniverseResult> {
  const universe = config.universe;
  let candidates: TokenInfo[];
  let source: 'category' | 'whitelist';

  if (universe.whitelist_mints.length > 0) {
    candidates = await tokensApi.search(universe.whitelist_mints.join(','));
    source = 'whitelist';
  } else {
    candidates = await tokensApi.byCategory(
      universe.category,
      universe.interval,
      universe.candidate_limit,
    );
    source = 'category';
  }

  const { selected, exclusions } = filterUniverse(candidates, config, now);

  const watchlist: TokenInfo[] = [];
  if (source === 'category') {
    const bases = await tokensApi.search([SOL_MINT, USDC_MINT].join(','));
    for (const base of bases) {
      if (!selected.some((token) => token.id === base.id)) watchlist.push(base);
    }
  }
  watchlist.push(...selected);

  return { watchlist, candidates: candidates.length, source, exclusions };
}
