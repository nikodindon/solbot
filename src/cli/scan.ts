import { Command } from 'commander';
import { JupiterClient } from '../jupiter/client.js';
import { TokensApi } from '../jupiter/tokens.js';
import { openDatabase, resolveDatabasePath } from '../state/db.js';
import { runMigrations } from '../state/migrations.js';
import { replaceWatchlist, toWatchlistItems } from '../state/watchlist.js';
import { resolveUniverse, type UniverseResult } from '../universe/builder.js';
import { loadConfig, parseEnv, type Config } from '../utils/config.js';
import { loadEnvFile } from '../utils/env-file.js';
import { getProjectRoot } from '../utils/paths.js';
import {
  fail,
  formatPct,
  formatPriceUsd,
  formatUsdCompact,
  ICONS,
  parseIntOption,
  printHeader,
  shorten,
} from './ui.js';

export interface ScanOptions {
  /** Taille max de la watchlist (défaut : `universe.max_watchlist`). */
  top?: number;
  /** `false` → aperçu sans écriture en base. */
  save?: boolean;
  root?: string;
}

export interface ScanOutcome {
  result: UniverseResult;
  saved: boolean;
  dbPath: string | null;
}

/** Construit l'univers (Jupiter Tokens API + filtres config) et enregistre la watchlist. */
export async function runScan(options: ScanOptions = {}): Promise<ScanOutcome> {
  const root = options.root ?? getProjectRoot();
  loadEnvFile(root);
  const env = parseEnv();
  const { config } = loadConfig({ root });

  const effective: Config =
    options.top === undefined
      ? config
      : { ...config, universe: { ...config.universe, max_watchlist: options.top } };

  const client = new JupiterClient({
    apiKey: env.JUPITER_API_KEY,
    ratePerSecond: env.JUPITER_RPS,
  });
  const tokensApi = new TokensApi(client);
  const result = await resolveUniverse(tokensApi, effective);

  let saved = false;
  let dbPath: string | null = null;
  if (options.save !== false) {
    dbPath = resolveDatabasePath(root, config.database.path);
    const db = openDatabase(dbPath);
    try {
      runMigrations(db);
      replaceWatchlist(db, toWatchlistItems(result.watchlist));
    } finally {
      db.close();
    }
    saved = true;
  }

  return { result, saved, dbPath };
}

function printScanReport(outcome: ScanOutcome): void {
  const { result } = outcome;
  const source = result.source === 'whitelist' ? 'whitelist config.yaml' : 'classement Jupiter';

  printHeader('solbot scan — univers de trading');
  console.log(
    `  ${'#'.padEnd(4)}${'Symbole'.padEnd(14)}${'Mint'.padEnd(15)}${'Prix'.padEnd(13)}${'24 h'.padEnd(11)}${'Liquidité'.padEnd(12)}Score`,
  );
  result.watchlist.forEach((token, index) => {
    const score =
      token.organicScore === null || token.organicScore === undefined
        ? '—'
        : token.organicScore.toFixed(1);
    console.log(
      `  ${String(index + 1).padEnd(4)}` +
        `${(token.symbol || '?').slice(0, 13).padEnd(14)}` +
        `${shorten(token.id, 6, 6).padEnd(15)}` +
        `${formatPriceUsd(token.usdPrice ?? null).padEnd(13)}` +
        `${formatPct(token.stats24h?.priceChange ?? null).padEnd(11)}` +
        `${formatUsdCompact(token.liquidity ?? null).padEnd(12)}` +
        `${score}`,
    );
  });

  console.log('');
  console.log(
    `  ${result.watchlist.length} actifs retenus — ${result.candidates} candidats examinés (source : ${source})`,
  );
  const excluded = describeExclusions(result);
  if (excluded !== '') console.log(`  exclus : ${excluded}`);

  if (outcome.saved) {
    console.log(`  ${ICONS.ok} watchlist enregistrée → ${outcome.dbPath}`);
  } else {
    console.log('  ℹ watchlist non enregistrée (--no-save)');
  }
}

function describeExclusions(result: UniverseResult): string {
  const e = result.exclusions;
  return [
    e.blacklist > 0 ? `blacklist ${e.blacklist}` : '',
    e.whitelist > 0 ? `hors whitelist ${e.whitelist}` : '',
    e.unverified > 0 ? `non vérifiés ${e.unverified}` : '',
    e.liquidity > 0 ? `liquidité ${e.liquidity}` : '',
    e.organicScore > 0 ? `organic score ${e.organicScore}` : '',
    e.age > 0 ? `âge ${e.age}` : '',
    e.duplicates > 0 ? `doublons ${e.duplicates}` : '',
  ]
    .filter((part) => part !== '')
    .join(' · ');
}

export function scanCommand(): Command {
  return new Command('scan')
    .description(
      "Construit l'univers de trading (filtres config.yaml) et enregistre la watchlist en base",
    )
    .option('--top <n>', 'taille max de la watchlist (défaut : universe.max_watchlist)')
    .option('--no-save', 'aperçu seulement — ne pas écrire la watchlist en base')
    .action(async (options: { top?: string; save?: boolean }) => {
      try {
        const top =
          options.top === undefined ? undefined : parseIntOption(options.top, '--top', 1, 200);
        const outcome = await runScan({
          ...(top !== undefined ? { top } : {}),
          save: options.save !== false,
        });
        printScanReport(outcome);
      } catch (error) {
        fail(error);
      }
    });
}
