import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Migrations versionnées, appliquées dans l'ordre et jamais modifiées après coup.
 * Chaque migration s'exécute dans une transaction ; l'échec annule tout.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE watchlist (
        mint             TEXT PRIMARY KEY,
        symbol           TEXT NOT NULL,
        name             TEXT NOT NULL,
        rank             INTEGER NOT NULL,
        is_base          INTEGER NOT NULL DEFAULT 0,
        is_verified      INTEGER NOT NULL DEFAULT 0,
        organic_score    REAL,
        liquidity_usd    REAL,
        usd_price        REAL,
        price_change_24h REAL,
        tags             TEXT,
        updated_at       INTEGER NOT NULL
      );

      CREATE TABLE price_ticks (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        mint             TEXT NOT NULL,
        usd_price        REAL NOT NULL,
        liquidity_usd    REAL,
        price_change_24h REAL,
        block_id         INTEGER,
        ts               INTEGER NOT NULL
      );
      CREATE INDEX idx_price_ticks_mint_ts ON price_ticks (mint, ts);

      CREATE TABLE candles (
        mint         TEXT NOT NULL,
        timeframe    TEXT NOT NULL,
        bucket_start INTEGER NOT NULL,
        open         REAL NOT NULL,
        high         REAL NOT NULL,
        low          REAL NOT NULL,
        close        REAL NOT NULL,
        tick_count   INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (mint, timeframe, bucket_start)
      );
    `,
  },
  {
    version: 2,
    name: 'trades',
    sql: `
      CREATE TABLE trades (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        mode                   TEXT NOT NULL,
        status                 TEXT NOT NULL,
        signature              TEXT,
        request_id             TEXT,
        input_mint             TEXT NOT NULL,
        output_mint            TEXT NOT NULL,
        in_amount              TEXT NOT NULL,
        expected_out_amount    TEXT,
        out_amount             TEXT,
        router                 TEXT,
        fee_bps                INTEGER,
        fee_mint               TEXT,
        price_impact           REAL,
        slippage_bps           INTEGER,
        realized_slippage_bps  INTEGER,
        error_code             INTEGER,
        error_message          TEXT,
        created_at             INTEGER NOT NULL
      );
      CREATE INDEX idx_trades_created_at ON trades (created_at);
    `,
  },
  {
    version: 3,
    name: 'engine',
    sql: `
      -- Position agrégée par actif (une position ouverte max par mint ; les lots
      -- restants vivent dans position_lots pour le cost basis FIFO).
      CREATE TABLE positions (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        mint                  TEXT NOT NULL,
        symbol                TEXT NOT NULL,
        decimals              INTEGER NOT NULL,
        status                TEXT NOT NULL,               -- open | closed
        qty                   TEXT NOT NULL,               -- unités de base (texte, u64)
        qty_remaining         TEXT NOT NULL,
        avg_entry_price_usd   REAL NOT NULL,
        cost_basis_usd        REAL NOT NULL,               -- coût des unités restantes
        realized_pnl_usd      REAL NOT NULL DEFAULT 0,
        peak_price_usd        REAL,                        -- high-water mark (trailing)
        stop_loss_price_usd   REAL,
        take_profit_price_usd REAL,
        opened_at             INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL,
        closed_at             INTEGER
      );
      CREATE INDEX idx_positions_status ON positions (status);
      CREATE INDEX idx_positions_mint ON positions (mint, status);

      CREATE TABLE position_lots (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER NOT NULL REFERENCES positions(id),
        qty         TEXT NOT NULL,                          -- unités de base restantes du lot
        price_usd   REAL NOT NULL,
        ts          INTEGER NOT NULL
      );
      CREATE INDEX idx_position_lots_position ON position_lots (position_id);

      CREATE TABLE signals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        strategy    TEXT NOT NULL,
        mint        TEXT NOT NULL,
        symbol      TEXT NOT NULL,
        side        TEXT NOT NULL,                          -- buy | sell
        confidence  REAL NOT NULL,
        edge_bps    REAL,
        ttl_ms      INTEGER NOT NULL,
        reason      TEXT NOT NULL,
        acted       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_signals_ts ON signals (ts);

      CREATE TABLE risk_rejections (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         INTEGER NOT NULL,
        mint       TEXT NOT NULL,
        symbol     TEXT NOT NULL,
        side       TEXT NOT NULL,
        strategy   TEXT NOT NULL,
        rule       TEXT NOT NULL,
        message    TEXT NOT NULL,
        metrics    TEXT
      );
      CREATE INDEX idx_risk_rejections_ts ON risk_rejections (ts);

      CREATE TABLE events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      INTEGER NOT NULL,
        level   TEXT NOT NULL,                              -- info | warn | error
        kind    TEXT NOT NULL,
        message TEXT NOT NULL,
        details TEXT
      );
      CREATE INDEX idx_events_ts ON events (ts);

      CREATE TABLE bot_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Ticks enrichis du volume 24 h (proxy de volume pour la confirmation momentum).
      ALTER TABLE price_ticks ADD COLUMN volume_24h_usd REAL;

      -- Volume agrégé par bougie (somme des deltas de volume 24 h dans le bucket).
      ALTER TABLE candles ADD COLUMN volume_usd REAL NOT NULL DEFAULT 0;

      -- Origine des trades exécutés par le moteur (audit signaux → exécution).
      ALTER TABLE trades ADD COLUMN strategy TEXT;
      ALTER TABLE trades ADD COLUMN trigger TEXT;
    `,
  },
];

/** Applique les migrations manquantes. Retourne le nombre de migrations appliquées. */
export function runMigrations(db: DatabaseSync): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const rows = db.prepare('SELECT version FROM schema_migrations').all() as unknown as {
    version: number;
  }[];
  const applied = new Set(rows.map((row) => row.version));

  let count = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      count += 1;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return count;
}

/** Version de schéma courante (0 si aucune migration appliquée). */
export function currentSchemaVersion(db: DatabaseSync): number {
  try {
    const row = db
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as unknown as { version: number | null } | undefined;
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}
