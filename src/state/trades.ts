import type { DatabaseSync } from 'node:sqlite';

/** Modes d'exécution journalisés (paper et dry-run ne touchent jamais aux fonds). */
export type TradeMode = 'paper' | 'dry_run' | 'live';

/** Résultat d'une intention de swap : simulée, réussie on-chain, ou échouée. */
export type TradeStatus = 'simulated' | 'success' | 'failed';

export interface TradeRecord {
  mode: TradeMode;
  status: TradeStatus;
  signature: string | null;
  requestId: string | null;
  inputMint: string;
  outputMint: string;
  /** Montants en unités de base, en texte (précision u64). */
  inAmount: string;
  expectedOutAmount: string | null;
  outAmount: string | null;
  router: string | null;
  feeBps: number | null;
  feeMint: string | null;
  priceImpact: number | null;
  slippageBps: number | null;
  realizedSlippageBps: number | null;
  errorCode: number | null;
  errorMessage: string | null;
  createdAt: number;
  /** Stratégie à l'origine du trade (moteur uniquement). */
  strategy?: string | null;
  /** Déclencheur : entry, stop_loss, take_profit, trailing_stop, momentum_exit… */
  trigger?: string | null;
  /** Frais modélisés en USD (paper/backtest) — `null` si inconnus (live). */
  feeUsd?: number | null;
  /** Chemin d'exécution (Phase 6) : meta_aggregator | router. */
  path?: string | null;
  /** Limite de compute units fixée (chemin router). */
  cuLimit?: number | null;
  /** Prix des compute units en micro-lamports (chemin router). */
  cuPriceMicrolamports?: number | null;
  /** Tip inclus dans la transaction, en lamports (chemin router). */
  tipLamports?: number | null;
  /** Cible d'atterrissage : rpc, tx_jup, jito… (chemin router). */
  landing?: string | null;
  /** Durée envoi → confirmation en ms (chemin router). */
  landingMs?: number | null;
}

interface TradeRow {
  id: number;
  mode: string;
  status: string;
  signature: string | null;
  request_id: string | null;
  input_mint: string;
  output_mint: string;
  in_amount: string;
  expected_out_amount: string | null;
  out_amount: string | null;
  router: string | null;
  fee_bps: number | null;
  fee_mint: string | null;
  price_impact: number | null;
  slippage_bps: number | null;
  realized_slippage_bps: number | null;
  error_code: number | null;
  error_message: string | null;
  created_at: number;
  strategy: string | null;
  trigger: string | null;
  fee_usd: number | null;
  path: string | null;
  cu_limit: number | null;
  cu_price_microlamports: number | null;
  tip_lamports: number | null;
  landing: string | null;
  landing_ms: number | null;
}

/** Journalise une intention de swap. Retourne l'id de la ligne créée. */
export function insertTrade(db: DatabaseSync, trade: TradeRecord): number {
  const result = db
    .prepare(
      `INSERT INTO trades
        (mode, status, signature, request_id, input_mint, output_mint, in_amount,
         expected_out_amount, out_amount, router, fee_bps, fee_mint, price_impact,
         slippage_bps, realized_slippage_bps, error_code, error_message, created_at,
         strategy, trigger, fee_usd, path, cu_limit, cu_price_microlamports,
         tip_lamports, landing, landing_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      trade.mode,
      trade.status,
      trade.signature,
      trade.requestId,
      trade.inputMint,
      trade.outputMint,
      trade.inAmount,
      trade.expectedOutAmount,
      trade.outAmount,
      trade.router,
      trade.feeBps,
      trade.feeMint,
      trade.priceImpact,
      trade.slippageBps,
      trade.realizedSlippageBps,
      trade.errorCode,
      trade.errorMessage,
      trade.createdAt,
      trade.strategy ?? null,
      trade.trigger ?? null,
      trade.feeUsd ?? null,
      trade.path ?? null,
      trade.cuLimit ?? null,
      trade.cuPriceMicrolamports ?? null,
      trade.tipLamports ?? null,
      trade.landing ?? null,
      trade.landingMs ?? null,
    ) as unknown as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

/** Horodatage du dernier trade touchant ce mint (entrée ou sortie), pour les cooldowns. */
export function lastTradeTsForMint(db: DatabaseSync, mint: string): number | null {
  const row = db
    .prepare('SELECT MAX(created_at) AS ts FROM trades WHERE input_mint = ? OR output_mint = ?')
    .get(mint, mint) as unknown as { ts: number | null } | undefined;
  return row?.ts ?? null;
}

/** Complète un trade déjà journalisé (stratégie, déclencheur) — moteur uniquement. */
export function annotateTrade(
  db: DatabaseSync,
  id: number,
  fields: { strategy?: string; trigger?: string },
): void {
  db.prepare(
    'UPDATE trades SET strategy = COALESCE(?, strategy), trigger = COALESCE(?, trigger) WHERE id = ?',
  ).run(fields.strategy ?? null, fields.trigger ?? null, id);
}

/** Derniers trades journalisés (du plus récent au plus ancien). */
export function getRecentTrades(db: DatabaseSync, limit = 20): Array<TradeRecord & { id: number }> {
  const rows = db
    .prepare('SELECT * FROM trades ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit) as unknown as TradeRow[];
  return rows.map((row) => ({
    id: row.id,
    mode: row.mode as TradeMode,
    status: row.status as TradeStatus,
    signature: row.signature,
    requestId: row.request_id,
    inputMint: row.input_mint,
    outputMint: row.output_mint,
    inAmount: row.in_amount,
    expectedOutAmount: row.expected_out_amount,
    outAmount: row.out_amount,
    router: row.router,
    feeBps: row.fee_bps,
    feeMint: row.fee_mint,
    priceImpact: row.price_impact,
    slippageBps: row.slippage_bps,
    realizedSlippageBps: row.realized_slippage_bps,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    strategy: row.strategy,
    trigger: row.trigger,
    feeUsd: row.fee_usd,
    path: row.path,
    cuLimit: row.cu_limit,
    cuPriceMicrolamports: row.cu_price_microlamports,
    tipLamports: row.tip_lamports,
    landing: row.landing,
    landingMs: row.landing_ms,
  }));
}
