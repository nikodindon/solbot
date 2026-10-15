import { Command } from 'commander';
import { JupiterClient } from '../jupiter/client.js';
import { PriceApi } from '../jupiter/price.js';
import { TokensApi } from '../jupiter/tokens.js';
import { pollOnce } from '../market/poller.js';
import { openDatabase, resolveDatabasePath } from '../state/db.js';
import { runMigrations } from '../state/migrations.js';
import { getWatchlist, replaceWatchlist, toWatchlistItems } from '../state/watchlist.js';
import { resolveUniverse } from '../universe/builder.js';
import { loadConfig, parseEnv } from '../utils/config.js';
import { loadEnvFile } from '../utils/env-file.js';
import { getProjectRoot } from '../utils/paths.js';
import { sleep } from '../utils/retry.js';
import { fail, ICONS, parseIntOption, printHeader } from './ui.js';

export interface WatchOptions {
  /** Intervalle entre deux cycles, en secondes (défaut : `loop_interval_s`). */
  interval?: number;
  /** Un seul cycle puis sortie (utile en cron). */
  once?: boolean;
  /** Arrêt automatique après N secondes. */
  duration?: number;
  /** Reconstruit la watchlist avant de commencer. */
  refresh?: boolean;
  root?: string;
}

function clock(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

/** Pause interruptible (vérifie `shouldStop` toutes les 250 ms). */
async function interruptibleSleep(ms: number, shouldStop: () => boolean): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !shouldStop()) {
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Boucle d'échantillonnage : prix de la watchlist → ticks → bougies OHLCV
 * (1m/5m/15m/1h). La watchlist est construite au premier lancement si la base est vide.
 */
export async function runWatch(options: WatchOptions = {}): Promise<void> {
  const root = options.root ?? getProjectRoot();
  loadEnvFile(root);
  const env = parseEnv();
  const { config } = loadConfig({ root });
  const dbPath = resolveDatabasePath(root, config.database.path);

  const db = openDatabase(dbPath);
  runMigrations(db);

  const client = new JupiterClient({
    apiKey: env.JUPITER_API_KEY,
    ratePerSecond: env.JUPITER_RPS,
    onRetry: (info) => {
      console.log(
        `  ${ICONS.warn} Jupiter ${info.endpoint} : ${info.reason} — nouvelle tentative dans ${Math.round(info.delayMs)} ms`,
      );
    },
  });
  const tokensApi = new TokensApi(client);
  const priceApi = new PriceApi(client);

  let watchlist = getWatchlist(db);
  if (watchlist.length === 0 || options.refresh === true) {
    console.log('  construction de la watchlist (scan de l’univers)…');
    const universe = await resolveUniverse(tokensApi, config);
    replaceWatchlist(db, toWatchlistItems(universe.watchlist));
    watchlist = getWatchlist(db);
    console.log(`  ${ICONS.ok} ${watchlist.length} actifs surveillés`);
  }

  const mints = watchlist.map((item) => item.mint);
  const intervalMs = (options.interval ?? config.loop_interval_s) * 1000;
  const deadline =
    options.duration === undefined ? undefined : Date.now() + options.duration * 1000;

  let stop = false;
  const onSignal = (): void => {
    if (!stop) console.log('\n  arrêt demandé — fin du cycle en cours…');
    stop = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  printHeader(
    `solbot watch — ${mints.length} actifs, cycle de ${intervalMs / 1000} s (base : ${dbPath})`,
  );

  try {
    let cycle = 0;
    do {
      cycle += 1;
      const summary = await pollOnce({ db, priceApi, mints });
      console.log(
        `  ${clock(summary.ts)}  #${String(cycle).padStart(3)}  ` +
          `prix ${summary.priced}/${summary.requested}  ` +
          `ticks ${summary.ticksInserted}  ` +
          `bougies ${summary.candlesUpserted}  ` +
          `(${summary.durationMs} ms)`,
      );

      if (options.once === true) break;
      if (deadline !== undefined && Date.now() >= deadline) break;
      const waitMs =
        deadline === undefined
          ? intervalMs
          : Math.min(intervalMs, Math.max(0, deadline - Date.now()));
      await interruptibleSleep(waitMs, () => stop);
    } while (!stop);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    db.close();
  }

  console.log(`  ${ICONS.ok} arrêt propre — données persistées dans ${dbPath}`);
}

export function watchCommand(): Command {
  return new Command('watch')
    .description('Échantillonne les prix de la watchlist en continu (ticks + bougies OHLCV)')
    .option(
      '-i, --interval <s>',
      'intervalle entre deux cycles en secondes (défaut : loop_interval_s)',
    )
    .option('--once', 'un seul cycle puis sortie')
    .option('--duration <s>', 'arrêt automatique après N secondes')
    .option('--refresh', 'reconstruit la watchlist avant de commencer')
    .action(
      async (options: {
        interval?: string;
        once?: boolean;
        duration?: string;
        refresh?: boolean;
      }) => {
        try {
          await runWatch({
            ...(options.interval !== undefined
              ? { interval: parseIntOption(options.interval, '--interval', 1, 3600) }
              : {}),
            ...(options.duration !== undefined
              ? { duration: parseIntOption(options.duration, '--duration', 1) }
              : {}),
            once: Boolean(options.once),
            refresh: Boolean(options.refresh),
          });
        } catch (error) {
          fail(error);
        }
      },
    );
}
