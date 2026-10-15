import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Command } from 'commander';
import { SOL_MINT, USDC_MINT } from '../constants.js';
import { Engine, type EngineMode, type TickResult } from '../engine/engine.js';
import { reconcileBalances, type ChainBalance } from '../engine/reconcile.js';
import { Executor } from '../execution/executor.js';
import { JupiterClient } from '../jupiter/client.js';
import { PriceApi } from '../jupiter/price.js';
import { SwapApi } from '../jupiter/swap.js';
import { TokensApi } from '../jupiter/tokens.js';
import { pollOnce } from '../market/poller.js';
import { resolveConnection } from '../solana/connection.js';
import { buildSimulator } from '../solana/simulate.js';
import { fetchTokenBalances } from '../solana/tokens.js';
import { openDatabase, resolveDatabasePath } from '../state/db.js';
import { runMigrations } from '../state/migrations.js';
import { getRecentEvents } from '../state/events.js';
import { getWatchlist, replaceWatchlist, toWatchlistItems } from '../state/watchlist.js';
import { buildStrategies, strategyWeights } from '../strategy/registry.js';
import { resolveUniverse } from '../universe/builder.js';
import { loadConfig, parseEnv, type Config } from '../utils/config.js';
import { loadEnvFile } from '../utils/env-file.js';
import { SolbotError } from '../utils/errors.js';
import { getProjectRoot } from '../utils/paths.js';
import { EnvSigner } from '../wallet/env-signer.js';
import { fail, ICONS, parseIntOption, printHeader, shorten } from './ui.js';

export interface StartCliOptions {
  paper?: boolean;
  dryRun?: boolean;
  live?: boolean;
  yes?: boolean;
  once?: boolean;
  duration?: number;
  interval?: number;
  refresh?: boolean;
  root?: string;
}

/**
 * Moteur autonome (Phase 3) : boucle de ticks — marché → portefeuille →
 * sorties (stop-loss, take-profit, trailing, signal) → entrées arbitrées et
 * contrôlées par le RiskManager. Modes : paper (fills virtuels), dry-run
 * (ordres réels simulés + portefeuille virtuel), live (fonds réels).
 */
export async function runStart(options: StartCliOptions = {}): Promise<void> {
  const root = options.root ?? getProjectRoot();
  loadEnvFile(root);
  const env = parseEnv();
  const { config } = loadConfig({ root });
  const mode = resolveMode(options, config);

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
  const swapApi = new SwapApi(client);
  const strategies = buildStrategies(config);
  const weights = strategyWeights(config);

  let watchlist = getWatchlist(db);
  if (watchlist.length === 0 || options.refresh === true) {
    console.log('  construction de la watchlist (scan de l’univers)…');
    const universe = await resolveUniverse(tokensApi, config);
    replaceWatchlist(db, toWatchlistItems(universe.watchlist));
    watchlist = getWatchlist(db);
    console.log(`  ${ICONS.ok} ${watchlist.length} actifs surveillés`);
  }
  if (watchlist.length === 0) {
    throw new SolbotError('Watchlist vide : impossible de démarrer le moteur', {
      hint: 'Lancez `solbot scan` puis relancez `solbot start`.',
    });
  }

  const signer = EnvSigner.fromEnv(env);
  const base = config.base_currency === 'SOL' ? SOL_MINT : USDC_MINT;
  const stopPath = path.join(root, 'STOP');

  let connect: (() => ReturnType<typeof resolveConnection>) | null = null;
  const connection = (): ReturnType<typeof resolveConnection> => {
    connect ??= () => resolveConnection(env);
    return connect();
  };

  if (mode === 'live') {
    await confirmLiveStart({
      config,
      yes: options.yes === true,
      address: signer.address,
      base: config.base_currency,
    });
  }

  try {
    // ── Réconciliation on-chain (live uniquement : la chaîne fait foi) ─────
    if (mode === 'live') {
      const { connection: rpc } = await connection();
      const [lamports, balances] = await Promise.all([
        rpc.getBalance(signer.publicKey, 'confirmed'),
        fetchTokenBalances(rpc, signer.publicKey),
      ]);
      const symbols = new Map(watchlist.map((item) => [item.mint, item.symbol]));
      const chainBalances: ChainBalance[] = balances.map((balance) => ({
        mint: balance.mint,
        symbol: symbols.get(balance.mint) ?? '',
        amount: balance.amountBaseUnits,
        decimals: balance.decimals,
      }));
      console.log(
        `  soldes on-chain : ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL, ${balances.length} token(s)`,
      );

      const pollMints = [
        ...new Set([
          ...watchlist.map((item) => item.mint),
          ...chainBalances.map((balance) => balance.mint),
          base,
          SOL_MINT,
        ]),
      ];
      const priming = await pollOnce({ db, priceApi, tokensApi, mints: pollMints });
      const prices = new Map<string, number | null>(
        [...priming.prices].map(([mint, info]) => [mint, info.usdPrice]),
      );
      const reconcile = reconcileBalances({
        db,
        balances: chainBalances,
        baseMint: base,
        prices,
        defaultStopLossPct: config.risk.stop_loss_pct,
        defaultTakeProfitPct: config.risk.take_profit_pct,
        ts: Date.now(),
      });
      const actions =
        reconcile.adopted.length + reconcile.adjusted.length + reconcile.closed.length;
      console.log(
        `  ${ICONS.ok} réconciliation : ${reconcile.adopted.length} adoptée(s), ${reconcile.adjusted.length} ajustée(s), ${reconcile.closed.length} clôturée(s)${reconcile.skipped.length > 0 ? `, ${reconcile.skipped.length} ignorée(s)` : ''}${actions === 0 ? ' — rien à faire' : ''}`,
      );
    }

    // ── Exécuteur (requis en dry-run/live) ─────────────────────────────────
    const executor =
      mode === 'paper'
        ? undefined
        : new Executor({
            swapApi,
            config,
            signer,
            db,
            ...(mode === 'dry_run'
              ? { simulate: buildSimulator((await connection()).connection) }
              : {}),
            onQuote: (order) => {
              console.log(
                `  devis : ${order.outAmount ?? '?'} (unités de base), routeur ${order.router ?? '?'}${order.feeBps !== undefined ? `, frais ${order.feeBps} bps` : ''}`,
              );
            },
          });

    const engine = new Engine({
      db,
      config,
      mode,
      strategies,
      weights,
      poll: (mints) => pollOnce({ db, priceApi, tokensApi, mints }),
      ...(executor === undefined ? {} : { executor }),
      ...(mode === 'live'
        ? {
            readLiveCash: async (prices: Map<string, number | null>) => {
              const { connection: rpc } = await connection();
              const [lamports, balances] = await Promise.all([
                rpc.getBalance(signer.publicKey, 'confirmed'),
                fetchTokenBalances(rpc, signer.publicKey),
              ]);
              const solBalanceSol = lamports / LAMPORTS_PER_SOL;
              let baseUsd: number;
              if (base === USDC_MINT) {
                baseUsd = balances.find((balance) => balance.mint === USDC_MINT)?.amount ?? 0;
              } else {
                const usable = Math.max(0, solBalanceSol - config.risk.sol_gas_reserve);
                baseUsd = usable * (prices.get(SOL_MINT) ?? 0);
              }
              return { baseUsd, solBalanceSol };
            },
          }
        : {}),
      stopFile: {
        exists: () => fs.existsSync(stopPath),
        createIfAbsent: () => {
          try {
            fs.writeFileSync(stopPath, `Kill-switch déclenché le ${new Date().toISOString()}\n`, {
              flag: 'wx',
            });
          } catch {
            // Le fichier existe déjà — rien à faire.
          }
        },
      },
      onLog: (line) => console.log(`  ${ICONS.warn} ${line}`),
    });

    const onSignal = (): void => {
      if (!engine.stopping) console.log('\n  arrêt demandé — fin du tick en cours…');
      engine.requestStop();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    printHeader(
      `solbot start — moteur autonome (mode ${mode}), ${strategies.length} stratégie(s), ${watchlist.length} actifs`,
    );
    console.log(
      `  wallet ${shorten(signer.address, 6, 6)} · intervalle ${options.interval ?? config.loop_interval_s} s · base ${config.base_currency} · kill-switch : ${stopPath}`,
    );
    if (mode === 'live') {
      console.log(
        `  ${ICONS.warn} LIVE — fonds réels. Sorties prioritaires (SL/TP/trailing actifs dès la première position).`,
      );
    } else if (mode === 'dry_run') {
      console.log(
        `  ${ICONS.warn} dry-run — portefeuille virtuel, chaque ordre est validé par /order + simulation RPC.`,
      );
    } else {
      console.log(
        `  paper — caisse virtuelle ${config.paper.initial_usdc.toFixed(2)} ${config.base_currency}, fills modélisés (slippage ${config.paper.fill_slippage_bps} bps + frais).`,
      );
    }

    let tickNumber = 0;
    try {
      const summary = await engine.run({
        ...(options.once === true ? { once: true } : {}),
        ...(options.duration === undefined ? {} : { durationS: options.duration }),
        ...(options.interval === undefined ? {} : { intervalS: options.interval }),
        onTick: (result) => {
          tickNumber += 1;
          printTick(tickNumber, result);
        },
      });

      const stopLabels: Record<string, string> = {
        once: 'tick unique terminé',
        duration: 'durée écoulée',
        requested: 'arrêt demandé',
        error: 'erreur fatale',
      };
      console.log(
        `\n  ${ICONS.ok} moteur arrêté (${stopLabels[summary.stopReason] ?? summary.stopReason}) — ${summary.ticks} tick(s)`,
      );
      const events = getRecentEvents(db, 5);
      for (const event of events) {
        console.log(`    [${event.kind}] ${event.message}`);
      }
      console.log(`  journal complet : ${dbPath}`);
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  } finally {
    db.close();
  }
}

/** Résumé d'un tick (une ligne + détail des actions). */
function printTick(number: number, result: TickResult): void {
  const time = new Date(result.ts).toISOString().slice(11, 19);
  const kill = result.killSwitch ? ' · ⛔ entrées coupées' : '';
  console.log(
    `  ${time}  #${String(number).padStart(3)}  NAV ${result.navUsd.toFixed(2)} $ ` +
      `(caisse ${result.cashUsd.toFixed(2)} $, ${result.openCount} pos.)  ` +
      `dd ${result.drawdownPct.toFixed(2)} % · jour -${result.dailyLossPct.toFixed(2)} %  ` +
      `prêts ${result.readyAssets}/${result.totalAssets}${kill}`,
  );
  for (const line of result.entries) console.log(`      ${ICONS.ok} ${line}`);
  for (const line of result.exits) console.log(`      ${ICONS.warn} ${line}`);
  for (const line of result.rejections) console.log(`      · ${line}`);
}

function resolveMode(options: StartCliOptions, config: Config): EngineMode {
  const requested = [options.live === true, options.dryRun === true, options.paper === true].filter(
    Boolean,
  ).length;
  if (requested > 1) {
    throw new SolbotError('--paper, --dry-run et --live sont exclusifs');
  }
  const mode: EngineMode =
    options.live === true
      ? 'live'
      : options.dryRun === true
        ? 'dry_run'
        : options.paper === true
          ? 'paper'
          : config.mode;
  if (mode === 'live' && !config.confirm_live) {
    throw new SolbotError('Mode live demandé mais confirm_live: false dans config.yaml', {
      hint: 'Ajoutez `confirm_live: true` dans config.yaml pour autoriser le trading réel.',
    });
  }
  return mode;
}

/** Confirmation unique avant de lancer un moteur live (ou `--yes` pour les scripts). */
async function confirmLiveStart(input: {
  config: Config;
  yes: boolean;
  address: string;
  base: string;
}): Promise<void> {
  if (input.yes) {
    console.log(`\n  ${ICONS.warn} LIVE — démarrage automatique (--yes), wallet ${input.address}`);
    return;
  }
  if (!process.stdin.isTTY) {
    throw new SolbotError('Confirmation interactive impossible (entrée non interactive)', {
      hint: 'Ajoutez --yes pour démarrer le moteur live sans confirmation.',
    });
  }

  const timeoutMs = input.config.execution.confirm_timeout_s * 1000;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let timer: NodeJS.Timeout | undefined;
  try {
    const answer = await Promise.race([
      rl.question(
        `\n  ${ICONS.warn} MOTEUR RÉEL : trading autonome depuis ${shorten(input.address, 6, 6)} ` +
          `(base ${input.base}, plafond ${input.config.risk.max_position_pct} % du NAV par position).\n` +
          `  Tapez « oui » pour démarrer (timeout ${input.config.execution.confirm_timeout_s} s) : `,
      ),
      new Promise<string>((_, reject) => {
        timer = setTimeout(
          () => reject(new SolbotError('Délai de confirmation dépassé — démarrage annulé')),
          timeoutMs,
        );
      }),
    ]);
    if (answer.trim().toLowerCase() !== 'oui') {
      throw new SolbotError('Démarrage live annulé (réponse différente de « oui »)');
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    rl.close();
  }
}

export function startCommand(): Command {
  return new Command('start')
    .description(
      'Moteur autonome : tick → signaux → risque → exécution (SL/TP/trailing, kill-switch STOP)',
    )
    .option('--paper', 'force le mode paper (fills virtuels — défaut config)')
    .option('--dry-run', 'ordres réels simulés (validation /order + RPC) sur portefeuille virtuel')
    .option('--live', 'trading réel (exige confirm_live: true)')
    .option('--yes', 'confirmation live automatique (scripts, cron)')
    .option('--once', 'un seul tick puis sortie')
    .option('--duration <s>', 'arrêt automatique après N secondes')
    .option('-i, --interval <s>', 'intervalle des ticks en secondes (défaut : loop_interval_s)')
    .option('--refresh', 'reconstruit la watchlist avant de démarrer')
    .action(
      async (options: {
        paper?: boolean;
        dryRun?: boolean;
        live?: boolean;
        yes?: boolean;
        once?: boolean;
        duration?: string;
        interval?: string;
        refresh?: boolean;
      }) => {
        try {
          await runStart({
            paper: Boolean(options.paper),
            dryRun: Boolean(options.dryRun),
            live: Boolean(options.live),
            yes: Boolean(options.yes),
            once: Boolean(options.once),
            ...(options.duration !== undefined
              ? { duration: parseIntOption(options.duration, '--duration', 1) }
              : {}),
            ...(options.interval !== undefined
              ? { interval: parseIntOption(options.interval, '--interval', 1, 3600) }
              : {}),
            refresh: Boolean(options.refresh),
          });
        } catch (error) {
          fail(error);
        }
      },
    );
}
