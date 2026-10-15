import type { DatabaseSync } from 'node:sqlite';
import { VersionedTransaction } from '@solana/web3.js';
import {
  describeExecuteError,
  describeOrderFailure,
  type ExecuteResponse,
  type OrderResponse,
  type SwapApi,
} from '../jupiter/swap.js';
import { insertTrade, type TradeRecord } from '../state/trades.js';
import type { Config } from '../utils/config.js';
import { SolbotError, messageOf } from '../utils/errors.js';
import type { Signer } from '../wallet/signer.js';

export type SwapExecutionMode = 'paper' | 'dry_run' | 'live';

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
}

/** Simule une transaction base64 (implémentation RPC fournie par le CLI). */
export type SimulateTransaction = (transactionBase64: string) => Promise<SimulationSummary>;

export interface ExecutorOptions {
  swapApi: SwapApi;
  config: Config;
  signer: Signer;
  /** Requis en paper/dry-run : simule la transaction assemblée, sans signature. */
  simulate?: SimulateTransaction;
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
 * Orchestre un swap Meta-Aggregator : `/order` → (simulation | signature) → `/execute`.
 *
 * Stratégie d'échec par code `/execute` (voir `EXECUTE_ERRORS`) : `requote`
 * relance un ordre frais tant qu'il reste des tentatives, `abort` s'arrête
 * immédiatement. Les échecs prévisibles sont retournés dans `SwapOutcome.failure`
 * (jamais levés) et journalisés dans la table `trades`.
 */
export class Executor {
  constructor(private readonly options: ExecutorOptions) {}

  async swap(request: SwapRequest, mode: SwapExecutionMode): Promise<SwapOutcome> {
    const { config, signer, simulate, swapApi } = this.options;

    if (config.execution.path !== 'meta_aggregator') {
      throw new SolbotError("execution.path = 'router' n'est pas encore implémenté", {
        hint: "Passez execution.path à 'meta_aggregator' (chemin avancé prévu en Phase 6).",
      });
    }
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

    const slippageBps =
      request.slippageBps ??
      (typeof config.execution.slippage === 'number' ? config.execution.slippage : undefined);
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
        ...(slippageBps === undefined ? {} : { slippageBps }),
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
        const simulationError = simulation.err === null ? null : messageOf(simulation.err);
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
      if (info.strategy === 'requote' && attempt < maxAttempts) continue;

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
    extra: { signature?: string | null; realizedSlippageBps?: number | null } = {},
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
    };
  }
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
