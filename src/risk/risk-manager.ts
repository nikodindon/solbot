import type { DatabaseSync } from 'node:sqlite';
import { insertRejection } from '../state/risk-rejections.js';
import type { PositionRow } from '../state/positions.js';
import type { Config } from '../utils/config.js';

/** Notionnel minimum d'une entrée (en devise de base). */
export const MIN_NOTIONAL_USD = 1;

/** Règles de risque — chaque rejet est journalisé avec sa règle (slug stable). */
export type RiskRule =
  | 'kill_switch'
  | 'daily_loss_pause'
  | 'invalid_price'
  | 'max_positions'
  | 'unknown_liquidity'
  | 'exposure_cap'
  | 'cooldown'
  | 'gas_reserve'
  | 'size_too_small'
  | 'empty_position';

export interface RiskContext {
  now: number;
  navUsd: number;
  /** Diffusion d'entrées coupée (fichier STOP ou drawdown max). */
  killSwitch: boolean;
  /** Fin de la pause perte journalière (ms epoch), ou `null`. */
  pausedUntilMs: number | null;
  openPositions: PositionRow[];
  /** Exposition USD actuelle par mint (positions ouvertes, mark-to-market). */
  exposureByMint: Map<string, number>;
  /** Dernier trade par mint (ms epoch) — cooldowns anti-churn. */
  lastTradeTsByMint: Map<string, number>;
  /** Liquidités mobilisables en devise de base (réserves déduites). */
  cashAvailableUsd: number;
  /** Solde SOL natif en unités UI (`null` = non vérifiable : paper/dry-run). */
  solBalanceSol: number | null;
}

export interface EntryIntent {
  mint: string;
  symbol: string;
  strategy: string;
  priceUsd: number;
  liquidityUsd: number | null;
}

export interface ExitIntent {
  mint: string;
  symbol: string;
  strategy: string;
  trigger: string;
  /** Quantité à vendre en unités de base (texte u64). */
  qtyBaseUnits: string;
  priceUsd: number;
}

export type RiskDecision =
  { allowed: true; sizeUsd: number } | { allowed: false; rule: RiskRule; message: string };

/**
 * Gestionnaire de risque (section 9 du README). Ordre des contrôles d'entrée :
 * kill-switch → pause perte journalière → plafonds d'exposition et sizing →
 * cooldown → réserve de gaz → notionnel minimum. Les **sorties** (stop-loss,
 * take-profit, trailing, signal de sortie) ne sont jamais bloquées par le
 * kill-switch ni par la pause : la garde de sortie est prioritaire.
 */
export class RiskManager {
  constructor(
    private readonly db: DatabaseSync,
    private readonly config: Config,
  ) {}

  /** Valide et dimensionne une entrée ; `sizeUsd` = notionnel proposé si autorisé. */
  checkEntry(intent: EntryIntent, ctx: RiskContext): RiskDecision {
    const reject = (
      rule: RiskRule,
      message: string,
      metrics?: Record<string, number | string | null>,
    ): RiskDecision => {
      insertRejection(this.db, {
        ts: ctx.now,
        mint: intent.mint,
        symbol: intent.symbol,
        side: 'buy',
        strategy: intent.strategy,
        rule,
        message,
        ...(metrics === undefined ? {} : { metrics }),
      });
      return { allowed: false, rule, message };
    };

    if (ctx.killSwitch) {
      return reject(
        'kill_switch',
        'entrées coupées : kill-switch actif (fichier STOP ou drawdown max)',
      );
    }
    if (ctx.pausedUntilMs !== null && ctx.pausedUntilMs > ctx.now) {
      const minutes = Math.ceil((ctx.pausedUntilMs - ctx.now) / 60_000);
      return reject('daily_loss_pause', `pause perte journalière : encore ${minutes} min`);
    }
    if (!(intent.priceUsd > 0)) {
      return reject('invalid_price', `prix invalide (${intent.priceUsd})`);
    }

    const { risk } = this.config;
    const existing = ctx.openPositions.find((position) => position.mint === intent.mint);
    if (existing === undefined && ctx.openPositions.length >= risk.max_positions) {
      return reject(
        'max_positions',
        `limite de ${risk.max_positions} positions ouvertes atteinte`,
        {
          open: ctx.openPositions.length,
        },
      );
    }

    if (intent.liquidityUsd === null || intent.liquidityUsd <= 0) {
      return reject('unknown_liquidity', 'liquidité inconnue : impact non estimable');
    }

    // ── Sizing (règles 3 + 4) ──────────────────────────────────────────────
    const exposure = ctx.exposureByMint.get(intent.mint) ?? 0;
    const nav = Math.max(0, ctx.navUsd);
    const caps: Array<[string, number]> = [
      ['max_position_pct', (risk.max_position_pct / 100) * nav - exposure],
      ['max_asset_exposure_pct', (risk.max_asset_exposure_pct / 100) * nav - exposure],
      ['cash', ctx.cashAvailableUsd],
      // Approximation conservatrice x·y=k : impact % ≈ 2 × notionnel / liquidité.
      ['max_price_impact_pct', (risk.max_price_impact_pct / 100 / 2) * intent.liquidityUsd],
    ];
    const sizeUsd = Math.min(...caps.map(([, value]) => Math.max(0, value)));
    if (sizeUsd <= 0) {
      const binding = caps.reduce((worst, cap) => (cap[1] < worst[1] ? cap : worst), caps[0]!);
      return reject('exposure_cap', `plafond d'exposition atteint (${binding[0]})`, {
        navUsd: nav,
        exposureUsd: exposure,
        cashAvailableUsd: ctx.cashAvailableUsd,
      });
    }

    // ── Cooldown (règle 5) ─────────────────────────────────────────────────
    const lastTradeTs = ctx.lastTradeTsByMint.get(intent.mint);
    if (lastTradeTs !== undefined) {
      const elapsedS = Math.floor((ctx.now - lastTradeTs) / 1000);
      if (elapsedS < risk.min_time_between_trades_s) {
        const remaining = risk.min_time_between_trades_s - elapsedS;
        return reject('cooldown', `cooldown : ${remaining} s avant de retoucher ${intent.symbol}`, {
          lastTradeTs,
          cooldownS: risk.min_time_between_trades_s,
        });
      }
    }

    // ── Réserve de gaz (règle 6) ───────────────────────────────────────────
    if (ctx.solBalanceSol !== null && ctx.solBalanceSol < risk.sol_gas_reserve) {
      return reject(
        'gas_reserve',
        `réserve de gaz entamée (${ctx.solBalanceSol.toFixed(4)} SOL < ${risk.sol_gas_reserve} SOL)`,
        { solBalanceSol: ctx.solBalanceSol },
      );
    }

    if (sizeUsd < MIN_NOTIONAL_USD) {
      return reject(
        'size_too_small',
        `notionnel ${sizeUsd.toFixed(2)} $ < minimum ${MIN_NOTIONAL_USD} $`,
      );
    }

    return { allowed: true, sizeUsd };
  }

  /** Valide une sortie — garde de sortie prioritaire : jamais bloquée par le kill-switch. */
  checkExit(intent: ExitIntent, ctx: RiskContext): RiskDecision {
    const reject = (rule: RiskRule, message: string): RiskDecision => {
      insertRejection(this.db, {
        ts: ctx.now,
        mint: intent.mint,
        symbol: intent.symbol,
        side: 'sell',
        strategy: intent.strategy,
        rule,
        message,
      });
      return { allowed: false, rule, message };
    };
    if (!(intent.priceUsd > 0)) {
      return reject('invalid_price', `prix invalide (${intent.priceUsd})`);
    }
    if (!/^\d+$/.test(intent.qtyBaseUnits) || BigInt(intent.qtyBaseUnits) <= 0n) {
      return reject('empty_position', 'quantité à vendre nulle');
    }
    return { allowed: true, sizeUsd: 0 };
  }
}
