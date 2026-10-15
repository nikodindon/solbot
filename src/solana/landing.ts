import {
  PublicKey,
  SystemProgram,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import { SOL_MINT } from '../constants.js';
import { SolbotError, messageOf } from '../utils/errors.js';
import { sleep } from '../utils/retry.js';

/**
 * Atterrissage des transactions signées (Phase 6, chemin Router).
 *
 * Le chemin Meta-Aggregator délègue l'envoi à Jupiter (`/execute`) ; le chemin
 * Router envoie lui-même. Trois cibles sont disponibles (Phase 6a/6b) :
 * - `rpc` : notre propre nœud Solana (`sendRawTransaction`) ;
 * - `tx_jup` : infra d'atterrissage Jupiter (`tx.jup.ag`, envoi seul, tip
 *   ≥ 0,001 SOL vers un compte Jupiter ajouté par `/build?tipAmount=`) ;
 * - `jito` : bundles Jito (tip vers un compte Jito ajouté par nos soins,
 *   suivi du sort du bundle pour distinguer « jamais envoyé » d'« incertain »).
 *
 * Dans tous les cas la confirmation se fait sur notre RPC, qui reste la source
 * de vérité on-chain — dont le montant réellement reçu, pour le PnL.
 */

export interface LandingContext {
  blockhash: string;
  lastValidBlockHeight: number;
  /** Mint de sortie attendu (calcul du montant reçu). */
  outputMint: string;
  /** Wallet taker/signataire (calcul du montant reçu). */
  taker: string;
  /** Signature locale (bs58) de la transaction signée — connue avant tout envoi. */
  signature: string;
}

export interface LandingSendResult {
  signature: string;
  /** Identifiant de bundle (Jito) — permet de suivre le sort du bundle. */
  bundleId?: string;
}

export interface LandingConfirmation {
  /** `null` = confirmée sans erreur on-chain. */
  err: unknown;
  slot: number | null;
  /** Montant réellement reçu sur `outputMint` (unités de base), si déductible. */
  outAmountBaseUnits: string | null;
  feeLamports: number | null;
}

/** Contrainte de tip imposée par une cible d'atterrissage. */
export interface LandingTipRequirement {
  /** Tip minimal (lamports) — le bot coupe la poire en deux via un `max` avec la config. */
  minLamports: number;
  /** Tail la transaction pour un bundle Jito (exclut les DEX incompatibles). */
  forJitoBundle?: boolean;
}

/** Paramètres d'un virement de tip à insérer avant signature (ex. compte Jito). */
export interface LandingTipPreparation {
  taker: PublicKey;
  lamports: number;
}

export interface LandingTarget {
  readonly name: string;
  /** Contrainte de tip de la cible (`undefined` = aucun minimum, la config seule décide). */
  readonly tip?: LandingTipRequirement;
  /**
   * Pré-chauffe best-effort, lancée en parallèle du premier `/build` (latence) :
   * ex. récupération des comptes de tip Jito. Ne doit jamais lever — `prepare`
   * reste la voie de référence.
   */
  warmup?(): Promise<void>;
  /**
   * Instructions à ajouter à la transaction avant signature (ex. virement de
   * tip Jito, dont le compte destinataire est choisi au dernier moment).
   */
  prepare?(request: LandingTipPreparation): Promise<TransactionInstruction[]>;
  send(signedBase64: string, context: LandingContext): Promise<LandingSendResult>;
  confirm(
    signature: string,
    context: LandingContext,
    sendResult: LandingSendResult,
  ): Promise<LandingConfirmation>;
}

/**
 * Envoi refusé par la cible d'atterrissage (preflight refusé, HTTP 4xx,
 * erreur JSON-RPC) : la transaction n'a jamais été soumise au réseau.
 * Le bot peut donc la re-coter sans risque de double exécution.
 */
export class LandingSendError extends SolbotError {}

export interface TokenBalanceLike {
  mint: string;
  owner?: string | undefined;
  uiTokenAmount: { amount: string };
}

/** Forme minimale d'une transaction confirmée (`getTransaction`) — testable sans RPC. */
export interface ConfirmedTransactionLike {
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: ReadonlyArray<TokenBalanceLike | undefined | null> | null;
    postTokenBalances?: ReadonlyArray<TokenBalanceLike | undefined | null> | null;
  } | null;
  transaction: {
    message: {
      staticAccountKeys?: readonly PublicKey[] | undefined;
      accountKeys?: readonly PublicKey[] | undefined;
    };
  };
}

/**
 * Montant reçu déduit des balances de la transaction confirmée :
 * - token SPL : delta des post/pré-balances du taker pour `outputMint` ;
 * - SOL natif : delta de lamports du taker + frais payés (best-effort — les
 *   variations de rent des ATA sont lissées par la réconciliation au démarrage).
 */
export function outputAmountFromTransaction(
  transaction: ConfirmedTransactionLike | null,
  taker: string,
  outputMint: string,
): string | null {
  const meta = transaction?.meta ?? null;
  if (meta === null) return null;
  if (meta.err !== null && meta.err !== undefined) return null;

  if (outputMint !== SOL_MINT) {
    const total = (
      balances: ReadonlyArray<TokenBalanceLike | undefined | null> | null | undefined,
    ): bigint => {
      let sum = 0n;
      for (const balance of balances ?? []) {
        if (balance === undefined || balance === null) continue;
        if (balance.mint !== outputMint || balance.owner !== taker) continue;
        sum += BigInt(balance.uiTokenAmount.amount);
      }
      return sum;
    };
    const delta = total(meta.postTokenBalances) - total(meta.preTokenBalances);
    return delta > 0n ? delta.toString() : null;
  }

  const message = transaction?.transaction.message;
  const keys = message?.staticAccountKeys ?? message?.accountKeys ?? [];
  const index = keys.findIndex((key) => key.toBase58() === taker);
  if (index < 0) return null;
  const delta = BigInt(meta.postBalances[index] ?? 0) - BigInt(meta.preBalances[index] ?? 0);
  const received = delta + BigInt(meta.fee);
  return received > 0n ? received.toString() : null;
}

/**
 * Confirmation via notre RPC (stratégie blockhash) puis reçu on-chain.
 * Partagée par toutes les cibles : `tx.jup.ag` et Jito n'offrent pas de lecture.
 */
export async function confirmViaRpc(
  connection: Connection,
  signature: string,
  context: LandingContext,
): Promise<LandingConfirmation> {
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: context.blockhash,
      lastValidBlockHeight: context.lastValidBlockHeight,
    },
    'confirmed',
  );
  const transaction = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    // 1 = plafond « à quelle version maximale je sais lire » : couvre v0 et v1
    // (Phase 6c) sans changer le résultat pour les transactions v0.
    maxSupportedTransactionVersion: 1,
  });
  const meta = transaction?.meta ?? null;
  return {
    err: confirmation.value.err ?? meta?.err ?? null,
    slot: confirmation.context.slot,
    outAmountBaseUnits: outputAmountFromTransaction(transaction, context.taker, context.outputMint),
    feeLamports: meta?.fee ?? null,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Cible 1 — notre nœud RPC
 * ──────────────────────────────────────────────────────────────────────────── */

/** Envoi et confirmation via notre propre nœud RPC (sans infra Jupiter). */
export class RpcLanding implements LandingTarget {
  readonly name = 'rpc';

  constructor(private readonly connection: Connection) {}

  async send(signedBase64: string): Promise<LandingSendResult> {
    const signature = await this.connection.sendRawTransaction(
      Buffer.from(signedBase64, 'base64'),
      { skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' },
    );
    return { signature };
  }

  confirm(signature: string, context: LandingContext): Promise<LandingConfirmation> {
    return confirmViaRpc(this.connection, signature, context);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Cible 2 — tx.jup.ag (infra Jupiter, envoi seul)
 * ──────────────────────────────────────────────────────────────────────────── */

export const TX_JUP_URL = 'https://tx.jup.ag';

export interface JupiterTxLandingOptions {
  connection: Connection;
  /** Clé API Jupiter (en-tête `x-api-key`) — obligatoire pour tx.jup.ag. */
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** URL du endpoint (défaut : `https://tx.jup.ag`) — surchargeable en test. */
  url?: string;
  /** Délai d'abandon de l'appel HTTP (ms). */
  timeoutMs?: number;
}

interface JsonRpcPayload {
  result?: unknown;
  error?: { code?: number; message?: string } | undefined;
}

/**
 * Requête JSON-RPC 2.0 générique (tx.jup.ag et Block Engine Jito).
 *
 * Classification d'erreur volontairement stricte : HTTP 4xx et erreurs
 * JSON-RPC = refus définitif (`LandingSendError` → réessai sûr) ; 5xx,
 * timeout et réseau = sort inconnu (jamais de réessai automatique).
 */
async function postJsonRpc(args: {
  url: string;
  method: string;
  params: unknown;
  label: string;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}): Promise<unknown> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (args.apiKey !== undefined) headers['x-api-key'] = args.apiKey;

  let response: Response;
  try {
    response = await fetchImpl(args.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: args.method, params: args.params }),
      signal: AbortSignal.timeout(args.timeoutMs ?? 15_000),
    });
  } catch (error) {
    throw new SolbotError(`${args.label} injoignable : ${messageOf(error)}`);
  }
  if (!response.ok) {
    const message = `${args.label} : HTTP ${response.status}`;
    if (response.status >= 400 && response.status < 500) throw new LandingSendError(message);
    throw new SolbotError(message);
  }
  const payload = (await response.json().catch(() => null)) as JsonRpcPayload | null;
  if (payload === null) throw new SolbotError(`${args.label} : réponse illisible`);
  if (payload.error !== undefined) {
    const detail = payload.error.message ?? `code ${payload.error.code ?? '?'}`;
    throw new LandingSendError(`${args.label} refusé : ${detail}`);
  }
  return payload.result;
}

/**
 * Atterrissage via `tx.jup.ag` : envoi seul via le `sendTransaction`
 * JSON-RPC de Jupiter (le tip ≥ 0,001 SOL doit déjà figurer dans la
 * transaction — `/build?tipAmount=` s'en charge). La confirmation se fait sur
 * notre RPC, qui reste la source de vérité.
 */
export class JupiterTxLanding implements LandingTarget {
  readonly name = 'tx_jup';
  /** Jupiter exige un tip d'au moins 0,001 SOL oscillant vers ses comptes. */
  readonly tip = { minLamports: 1_000_000 };

  constructor(private readonly options: JupiterTxLandingOptions) {}

  async send(signedBase64: string, context: LandingContext): Promise<LandingSendResult> {
    const signature = await postJsonRpc({
      url: this.options.url ?? TX_JUP_URL,
      method: 'sendTransaction',
      // Pas de `skipPreflight` : tx.jup.ag le refuse explicitement (code -1015).
      params: [signedBase64, { encoding: 'base64' }],
      label: 'atterrissage tx.jup.ag',
      apiKey: this.options.apiKey,
      fetchImpl: this.options.fetchImpl,
      timeoutMs: this.options.timeoutMs,
    });
    if (typeof signature !== 'string' || signature !== context.signature) {
      throw new SolbotError('atterrissage tx.jup.ag : signature renvoyée inattendue', {
        hint:
          typeof signature === 'string'
            ? `attendu ${context.signature}, reçu ${signature}`
            : 'réponse sans signature',
      });
    }
    return { signature };
  }

  confirm(signature: string, context: LandingContext): Promise<LandingConfirmation> {
    return confirmViaRpc(this.options.connection, signature, context);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Cible 3 — Jito (bundles)
 * ──────────────────────────────────────────────────────────────────────────── */

export const JITO_BLOCK_ENGINE_URL = 'https://mainnet.block-engine.jito.wtf';
const JITO_BUNDLES_PATH = '/api/v1/bundles';

/** Régions officielles du Block Engine Jito (+ `global` = mainnet par défaut). */
export type JitoRegion =
  'global' | 'amsterdam' | 'frankfurt' | 'london' | 'ny' | 'slc' | 'singapore' | 'tokyo';

/**
 * URL du Block Engine Jito régional (Phase 6c) : choisir la région la plus
 * proche du VPS réduit la latence d'envoi du bundle (ex. `frankfurt` en
 * Europe). `global` = point d'entrée mainnet historique.
 */
export function jitoBlockEngineUrl(region: JitoRegion = 'global'): string {
  return region === 'global'
    ? JITO_BLOCK_ENGINE_URL
    : `https://${region}.mainnet.block-engine.jito.wtf`;
}

export interface JitoLandingOptions {
  connection: Connection;
  fetchImpl?: typeof fetch;
  /** Base du Block Engine (défaut : mainnet global) — surchargeable en test. */
  baseUrl?: string;
  /** Durée d'observation du sort du bundle avant de basculer sur la confirmation RPC. */
  bundleWaitMs?: number;
  /** Intervalle entre deux observations du bundle. */
  pollIntervalMs?: number;
}

interface JitoInflightStatus {
  status?: string | undefined;
}

type BundleVerdict = 'landed' | 'not_landed' | 'unknown';

/**
 * Atterrissage via un bundle Jito à un seul élément.
 *
 * Le virement de tip vers un compte Jito n'est *pas* ajouté par `/build` (le
 * tip de Jupiter part vers les comptes Jupiter) : il est préparé ici et
 * inséré dans la transaction par l'assembleur (`prepare`).
 *
 * Après envoi, le sort du bundle est observé (`getInflightBundleStatuses`) :
 * - `Failed` : aucune région n'a forwardé le bundle → la transaction n'ira
 *   jamais on-chain, un réessai est sûr ;
 * - `Landed` : bascule immédiate sur la confirmation RPC ;
 * - tout le reste (dont `Invalid`, potentiellement un décalage de région) ou
 *   un timeout d'observation : confirmation RPC, qui tranchera — en cas
 *   d'expiration le swap reste marqué « incertain » (jamais de réessai).
 */
export class JitoLanding implements LandingTarget {
  readonly name = 'jito';
  /** Planché de sécurité : sous ~1 000 lamports, aucun bundle n'est retenu. */
  readonly tip = { minLamports: 1_000, forJitoBundle: true };
  private tipAccountsPromise: Promise<string[]> | null = null;

  constructor(private readonly options: JitoLandingOptions) {}

  /**
   * Pré-charge les comptes de tip pendant que la transaction se construit.
   * Best-effort : un échec n'est pas propagé (aucun accusé mémorisé), la
   * prochaine demande (`prepare`) retentera pour de vrai.
   */
  async warmup(): Promise<void> {
    await this.getTipAccounts().catch(() => []);
  }

  /** Virement de tip vers un compte Jito (tiré au hasard pour répartir la charge). */
  async prepare(request: LandingTipPreparation): Promise<TransactionInstruction[]> {
    const accounts = await this.getTipAccounts();
    const recipient = accounts[Math.floor(Math.random() * accounts.length)];
    if (recipient === undefined) {
      throw new SolbotError('Jito : aucun compte de tip disponible');
    }
    return [
      SystemProgram.transfer({
        fromPubkey: request.taker,
        toPubkey: new PublicKey(recipient),
        lamports: request.lamports,
      }),
    ];
  }

  async send(signedBase64: string, context: LandingContext): Promise<LandingSendResult> {
    const bundleId = await postJsonRpc({
      url: this.bundlesUrl(),
      method: 'sendBundle',
      params: [[signedBase64]],
      label: 'Jito sendBundle',
      fetchImpl: this.options.fetchImpl,
    });
    if (typeof bundleId !== 'string') {
      throw new SolbotError('Jito : sendBundle sans identifiant de bundle');
    }
    return { signature: context.signature, bundleId };
  }

  async confirm(
    signature: string,
    context: LandingContext,
    sendResult: LandingSendResult,
  ): Promise<LandingConfirmation> {
    if (sendResult.bundleId !== undefined) {
      const verdict = await this.waitForBundle(sendResult.bundleId);
      if (verdict === 'not_landed') {
        // Échec définitif du bundle : la transaction n'existera jamais
        // on-chain, on peut donc la signaler comme rejetée (réessai sûr).
        return {
          err: 'bundle Jito non retenu (jamais forwardé)',
          slot: null,
          outAmountBaseUnits: null,
          feeLamports: null,
        };
      }
    }
    return confirmViaRpc(this.options.connection, signature, context);
  }

  /** Comptes de tip officiels, récupérés dynamiquement (jamais codés en dur). */
  getTipAccounts(): Promise<string[]> {
    // Promesse mémorisée : `warmup` et `prepare` peuvent la demander en même
    // temps — un seul aller-retour réseau. Un échec n'est pas mémorisé.
    this.tipAccountsPromise ??= this.fetchTipAccounts().catch((error: unknown) => {
      this.tipAccountsPromise = null;
      throw error;
    });
    return this.tipAccountsPromise;
  }

  private async fetchTipAccounts(): Promise<string[]> {
    const result = await postJsonRpc({
      url: this.bundlesUrl(),
      method: 'getTipAccounts',
      params: [],
      label: 'Jito getTipAccounts',
      fetchImpl: this.options.fetchImpl,
    });
    if (
      !Array.isArray(result) ||
      result.length === 0 ||
      !result.every((account): account is string => typeof account === 'string')
    ) {
      throw new SolbotError('Jito : réponse getTipAccounts invalide');
    }
    return result;
  }

  private bundlesUrl(): string {
    return `${this.options.baseUrl ?? JITO_BLOCK_ENGINE_URL}${JITO_BUNDLES_PATH}`;
  }

  /**
   * Observe le bundle jusqu'à un verdict (`Failed`/`Landed`) ou l'expiration
   * de la fenêtre d'observation. L'observation est best-effort : toute erreur
   * renvoie `unknown` et la confirmation RPC tranche.
   */
  private async waitForBundle(bundleId: string): Promise<BundleVerdict> {
    const deadline = Date.now() + (this.options.bundleWaitMs ?? 20_000);
    const intervalMs = this.options.pollIntervalMs ?? 2_000;
    while (Date.now() < deadline) {
      let status: string | null;
      try {
        const result = (await postJsonRpc({
          url: this.bundlesUrl(),
          method: 'getInflightBundleStatuses',
          params: [[bundleId]],
          label: 'Jito getInflightBundleStatuses',
          fetchImpl: this.options.fetchImpl,
        })) as { value?: ReadonlyArray<JitoInflightStatus | undefined> | null } | null;
        status = result?.value?.[0]?.status ?? null;
      } catch {
        return 'unknown';
      }
      if (status === 'Failed') return 'not_landed';
      if (status === 'Landed') return 'landed';
      await sleep(intervalMs);
    }
    return 'unknown';
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Fabrique
 * ──────────────────────────────────────────────────────────────────────────── */

export type LandingChoice = 'rpc' | 'tx_jup' | 'jito';

export interface CreateLandingTargetOptions {
  choice: LandingChoice;
  connection: Connection;
  /** Clé API Jupiter (`JUPITER_API_KEY`) — requise pour la cible `tx_jup`. */
  apiKey?: string | undefined;
  /** Région du Block Engine Jito (Phase 6c, latence) — défaut `global`. */
  jitoRegion?: JitoRegion | undefined;
  fetchImpl?: typeof fetch;
}

/** Construit la cible d'atterrissage demandée par `execution.router.landing`. */
export function createLandingTarget(options: CreateLandingTargetOptions): LandingTarget {
  if (options.choice === 'rpc') {
    return new RpcLanding(options.connection);
  }
  if (options.choice === 'tx_jup') {
    if (options.apiKey === undefined || options.apiKey === '') {
      throw new SolbotError('atterrissage tx.jup.ag : JUPITER_API_KEY requise', {
        hint: 'tx.jup.ag authentifie chaque envoi par clé API — renseignez JUPITER_API_KEY dans .env.',
      });
    }
    return new JupiterTxLanding({
      connection: options.connection,
      apiKey: options.apiKey,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  }
  return new JitoLanding({
    connection: options.connection,
    baseUrl: jitoBlockEngineUrl(options.jitoRegion),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}
