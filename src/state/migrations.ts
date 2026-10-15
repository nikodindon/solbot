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
