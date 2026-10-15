import type { DatabaseSync } from 'node:sqlite';
import { SendTransactionError, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { JupiterApiError } from '../jupiter/errors.js';
import {
  buildSwapInstructionError,
  describeExecuteError,
  describeOrderFailure,
  type BuildResponse,
  type ExecuteResponse,
  type OrderResponse,
  type SwapApi,
} from '../jupiter/swap.js';
import {
  LandingSendError,
  type LandingConfirmation,
  type LandingSendResult,
  type LandingTarget,
} from '../solana/landing.js';
import { insertTrade, type TradeRecord } from '../state/trades.js';
import type { Config } from '../utils/config.js';
import { SolbotError, messageOf } from '../utils/errors.js';
import type { Signer } from '../wallet/signer.js';
import { collectPathStats, pickPath, type KnownPath } from './path-stats.js';
import {
  COMPUTE_UNIT_LIMIT_MAX,
  ROUTER_CODES,
  buildRouterTransaction,
  computeUnitLimitFromSimulation,
} from './router.js';
import { buildRouterTransactionV1 } from './router-v1.js';
import {
  adaptiveSlippageBps,
  bumpedSlippageBps,
  failureText,
  isSlippageFailure,
} from './slippage.js';

export type SwapExecutionMode = 'paper' | 'dry_run' | 'live';

/** Chemin d'exécution : Meta-Aggregator managé (`/order`+`/execute`) ou Router (`/build`). */
export type ExecutionPath = 'meta_aggregator' | 'router';

export interface SwapRequest {
  inputMint: string;
  outputMint: string;
  /** Montant en unités de base (smallest unit) du token d'entrée. */
  amountBaseUnits: bigint;
  /** Bps de slippage. Absent → `execution.slippage` (ou RTSE si `'rtse'`). */
  slippageBps?: number;
}

/** Résumé d'une simulation RPC (transaction non signée). */
export interface SimulationSummary {
  err: unknown;
  unitsConsumed: number | null;
  logsTail: string[];
}

export interface ExecuteAttempt {
  attempt: number;
  requestId: string | null;
  /** Code `/execute` (0 = succès). */
  code: number;
  label: string;
  signature: string | null;
}

export interface SwapFailure {
  kind: 'order' | 'execute';
  label: string;
  hint?: string;
  /** `errorCode` de `/order` ou code `/execute` (négatif). */
  code: number | null;
}

export interface SwapOutcome {
  mode: SwapExecutionMode;
  status: 'simulated' | 'success' | 'failed';
  order: OrderResponse;
  execute: ExecuteResponse | null;
  simulation: SimulationSummary | null;
  attempts: ExecuteAttempt[];
  signature: string | null;
  realizedSlippageBps: number | null;
  tradeId: number | null;
  failure: SwapFailure | null;
  /** Chemin d'exécution utilisé (Phase 6 ; toujours renseigné par l'Executor). */
  path?: ExecutionPath;
  /** Télémétrie du chemin Router (null sur le chemin Meta-Aggregator). */
  router?: RouterExecutionDetails | null;
}

/** Télémétrie du chemin Router — journalisée dans `trades` et affichée par la CLI. */
export interface RouterExecutionDetails {
  cuLimit: number | null;
  cuPriceMicrolamports: number | null;
  tipLamports: number | null;
  /** Cible d'atterrissage utilisée (`rpc`, `tx_jup`, `jito`…). */
  landing: string | null;
  /** Durée envoi → confirmation (ms) — latence d'atterrissage. */
  landingMs: number | null;
}

/** Transaction finale du chemin Router, signée et prête à envoyer. */
interface SignedRouterTransaction {
  signedTransaction: string;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/** Simule une transaction base64 (implémentation RPC fournie par le CLI). */
export type SimulateTransaction = (transactionBase64: string) => Promise<SimulationSummary>;

export interface ExecutorOptions {
  swapApi: SwapApi;
  config: Config;
  signer: Signer;
  /**
   * Simule la transaction assemblée, sans signature. Requis en paper/dry-run ;
   * requis aussi sur le chemin Router (estimation des compute units).
   */
  simulate?: SimulateTransaction;
  /** Requis sur le chemin Router en live : envoi + confirmation de la transaction signée. */
  landing?: LandingTarget;
  /** Journalisation SQLite (absent en test unitaire pur). */
  db?: DatabaseSync;
  /**
   * Appelé après chaque `/order` réussi (transaction disponible), avant
   * simulation/signature. Le CLI y branche la confirmation interactive en live ;
   * lever une erreur annule le swap.
   */
  onQuote?: (order: OrderResponse, attempt: number) => void | Promise<void>;
}

/**
 * Orchestre un swap selon `execution.path` :
 * - `meta_aggregator` (défaut) : `/order` → (simulation | signature) → `/execute` ;
 * - `router` (Phase 6) : `/build` → assemblage v0 → simulation (CU) → signature →
 *   atterrissage par nos soins (`LandingTarget`), confirmation on-chain ;
 * - `auto` (Phase 6b) : décision par swap à partir des statistiques live
 *   (`solbot paths`) — tant que les deux chemins n'ont pas assez
 *   d'échantillons, le Meta-Aggregator est conservé.
 *
 * Stratégie d'échec par code `/execute` (voir `EXECUTE_ERRORS`) : `requote`
 * relance un ordre frais tant qu'il reste des tentatives, `abort` s'arrête
 * immédiatement. Les échecs prévisibles sont retournés dans `SwapOutcome.failure`
 * (jamais levés) et journalisés dans la table `trades`.
 */
export class Executor {
  constructor(private readonly options: ExecutorOptions) {}

  async swap(request: SwapRequest, mode: SwapExecutionMode): Promise<SwapOutcome> {
    const { simulate } = this.options;
    const path = this.resolvePath();

    if (request.inputMint === request.outputMint) {
      throw new SolbotError("Les tokens d'entrée et de sortie sont identiques");
    }
    if (request.amountBaseUnits <= 0n) {
      throw new SolbotError("Le montant d'entrée doit être strictement positif");
    }
    if (mode !== 'live' && simulate === undefined) {
      throw new SolbotError('Simulation RPC indisponible : modes paper/dry-run impossibles', {
        hint: 'Erreur interne — le CLI doit fournir une fonction de simulation.',
      });
    }
    if (path === 'router' && simulate === undefined) {
      throw new SolbotError(
        'Chemin Router : simulation RPC requise pour estimer les compute units',
        {
          hint: 'Le CLI doit fournir une fonction de simulation, y compris en live.',
        },
      );
    }
    if (path === 'router' && mode === 'live' && this.options.landing === undefined) {
      throw new SolbotError("Chemin Router en live : cible d'atterrissage manquante", {
        hint: 'Le CLI doit fournir un LandingTarget (ex. RpcLanding).',
      });
    }

    return path === 'router'
      ? this.swapRouter(request, mode)
      : this.swapMetaAggregator(request, mode);
  }

  /**
   * Chemin effectif du swap : valeur de configuration, ou décision `auto`
   * fondée sur les statistiques des swaps live (même analyse que
   * `solbot paths`). Sans base de données, l'auto retombe sur le
   * Meta-Aggregator — prudent par défaut.
   */
  private resolvePath(): KnownPath {
    const { config, db } = this.options;
    const configured = config.execution.path;
    if (configured !== 'auto') return configured;
    if (db === undefined) return 'meta_aggregator';
    const stats = collectPathStats(db, {
      windowDays: config.execution.auto.window_days,
      now: Date.now(),
    });
    return pickPath(stats, {
      minSamples: config.execution.auto.min_samples,
      rateMargin: config.execution.auto.rate_margin,
    });
  }

  /**
   * Borne de slippage initiale d'un swap : surcharge de la requête, sinon
   * configuration. `adaptive` (Phase 6c) calcule une borne depuis la volatilité
   * ATR des bougies stockées — repli RTSE si l'historique est insuffisant.
   */
  private resolveSwapSlippage(request: SwapRequest): number | 'rtse' {
    if (request.slippageBps !== undefined) return request.slippageBps;
    const { config, db } = this.options;
    const configured = config.execution.slippage;
    if (configured === 'rtse') return 'rtse';
    if (typeof configured === 'number') return configured;
    if (db === undefined) return 'rtse';
    const adaptive = config.execution.slippage_adaptive;
    return (
      adaptiveSlippageBps(db, request.inputMint, {
        timeframe: adaptive.timeframe,
        period: adaptive.period,
        multiplier: adaptive.multiplier,
        minBps: adaptive.min_bps,
        maxBps: adaptive.max_bps,
      }) ?? 'rtse'
    );
  }

  /**
   * Élargit une borne numérique après un échec « slippage » (re-cotation
   * intelligente) : × `slippage_bump_factor`, plafonné par
   * `risk.max_slippage_bps`. Une borne fournie explicitement dans la requête
   * (ex. `--max-slippage-bps`) est un choix utilisateur : jamais modifiée.
   * RTSE re-cote de lui-même — rien à élargir.
   */
  private bumpSlippage(current: number | 'rtse', request: SwapRequest): number | 'rtse' {
    if (request.slippageBps !== undefined || current === 'rtse') return current;
    const { slippage_bump_factor: factor } = this.options.config.execution;
    if (factor <= 1) return current;
    return bumpedSlippageBps(current, factor, this.options.config.risk.max_slippage_bps);
  }

  /** Chemin par défaut : `/order` → (simulation | signature) → `/execute`. */
  private async swapMetaAggregator(
    request: SwapRequest,
    mode: SwapExecutionMode,
  ): Promise<SwapOutcome> {
    const { config, signer, simulate, swapApi } = this.options;

    // Borne de slippage (Phase 6c) : numérique (fixe, adaptative ATR…) ou RTSE.
    let slippageBps = this.resolveSwapSlippage(request);
    const excludeRouters = config.execution.exclude_routers;
    const maxAttempts = Math.max(1, config.execution.retries + 1);
    const attempts: ExecuteAttempt[] = [];

    let lastFailure: SwapFailure | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) await sleep(config.execution.retry_backoff_ms);

      const order = await swapApi.getOrder({
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        amount: request.amountBaseUnits.toString(),
        taker: signer.address,
        ...(slippageBps === 'rtse' ? {} : { slippageBps }),
        ...(excludeRouters.length === 0 ? {} : { excludeRouters }),
      });

      // `""` = Jupiter n'a pas pu construire la transaction (voir errorCode) ;
      // `null` = pas de `taker` fourni — impossible ici, mais traité comme échec.
      if (!order.transaction) {
        const failure = describeOrderFailure(order.router, order.errorCode);
        const tradeId = this.record(order, request, mode, {
          status: 'failed',
          errorCode: order.errorCode ?? null,
          errorMessage: failure.label,
        });
        return this.outcome(mode, 'failed', order, null, null, attempts, tradeId, {
          kind: 'order',
          label: failure.label,
          ...(failure.hint === undefined ? {} : { hint: failure.hint }),
          code: order.errorCode ?? null,
        });
      }

      await this.options.onQuote?.(order, attempt);

      if (mode !== 'live') {
        const simulation = await simulate!(order.transaction);
        const simulationError = simulation.err === null ? null : failureText(simulation.err);
        const tradeId = this.record(order, request, mode, {
          status: 'simulated',
          errorCode: null,
          errorMessage: simulationError,
        });
        return this.outcome(mode, 'simulated', order, null, simulation, attempts, tradeId, null);
      }

      const requestId = order.requestId;
      if (requestId === undefined || requestId === '') {
        throw new SolbotError('/order a répondu sans requestId : impossible de soumettre', {
          hint: 'Réessayez ; si le problème persiste, la réponse de Jupiter a changé de format.',
        });
      }

      const transaction = VersionedTransaction.deserialize(
        Buffer.from(order.transaction, 'base64'),
      );
      signer.signTransaction(transaction);
      const signedTransaction = Buffer.from(transaction.serialize()).toString('base64');

      const execute = await swapApi.execute({
        signedTransaction,
        requestId,
        ...(parseBlockHeight(order.lastValidBlockHeight) === undefined
          ? {}
          : { lastValidBlockHeight: parseBlockHeight(order.lastValidBlockHeight) }),
      });

      const info = describeExecuteError(execute.code);
      const succeeded = execute.code === 0 && execute.status === 'Success';
      const label = succeeded ? 'succès' : info.label;
      attempts.push({
        attempt,
        requestId,
        code: execute.code,
        label,
        signature: execute.signature ?? null,
      });

      if (succeeded) {
        const realizedSlippageBps = computeRealizedSlippageBps(
          order.outAmount,
          execute.totalOutputAmount,
        );
        const tradeId = this.record(order, request, mode, {
          status: 'success',
          signature: execute.signature ?? null,
          outAmount: execute.totalOutputAmount ?? null,
          realizedSlippageBps,
          errorCode: null,
          errorMessage: null,
        });
        return this.outcome(mode, 'success', order, execute, null, attempts, tradeId, null, {
          signature: execute.signature ?? null,
          realizedSlippageBps,
        });
      }

      lastFailure = {
        kind: 'execute',
        label: info.label,
        ...(info.hint === undefined ? {} : { hint: info.hint }),
        code: execute.code,
      };
      // Échec de type slippage : on élargit la borne pour la re-cotation.
      const slippageFailure = isSlippageFailure(execute.error);
      if (slippageFailure) slippageBps = this.bumpSlippage(slippageBps, request);
      if ((info.strategy === 'requote' || slippageFailure) && attempt < maxAttempts) continue;

      this.record(order, request, mode, {
        status: 'failed',
        errorCode: execute.code,
        errorMessage: info.label,
      });
      return this.outcome(mode, 'failed', order, execute, null, attempts, null, lastFailure);
    }

    // Inatteignable (la boucle retourne toujours), garde-fou TypeScript.
    throw new SolbotError('Échec inattendu : aucune tentative effectuée', {
      hint: lastFailure?.label ?? 'erreur interne',
    });
  }

  /**
   * Chemin Phase 6 : `/build` → assemblage v0 → simulation (CU) → signature →
   * atterrissage propre (RPC) → confirmation on-chain et reçu déduit des balances.
   */
  private async swapRouter(request: SwapRequest, mode: SwapExecutionMode): Promise<SwapOutcome> {
    const { config, signer, simulate, swapApi } = this.options;
    const routerConfig = config.execution.router;
    // Contraintes de la cible d'atterrissage (live uniquement) : tip minimal
    // imposé par l'infra, transaction taillée Jito, instructions préparées par
    // la cible (ex. virement de tip vers un compte Jito).
    const landingTarget = mode === 'live' ? this.options.landing : undefined;
    const forJitoBundle =
      landingTarget?.tip?.forJitoBundle === true || routerConfig.for_jito_bundle;
    const tipLamports = Math.max(routerConfig.tip_lamports, landingTarget?.tip?.minLamports ?? 0);
    // Borne de slippage (Phase 6c) : numérique (fixe, adaptative ATR…) ou RTSE.
    let slippageBps = this.resolveSwapSlippage(request);
    const maxAttempts = Math.max(1, config.execution.retries + 1);
    const attempts: ExecuteAttempt[] = [];
    let lastFailure: SwapFailure | null = null;

    // Pré-chauffe de la cible d'atterrissage (ex. comptes de tip Jito) en
    // parallèle du premier `/build` — best-effort : `prepare` reste la
    // référence et signalera lui-même un échec réel.
    if (landingTarget?.warmup !== undefined) {
      void landingTarget.warmup().catch(() => undefined);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) await sleep(config.execution.retry_backoff_ms);

      // 1) Instructions brutes (routage Metis on-chain, pas de transaction assemblée).
      let build: BuildResponse;
      try {
        build = await swapApi.getBuild({
          inputMint: request.inputMint,
          outputMint: request.outputMint,
          amount: request.amountBaseUnits.toString(),
          taker: signer.address,
          slippageBps,
          computeUnitPricePercentile: routerConfig.compute_unit_price_percentile,
          maxAccounts: routerConfig.max_accounts,
          ...(routerConfig.fast_mode ? { mode: 'fast' as const } : {}),
          ...(routerConfig.transaction_version === 1 ? { transactionVersion: '1' as const } : {}),
          ...(forJitoBundle ? { forJitoBundle: true } : {}),
          // Pour Jito, le tip est un virement vers un compte Jito ajouté par
          // l'assembleur (`prepare`) : on ne demande pas de tip Jupiter.
          ...(tipLamports > 0 && !forJitoBundle ? { tipAmount: tipLamports } : {}),
        });
      } catch (error) {
        // Rien à exécuter : pas de ligne `trades` ; HTTP 400 = pas de route, définitif.
        const definitive = error instanceof JupiterApiError && error.status === 400;
        const label = `échec /build : ${messageOf(error)}`;
        lastFailure = { kind: 'order', label, code: ROUTER_CODES.build };
        attempts.push({
          attempt,
          requestId: null,
          code: ROUTER_CODES.build,
          label,
          signature: null,
        });
        if (!definitive && attempt < maxAttempts) continue;
        return this.outcome(
          mode,
          'failed',
          emptyOrderResponse(),
          null,
          null,
          attempts,
          null,
          lastFailure,
          {
            path: 'router',
          },
        );
      }

      const order = orderFromBuild(build);
      const buildError = buildSwapInstructionError(build.swapInstruction);
      if (buildError !== null) {
        lastFailure = { kind: 'order', label: buildError, code: ROUTER_CODES.build };
        attempts.push({
          attempt,
          requestId: null,
          code: ROUTER_CODES.build,
          label: buildError,
          signature: null,
        });
        const tradeId = this.record(order, request, mode, {
          status: 'failed',
          errorCode: ROUTER_CODES.build,
          errorMessage: buildError,
          path: 'router',
        });
        return this.outcome(mode, 'failed', order, null, null, attempts, tradeId, lastFailure, {
          path: 'router',
        });
      }

      await this.options.onQuote?.(order, attempt);

      // 2) Instructions préparées par la cible d'atterrissage (ex. virement de
      // tip Jito), puis simulation sonde (limite maximale) : la sonde mesure
      // ainsi les CU de la transaction réellement envoyée.
      const extraInstructions =
        landingTarget?.prepare !== undefined && tipLamports > 0
          ? await landingTarget.prepare({ taker: signer.publicKey, lamports: tipLamports })
          : [];
      // Transaction v1 uniquement si demandée et confirmée par la réponse
      // (`/build` force la v1 avec `transactionVersion=1` ; toute autre
      // réponse retombe prudemment sur l'assemblage v0).
      const useV1 = routerConfig.transaction_version === 1 && build.transactionVersion === 1;
      const cuPriceCap =
        routerConfig.cu_price_cap_microlamports > 0
          ? { cuPriceCapMicrolamports: routerConfig.cu_price_cap_microlamports }
          : {};
      const probeBase64 = useV1
        ? buildRouterTransactionV1({
            build,
            payerAddress: signer.address,
            cuLimit: COMPUTE_UNIT_LIMIT_MAX,
            ...cuPriceCap,
            additionalInstructions: extraInstructions,
          }).probeBase64
        : serializeTransaction(
            buildRouterTransaction({
              build,
              payerKey: signer.publicKey,
              cuLimit: COMPUTE_UNIT_LIMIT_MAX,
              additionalInstructions: extraInstructions,
            }).transaction,
          );
      const simulation = await simulate!(probeBase64);
      const simulationError = simulation.err === null ? null : failureText(simulation.err);

      if (simulationError !== null && mode === 'live') {
        // La transaction telle que construite serait rejetée : on re-cote, en
        // élargissant la borne si le refus est un dépassement de slippage.
        if (isSlippageFailure(simulationError)) {
          slippageBps = this.bumpSlippage(slippageBps, request);
        }
        const label = `simulation en échec : ${simulationError}`;
        lastFailure = { kind: 'execute', label, code: ROUTER_CODES.simulation };
        attempts.push({
          attempt,
          requestId: null,
          code: ROUTER_CODES.simulation,
          label,
          signature: null,
        });
        if (attempt < maxAttempts) continue;
        const tradeId = this.record(order, request, mode, {
          status: 'failed',
          errorCode: ROUTER_CODES.simulation,
          errorMessage: label,
          path: 'router',
        });
        return this.outcome(
          mode,
          'failed',
          order,
          null,
          simulation,
          attempts,
          tradeId,
          lastFailure,
          {
            path: 'router',
          },
        );
      }

      // 3) Transaction finale : limite = buffer × CU simulés, prix éventuellement plafonné.
      const cuLimit = computeUnitLimitFromSimulation(
        simulation.unitsConsumed,
        routerConfig.cu_limit_buffer,
      );
      let details: RouterExecutionDetails;
      /** Signe et sérialise la transaction finale (v0 : web3.js ; v1 : kit). */
      let finalize: () => Promise<SignedRouterTransaction>;
      if (useV1) {
        const assembled = buildRouterTransactionV1({
          build,
          payerAddress: signer.address,
          cuLimit,
          ...cuPriceCap,
          additionalInstructions: extraInstructions,
        });
        details = {
          cuLimit: assembled.cuLimit,
          cuPriceMicrolamports: assembled.cuPriceMicrolamports,
          tipLamports: tipLamports > 0 ? tipLamports : null,
          landing: null,
          landingMs: null,
        };
        finalize = async () => {
          const signBytes = signer.signBytes;
          if (signBytes === undefined) {
            throw new SolbotError(
              'transactions v1 : le signer ne sait pas signer un message brut',
              {
                hint: 'Utilisez EnvSigner ou repassez transaction_version à 0 dans config.yaml.',
              },
            );
          }
          const signed = await assembled.sign((message) => signBytes.call(signer, message));
          return {
            signedTransaction: signed.signedBase64,
            signature: signed.signature,
            blockhash: assembled.blockhash,
            lastValidBlockHeight: assembled.lastValidBlockHeight,
          };
        };
      } else {
        const assembled = buildRouterTransaction({
          build,
          payerKey: signer.publicKey,
          cuLimit,
          additionalInstructions: extraInstructions,
          ...cuPriceCap,
        });
        details = {
          cuLimit: assembled.cuLimit,
          cuPriceMicrolamports: assembled.cuPriceMicrolamports,
          tipLamports: tipLamports > 0 ? tipLamports : null,
          landing: null,
          landingMs: null,
        };
        finalize = async () => {
          signer.signTransaction(assembled.transaction);
          const [signatureBytes] = assembled.transaction.signatures;
          if (signatureBytes === undefined) {
            throw new SolbotError('signature locale manquante après signature de la transaction');
          }
          return {
            signedTransaction: serializeTransaction(assembled.transaction),
            signature: bs58.encode(signatureBytes),
            blockhash: assembled.blockhash,
            lastValidBlockHeight: assembled.lastValidBlockHeight,
          };
        };
      }
      const routerFields = {
        path: 'router' as const,
        cuLimit: details.cuLimit,
        cuPriceMicrolamports: details.cuPriceMicrolamports,
        tipLamports: details.tipLamports,
      };

      if (mode !== 'live') {
        const tradeId = this.record(order, request, mode, {
          status: 'simulated',
          errorCode: null,
          errorMessage: simulationError,
          ...routerFields,
        });
        return this.outcome(mode, 'simulated', order, null, simulation, attempts, tradeId, null, {
          path: 'router',
          router: details,
        });
      }

      // 4) Signature puis atterrissage par nos soins.
      const landing = this.options.landing!;
      const signed = await finalize();
      const landingContext = {
        blockhash: signed.blockhash,
        lastValidBlockHeight: signed.lastValidBlockHeight,
        outputMint: request.outputMint,
        taker: signer.address,
        signature: signed.signature,
      };

      const startedAt = Date.now();
      let sendResult: LandingSendResult;
      try {
        sendResult = await landing.send(signed.signedTransaction, landingContext);
      } catch (error) {
        // Envoi refusé (preflight RPC ou cible d'atterrissage) = jamais soumise
        // → re-cotation sûre. Autre erreur (5xx, timeout) = sort inconnu : on
        // n'enchaîne pas un second envoi à l'aveugle.
        const rejected = error instanceof SendTransactionError || error instanceof LandingSendError;
        const label = `envoi refusé : ${messageOf(error)}`;
        lastFailure = { kind: 'execute', label, code: ROUTER_CODES.send };
        attempts.push({
          attempt,
          requestId: null,
          code: ROUTER_CODES.send,
          label,
          signature: null,
        });
        if (rejected && attempt < maxAttempts) continue;
        const tradeId = this.record(order, request, mode, {
          status: 'failed',
          errorCode: ROUTER_CODES.send,
          errorMessage: label,
          landing: landing.name,
          ...routerFields,
        });
        return this.outcome(
          mode,
          'failed',
          order,
          null,
          simulation,
          attempts,
          tradeId,
          lastFailure,
          {
            path: 'router',
            router: { ...details, landing: landing.name },
          },
        );
      }

      const signature = sendResult.signature;

      let confirmation: LandingConfirmation;
      try {
        confirmation = await landing.confirm(signature, landingContext, sendResult);
      } catch (error) {
        // Timeout/expiration : la transaction peut encore atterrir — jamais de réessai ici.
        const landingMs = Date.now() - startedAt;
        const label = `confirmation incertaine : ${messageOf(error)} — vérifiez ${signature} on-chain avant toute action`;
        lastFailure = { kind: 'execute', label, code: ROUTER_CODES.confirmUnknown };
        attempts.push({
          attempt,
          requestId: null,
          code: ROUTER_CODES.confirmUnknown,
          label,
          signature,
        });
        const tradeId = this.record(order, request, mode, {
          status: 'failed',
          signature,
          errorCode: ROUTER_CODES.confirmUnknown,
          errorMessage: label,
          landing: landing.name,
          landingMs,
          ...routerFields,
        });
        return this.outcome(
          mode,
          'failed',
          order,
          null,
          simulation,
          attempts,
          tradeId,
          lastFailure,
          {
            path: 'router',
            router: { ...details, landing: landing.name, landingMs },
          },
        );
      }
      const landingMs = Date.now() - startedAt;

      const chainError = confirmation.err;
      const succeeded = chainError === null || chainError === undefined;
      if (!succeeded) {
        const label = `transaction rejetée on-chain : ${failureText(chainError)}`;
        // Rejet de type slippage : on élargit la borne pour la re-cotation.
        if (isSlippageFailure(label)) {
          slippageBps = this.bumpSlippage(slippageBps, request);
        }
        lastFailure = { kind: 'execute', label, code: ROUTER_CODES.landing };
        attempts.push({ attempt, requestId: null, code: ROUTER_CODES.landing, label, signature });
        if (attempt < maxAttempts) continue;
        const tradeId = this.record(order, request, mode, {
          status: 'failed',
          signature,
          errorCode: ROUTER_CODES.landing,
          errorMessage: label,
          landing: landing.name,
          landingMs,
          ...routerFields,
        });
        return this.outcome(
          mode,
          'failed',
          order,
          null,
          simulation,
          attempts,
          tradeId,
          lastFailure,
          {
            path: 'router',
            router: { ...details, landing: landing.name, landingMs },
          },
        );
      }

      const outAmount = confirmation.outAmountBaseUnits;
      const realizedSlippageBps = computeRealizedSlippageBps(order.outAmount, outAmount);
      const execute: ExecuteResponse = {
        status: 'Success',
        signature,
        code: 0,
        totalOutputAmount: outAmount,
        error: null,
      };
      attempts.push({ attempt, requestId: null, code: 0, label: 'succès', signature });
      const tradeId = this.record(order, request, mode, {
        status: 'success',
        signature,
        outAmount,
        realizedSlippageBps,
        errorCode: null,
        errorMessage: null,
        landing: landing.name,
        landingMs,
        ...routerFields,
      });
      return this.outcome(mode, 'success', order, execute, simulation, attempts, tradeId, null, {
        path: 'router',
        router: { ...details, landing: landing.name, landingMs },
        signature,
        realizedSlippageBps,
      });
    }

    // Inatteignable (la boucle retourne toujours), garde-fou TypeScript.
    throw new SolbotError('Échec inattendu : aucune tentative effectuée', {
      hint: lastFailure?.label ?? 'erreur interne',
    });
  }

  private record(
    order: OrderResponse,
    request: SwapRequest,
    mode: SwapExecutionMode,
    overrides: {
      status: TradeRecord['status'];
      signature?: string | null;
      outAmount?: string | null;
      realizedSlippageBps?: number | null;
      errorCode: number | null;
      errorMessage: string | null;
      path?: ExecutionPath;
      cuLimit?: number | null;
      cuPriceMicrolamports?: number | null;
      tipLamports?: number | null;
      landing?: string | null;
      landingMs?: number | null;
    },
  ): number | null {
    const { db } = this.options;
    if (db === undefined) return null;
    return insertTrade(db, {
      mode,
      status: overrides.status,
      signature: overrides.signature ?? null,
      requestId: order.requestId ?? null,
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inAmount: request.amountBaseUnits.toString(),
      expectedOutAmount: order.outAmount ?? null,
      outAmount: overrides.outAmount ?? null,
      router: order.router ?? null,
      feeBps: order.feeBps ?? null,
      feeMint: order.feeMint ?? null,
      priceImpact: order.priceImpact ?? null,
      slippageBps: order.slippageBps ?? request.slippageBps ?? null,
      realizedSlippageBps: overrides.realizedSlippageBps ?? null,
      errorCode: overrides.errorCode,
      errorMessage: overrides.errorMessage,
      createdAt: Date.now(),
      path: overrides.path ?? 'meta_aggregator',
      cuLimit: overrides.cuLimit ?? null,
      cuPriceMicrolamports: overrides.cuPriceMicrolamports ?? null,
      tipLamports: overrides.tipLamports ?? null,
      landing: overrides.landing ?? null,
      landingMs: overrides.landingMs ?? null,
    });
  }

  private outcome(
    mode: SwapExecutionMode,
    status: SwapOutcome['status'],
    order: OrderResponse,
    execute: ExecuteResponse | null,
    simulation: SimulationSummary | null,
    attempts: ExecuteAttempt[],
    tradeId: number | null,
    failure: SwapFailure | null,
    extra: {
      signature?: string | null;
      realizedSlippageBps?: number | null;
      path?: ExecutionPath;
      router?: RouterExecutionDetails | null;
    } = {},
  ): SwapOutcome {
    return {
      mode,
      status,
      order,
      execute,
      simulation,
      attempts,
      signature: extra.signature ?? null,
      realizedSlippageBps: extra.realizedSlippageBps ?? null,
      tradeId,
      failure,
      path: extra.path ?? 'meta_aggregator',
      router: extra.router ?? null,
    };
  }
}

/** Sérialise une transaction (signée ou non) en base64, prête pour le RPC. */
function serializeTransaction(transaction: VersionedTransaction): string {
  return Buffer.from(transaction.serialize()).toString('base64');
}

/** Normalise la citation `/build` au format `/order` (le reste du code ne voit pas la différence). */
function orderFromBuild(build: BuildResponse): OrderResponse {
  const priceImpactPct =
    build.priceImpactPct === undefined ? undefined : Number(build.priceImpactPct);
  return {
    outAmount: build.outAmount,
    router: 'metis',
    feeBps: 0,
    ...(build.inputMint === undefined ? {} : { inputMint: build.inputMint }),
    ...(build.outputMint === undefined ? {} : { outputMint: build.outputMint }),
    ...(build.inAmount === undefined ? {} : { inAmount: build.inAmount }),
    ...(build.otherAmountThreshold === undefined
      ? {}
      : { otherAmountThreshold: build.otherAmountThreshold }),
    ...(build.swapMode === undefined ? {} : { swapMode: build.swapMode }),
    ...(build.slippageBps === undefined ? {} : { slippageBps: build.slippageBps }),
    ...(priceImpactPct === undefined || !Number.isFinite(priceImpactPct)
      ? {}
      : { priceImpact: priceImpactPct * 100 }),
    ...(build.routePlan === undefined ? {} : { routePlan: build.routePlan }),
  };
}

/** Citation vide pour les échecs `/build` sans réponse exploitable (pas de ligne `trades`). */
function emptyOrderResponse(): OrderResponse {
  return { outAmount: '0' };
}

/** Slippage réalisé en bps vs `outAmount` attendu (positif = exécution moins bonne). */
export function computeRealizedSlippageBps(
  expectedOutAmount: string | undefined,
  actualOutAmount: string | null | undefined,
): number | null {
  if (
    expectedOutAmount === undefined ||
    actualOutAmount === null ||
    actualOutAmount === undefined
  ) {
    return null;
  }
  try {
    const expected = BigInt(expectedOutAmount);
    const actual = BigInt(actualOutAmount);
    if (expected <= 0n) return null;
    return Number(((expected - actual) * 10_000n) / expected);
  } catch {
    return null;
  }
}

function parseBlockHeight(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
