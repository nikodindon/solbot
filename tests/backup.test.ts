import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backupFileName,
  createBackup,
  listBackups,
  pruneBackups,
  resolveBackupDir,
  restoreBackup,
  verifyBackup,
} from '../src/state/backup.js';
import { getState, setState } from '../src/state/bot-state.js';
import { openDatabase } from '../src/state/db.js';
import { runMigrations } from '../src/state/migrations.js';

const NOW = 1_750_000_000_000;
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solbot-backup-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function memoryDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

function readState(filePath: string, key: string): string | null {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return getState(db, key);
  } finally {
    db.close();
  }
}

describe('createBackup', () => {
  it('produit un snapshot cohérent et vérifiable', () => {
    const dir = tempDir();
    const db = memoryDb();
    setState(db, 'clé', 'valeur', NOW);

    const result = createBackup(db, { dir, keep: 7, ts: NOW });

    expect(result.path).toBe(path.join(dir, backupFileName(NOW)));
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.pruned).toEqual([]);
    verifyBackup(result.path);
    expect(readState(result.path, 'clé')).toBe('valeur');
    db.close();
  });

  it('refuse d’écraser une sauvegarde existante (horodatage à la seconde)', () => {
    const dir = tempDir();
    const db = memoryDb();
    createBackup(db, { dir, keep: 7, ts: NOW });
    expect(() => createBackup(db, { dir, keep: 7, ts: NOW })).toThrow(/existe déjà/);
    db.close();
  });
});

describe('rotation', () => {
  it('conserve les `keep` sauvegardes les plus récentes (tri chronologique)', () => {
    const dir = tempDir();
    const db = memoryDb();
    createBackup(db, { dir, keep: 2, ts: 1_000 });
    createBackup(db, { dir, keep: 2, ts: 2_000 });
    const third = createBackup(db, { dir, keep: 2, ts: 3_000 });

    expect(third.pruned).toEqual([path.join(dir, backupFileName(1_000))]);
    const entries = listBackups(dir);
    expect(entries.map((entry) => path.basename(entry.path))).toEqual([
      backupFileName(3_000),
      backupFileName(2_000),
    ]);

    expect(pruneBackups(dir, 1)).toEqual([path.join(dir, backupFileName(2_000))]);
    expect(listBackups(dir)).toHaveLength(1);
    expect(listBackups(tempDir())).toEqual([]);
    db.close();
  });
});

describe('restoreBackup', () => {
  it('restaure vers une base neuve, refuse d’écraser sans confirmation', () => {
    const dir = tempDir();
    const db = memoryDb();
    setState(db, 'clé', 'valeur', NOW);
    const backup = createBackup(db, { dir, keep: 7, ts: NOW });
    db.close();

    const target = path.join(tempDir(), 'sous-dossier', 'base.sqlite');
    const restored = restoreBackup({ from: backup.path, to: target });
    expect(restored.path).toBe(target);
    expect(readState(target, 'clé')).toBe('valeur');

    expect(() => restoreBackup({ from: backup.path, to: target })).toThrow(/existe déjà/);
    expect(() => restoreBackup({ from: backup.path, to: target, overwrite: true })).not.toThrow();
  });

  it('refuse un fichier absent ou illisible', () => {
    const dir = tempDir();
    expect(() => verifyBackup(path.join(dir, 'absent.sqlite'))).toThrow(/introuvable/);

    const garbage = path.join(dir, 'garbage.sqlite');
    fs.writeFileSync(garbage, 'ceci n’est pas une base SQLite');
    expect(() => verifyBackup(garbage)).toThrow(/illisible|corrompue/);
    expect(() => restoreBackup({ from: garbage, to: path.join(dir, 'cible.sqlite') })).toThrow(
      /illisible|corrompue/,
    );
  });
});

describe('resolveBackupDir', () => {
  it('résout les chemins relatifs depuis la racine du projet', () => {
    expect(resolveBackupDir('/home/niko/solbot', './data/backups')).toBe(
      '/home/niko/solbot/data/backups',
    );
    expect(resolveBackupDir('/home/niko/solbot', '/var/backups')).toBe('/var/backups');
  });
});
