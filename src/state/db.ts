import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureDir } from '../utils/paths.js';

/**
 * Ouvre (et crée si besoin) la base SQLite via `node:sqlite` — intégré à Node 22,
 * aucune dépendance native. WAL activé pour la lecture concurrente.
 */
export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') ensureDir(path.dirname(dbPath));
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** Résout le chemin de la base configuré dans config.yaml (relatif à la racine du projet). */
export function resolveDatabasePath(root: string, configuredPath: string): string {
  if (configuredPath === ':memory:' || path.isAbsolute(configuredPath)) return configuredPath;
  return path.resolve(root, configuredPath);
}
