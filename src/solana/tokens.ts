import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID_STR, TOKEN_PROGRAM_ID_STR } from '../constants.js';

export interface TokenBalance {
  mint: string;
  /** Montant en unités UI (décimales appliquées). */
  amount: number;
  /** Montant exact en unités de base (texte, u64). */
  amountBaseUnits: string;
  decimals: number;
}

interface ParsedTokenAmount {
  uiAmount?: number | null;
  uiAmountString?: string;
  decimals?: number;
}

interface ParsedTokenInfo {
  mint?: string;
  tokenAmount?: ParsedTokenAmount;
}

interface ParsedTokenAccountData {
  parsed?: { info?: ParsedTokenInfo };
}

/**
 * Soldes SPL non nuls du wallet (programmes Token classique + Token-2022).
 * Un seul appel RPC par programme.
 */
export async function fetchTokenBalances(
  connection: Connection,
  owner: PublicKey,
): Promise<TokenBalance[]> {
  const balances: TokenBalance[] = [];

  for (const programIdStr of [TOKEN_PROGRAM_ID_STR, TOKEN_2022_PROGRAM_ID_STR]) {
    const response = await connection.getParsedTokenAccountsByOwner(owner, {
      programId: new PublicKey(programIdStr),
    });
    for (const { account } of response.value) {
      const data = account.data as unknown as ParsedTokenAccountData;
      const info = data.parsed?.info;
      const raw = info?.tokenAmount;
      if (!info?.mint || !raw) continue;

      const amount =
        typeof raw.uiAmount === 'number'
          ? raw.uiAmount
          : Number.parseFloat(raw.uiAmountString ?? '0');
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const decimals = raw.decimals ?? 0;
      balances.push({
        mint: info.mint,
        amount,
        amountBaseUnits: uiStringToBaseUnits(raw.uiAmountString ?? String(amount), decimals),
        decimals,
      });
    }
  }
  return balances;
}

/**
 * « 1.25 » + 6 décimales → « 1250000 » (texte u64, sans perte de précision).
 * Toute chaîne non numérique est traitée comme 0.
 */
export function uiStringToBaseUnits(uiAmount: string, decimals: number): string {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(uiAmount.trim());
  if (match === null) return '0';
  const integer = match[1]!;
  const fraction = (match[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt(`${integer}${fraction}`).toString();
}
