import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID_STR, TOKEN_PROGRAM_ID_STR } from '../constants.js';

export interface TokenBalance {
  mint: string;
  /** Montant en unités UI (décimales appliquées). */
  amount: number;
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

      balances.push({ mint: info.mint, amount, decimals: raw.decimals ?? 0 });
    }
  }
  return balances;
}
