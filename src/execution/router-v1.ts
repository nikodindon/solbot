import { TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Blockhash,
  type Instruction,
  type SignatureDictionary,
  type TransactionPartialSigner,
  type TransactionSigner,
} from '@solana/kit';
import type { ApiInstruction, BuildResponse } from '../jupiter/swap.js';
import { SolbotError } from '../utils/errors.js';

/**
 * Chemin Router (`/build`) — transactions Solana v1 (SIMD-0385), Phase 6c.
 *
 * `transactionVersion=1` demande à Jupiter des instructions v1 : jusqu'à
 * 4 096 octets, 64 comptes en ligne (pas de tables d'adresses) et le budget de
 * calcul exprimé dans la config du message (pas d'instructions
 * `ComputeBudget`). L'assemblage et la signature passent par `@solana/kit` v8+
 * — `@solana/web3.js` v1 sait *lire* une v1 mais pas la signer.
 *
 * Le chemin v1 est opt-in (`execution.router.transaction_version: 1`) et reste
 * expérimental jusqu'à validation en live : rien ne change par défaut.
 */

/** Plafond implicite de données de comptes en v0 — repris tel quel pour la v1. */
export const LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 64 * 1024 * 1024;

export interface RouterTransactionV1Args {
  build: BuildResponse;
  /** Adresse du payeur/taker (fee payer du message). */
  payerAddress: string;
  cuLimit: number;
  /** Plafond du prix des CU en micro-lamports (undefined/0 = pas de plafond). */
  cuPriceCapMicrolamports?: number | undefined;
  /**
   * Instructions ajoutées en fin de transaction après le tip du build
   * (ex. virement de tip Jito préparé par la cible d'atterrissage).
   */
  additionalInstructions?: readonly TransactionInstruction[] | undefined;
}

export interface RouterTransactionV1 {
  /** base64 non signé (slots de signature à zéro), prêt pour la simulation. */
  probeBase64: string;
  cuLimit: number;
  /** Prix effectif des CU (micro-lamports) après plafond éventuel — null si absent. */
  cuPriceMicrolamports: number | null;
  blockhash: string;
  lastValidBlockHeight: number;
  instructionCount: number;
  /** Signe le message (ed25519) et le sérialise pour l'envoi. */
  sign(signBytes: (message: Uint8Array) => Promise<Uint8Array>): Promise<{
    signedBase64: string;
    signature: string;
  }>;
}

/** Prix effectif des CU (micro-lamports) après plafond — null si `/build` n'en fournit pas. */
export function effectiveCuPriceMicrolamports(
  computeUnitPrice: string | undefined,
  capMicrolamports = 0,
): number | null {
  if (computeUnitPrice === undefined) return null;
  const price = Number.parseInt(computeUnitPrice, 10);
  if (!Number.isFinite(price) || price <= 0) return null;
  return capMicrolamports > 0 ? Math.min(price, capMicrolamports) : price;
}

/** Frais de priorité v1 : lamports totaux = ⌈prix µlamports/CU × limite CU ÷ 1e6⌉. */
export function priorityFeeLamports(priceMicrolamports: number | null, cuLimit: number): bigint {
  if (priceMicrolamports === null || priceMicrolamports <= 0) return 0n;
  return BigInt(Math.ceil((priceMicrolamports * cuLimit) / 1_000_000));
}

/** Convertit une instruction Jupiter (base64) en instruction kit. */
export function apiInstructionToKit(instruction: ApiInstruction): Instruction {
  return {
    programAddress: instruction.programId as Address,
    accounts: instruction.accounts.map((account) => ({
      address: account.pubkey as Address,
      role:
        account.isSigner && account.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : account.isSigner
            ? AccountRole.READONLY_SIGNER
            : account.isWritable
              ? AccountRole.WRITABLE
              : AccountRole.READONLY,
    })),
    data: Uint8Array.from(Buffer.from(instruction.data, 'base64')),
  };
}

/** Convertit une instruction web3.js (ex. tip Jito) en instruction kit. */
export function web3InstructionToKit(instruction: TransactionInstruction): Instruction {
  return {
    programAddress: instruction.programId.toBase58() as Address,
    accounts: instruction.keys.map((key) => ({
      address: key.pubkey.toBase58() as Address,
      role: key.isSigner
        ? key.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : key.isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY,
    })),
    data: Uint8Array.from(instruction.data),
  };
}

/**
 * Signer kit partiel bâti sur `signBytes` : le secret ne sort jamais du Signer
 * de l'application (keystore, HSM… demain), seul le message à signer circule.
 */
export function partialSignerFrom(
  address: string,
  signBytes: (message: Uint8Array) => Promise<Uint8Array>,
): TransactionPartialSigner {
  return {
    address: address as Address,
    signTransactions(transactions) {
      return Promise.all(
        transactions.map(
          async (transaction) =>
            ({
              [address]: await signBytes(Uint8Array.from(transaction.messageBytes)),
            }) as SignatureDictionary,
        ),
      );
    },
  };
}

/**
 * Assemble la transaction v1 du chemin Router :
 * setup + swap + cleanup + other + tip + instructions supplémentaires.
 *
 * La config du message porte `computeUnitLimit` (avec buffer), le frais de
 * priorité total converti du prix des CU et la limite de données de comptes.
 */
export function buildRouterTransactionV1(args: RouterTransactionV1Args): RouterTransactionV1 {
  const { build, payerAddress, cuLimit } = args;

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

  // Les instructions de budget (`computeBudgetInstructions`) sont ignorées :
  // en v1 le budget vit dans la config du message (POST /build les renvoie vides).
  const instructions: Instruction[] = [
    ...build.setupInstructions.map(apiInstructionToKit),
    apiInstructionToKit(swapInstruction),
    ...(build.cleanupInstruction === null || build.cleanupInstruction === undefined
      ? []
      : [apiInstructionToKit(build.cleanupInstruction)]),
    ...build.otherInstructions.map(apiInstructionToKit),
    ...(build.tipInstruction === null || build.tipInstruction === undefined
      ? []
      : [apiInstructionToKit(build.tipInstruction)]),
    ...(args.additionalInstructions ?? []).map(web3InstructionToKit),
  ];

  const blockhash = bs58.encode(Uint8Array.from(metadata.blockhash));
  const lifetime = {
    blockhash: blockhash as Blockhash,
    lastValidBlockHeight: BigInt(metadata.lastValidBlockHeight),
  };
  const cuPriceMicrolamports = effectiveCuPriceMicrolamports(
    build.computeUnitPrice,
    args.cuPriceCapMicrolamports ?? 0,
  );
  const feeLamports = priorityFeeLamports(cuPriceMicrolamports, cuLimit);

  const baseMessage = () =>
    pipe(
      createTransactionMessage({ version: 1 }),
      (message) => setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
      (message) => appendTransactionMessageInstructions(instructions, message),
      (message) =>
        setTransactionMessageConfig(
          {
            computeUnitLimit: cuLimit,
            priorityFeeLamports: feeLamports,
            loadedAccountsDataSizeLimit: LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
          },
          message,
        ),
    );

  // Sonde : message non signé (fee payer par adresse), signatures à zéro — le
  // RPC accepte de simuler ce format, comme pour la v0.
  const probeBase64 = getBase64EncodedWireTransaction(
    compileTransaction(setTransactionMessageFeePayer(payerAddress as Address, baseMessage())),
  );

  return {
    probeBase64,
    cuLimit,
    cuPriceMicrolamports,
    blockhash,
    lastValidBlockHeight: metadata.lastValidBlockHeight,
    instructionCount: instructions.length,
    async sign(signBytes) {
      const signer = partialSignerFrom(payerAddress, signBytes);
      const message = setTransactionMessageFeePayerSigner(
        signer as TransactionSigner,
        baseMessage(),
      );
      const signed = await signTransactionMessageWithSigners(
        message as Parameters<typeof signTransactionMessageWithSigners>[0],
      );
      const signatureBytes = (
        signed.signatures as Readonly<Record<string, Uint8Array | undefined>>
      )[payerAddress];
      if (signatureBytes === undefined) {
        throw new SolbotError('transaction v1 : signature manquante après signature du message');
      }
      return {
        signedBase64: getBase64EncodedWireTransaction(signed),
        signature: bs58.encode(signatureBytes),
      };
    },
  };
}
