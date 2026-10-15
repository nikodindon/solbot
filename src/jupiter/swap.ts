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
 * Schémas — Router path (`GET /swap/v2/build`)
 * ────────────────────────────────────────────────────────────── */

const AccountMetaSchema = z.object({
  pubkey: z.string(),
  isWritable: z.boolean(),
  isSigner: z.boolean(),
});

/** Instruction brute (base64) renvoyée par `/build` — assemblée par nos soins. */
export const ApiInstructionSchema = z.object({
  programId: z.string(),
  accounts: z.array(AccountMetaSchema),
  data: z.string(),
});

export type ApiInstruction = z.infer<typeof ApiInstructionSchema>;

/** `swapInstruction` porte `{ error }` quand aucune route exploitable n'existe. */
export type BuildSwapInstruction = ApiInstruction | { error: string };

/** Blockhash fourni par `/build` (octets + validité) — l'envoi reste à notre charge. */
export const BlockhashWithMetadataSchema = z.object({
  blockhash: z.array(z.number().int().min(0).max(255)),
  lastValidBlockHeight: z.number(),
  fetchedAt: z.object({ secs_since_epoch: z.number(), nanos_since_epoch: z.number() }).optional(),
});

export type BlockhashWithMetadata = z.infer<typeof BlockhashWithMetadataSchema>;

/**
 * Réponse de `GET /swap/v2/build`. Schéma tolérant (`passthrough`) : l'API V2
 * évolue, seuls les champs essentiels au flux sont validés.
 */
export const BuildResponseSchema = z
  .object({
    inputMint: z.string().optional(),
    outputMint: z.string().optional(),
    inAmount: z.string().optional(),
    outAmount: z.string().default('0'),
    otherAmountThreshold: z.string().optional(),
    swapMode: z.string().optional(),
    slippageBps: z.number().optional(),
    /** Ratio décimal (« 0.001 » = 0,1 %) — converti en % par l'exécuteur. */
    priceImpactPct: z.string().optional(),
    routePlan: z.array(RoutePlanStepSchema).optional(),
    computeBudgetInstructions: z.array(ApiInstructionSchema).default([]),
    setupInstructions: z.array(ApiInstructionSchema).default([]),
    swapInstruction: z
      .union([ApiInstructionSchema, z.object({ error: z.string() })])
      .nullable()
      .optional(),
    cleanupInstruction: ApiInstructionSchema.nullable().optional(),
    otherInstructions: z.array(ApiInstructionSchema).default([]),
    tipInstruction: ApiInstructionSchema.nullable().optional(),
    addressesByLookupTableAddress: z.record(z.string(), z.array(z.string())).nullable().optional(),
    computeUnitPrice: z.string().optional(),
    transactionVersion: z.number().optional(),
    blockhashWithMetadata: BlockhashWithMetadataSchema.optional(),
  })
  .passthrough();

export type BuildResponse = z.infer<typeof BuildResponseSchema>;

/** Extrait l'erreur de `swapInstruction` (null si l'instruction est exploitable). */
export function buildSwapInstructionError(
  swapInstruction: BuildSwapInstruction | null | undefined,
): string | null {
  if (swapInstruction === null || swapInstruction === undefined) {
    return 'réponse /build sans instruction de swap';
  }
  if ('error' in swapInstruction) return swapInstruction.error;
  return null;
}

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
 * Paramètres /build (Router path)
 * ────────────────────────────────────────────────────────────── */

export interface BuildParams {
  inputMint: string;
  outputMint: string;
  /** Montant en unités de base (smallest unit) du token d'entrée. */
  amount: string;
  /** Adresse qui paiera et signera (nos swaps sont auto-financés : taker = payeur). */
  taker: string;
  /** Bps de slippage (0–10000), ou `'rtse'` pour le slippage automatique Jupiter. */
  slippageBps?: number | 'rtse';
  /** Cherté des compute units : percentile nommé ou bps (0–10000). */
  computeUnitPricePercentile?: 'medium' | 'high' | 'veryHigh' | number;
  /** Plafonne le nombre de comptes de la route (transaction plus compacte). */
  maxAccounts?: number;
  /** `fast` : latence réduite, routage légèrement moins optimal. */
  mode?: 'fast';
  /** Tip en lamports (≥ 1 000 000 pour l'infra d'atterrissage Jupiter) — ajoute `tipInstruction`. */
  tipAmount?: number;
  /** Tip taillé pour un bundle Jito (atterrissage Jito — Phase 6b). */
  forJitoBundle?: boolean;
  transactionVersion?: '0' | '1';
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

  /** Instructions brutes de swap (Router path, Phase 6) — assemblage et envoi à notre charge. */
  getBuild(params: BuildParams): Promise<BuildResponse> {
    return this.client.getJson('/swap/v2/build', BuildResponseSchema, {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      taker: params.taker,
      slippageBps: params.slippageBps,
      computeUnitPricePercentile: params.computeUnitPricePercentile,
      maxAccounts: params.maxAccounts,
      mode: params.mode,
      tipAmount: params.tipAmount,
      forJitoBundle: params.forJitoBundle,
      transactionVersion: params.transactionVersion,
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
