import { z } from 'zod';
import type { JupiterClient } from './client.js';

/* ──────────────────────────────────────────────────────────────
 * Schémas — Swap API V2 (`/swap/v2/order`, `/swap/v2/execute`)
 * ────────────────────────────────────────────────────────────── */

const RoutePlanStepSchema = z
  .object({
    swapInfo: z
      .object({
        ammKey: z.string().optional(),
        label: z.string().optional(),
        inputMint: z.string().optional(),
        outputMint: z.string().optional(),
        inAmount: z.string().optional(),
        outAmount: z.string().optional(),
      })
      .passthrough()
      .optional(),
    percent: z.number().optional(),
    bps: z.number().optional(),
    usdValue: z.number().optional(),
  })
  .passthrough();

const PlatformFeeSchema = z
  .object({
    amount: z.string().optional(),
    feeBps: z.number().optional(),
    feeMint: z.string().optional(),
  })
  .passthrough();

/**
 * Réponse de `GET /swap/v2/order`. Schéma tolérant (`passthrough`) : l'API V2 est
 * récente et ses champs évoluent. Les champs essentiels au flux sont validés
 * dans `SwapApi.getOrder`, pas ici.
 */
export const OrderResponseSchema = z
  .object({
    mode: z.string().optional(),
    inputMint: z.string().optional(),
    outputMint: z.string().optional(),
    inAmount: z.string().optional(),
    outAmount: z.string().default('0'),
    inUsdValue: z.number().optional(),
    outUsdValue: z.number().optional(),
    /** Impact en points de pourcentage (ex. -0.1 = -0.1 %). */
    priceImpact: z.number().optional(),
    otherAmountThreshold: z.string().optional(),
    swapMode: z.string().optional(),
    slippageBps: z.number().optional(),
    routePlan: z.array(RoutePlanStepSchema).optional(),
    feeMint: z.string().optional(),
    feeBps: z.number().optional(),
    platformFee: PlatformFeeSchema.optional(),
    router: z.string().optional(),
    transactionVersion: z.union([z.number(), z.string()]).optional(),
    /** base64 ; `null` si `taker` absent, `""` si la transaction n'a pas pu être construite (voir `errorCode`). */
    transaction: z.string().nullable().optional(),
    lastValidBlockHeight: z.string().optional(),
    gasless: z.boolean().optional(),
    signatureFeePayer: z.string().nullable().optional(),
    requestId: z.string().optional(),
    taker: z.string().nullable().optional(),
    quoteId: z.string().optional(),
    maker: z.string().optional(),
    /** Expiration RFQ (JupiterZ). */
    expireAt: z.string().optional(),
    errorCode: z.number().optional(),
    errorMessage: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export type OrderResponse = z.infer<typeof OrderResponseSchema>;

export const ExecuteResponseSchema = z
  .object({
    status: z.string(),
    signature: z.string().nullable().optional(),
    code: z.number(),
    totalInputAmount: z.string().nullable().optional(),
    totalOutputAmount: z.string().nullable().optional(),
    inputAmountResult: z.string().nullable().optional(),
    outputAmountResult: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
  })
  .passthrough();

export type ExecuteResponse = z.infer<typeof ExecuteResponseSchema>;

/* ──────────────────────────────────────────────────────────────
 * Paramètres /order
 * ────────────────────────────────────────────────────────────── */

export interface OrderParams {
  inputMint: string;
  outputMint: string;
  /** Montant en unités de base (smallest unit) du token d'entrée. */
  amount: string;
  /** Adresse du wallet qui signera — requis pour obtenir une transaction assemblée. */
  taker: string;
  /** Bps de slippage (0–10000). Absent → RTSE automatique. */
  slippageBps?: number;
  receiver?: string;
  /** Routeurs à exclure (`metis`, `jupiterz`, `dflow`, `okx`). */
  excludeRouters?: string[];
  maxSupportedTransactionVersion?: '0' | '1';
  priorityFeeLamports?: number;
  jitoTipLamports?: number;
}

/* ──────────────────────────────────────────────────────────────
 * Taxonomie des erreurs
 * ────────────────────────────────────────────────────────────── */

/** Stratégie de réaction après un échec d'exécution. */
export type ExecuteStrategy = 'requote' | 'abort';

export interface ExecuteErrorInfo {
  label: string;
  strategy: ExecuteStrategy;
  /** Transition vers le code suivant possible (retry borné). */
  hint?: string;
}

/** Codes `/execute` — 0 = succès ; négatifs = erreurs (agrégateur puis RFQ). */
export const EXECUTE_ERRORS: Readonly<Record<number, ExecuteErrorInfo>> = {
  [-1]: {
    label: 'commande en cache introuvable (requestId inconnu ou expiré)',
    strategy: 'requote',
  },
  [-2]: { label: 'transaction signée invalide', strategy: 'abort' },
  [-3]: { label: 'octets de message invalides', strategy: 'abort' },
  [-1000]: { label: 'échec d’atterrissage (agrégateur)', strategy: 'requote' },
  [-1001]: { label: 'erreur inconnue (agrégateur)', strategy: 'requote' },
  [-1002]: { label: 'transaction invalide (agrégateur)', strategy: 'abort' },
  [-1003]: { label: 'transaction partiellement signée (agrégateur)', strategy: 'abort' },
  [-1004]: { label: 'block height invalide (agrégateur)', strategy: 'requote' },
  [-1005]: {
    label: 'transaction expirée avant atterrissage (blockhash périmé)',
    strategy: 'requote',
    hint: 'Signez et soumettez plus vite, ou relancez un ordre frais.',
  },
  [-2000]: { label: 'échec d’atterrissage (RFQ)', strategy: 'requote' },
  [-2001]: { label: 'erreur inconnue (RFQ)', strategy: 'requote' },
  [-2002]: { label: 'payload invalide (RFQ)', strategy: 'abort' },
  [-2003]: { label: 'citation expirée (RFQ)', strategy: 'requote' },
  [-2004]: {
    label: 'swap rejeté par le market maker (RFQ)',
    strategy: 'requote',
    hint: 'Rejet last-look du MM — un ordre frais ou un autre routeur peut passer.',
  },
};

export function describeExecuteError(code: number): ExecuteErrorInfo {
  return EXECUTE_ERRORS[code] ?? { label: `code d’erreur inconnu (${code})`, strategy: 'abort' };
}

/** Codes `/order` quand `transaction` = `""`. Le sens dépend du routeur. */
export function describeOrderFailure(
  router: string | undefined,
  errorCode: number | undefined,
): { label: string; hint?: string } {
  const rfq = router === 'jupiterz';
  if (errorCode === 1) {
    return rfq
      ? {
          label: 'solde insuffisant pour financer le swap (RFQ)',
          hint: 'Financez le wallet avec le token d’entrée.',
        }
      : {
          label: 'fonds insuffisants — le wallet ne détient pas le montant demandé',
          hint: 'Réduisez le montant ou créditez le wallet.',
        };
  }
  if (errorCode === 2) {
    return rfq
      ? {
          label: 'compte de token associé manquant (RFQ)',
          hint: 'Le market maker exige un ATA existant pour le token de sortie.',
        }
      : {
          label: 'SOL insuffisant pour payer les frais de réseau',
          hint: 'Conservez ≥ 0.05 SOL (risk.sol_gas_reserve).',
        };
  }
  if (errorCode === 3) {
    return rfq
      ? { label: 'le market maker n’a pas pu construire de transaction' }
      : {
          label: 'montant sous le minimum pour le mode gasless',
          hint: 'Augmentez le montant ou désactivez le gasless (excludeRouters=jupiterz).',
        };
  }
  return { label: `impossible de construire la transaction (code ${errorCode ?? 'inconnu'})` };
}

/** Routeurs connus de la Meta-Aggregator, pour affichage. */
export const ROUTER_LABELS: Readonly<Record<string, string>> = {
  metis: 'Metis (on-chain)',
  jupiterz: 'JupiterZ (RFQ)',
  dflow: 'Dflow',
  okx: 'OKX',
};

export function routerLabel(router: string | undefined): string {
  if (router === undefined) return '—';
  return ROUTER_LABELS[router] ?? router;
}

/* ──────────────────────────────────────────────────────────────
 * Client
 * ────────────────────────────────────────────────────────────── */

/** API Swap V2 : `GET /order` (citation + transaction) et `POST /execute` (landing managé). */
export class SwapApi {
  constructor(private readonly client: JupiterClient) {}

  getOrder(params: OrderParams): Promise<OrderResponse> {
    return this.client.getJson('/swap/v2/order', OrderResponseSchema, {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      taker: params.taker,
      slippageBps: params.slippageBps,
      receiver: params.receiver,
      excludeRouters:
        params.excludeRouters !== undefined && params.excludeRouters.length > 0
          ? params.excludeRouters.join(',')
          : undefined,
      maxSupportedTransactionVersion: params.maxSupportedTransactionVersion,
      priorityFeeLamports: params.priorityFeeLamports,
      jitoTipLamports: params.jitoTipLamports,
    });
  }

  execute(request: {
    signedTransaction: string;
    requestId: string;
    lastValidBlockHeight?: number;
  }): Promise<ExecuteResponse> {
    return this.client.postJson('/swap/v2/execute', ExecuteResponseSchema, {
      signedTransaction: request.signedTransaction,
      requestId: request.requestId,
      lastValidBlockHeight: request.lastValidBlockHeight,
    });
  }
}
