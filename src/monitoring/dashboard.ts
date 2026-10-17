import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { SOL_MINT, USDC_MINT } from '../constants.js';
import { getNumberState, getState, STATE_KEYS } from '../state/bot-state.js';
import { getOpenPositions, qtyToFloat } from '../state/positions.js';
import { getRecentEvents } from '../state/events.js';
import { getRecentRejections } from '../state/risk-rejections.js';
import { getRecentSignals } from '../state/signals.js';
import { getRecentTrades } from '../state/trades.js';
import { getWatchlist } from '../state/watchlist.js';
import { SolbotError } from '../utils/errors.js';

/** Exigence de données d'une stratégie active (bougies par timeframe). */
export interface DashboardRequirement {
  timeframe: string;
  bars: number;
}

export interface DashboardContext {
  db: DatabaseSync;
  /** Racine du projet (détection du fichier STOP). */
  root: string;
  version: string;
  mode: string;
  baseCurrency: 'USDC' | 'SOL';
  /** Caisse virtuelle de départ (mode paper) — `null` si non applicable. */
  initialUsdc: number | null;
  /** Exigences cumulées des stratégies actives (pour le compteur « prêts x/y »). */
  requirements: DashboardRequirement[];
  /** Nombre d'éléments récents par liste (défaut 25). */
  recentLimit?: number;
  now?: () => number;
}

export interface DashboardServer {
  host: string;
  port: number;
  urls: string[];
  close: () => Promise<void>;
}

export interface DashboardServerDeps {
  host: string;
  port: number;
  context: DashboardContext;
}

/** Seuil au-delà duquel le moteur est considéré comme arrêté (s). */
const STALE_AFTER_S = 120;

const CLOSED_LIMIT = 25;
const EQUITY_POINTS_MAX = 360;

/**
 * Ouvre la base en **lecture seule** (le tableau de bord n'écrit jamais).
 * Repli en lecture-écriture si SQLite refuse l'ouverture RO (WAL sans -shm).
 */
export function openReadonlyDatabase(dbPath: string): DatabaseSync {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 3000');
    return db;
  } catch {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  }
}

interface LastPriceRow {
  mint: string;
  usd_price: number;
  ts: number;
}

interface LastPrice {
  price: number;
  ts: number;
}

interface EquityRow {
  ts: number;
  nav_usd: number;
  cash_usd: number;
  positions_value_usd: number;
  open_count: number;
}

function loadLastPrices(db: DatabaseSync): Map<string, LastPrice> {
  const rows = db
    .prepare(
      `SELECT mint, usd_price, ts FROM price_ticks
       WHERE id IN (SELECT MAX(id) FROM price_ticks GROUP BY mint)`,
    )
    .all() as unknown as LastPriceRow[];
  const map = new Map<string, LastPrice>();
  for (const row of rows) map.set(row.mint, { price: row.usd_price, ts: row.ts });
  return map;
}

function downsample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = items.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) out.push(items[Math.floor(i * step)]!);
  const last = items[items.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Construit la vue complète du bot à partir de la base (une photo cohérente :
 * NAV, positions, trades, signaux, rejets, événements, watchlist, courbe).
 */
export function buildOverview(context: DashboardContext): Record<string, unknown> {
  const { db } = context;
  const now = context.now?.() ?? Date.now();
  const limit = context.recentLimit ?? 25;
  const baseMint = context.baseCurrency === 'USDC' ? USDC_MINT : SOL_MINT;
  const baseSymbol = context.baseCurrency;
  const baseDecimals = context.baseCurrency === 'USDC' ? 6 : 9;

  const symbols = new Map<string, string>();
  symbols.set(USDC_MINT, 'USDC');
  symbols.set(SOL_MINT, 'SOL');
  const watchlist = getWatchlist(db);
  for (const item of watchlist) symbols.set(item.mint, item.symbol);
  const symbolOf = (mint: string): string => symbols.get(mint) ?? `${mint.slice(0, 4)}…`;

  const lastPrices = loadLastPrices(db);

  const equityRows = db
    .prepare(
      `SELECT ts, nav_usd, cash_usd, positions_value_usd, open_count
       FROM equity_curve WHERE mode = ? ORDER BY ts ASC`,
    )
    .all(context.mode) as unknown as EquityRow[];
  const lastEquity = equityRows[equityRows.length - 1] ?? null;

  const peakUsd = getNumberState(db, STATE_KEYS.navPeakUsd);
  const dayStartNav = getNumberState(db, STATE_KEYS.dayStartNavUsd);
  const pausedUntilMs = getNumberState(db, STATE_KEYS.pausedUntilMs);
  const manualPaused = getState(db, STATE_KEYS.manualPaused) === '1';
  const killSwitch = fs.existsSync(`${context.root}/STOP`);
  const entriesPaused = manualPaused || (pausedUntilMs !== null && pausedUntilMs > now);

  const navUsd = lastEquity?.nav_usd ?? context.initialUsdc;
  const cashUsd = lastEquity?.cash_usd ?? null;
  const positionsValueUsd = lastEquity?.positions_value_usd ?? null;
  const ticks = equityRows.length;
  const lastTickTs = lastEquity?.ts ?? null;
  const lastTickAgeS = lastTickTs === null ? null : Math.max(0, (now - lastTickTs) / 1000);
  const alive = lastTickAgeS !== null && lastTickAgeS <= STALE_AFTER_S;

  const drawdownPct =
    peakUsd !== null && navUsd !== null && peakUsd > 0
      ? Math.max(0, ((peakUsd - navUsd) / peakUsd) * 100)
      : null;
  const dayPnlPct =
    dayStartNav !== null && navUsd !== null && dayStartNav > 0
      ? ((navUsd - dayStartNav) / dayStartNav) * 100
      : null;
  const sinceStartPct =
    context.initialUsdc !== null && navUsd !== null && context.initialUsdc > 0
      ? ((navUsd - context.initialUsdc) / context.initialUsdc) * 100
      : null;

  // ── Positions ouvertes (mark-to-market sur le dernier prix connu) ────────
  const positions = getOpenPositions(db).map((position) => {
    const qty = qtyToFloat(position.qtyRemaining, position.decimals);
    const last = lastPrices.get(position.mint) ?? null;
    const valueUsd = last === null ? null : qty * last.price;
    const pnlUsd = valueUsd === null ? null : valueUsd - position.costBasisUsd;
    const pnlPct =
      valueUsd === null || position.costBasisUsd <= 0
        ? null
        : ((valueUsd - position.costBasisUsd) / position.costBasisUsd) * 100;
    const trailing =
      position.peakPriceUsd !== null &&
      position.stopLossPriceUsd !== null &&
      position.stopLossPriceUsd > position.avgEntryPriceUsd;
    return {
      symbol: position.symbol,
      mint: position.mint,
      qty,
      openedAt: position.openedAt,
      entryPriceUsd: position.avgEntryPriceUsd,
      lastPriceUsd: last?.price ?? null,
      lastPriceAt: last?.ts ?? null,
      costBasisUsd: position.costBasisUsd,
      valueUsd,
      pnlUsd,
      pnlPct,
      stopLossPriceUsd: position.stopLossPriceUsd,
      takeProfitPriceUsd: position.takeProfitPriceUsd,
      peakPriceUsd: position.peakPriceUsd,
      trailing,
    };
  });
  const openValueUsd = positions.reduce((sum, item) => sum + (item.valueUsd ?? 0), 0);
  const openPnlUsd = positions.reduce((sum, item) => sum + (item.pnlUsd ?? 0), 0);

  // ── Positions fermées (bilan réalisé) ────────────────────────────────────
  const closedRows = db
    .prepare(
      `SELECT id, symbol, realized_pnl_usd, opened_at, closed_at
       FROM positions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT ?`,
    )
    .all(CLOSED_LIMIT) as unknown as Array<{
    id: number;
    symbol: string;
    realized_pnl_usd: number;
    opened_at: number;
    closed_at: number;
  }>;
  const aggregate = db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(realized_pnl_usd), 0) AS total,
              COALESCE(SUM(CASE WHEN realized_pnl_usd > 0 THEN 1 ELSE 0 END), 0) AS wins,
              COALESCE(MAX(realized_pnl_usd), 0) AS best,
              COALESCE(MIN(realized_pnl_usd), 0) AS worst
       FROM positions WHERE status = 'closed'`,
    )
    .get() as unknown as { n: number; total: number; wins: number; best: number; worst: number };

  // ── Trades récents (achat/vente, montant en devise de base) ──────────────
  const trades = getRecentTrades(db, limit).map((trade) => {
    const side =
      trade.inputMint === baseMint ? 'buy' : trade.outputMint === baseMint ? 'sell' : 'swap';
    const symbol =
      side === 'buy'
        ? symbolOf(trade.outputMint)
        : side === 'sell'
          ? symbolOf(trade.inputMint)
          : `${symbolOf(trade.inputMint)}→${symbolOf(trade.outputMint)}`;
    const raw = side === 'sell' ? (trade.outAmount ?? '0') : trade.inAmount;
    const amountUsd = Number(raw) / 10 ** baseDecimals;
    return {
      id: trade.id,
      ts: trade.createdAt,
      side,
      symbol,
      amountUsd: Number.isFinite(amountUsd) ? amountUsd : null,
      strategy: trade.strategy ?? null,
      trigger: trade.trigger ?? null,
      status: trade.status,
      feeUsd: trade.feeUsd ?? null,
    };
  });

  const signals = getRecentSignals(db, limit).map((signal) => ({
    ts: signal.ts,
    strategy: signal.strategy,
    symbol: signal.symbol,
    side: signal.side,
    confidence: signal.confidence,
    reason: signal.reason,
    acted: signal.acted,
  }));

  const rejections = getRecentRejections(db, limit).map((rejection) => ({
    ts: rejection.ts,
    symbol: rejection.symbol,
    side: rejection.side,
    strategy: rejection.strategy,
    rule: rejection.rule,
    message: rejection.message,
  }));

  const events = getRecentEvents(db, limit).map((event) => ({
    ts: event.ts,
    level: event.level,
    kind: event.kind,
    message: event.message,
  }));

  // ── Watchlist + disponibilité des données (bougies par timeframe) ────────
  const candleRows = db
    .prepare('SELECT mint, timeframe, COUNT(*) AS n FROM candles GROUP BY mint, timeframe')
    .all() as unknown as Array<{ mint: string; timeframe: string; n: number }>;
  const candleCounts = new Map<string, number>();
  for (const row of candleRows) candleCounts.set(`${row.mint}:${row.timeframe}`, row.n);
  const requirements = context.requirements;

  const watchlistItems = watchlist.map((item) => {
    const ready =
      requirements.length === 0 ||
      requirements.every(
        (requirement) =>
          (candleCounts.get(`${item.mint}:${requirement.timeframe}`) ?? 0) >= requirement.bars,
      );
    const last = lastPrices.get(item.mint) ?? null;
    return {
      rank: item.rank,
      symbol: item.symbol,
      mint: item.mint,
      isBase: item.isBase,
      priceUsd: last?.price ?? item.usdPrice,
      priceChange24h: item.priceChange24h,
      liquidityUsd: item.liquidityUsd,
      organicScore: item.organicScore,
      ready,
    };
  });
  const readyCount = watchlistItems.filter((item) => item.ready).length;

  const equity = downsample(
    equityRows.map((row) => ({ ts: row.ts, navUsd: row.nav_usd, openCount: row.open_count })),
    EQUITY_POINTS_MAX,
  );

  return {
    generatedAt: now,
    engine: {
      mode: context.mode,
      version: context.version,
      baseCurrency: baseSymbol,
      alive,
      lastTickAt: lastTickTs,
      lastTickAgeS,
      ticks,
    },
    nav: {
      usd: navUsd,
      cashUsd,
      positionsValueUsd,
      peakUsd,
      drawdownPct,
      dayStartNavUsd: dayStartNav,
      dayPnlPct,
      initialUsdc: context.initialUsdc,
      sinceStartPct,
      openValueUsd: positions.length > 0 ? openValueUsd : (positionsValueUsd ?? 0),
      openPnlUsd,
    },
    flags: { manualPaused, entriesPaused, pausedUntilMs, killSwitch },
    stats: {
      closed: aggregate.n,
      wins: aggregate.wins,
      losses: aggregate.n - aggregate.wins,
      winRatePct: aggregate.n > 0 ? (aggregate.wins / aggregate.n) * 100 : null,
      realizedPnlUsd: aggregate.total,
      bestUsd: aggregate.best,
      worstUsd: aggregate.worst,
      openCount: positions.length,
    },
    positions,
    closedPositions: closedRows.map((row) => ({
      symbol: row.symbol,
      pnlUsd: row.realized_pnl_usd,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
    })),
    trades,
    signals,
    rejections,
    events,
    watchlist: { total: watchlist.length, ready: readyCount, items: watchlistItems },
    equity,
  };
}

/** Contenu HTML du tableau de bord (page unique, sans dépendance externe). */
export function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>solbot — tableau de bord</title>
<style>
  :root { --bg:#0b0f14; --panel:#131a23; --panel2:#0f151d; --line:#1f2a37;
    --txt:#e6edf5; --muted:#8a9bb0; --up:#3ddc84; --down:#ff6b6b; --acc:#4da3ff; --warn:#ffc857; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt);
    font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  header { display:flex; align-items:center; gap:14px; flex-wrap:wrap;
    padding:14px 20px; border-bottom:1px solid var(--line); background:var(--panel2); position:sticky; top:0; z-index:5; }
  h1 { font-size:17px; margin:0; letter-spacing:.5px; }
  .badge { padding:2px 9px; border-radius:999px; font-size:12px; border:1px solid var(--line); color:var(--muted); }
  .badge.mode { color:var(--acc); border-color:#20456e; background:#0d1c2e; }
  .dot { width:9px; height:9px; border-radius:50%; display:inline-block; margin-right:6px; }
  .ok { background:var(--up); box-shadow:0 0 8px var(--up); }
  .ko { background:var(--down); }
  main { padding:16px 20px 60px; max-width:1500px; margin:0 auto; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-bottom:16px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  .card .k { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.6px; }
  .card .v { font-size:19px; margin-top:4px; }
  .card .s { color:var(--muted); font-size:11px; margin-top:2px; }
  section { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-bottom:16px; }
  section h2 { font-size:13px; margin:0 0 10px; color:var(--muted); text-transform:uppercase; letter-spacing:.8px; font-weight:600; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th { text-align:left; color:var(--muted); font-weight:600; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
  td { padding:5px 8px; border-bottom:1px solid #161e28; white-space:nowrap; }
  tr:hover td { background:#161f2a; }
  .num { text-align:right; }
  .up { color:var(--up); } .down { color:var(--down); } .muted { color:var(--muted); }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:1000px){ .cols { grid-template-columns:1fr; } }
  .tag { font-size:11px; padding:1px 6px; border-radius:5px; background:#1b2634; color:var(--muted); }
  .tag.buy { background:#122e1e; color:var(--up); } .tag.sell { background:#331717; color:var(--down); }
  .tag.entry { background:#152a45; color:var(--acc); }
  .tag.sl { background:#331b17; color:#ff9d6b; }
  .tag.tp { background:#122e1e; color:var(--up); }
  .scroll { max-height:340px; overflow:auto; }
  svg { width:100%; height:150px; display:block; }
  .foot { color:var(--muted); font-size:11px; text-align:center; margin-top:10px; }
  .warnbar { color:var(--warn); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>solbot</h1>
  <span class="badge mode" id="mode">—</span>
  <span class="badge" id="version">v—</span>
  <span id="alive" class="badge"><span class="dot ko"></span>—</span>
  <span class="badge" id="tickinfo">tick —</span>
  <span class="badge" id="updated">—</span>
</header>
<main>
  <div class="grid" id="kpis"></div>
  <div id="flags"></div>
  <section>
    <h2>Courbe de valeur (NAV)</h2>
    <svg id="chart" viewBox="0 0 1000 150" preserveAspectRatio="none"></svg>
  </section>
  <div class="cols">
    <section>
      <h2>Positions ouvertes (<span id="pc">0</span>)</h2>
      <div class="scroll"><table id="positions"><thead><tr>
        <th>Actif</th><th>Qté</th><th class="num">Entrée</th><th class="num">Dernier</th>
        <th class="num">Valeur</th><th class="num">P&L</th><th class="num">Stop</th><th>Depuis</th>
      </tr></thead><tbody></tbody></table></div>
    </section>
    <section>
      <h2>Watchlist — <span id="wready">0/0</span> prêts</h2>
      <div class="scroll"><table id="watchlist"><thead><tr>
        <th>#</th><th>Actif</th><th class="num">Prix</th><th class="num">24 h</th>
        <th class="num">Liquidité</th><th class="num">Score</th><th>État</th>
      </tr></thead><tbody></tbody></table></div>
    </section>
  </div>
  <section>
    <h2>Trades récents</h2>
    <div class="scroll"><table id="trades"><thead><tr>
      <th>Heure</th><th>Sens</th><th>Actif</th><th class="num">Montant</th>
      <th>Déclencheur</th><th>Stratégie</th><th>Statut</th>
    </tr></thead><tbody></tbody></table></div>
  </section>
  <div class="cols">
    <section>
      <h2>Signaux des stratégies</h2>
      <div class="scroll"><table id="signals"><thead><tr>
        <th>Heure</th><th>Actif</th><th>Sens</th><th class="num">Conf.</th><th>Motif</th>
      </tr></thead><tbody></tbody></table></div>
    </section>
    <section>
      <h2>Rejets du gestionnaire de risque</h2>
      <div class="scroll"><table id="rejections"><thead><tr>
        <th>Heure</th><th>Actif</th><th>Règle</th><th>Message</th>
      </tr></thead><tbody></tbody></table></div>
    </section>
  </div>
  <section>
    <h2>Journal d'événements</h2>
    <div class="scroll"><table id="events"><thead><tr>
      <th>Heure</th><th>Niveau</th><th>Type</th><th>Message</th>
    </tr></thead><tbody></tbody></table></div>
  </section>
  <div class="foot">Actualisation automatique toutes les 3 s · lecture seule de la base ·
    <span id="footer-mode"></span></div>
</main>
<script>
var T = 3000;
function usd(v, d) { if (v === null || v === undefined || !isFinite(v)) return '—';
  var n = d === undefined ? 2 : d; return v.toFixed(n) + ' $'; }
function pct(v) { if (v === null || v === undefined || !isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(2) + ' %'; }
function price(v) { if (v === null || v === undefined || !isFinite(v)) return '—';
  if (v >= 1) return v.toFixed(2); if (v >= 0.000001) return String(Number(v.toPrecision(4)));
  return v.toExponential(2); }
function compact(v) { if (v === null || v === undefined || !isFinite(v)) return '—';
  if (v >= 1e9) return '$' + (v/1e9).toFixed(2) + 'B'; if (v >= 1e6) return '$' + (v/1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v/1e3).toFixed(1) + 'k'; return '$' + v.toFixed(2); }
function cls(v) { return v === null || v === undefined ? 'muted' : (v >= 0 ? 'up' : 'down'); }
function hhmmss(ts) { if (!ts) return '—';
  var d = new Date(ts); return d.toTimeString().slice(0,8); }
function ddhhmm(ts) { if (!ts) return '—';
  var d = new Date(ts); return (d.getMonth()+1) + '/' + d.getDate() + ' ' + d.toTimeString().slice(0,5); }
function ago(ts) { if (!ts) return '—'; var s = Math.max(0, Math.round((Date.now()-ts)/1000));
  if (s < 60) return s + ' s'; if (s < 3600) return Math.round(s/60) + ' min'; return Math.round(s/3600) + ' h'; }
function esc(s) { return String(s === null || s === undefined ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function rows(tbody, html) { tbody.innerHTML = html || '<tr><td colspan="9" class="muted">—</td></tr>'; }

function renderKpis(d) {
  var n = d.nav, s = d.stats;
  var cards = [
    ['Valeur (NAV)', usd(n.usd), 'pic ' + usd(n.peakUsd)],
    ['Caisse', usd(n.cashUsd), ''],
    ['Positions', usd(n.openValueUsd), s.openCount + ' ouverte(s)'],
    ['P&L total', usd(n.initialUsdc === null ? s.realizedPnlUsd : (n.usd - n.initialUsdc)),
      n.sinceStartPct === null ? 'réalisé ' + usd(s.realizedPnlUsd) : pct(n.sinceStartPct) + ' depuis le départ', cls(n.sinceStartPct)],
    ['Journée (UTC)', pct(n.dayPnlPct), 'depuis ' + usd(n.dayStartNavUsd)],
    ['P&L latent', usd(n.openPnlUsd), ''],
    ['Drawdown', pct(n.drawdownPct === null ? null : -n.drawdownPct), '', 'down'],
    ['Réalisé', usd(s.realizedPnlUsd), s.wins + 'W / ' + s.losses + 'L'],
    ['' + 'Actifs prêts', d.watchlist.ready + '/' + d.watchlist.total, 'bougies suffisantes'],
    ['Ticks', String(d.engine.ticks), 'dernier ' + ago(d.engine.lastTickAt)]
  ];
  document.getElementById('kpis').innerHTML = cards.map(function (c) {
    return '<div class="card"><div class="k">' + esc(c[0]) + '</div><div class="v ' +
      (c[3] === 'down' ? 'down' : (c[3] || cls(c[1]))) + '">' + c[1] + '</div><div class="s">' + esc(c[2]) + '</div></div>';
  }).join('');
}

function renderFlags(d) {
  var f = d.flags, parts = [];
  if (f.killSwitch) parts.push('<span class="badge down">⛔ kill-switch actif (fichier STOP)</span>');
  if (f.manualPaused) parts.push('<span class="badge">⏸ pause manuelle (entrées)</span>');
  if (f.pausedUntilMs && f.pausedUntilMs > Date.now()) parts.push('<span class="badge">⏸ pause perte journalière jusqu&#39;à ' + hhmmss(f.pausedUntilMs) + '</span>');
  if (parts.length === 0) parts.push('<span class="muted" style="font-size:12px">aucune pause ni coupe-circuit — le moteur trade normalement</span>');
  document.getElementById('flags').innerHTML = '<div class="card" style="margin-bottom:16px">' + parts.join(' &nbsp; ') + '</div>';
}

function renderChart(d) {
  var pts = d.equity || []; if (pts.length < 2) { document.getElementById('chart').innerHTML = ''; return; }
  var vals = pts.map(function (p) { return p.navUsd; });
  var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  if (max - min < 1e-9) { max = min + 1; }
  var W = 1000, H = 150, pad = 6;
  var step = W / (pts.length - 1);
  var poly = pts.map(function (p, i) {
    var x = (i * step).toFixed(1);
    var y = (pad + (1 - (p.navUsd - min) / (max - min)) * (H - 2*pad)).toFixed(1);
    return x + ',' + y;
  }).join(' ');
  var start = vals[0], last = vals[vals.length-1];
  var color = last >= start ? '#3ddc84' : '#ff6b6b';
  document.getElementById('chart').innerHTML =
    '<polyline fill="none" stroke="' + color + '" stroke-width="2" points="' + poly + '"></polyline>' +
    '<text x="8" y="14" fill="#8a9bb0" font-size="11">max ' + usd(max) + '</text>' +
    '<text x="8" y="146" fill="#8a9bb0" font-size="11">min ' + usd(min) + '</text>';
}

function renderPositions(d) {
  document.getElementById('pc').textContent = String(d.positions.length);
  var html = d.positions.map(function (p) {
    return '<tr><td>' + esc(p.symbol) + (p.trailing ? ' <span class="tag tp">trailing</span>' : '') + '</td>' +
      '<td class="num">' + (p.qty >= 1000 ? Math.round(p.qty) : Number(p.qty.toPrecision(6))) + '</td>' +
      '<td class="num">' + price(p.entryPriceUsd) + '</td>' +
      '<td class="num">' + price(p.lastPriceUsd) + '</td>' +
      '<td class="num">' + usd(p.valueUsd) + '</td>' +
      '<td class="num ' + cls(p.pnlPct) + '">' + usd(p.pnlUsd) + ' <span class="muted">' + pct(p.pnlPct) + '</span></td>' +
      '<td class="num">' + price(p.stopLossPriceUsd) + '</td>' +
      '<td class="muted">' + ago(p.openedAt) + '</td></tr>';
  }).join('');
  rows(document.querySelector('#positions tbody'), html);
}

function renderWatchlist(d) {
  document.getElementById('wready').textContent = d.watchlist.ready + '/' + d.watchlist.total;
  var html = d.watchlist.items.map(function (w) {
    var chg = w.priceChange24h;
    return '<tr><td class="muted">' + w.rank + '</td><td>' + esc(w.symbol) +
      (w.isBase ? ' <span class="tag">base</span>' : '') + '</td>' +
      '<td class="num">' + price(w.priceUsd) + '</td>' +
      '<td class="num ' + cls(chg) + '">' + (chg === null ? '—' : (chg>=0?'+':'') + chg.toFixed(2) + ' %') + '</td>' +
      '<td class="num">' + compact(w.liquidityUsd) + '</td>' +
      '<td class="num">' + (w.organicScore === null ? '—' : w.organicScore.toFixed(1)) + '</td>' +
      '<td>' + (w.ready ? '<span class="tag buy">prêt</span>' : '<span class="tag">chauffe</span>') + '</td></tr>';
  }).join('');
  rows(document.querySelector('#watchlist tbody'), html);
}

function tagTrigger(t) {
  if (!t) return '<span class="tag">—</span>';
  if (t === 'entry') return '<span class="tag entry">achat</span>';
  if (t === 'stop_loss') return '<span class="tag sl">stop-loss</span>';
  if (t === 'take_profit') return '<span class="tag tp">take-profit</span>';
  if (t === 'trailing_stop') return '<span class="tag tp">trailing</span>';
  return '<span class="tag">' + esc(t) + '</span>';
}

function renderTrades(d) {
  var html = d.trades.map(function (t) {
    return '<tr><td class="muted">' + hhmmss(t.ts) + '</td>' +
      '<td><span class="tag ' + (t.side === 'buy' ? 'buy' : 'sell') + '">' + (t.side === 'buy' ? 'achat' : 'vente') + '</span></td>' +
      '<td>' + esc(t.symbol) + '</td><td class="num">' + usd(t.amountUsd) + '</td>' +
      '<td>' + tagTrigger(t.trigger) + '</td><td class="muted">' + esc(t.strategy || '—') + '</td>' +
      '<td class="muted">' + esc(t.status) + '</td></tr>';
  }).join('');
  rows(document.querySelector('#trades tbody'), html);
}

function renderSignals(d) {
  var html = d.signals.map(function (s) {
    return '<tr><td class="muted">' + hhmmss(s.ts) + '</td><td>' + esc(s.symbol) + '</td>' +
      '<td><span class="tag ' + (s.side === 'buy' ? 'buy' : 'sell') + '">' + (s.side === 'buy' ? 'achat' : 'vente') + '</span></td>' +
      '<td class="num">' + s.confidence.toFixed(2) + '</td>' +
      '<td class="muted" style="white-space:normal">' + esc(String(s.reason).slice(0, 90)) + '</td></tr>';
  }).join('');
  rows(document.querySelector('#signals tbody'), html);
}

function renderRejections(d) {
  var html = d.rejections.map(function (r) {
    return '<tr><td class="muted">' + hhmmss(r.ts) + '</td><td>' + esc(r.symbol) + '</td>' +
      '<td><span class="tag">' + esc(r.rule) + '</span></td>' +
      '<td style="white-space:normal">' + esc(r.message) + '</td></tr>';
  }).join('');
  rows(document.querySelector('#rejections tbody'), html);
}

function renderEvents(d) {
  var html = d.events.map(function (e) {
    var color = e.level === 'error' ? 'down' : (e.level === 'warn' ? 'up' : 'muted');
    return '<tr><td class="muted">' + ddhhmm(e.ts) + '</td><td class="' + color + '">' + esc(e.level) + '</td>' +
      '<td><span class="tag">' + esc(e.kind) + '</span></td>' +
      '<td style="white-space:normal">' + esc(e.message) + '</td></tr>';
  }).join('');
  rows(document.querySelector('#events tbody'), html);
}

function render(d) {
  var e = d.engine;
  document.getElementById('mode').textContent = e.mode.toUpperCase();
  document.getElementById('version').textContent = 'v' + e.version;
  var alive = document.getElementById('alive');
  alive.innerHTML = '<span class="dot ' + (e.alive ? 'ok' : 'ko') + '"></span>' +
    (e.alive ? 'en marche' : 'arrêté');
  document.getElementById('tickinfo').textContent = 'dernier tick ' + ago(e.lastTickAt);
  document.getElementById('updated').textContent = 'maj ' + hhmmss(d.generatedAt);
  document.getElementById('footer-mode').textContent = 'base ' + e.baseCurrency + ' · ' + e.ticks + ' ticks';
  renderKpis(d); renderFlags(d); renderChart(d); renderPositions(d);
  renderWatchlist(d); renderTrades(d); renderSignals(d);
  renderRejections(d); renderEvents(d);
}

function refresh() {
  fetch('/api/overview').then(function (r) { return r.json(); }).then(render).catch(function () {
    var alive = document.getElementById('alive');
    alive.innerHTML = '<span class="dot ko"></span>base inaccessible';
  });
}
refresh(); setInterval(refresh, T);
</script>
</body>
</html>
`;
}

/**
 * Serveur HTTP du tableau de bord : `/` (page), `/api/overview` (JSON),
 * `/healthz` (santé minimale). Aucune authentification — usage réseau local.
 */
export async function startDashboardServer(deps: DashboardServerDeps): Promise<DashboardServer> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method !== 'GET') {
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('méthode non autorisée\n');
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(renderDashboardHtml());
      return;
    }

    if (url.pathname === '/api/overview') {
      try {
        const payload = buildOverview(deps.context);
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(
          `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
        );
      }
      return;
    }

    if (url.pathname === '/healthz') {
      const overview = buildOverview(deps.context) as {
        engine: { alive: boolean; mode: string };
      };
      response.writeHead(overview.engine.alive ? 200 : 503, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(`${JSON.stringify({ status: overview.engine.alive ? 'ok' : 'stale' })}\n`);
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('introuvable — endpoints : /, /api/overview, /healthz\n');
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(deps.port, deps.host);
    });
  } catch (error) {
    throw new SolbotError(
      `Impossible de démarrer le tableau de bord sur ${deps.host}:${deps.port} (${error instanceof Error ? error.message : String(error)})`,
      { hint: 'Choisissez un autre port : solbot web --port 4101', cause: error },
    );
  }

  const address = server.address() as AddressInfo;
  const port = address.port;
  return {
    host: deps.host,
    port,
    urls: [`http://${deps.host}:${port}`],
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
