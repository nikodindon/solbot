import { Command } from 'commander';
import {
  computeMetrics,
  type ClosedPositionSample,
  type PerformanceMetrics,
  type TradeSample,
} from '../backtest/metrics.js';
import { getBacktestRuns, type BacktestRunRow } from '../backtest/store.js';
import { USDC_MINT } from '../constants.js';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { openDatabase, resolveDatabasePath } from '../state/db.js';
import { getEquitySeries } from '../state/equity.js';
import { runMigrations } from '../state/migrations.js';
import { loadConfig, parseEnv } from '../utils/config.js';
import { loadEnvFile } from '../utils/env-file.js';
import { SolbotError } from '../utils/errors.js';
import { getProjectRoot } from '../utils/paths.js';
import { fail, formatPct, ICONS, parseIntOption, printHeader } from './ui.js';

export interface ReportCliOptions {
  days?: string;
  mode?: string;
  telegram?: boolean;
}

/**
 * `solbot report` : métriques de performance (PnL net, win rate, profit
 * factor, drawdown, Sharpe, turnover, frais) depuis la base locale — courbe
 * d'equity + positions clôturées + trades. Compare au dernier backtest
 * enregistré (paper vs backtest) et peut publier sur Telegram.
 */
export async function runReportCli(options: ReportCliOptions): Promise<void> {
  const root = getProjectRoot();
  loadEnvFile(root);
  const env = parseEnv();
  const { config } = loadConfig({ root });
  const days = options.days === undefined ? 30 : parseIntOption(options.days, '--days', 1, 365);
  const mode = options.mode;
  if (mode !== undefined && !['paper', 'dry_run', 'live'].includes(mode)) {
    throw new SolbotError(`--mode invalide : « ${mode} » (paper, dry_run ou live)`);
  }

  const db = openDatabase(resolveDatabasePath(root, config.database.path));
  runMigrations(db);
  try {
    const now = Date.now();
    const fromTs = now - days * 86_400_000;
    const equity = getEquitySeries(db, {
      ...(mode === undefined ? {} : { mode }),
      fromTs,
      toTs: now,
    });

    const positionRows = db
      .prepare(
        `SELECT realized_pnl_usd AS pnl, closed_at AS closedAt, mode
         FROM positions WHERE status = 'closed' AND closed_at >= ? ORDER BY closed_at`,
      )
      .all(fromTs) as unknown as Array<{ pnl: number; closedAt: number; mode: string | null }>;
    const closedPositions: ClosedPositionSample[] = positionRows
      .filter((row) => mode === undefined || row.mode === mode || row.mode === null)
      .map((row) => ({ realizedPnlUsd: row.pnl, closedAt: row.closedAt }));

    const tradeRows = db
      .prepare(
        `SELECT mode, input_mint, output_mint, in_amount, out_amount, fee_usd
         FROM trades WHERE created_at >= ? AND status != 'failed'`,
      )
      .all(fromTs) as unknown as Array<{
      mode: string;
      input_mint: string;
      output_mint: string;
      in_amount: string;
      out_amount: string | null;
      fee_usd: number | null;
    }>;
    const trades: TradeSample[] = tradeRows
      .filter((row) => mode === undefined || row.mode === mode)
      .map((row) => ({ notionalUsd: usdNotional(row), feeUsd: row.fee_usd }));

    const metrics = computeMetrics({
      equity,
      closedPositions,
      trades,
      initialUsd: config.paper.initial_usdc,
      days,
    });

    printHeader(`solbot report — ${days} j${mode === undefined ? '' : ` · mode ${mode}`}`);
    printMetrics(metrics, equity.length);

    const runs = getBacktestRuns(db, 1);
    const lastRun = runs[0];
    if (lastRun !== undefined) {
      printComparison(lastRun);
    } else {
      console.log('  comparaison : aucun backtest enregistré (`solbot backtest --days 30`)');
    }

    if (options.telegram === true) {
      await publishTelegram(env, days, mode, metrics);
    }
  } finally {
    db.close();
  }
}

function printMetrics(metrics: PerformanceMetrics, equityPoints: number): void {
  console.log(
    `  equity : ${equityPoints} point(s)${equityPoints === 0 ? ' — courbe absente (moteur antérieur à la Phase 4) : DD/Sharpe indisponibles' : ''}`,
  );
  console.log(
    `  NAV ${metrics.initialNavUsd.toFixed(2)} → ${metrics.finalNavUsd.toFixed(2)} $ — ` +
      `net ${metrics.netPnlUsd >= 0 ? '+' : ''}${metrics.netPnlUsd.toFixed(2)} $ (${formatPct(metrics.netPnlPct)})`,
  );
  const winRate = metrics.winRatePct === null ? '—' : `${metrics.winRatePct.toFixed(1)} %`;
  const profitFactor = metrics.profitFactor === null ? '—' : metrics.profitFactor.toFixed(2);
  const drawdown =
    metrics.maxDrawdownPct === null ? 'n/d' : `${metrics.maxDrawdownPct.toFixed(2)} %`;
  const sharpe = metrics.sharpe === null ? 'n/d' : metrics.sharpe.toFixed(2);
  console.log(
    `  positions clôturées ${metrics.trades} · win rate ${winRate} (${metrics.wins}W/${metrics.losses}L) · PF ${profitFactor}`,
  );
  console.log(
    `  DD max ${drawdown} · Sharpe ${sharpe} · turnover ×${metrics.turnover.toFixed(2)} (${metrics.turnoverPerDay.toFixed(2)}/j)`,
  );
  console.log(
    `  frais modélisés ${metrics.feesUsd.toFixed(2)} $ · notionnel moyen ${metrics.avgTradeUsd.toFixed(2)} $ · ${metrics.days} j demandés`,
  );
}

function printComparison(run: BacktestRunRow): void {
  const m = run.metrics;
  const iso = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
  const winRate = m.winRatePct === null ? '—' : `${m.winRatePct.toFixed(1)} %`;
  const profitFactor = m.profitFactor === null ? '—' : m.profitFactor.toFixed(2);
  const drawdown = m.maxDrawdownPct === null ? 'n/d' : `${m.maxDrawdownPct.toFixed(2)} %`;
  const sharpe = m.sharpe === null ? 'n/d' : m.sharpe.toFixed(2);
  console.log(
    `  comparaison backtest #${run.id}${run.label === null ? '' : ` « ${run.label} »`} : ` +
      `${iso(run.fromTs)} → ${iso(run.toTs)} · ` +
      `net ${m.netPnlUsd >= 0 ? '+' : ''}${m.netPnlUsd.toFixed(2)} $ (${formatPct(m.netPnlPct)}) · ` +
      `win rate ${winRate} · PF ${profitFactor} · DD ${drawdown} · Sharpe ${sharpe}`,
  );
  console.log(
    '  écart paper vs backtest : coûts modélisés (frais Jupiter par paire + priority fees + impact liquidité) et fills paper au tick vs clôture de bougie',
  );
}

function usdNotional(row: {
  input_mint: string;
  output_mint: string;
  in_amount: string;
  out_amount: string | null;
}): number {
  try {
    if (row.input_mint === USDC_MINT) return Number(BigInt(row.in_amount)) / 1e6;
    if (row.output_mint === USDC_MINT && row.out_amount !== null) {
      return Number(BigInt(row.out_amount)) / 1e6;
    }
  } catch {
    return 0;
  }
  return 0;
}

async function publishTelegram(
  env: { TELEGRAM_BOT_TOKEN?: string | undefined; TELEGRAM_CHAT_ID?: string | undefined },
  days: number,
  mode: string | undefined,
  metrics: PerformanceMetrics,
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (token === undefined || chatId === undefined || token === '' || chatId === '') {
    throw new SolbotError('Notification Telegram impossible : token ou chat id manquant', {
      hint: 'Renseignez TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID dans .env.',
    });
  }
  const winRate = metrics.winRatePct === null ? '—' : `${metrics.winRatePct.toFixed(1)} %`;
  const lines = [
    `solbot report — ${days} j${mode === undefined ? '' : ` (${mode})`}`,
    `NAV ${metrics.initialNavUsd.toFixed(2)} → ${metrics.finalNavUsd.toFixed(2)} $ (${formatPct(metrics.netPnlPct)})`,
    `win rate ${winRate} · PF ${metrics.profitFactor === null ? '—' : metrics.profitFactor.toFixed(2)}`,
    `DD max ${metrics.maxDrawdownPct === null ? 'n/d' : `${metrics.maxDrawdownPct.toFixed(2)} %`} · ` +
      `Sharpe ${metrics.sharpe === null ? 'n/d' : metrics.sharpe.toFixed(2)}`,
    `turnover ×${metrics.turnover.toFixed(2)} · frais ${metrics.feesUsd.toFixed(2)} $`,
  ];
  const result = await sendTelegramMessage({ token, chatId, text: lines.join('\n') });
  if (!result.ok) {
    throw new SolbotError(`Échec de l'envoi Telegram : ${result.description ?? 'inconnu'}`);
  }
  console.log(`  ${ICONS.ok} rapport publié sur Telegram`);
}

export function reportCommand(): Command {
  return new Command('report')
    .description(
      'Rapport de métriques (PnL, win rate, PF, DD, Sharpe, turnover) + comparaison backtest',
    )
    .option('--days <n>', 'fenêtre du rapport en jours (défaut : 30)')
    .option('--mode <mode>', 'filtre : paper, dry_run ou live (défaut : tous)')
    .option('--telegram', 'publie le rapport sur Telegram (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)')
    .action(async (options: { days?: string; mode?: string; telegram?: boolean }) => {
      try {
        await runReportCli({
          ...(options.days === undefined ? {} : { days: options.days }),
          ...(options.mode === undefined ? {} : { mode: options.mode }),
          telegram: Boolean(options.telegram),
        });
      } catch (error) {
        fail(error);
      }
    });
}
