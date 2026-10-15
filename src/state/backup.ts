import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SolbotError } from '../utils/errors.js';

export interface BackupResult {
  path: string;
  bytes: number;
  ts: number;
  /** Fichiers supprimés par la rotation. */
  pruned: string[];
}

export interface BackupEntry {
  path: string;
  bytes: number;
  ts: number;
}

const BACKUP_RE = /^solbot-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.sqlite$/;

/** Dossier des sauvegardes (relatif à la racine du projet si non absolu). */
export function resolveBackupDir(root: string, configured: string): string {
  return path.isAbsolute(configured) ? configured : path.resolve(root, configured);
}

/** `solbot-2026-10-15T19-30-00.sqlite` (UTC, tri lexicographique = tri chronologique). */
export function backupFileName(ts: number): string {
  return `solbot-${new Date(ts).toISOString().slice(0, 19).replaceAll(':', '-')}.sqlite`;
}

/**
 * Sauvegarde cohérente de la base ouverte (`VACUUM INTO`, compatible WAL et
 * moteur en cours d'exécution), puis rotation : seules les `keep` plus
 * récentes sont conservées.
 */
export function createBackup(
  db: DatabaseSync,
  options: { dir: string; keep: number; ts?: number },
): BackupResult {
  const ts = options.ts ?? Date.now();
  fs.mkdirSync(options.dir, { recursive: true });
  const target = path.join(options.dir, backupFileName(ts));
  if (fs.existsSync(target)) {
    throw new SolbotError(`la sauvegarde existe déjà : ${target}`, {
      hint: 'Relancez dans une seconde (horodatage à la seconde), ou supprimez le fichier.',
    });
  }
  const escaped = target.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  const bytes = fs.statSync(target).size;
  const pruned = pruneBackups(options.dir, options.keep);
  return { path: target, bytes, ts, pruned };
}

/** Supprime les sauvegardes au-delà des `keep` plus récentes. */
export function pruneBackups(dir: string, keep: number): string[] {
  if (keep <= 0) return [];
  const entries = listBackups(dir);
  const stale = entries.slice(keep);
  for (const entry of stale) fs.rmSync(entry.path, { force: true });
  return stale.map((entry) => entry.path);
}

/** Sauvegardes présentes, de la plus récente à la plus ancienne. */
export function listBackups(dir: string): BackupEntry[] {
  if (!fs.existsSync(dir)) return [];
  const entries: BackupEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!BACKUP_RE.test(name)) continue;
    const fullPath = path.join(dir, name);
    const stat = fs.statSync(fullPath);
    entries.push({ path: fullPath, bytes: stat.size, ts: stat.mtimeMs });
  }
  return entries.sort((a, b) => (a.path < b.path ? 1 : a.path > b.path ? -1 : 0));
}

/** Vérifie qu'un fichier est une base SQLite saine (`PRAGMA integrity_check`). */
export function verifyBackup(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new SolbotError(`sauvegarde introuvable : ${filePath}`);
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
    const row = db.prepare('PRAGMA integrity_check').get() as unknown as Record<string, unknown>;
    const value = Object.values(row)[0];
    if (value !== 'ok') {
      throw new SolbotError(
        `sauvegarde corrompue (integrity_check : ${String(value)}) : ${filePath}`,
      );
    }
  } catch (error) {
    if (error instanceof SolbotError) throw error;
    throw new SolbotError(
      `fichier illisible comme base SQLite : ${filePath} (${error instanceof Error ? error.message : String(error)})`,
    );
  } finally {
    db?.close();
  }
}

/**
 * Restaure `from` vers `to` : vérifie l'intégrité, refuse d'écraser une base
 * existante sans `overwrite`, puis copie et nettoie les journaux WAL/SHM
 * périmés. Le moteur doit être arrêté pendant la restauration.
 */
export function restoreBackup(options: {
  from: string;
  to: string;
  overwrite?: boolean;
}): BackupEntry {
  verifyBackup(options.from);
  if (fs.existsSync(options.to) && options.overwrite !== true) {
    throw new SolbotError(`la base existe déjà : ${options.to}`, {
      hint: 'Arrêtez le moteur, puis relancez avec --yes pour écraser la base par la sauvegarde.',
    });
  }
  fs.mkdirSync(path.dirname(options.to), { recursive: true });
  fs.copyFileSync(options.from, options.to);
  for (const suffix of ['-wal', '-shm']) {
    fs.rmSync(`${options.to}${suffix}`, { force: true });
  }
  const stat = fs.statSync(options.to);
  return { path: options.to, bytes: stat.size, ts: stat.mtimeMs };
}
