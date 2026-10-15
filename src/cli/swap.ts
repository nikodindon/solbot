import * as readline from 'node:readline/promises';
import { LAMPORTS_PER_SOL, VersionedTransaction, type PublicKey } from '@solana/web3.js';
import { Command } from 'commander';
import { SOL_MINT } from '../constants.js';
import {
  Executor,
  type SimulateTransaction,
  type SwapExecutionMode,
  type SwapOutcome,
} from '../execution/executor.js';
import { formatBaseUnits, maxSpendableBaseUnits, parseDecimalAmount } from '../execution/amount.js';
import { JupiterClient } from '../jupiter/client.js';
import { SwapApi, routerLabel, type OrderResponse } from '../jupiter/swap.js';
import { TokensApi } from '../jupiter/tokens.js';
import { resolveConnection } from '../solana/connection.js';
import { fetchTokenBalances } from '../solana/tokens.js';
import { openDatabase, resolveDatabasePath } from '../state/db.js';
import { runMigrations } from '../state/migrations.js';
import { loadConfig, parseEnv, type Config, type Env } from '../utils/config.js';
import { loadEnvFile } from '../utils/env-file.js';
import { SolbotError, messageOf } from '../utils/errors.js';
import { getProjectRoot } from '../utils/paths.js';
import { EnvSigner } from '../wallet/env-signer.js';
import { resolveAsset, type ResolvedAsset } from './price.js';
import {
  fail,
  formatPct,
  formatPriceUsd,
  ICONS,
  parseIntOption,
  printHeader,
  shorten,
} from './ui.js';

export interface SwapCliOptions {
  dryRun?: boolean;
  live?: boolean;
  yes?: boolean;
  maxSlippageBps?: string;
  root?: string;
}

interface SwapAsset extends ResolvedAsset {
  decimals: number;
}

/**
 * Exécute un swap manuel : `solbot swap <entrée> <sortie> <montant|max>`.
 *
 * Modes : `--dry-run` (ordre réel + simulation RPC, aucune signature), `--live`
 * (fonds réels, exige `confirm_live: true` + confirmation interactive ou `--yes`),
 * sinon `mode` de config.yaml (paper = dry-run étiqueté « paper »).
 */
export async function runSwap(
  input: string,
  output: string,
  amount: string,
  options: SwapCliOptions = {},
): Promise<SwapOutcome> {
  const root = options.root ?? getProjectRoot();
  loadEnvFile(root);
  const env = parseEnv();
  const { config } = loadConfig({ root });

  const mode = resolveMode(options, config);
  const slippageBps = resolveSlippageBps(options, config);

  const signer = EnvSigner.fromEnv(env);
  const client = new JupiterClient({ apiKey: env.JUPITER_API_KEY, ratePerSecond: env.JUPITER_RPS });
  const tokensApi = new TokensApi(client);
  const swapApi = new SwapApi(client);

  const [inputAsset, outputAsset] = await Promise.all([
    resolveSwapAsset(tokensApi, input),
    resolveSwapAsset(tokensApi, output),
  ]);
  if (inputAsset.mint === outputAsset.mint) {
    throw new SolbotError(`Entrée et sortie identiques (${inputAsset.label})`);
  }

  const connect = lazyConnection(env);
  const amountBaseUnits =
    amount.trim().toLowerCase() === 'max'
      ? await resolveMaxAmount(connect, signer.publicKey, inputAsset, config)
      : parseDecimalAmount(amount, inputAsset.decimals);

  const dbPath = resolveDatabasePath(root, config.database.path);
  const db = openDatabase(dbPath);
  runMigrations(db);

  try {
    const simulate = mode === 'live' ? undefined : buildSimulator(await connect());

    if (mode === 'live') {
      await confirmLivePlannedSwap({
        inputAsset,
        outputAsset,
        amountBaseUnits,
        slippageBps,
        config,
        yes: options.yes === true,
        signer: signer.address,
      });
    }

    const executor = new Executor({
      swapApi,
      config,
      signer,
      ...(simulate === undefined ? {} : { simulate }),
      db,
      onQuote: mode === 'live' ? printLiveQuote : undefined,
    });

    const outcome = await executor.swap(
      {
        inputMint: inputAsset.mint,
        outputMint: outputAsset.mint,
        amountBaseUnits,
        ...(slippageBps === undefined ? {} : { slippageBps }),
      },
      mode,
    );

    printSwapReport(outcome, inputAsset, outputAsset, slippageBps, dbPath);
    return outcome;
  } finally {
    db.close();
  }
}

function resolveMode(options: SwapCliOptions, config: Config): SwapExecutionMode {
  if (options.live === true && options.dryRun === true) {
    throw new SolbotError('--live et --dry-run sont exclusifs');
  }
  const mode: SwapExecutionMode =
    options.live === true ? 'live' : options.dryRun === true ? 'dry_run' : config.mode;
  if (mode === 'live' && !config.confirm_live) {
    throw new SolbotError('Mode live demandé mais confirm_live: false dans config.yaml', {
      hint: "Ajoutez `confirm_live: true` dans config.yaml pour autoriser l'usage de fonds réels.",
    });
  }
  return mode;
}

function resolveSlippageBps(options: SwapCliOptions, config: Config): number | undefined {
  const fromCli =
    options.maxSlippageBps === undefined
      ? undefined
      : parseIntOption(options.maxSlippageBps, '--max-slippage-bps', 1, 5000);
  const fromConfig =
    typeof config.execution.slippage === 'number' ? config.execution.slippage : undefined;
  const bps = fromCli ?? fromConfig;
  if (bps !== undefined && bps > config.risk.max_slippage_bps) {
    throw new SolbotError(
      `Slippage demandé (${bps} bps) au-dessus du plafond risk.max_slippage_bps (${config.risk.max_slippage_bps})`,
      { hint: 'Réduisez --max-slippage-bps ou relevez le plafond dans config.yaml.' },
    );
  }
  return bps;
}

/** Connexion RPC paresseuse et mémorisée (le mode live sans « max » n'en a pas besoin). */
function lazyConnection(env: Env): () => ReturnType<typeof resolveConnection> {
  let pending: ReturnType<typeof resolveConnection> | null = null;
  return () => {
    pending ??= resolveConnection(env);
    return pending;
  };
}

function buildSimulator(
  resolved: Awaited<ReturnType<typeof resolveConnection>>,
): SimulateTransaction {
  const { connection } = resolved;
  return async (transactionBase64) => {
    const transaction = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
    const response = await connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
    });
    const value = response.value;
    return {
      err: value.err ?? null,
      unitsConsumed: value.unitsConsumed ?? null,
      logsTail: (value.logs ?? []).slice(-5),
    };
  };
}

/** Complète les décimales via Tokens API quand l'actif a été saisi en mint brut. */
async function resolveSwapAsset(tokensApi: TokensApi, input: string): Promise<SwapAsset> {
  const asset = await resolveAsset(tokensApi, input);
  if (asset.decimals !== undefined) return { ...asset, decimals: asset.decimals };

  const results = await tokensApi.search(asset.mint);
  const info = results.find((token) => token.id === asset.mint);
  if (info?.decimals === undefined) {
    throw new SolbotError(`Décimales inconnues pour « ${input} »`, {
      hint: 'Utilisez un symbole connu de Jupiter (ex. BONK) ou vérifiez l’adresse mint.',
    });
  }
  return { ...asset, decimals: info.decimals };
}

async function resolveMaxAmount(
  connect: () => ReturnType<typeof resolveConnection>,
  owner: PublicKey,
  inputAsset: SwapAsset,
  config: Config,
): Promise<bigint> {
  const { connection } = await connect();
  if (inputAsset.mint === SOL_MINT) {
    const lamports = await connection.getBalance(owner, 'confirmed');
    const reserve = BigInt(Math.round(config.risk.sol_gas_reserve * LAMPORTS_PER_SOL));
    return maxSpendableBaseUnits(BigInt(lamports), reserve);
  }
  const balances = await fetchTokenBalances(connection, owner);
  const balance = balances.find((entry) => entry.mint === inputAsset.mint);
  if (balance === undefined || balance.amount <= 0) {
    throw new SolbotError(`Aucun solde ${inputAsset.label} à vendre`, {
      hint: `Adresse du wallet : ${owner.toBase58()}`,
    });
  }
  const baseUnits = BigInt(Math.round(balance.amount * 10 ** inputAsset.decimals));
  if (baseUnits <= 0n) {
    throw new SolbotError(`Solde ${inputAsset.label} trop petit pour être échangé`);
  }
  return baseUnits;
}

interface PlannedSwap {
  inputAsset: SwapAsset;
  outputAsset: SwapAsset;
  amountBaseUnits: bigint;
  slippageBps: number | undefined;
  config: Config;
  yes: boolean;
  signer: string;
}

/** Confirmation interactive avant tout ordre live (ou `--yes` en environnement non interactif). */
async function confirmLivePlannedSwap(planned: PlannedSwap): Promise<void> {
  const amount = formatBaseUnits(planned.amountBaseUnits, planned.inputAsset.decimals);
  const description = `${amount} ${planned.inputAsset.label} → ${planned.outputAsset.label}`;

  if (planned.yes) {
    console.log(`\n  ${ICONS.warn} LIVE — confirmation automatique (--yes) : ${description}`);
    return;
  }
  if (!process.stdin.isTTY) {
    throw new SolbotError('Confirmation interactive impossible (entrée non interactive)', {
      hint: 'Ajoutez --yes pour exécuter un swap réel sans confirmation.',
    });
  }

  const timeoutMs = planned.config.execution.confirm_timeout_s * 1000;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const question = await Promise.race([
      rl
        .question(
          `\n  ${ICONS.warn} SWAP RÉEL : ${description} depuis ${shorten(planned.signer, 6, 6)}\n` +
            `  Tapez « oui » pour confirmer (${planned.config.execution.confirm_timeout_s} s) : `,
        )
        .then(
          (answer) => answer,
          () => '',
        ),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), timeoutMs)),
    ]);
    if (question.trim().toLowerCase() !== 'oui') {
      throw new SolbotError('Swap annulé (confirmation refusée ou expirée)');
    }
  } finally {
    rl.close();
  }
}

/** Affiche le détail de la citation live juste avant signature (branché sur `onQuote`). */
function printLiveQuote(order: OrderResponse, attempt: number): void {
  if (attempt > 1) {
    console.log(
      `  ${ICONS.warn} citation re-émise (tentative ${attempt}) — nouvelle route appliquée`,
    );
  }
  printQuote(order);
}

function printQuote(order: OrderResponse): void {
  console.log(
    `  Route       ${routerLabel(order.router)}` +
      `${order.gasless === true ? ' · gasless' : ''}` +
      `${order.mode !== undefined ? ` · ${order.mode}` : ''}`,
  );
  console.log(
    `  Citation    ${formatUnitsFr(order.outAmount)} unités de base (sortie)` +
      `${order.otherAmountThreshold !== undefined ? ` · minimum garanti ${formatUnitsFr(order.otherAmountThreshold)}` : ''}`,
  );
  if (order.priceImpact !== undefined) {
    console.log(`  Impact prix ${formatPct(order.priceImpact)}`);
  }
  if (order.feeBps !== undefined) {
    console.log(
      `  Frais       ${order.feeBps} bps${order.feeMint !== undefined ? ` (${shorten(order.feeMint, 4, 4)})` : ''}`,
    );
  }
  if (order.inUsdValue !== undefined || order.outUsdValue !== undefined) {
    console.log(
      `  Valeur      ${formatPriceUsd(order.inUsdValue ?? null)} → ${formatPriceUsd(order.outUsdValue ?? null)}`,
    );
  }
}

/** Unités de base avec séparateurs français (« 5 186 042 ») ; renvoie la chaîne telle quelle si non numérique. */
function formatUnitsFr(amount: string): string {
  if (!/^\d+$/.test(amount)) return amount;
  return BigInt(amount).toLocaleString('fr-FR');
}

function printSwapReport(
  outcome: SwapOutcome,
  inputAsset: SwapAsset,
  outputAsset: SwapAsset,
  slippageBps: number | undefined,
  dbPath: string,
): void {
  const modeLabel =
    outcome.mode === 'live'
      ? 'LIVE — fonds réels'
      : outcome.mode === 'dry_run'
        ? 'dry-run — simulation, aucune signature'
        : 'paper — simulation';
  printHeader(`solbot swap — ${inputAsset.label} → ${outputAsset.label} · ${modeLabel}`);

  const amountIn = formatBaseUnits(BigInt(outcome.order.inAmount ?? '0'), inputAsset.decimals);
  const expectedOut = formatBaseUnits(BigInt(outcome.order.outAmount ?? '0'), outputAsset.decimals);
  console.log(
    `  Entrée      ${amountIn} ${inputAsset.label} (${formatUnitsFr(outcome.order.inAmount ?? '0')} unités de base)`,
  );
  console.log(`  Attendu     ${expectedOut} ${outputAsset.label}`);

  printQuote(outcome.order);
  if (slippageBps !== undefined) {
    console.log(`  Slippage    ${slippageBps} bps`);
  } else {
    console.log('  Slippage    RTSE (automatique Jupiter)');
  }

  if (outcome.status === 'simulated' && outcome.simulation !== null) {
    const { err, unitsConsumed, logsTail } = outcome.simulation;
    if (err === null) {
      console.log(
        `\n  ${ICONS.ok} Simulation RPC réussie${unitsConsumed !== null ? ` (${unitsConsumed.toLocaleString('fr-FR')} CU)` : ''} — aucun envoi, aucune signature`,
      );
      for (const log of logsTail) console.log(`      ${log}`);
    } else {
      console.log(`\n  ${ICONS.fail} Simulation RPC en échec : ${messageOf(err)}`);
      console.log('      Le swap réel échouerait probablement de la même façon.');
    }
  }

  if (outcome.status === 'success') {
    console.log(`\n  ${ICONS.ok} Swap exécuté et confirmé par Jupiter`);
    if (outcome.signature !== null) {
      console.log(`      signature : ${outcome.signature}`);
      console.log(`      https://solscan.io/tx/${outcome.signature}`);
    }
    if (
      outcome.execute?.totalOutputAmount !== undefined &&
      outcome.execute.totalOutputAmount !== null
    ) {
      const received = formatBaseUnits(
        BigInt(outcome.execute.totalOutputAmount),
        outputAsset.decimals,
      );
      console.log(`      reçu      : ${received} ${outputAsset.label}`);
    }
    if (outcome.realizedSlippageBps !== null) {
      const sign = outcome.realizedSlippageBps > 0 ? 'moins bon' : 'meilleur';
      console.log(
        `      slippage réalisé : ${outcome.realizedSlippageBps} bps vs citation (${sign} que l'attendu)`,
      );
    }
  }

  if (outcome.status === 'failed' && outcome.failure !== null) {
    console.log(
      `\n  ${ICONS.fail} Échec (${outcome.failure.kind === 'order' ? '/order' : '/execute'}) : ${outcome.failure.label}`,
    );
    if (outcome.failure.code !== null) console.log(`      code ${outcome.failure.code}`);
    if (outcome.failure.hint !== undefined) console.log(`      → ${outcome.failure.hint}`);
  }

  for (const attempt of outcome.attempts) {
    console.log(`      tentative ${attempt.attempt} : code ${attempt.code} — ${attempt.label}`);
  }

  if (outcome.tradeId !== null) {
    console.log(`\n  ℹ journalisé dans trades (#${outcome.tradeId}) → ${dbPath}`);
  }
}

/** Code de sortie CLI : 0 si swap exécuté ou simulation propre, 1 sinon. */
export function swapExitCode(outcome: SwapOutcome): number {
  if (outcome.status === 'failed') return 1;
  if (outcome.simulation !== null && outcome.simulation.err !== null) return 1;
  return 0;
}

export function swapCommand(): Command {
  return new Command('swap')
    .description('Swap manuel via Jupiter Swap V2 (dry-run par défaut selon config.yaml)')
    .argument('<entrée>', 'token vendu — symbole ou mint (ex. SOL, USDC, BONK)')
    .argument('<sortie>', 'token acheté — symbole ou mint')
    .argument('<montant>', 'montant en unités du token vendu (ex. 0.5) ou « max »')
    .option('--dry-run', 'ordre réel + simulation RPC, sans signature (aucun fonds engagé)')
    .option('--live', 'swap réel — exige confirm_live: true et une confirmation (ou --yes)')
    .option('--yes', 'confirme automatiquement le swap live (automatisation, dangereux)')
    .option('--max-slippage-bps <n>', 'slippage max en bps (plafonné par risk.max_slippage_bps)')
    .action(
      async (
        input: string,
        output: string,
        amount: string,
        options: { dryRun?: boolean; live?: boolean; yes?: boolean; maxSlippageBps?: string },
      ) => {
        try {
          const outcome = await runSwap(input, output, amount, {
            dryRun: options.dryRun === true,
            live: options.live === true,
            yes: options.yes === true,
            ...(options.maxSlippageBps === undefined
              ? {}
              : { maxSlippageBps: options.maxSlippageBps }),
          });
          process.exitCode = swapExitCode(outcome);
        } catch (error) {
          fail(error);
        }
      },
    );
}
