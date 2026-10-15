import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { ApiInstruction, BuildResponse } from '../jupiter/swap.js';
import { SolbotError } from '../utils/errors.js';

/**
 * Chemin Router (`/build`) — assemblage de la transaction côté bot (Phase 6).
 *
 * Jupiter renvoie des instructions brutes que nous assemblons nous-mêmes :
 * limite de compute units (buffer × CU simulés), prix des CU (éventuellement
 * plafonné), tables d'adresses et blockhash fournis par le build. Toutes les
 * fonctions sont pures — la simulation et le réseau vivent dans l'Executor.
 */

/** Plafond réseau des compute units par transaction. */
export const COMPUTE_UNIT_LIMIT_MAX = 1_400_000;

/** Codes pseudo-`/execute` du chemin Router (négatifs, distincts de Jupiter). */
export const ROUTER_CODES = {
  /** `/build` n'a pas renvoyé d'instructions exploitables. */
  build: -9100,
  /** Simulation RPC en échec (la transaction serait rejetée). */
  simulation: -9101,
  /** Envoi refusé par le RPC (preflight) — la transaction n'a jamais été soumise. */
  send: -9102,
  /** Transaction confirmée en échec on-chain. */
  landing: -9103,
  /** Confirmation incertaine (timeout/expiration) — vérifier la signature. */
  confirmUnknown: -9104,
} as const;

/** Octet d'opcode `setComputeUnitPrice` (ComputeBudget). */
const COMPUTE_BUDGET_SET_UNIT_PRICE = 3;

export interface RouterTransaction {
  transaction: VersionedTransaction;
  /** Limite de compute units fixée dans la transaction. */
  cuLimit: number;
  /** Prix des compute units (micro-lamports), décodé du budget — null si absent. */
  cuPriceMicrolamports: number | null;
  blockhash: string;
  lastValidBlockHeight: number;
  /** Nombre d'instructions Jupiter (hors `setComputeUnitLimit` ajouté par le bot). */
  instructionCount: number;
}

/** Convertit une instruction Jupiter (base64) en instruction web3. */
export function apiInstructionToWeb3(instruction: ApiInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: Buffer.from(instruction.data, 'base64'),
  });
}

/**
 * Reconstruit les tables d'adresses du build, utilisables à la compilation.
 * État synthétique : seules les `addresses` sont lues par `compileToV0Message`.
 */
export function addressLookupTablesFromBuild(
  raw: Record<string, string[]> | null | undefined,
): AddressLookupTableAccount[] {
  if (raw === null || raw === undefined) return [];
  return Object.entries(raw).map(
    ([key, addresses]) =>
      new AddressLookupTableAccount({
        key: new PublicKey(key),
        state: {
          deactivationSlot: BigInt('18446744073709551615'),
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          addresses: addresses.map((address) => new PublicKey(address)),
        },
      }),
  );
}

/** Limite CU = buffer × CU simulés (défaut 1,2), plafonnée au maximum réseau. */
export function computeUnitLimitFromSimulation(
  unitsConsumed: number | null | undefined,
  buffer = 1.2,
): number {
  if (unitsConsumed === null || unitsConsumed === undefined || unitsConsumed <= 0) {
    return COMPUTE_UNIT_LIMIT_MAX;
  }
  return Math.min(Math.max(1, Math.ceil(unitsConsumed * buffer)), COMPUTE_UNIT_LIMIT_MAX);
}

/** Décode le prix des CU d'une instruction `setComputeUnitPrice` (micro-lamports/CU). */
export function decodeComputeUnitPrice(data: Uint8Array): number | null {
  // Layout : [opcode u8][prix u64 little-endian] — 9 octets minimum.
  if (data.length < 9 || data[0] !== COMPUTE_BUDGET_SET_UNIT_PRICE) return null;
  const price = Buffer.from(data).readBigUInt64LE(1);
  if (price > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(price);
}

/**
 * Plafonne le prix des CU d'une instruction budget. Les autres instructions du
 * budget (ex. `setComputeUnitLimit`) sont rendues telles quelles.
 */
export function clampComputeUnitPrice(
  instruction: ApiInstruction,
  capMicrolamports: number,
): ApiInstruction {
  const data = Buffer.from(instruction.data, 'base64');
  const price = decodeComputeUnitPrice(data);
  if (price === null || price <= capMicrolamports) return instruction;
  const clamped = Buffer.from(data);
  clamped.writeBigUInt64LE(BigInt(capMicrolamports), 1);
  return { ...instruction, data: clamped.toString('base64') };
}

export interface BuildRouterTransactionArgs {
  build: BuildResponse;
  payerKey: PublicKey;
  cuLimit: number;
  /** Plafond du prix des CU en micro-lamports (undefined/0 = pas de plafond). */
  cuPriceCapMicrolamports?: number | undefined;
  /**
   * Instructions ajoutées en fin de transaction après le tip du build
   * (ex. virement de tip Jito préparé par la cible d'atterrissage).
   */
  additionalInstructions?: readonly TransactionInstruction[] | undefined;
}

/**
 * Assemble la transaction v0 du chemin Router :
 * `setComputeUnitLimit` + budget (plafonné) + setup + swap + cleanup + other + tip
 * + instructions supplémentaires (le cas échéant).
 */
export function buildRouterTransaction(args: BuildRouterTransactionArgs): RouterTransaction {
  const { build, payerKey, cuLimit } = args;
  const cap = args.cuPriceCapMicrolamports ?? 0;

  const swapInstruction = build.swapInstruction;
  if (swapInstruction === null || swapInstruction === undefined) {
    throw new SolbotError('réponse /build sans instruction de swap');
  }
  if ('error' in swapInstruction) {
    throw new SolbotError(`réponse /build en erreur : ${swapInstruction.error}`);
  }
  const metadata = build.blockhashWithMetadata;
  if (metadata === undefined || metadata.blockhash.length === 0) {
    throw new SolbotError('réponse /build sans blockhash exploitable', {
      hint: 'Relancez un ordre frais ; si le problème persiste, vérifiez la version de l’API Jupiter.',
    });
  }

  const budget = build.computeBudgetInstructions.map((instruction) =>
    cap > 0 ? clampComputeUnitPrice(instruction, cap) : instruction,
  );
  const cuPriceMicrolamports =
    budget
      .map((instruction) => decodeComputeUnitPrice(Buffer.from(instruction.data, 'base64')))
      .find((price) => price !== null) ?? null;

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ...budget.map(apiInstructionToWeb3),
    ...build.setupInstructions.map(apiInstructionToWeb3),
    apiInstructionToWeb3(swapInstruction),
    ...(build.cleanupInstruction === null || build.cleanupInstruction === undefined
      ? []
      : [apiInstructionToWeb3(build.cleanupInstruction)]),
    ...build.otherInstructions.map(apiInstructionToWeb3),
    ...(build.tipInstruction === null || build.tipInstruction === undefined
      ? []
      : [apiInstructionToWeb3(build.tipInstruction)]),
    ...(args.additionalInstructions ?? []),
  ];

  const blockhash = bs58.encode(Uint8Array.from(metadata.blockhash));
  const message = new TransactionMessage({
    payerKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(addressLookupTablesFromBuild(build.addressesByLookupTableAddress));

  return {
    transaction: new VersionedTransaction(message),
    cuLimit,
    cuPriceMicrolamports,
    blockhash,
    lastValidBlockHeight: metadata.lastValidBlockHeight,
    instructionCount: instructions.length - 1,
  };
}
