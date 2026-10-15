import { Command } from 'commander';
import { formatBytes } from '../notifications/notifier.js';
import { createBackup, listBackups, resolveBackupDir, restoreBackup } from '../state/backup.js';
import { openDatabase, resolveDatabasePath } from '../state/db.js';
import { loadConfig } from '../utils/config.js';
import { getProjectRoot } from '../utils/paths.js';
import { fail, ICONS, parseIntOption, printHeader } from './ui.js';

export interface BackupCliOptions {
  list?: boolean;
  restore?: string;
  dir?: string;
  keep?: string;
  /** Confirme l'écrasement de la base lors d'une restauration. */
  yes?: boolean;
}

/**
 * `solbot backup` : sauvegarde SQLite manuelle (VACUUM INTO + rotation),
 * liste des sauvegardes, ou restauration vers la base courante.
 */
export async function runBackupCli(options: BackupCliOptions): Promise<void> {
  const root = getProjectRoot();
  const { config } = loadConfig({ root });
  const dir = resolveBackupDir(root, options.dir ?? config.backups.dir);
  const keep =
    options.keep === undefined
      ? config.backups.keep
      : parseIntOption(options.keep, '--keep', 1, 90);
  const dbPath = resolveDatabasePath(root, config.database.path);

  if (options.restore !== undefined) {
    printHeader('solbot backup — restauration');
    const entry = restoreBackup({
      from: options.restore,
      to: dbPath,
      overwrite: options.yes === true,
    });
    console.log(`  ${ICONS.ok} base restaurée : ${entry.path} (${formatBytes(entry.bytes)})`);
    console.log('  → vérifiez avec `solbot doctor` puis relancez `solbot start`.');
    console.log('');
    return;
  }

  if (options.list === true) {
    printHeader(`solbot backup — ${dir}`);
    const entries = listBackups(dir);
    if (entries.length === 0) {
      console.log('  aucune sauvegarde (lancez `solbot backup` pour en créer une)');
    } else {
      for (const entry of entries) {
        const date = new Date(entry.ts).toISOString().slice(0, 19).replace('T', ' ');
        console.log(`  ${ICONS.ok} ${date} · ${formatBytes(entry.bytes)} · ${entry.path}`);
      }
    }
    console.log('');
    return;
  }

  printHeader('solbot backup — sauvegarde SQLite');
  const ts = Date.now();
  const db = openDatabase(dbPath);
  try {
    const result = createBackup(db, { dir, keep, ts });
    console.log(`  ${ICONS.ok} sauvegarde créée : ${result.path} (${formatBytes(result.bytes)})`);
    if (result.pruned.length > 0) {
      console.log(`  ${ICONS.warn} rotation : ${result.pruned.length} ancienne(s) supprimée(s)`);
    }
    console.log(
      `  restauration : \`solbot backup --restore ${result.path} --yes\` (moteur arrêté)`,
    );
  } finally {
    db.close();
  }
  console.log('');
}

export function backupCommand(): Command {
  return new Command('backup')
    .description('sauvegardes SQLite (VACUUM INTO) : création manuelle, liste, restauration')
    .option('--list', 'liste les sauvegardes existantes')
    .option('--restore <fichier>', 'restaure une sauvegarde vers la base courante')
    .option('--dir <chemin>', 'dossier des sauvegardes (défaut : config.backups.dir)')
    .option('--keep <n>', 'nombre de sauvegardes conservées (défaut : config.backups.keep)')
    .option('--yes', 'confirme l’écrasement de la base lors d’une restauration')
    .action(async (options: BackupCliOptions) => {
      try {
        await runBackupCli({
          ...(options.list === undefined ? {} : { list: options.list }),
          ...(options.restore === undefined ? {} : { restore: options.restore }),
          ...(options.dir === undefined ? {} : { dir: options.dir }),
          ...(options.keep === undefined ? {} : { keep: options.keep }),
          ...(options.yes === undefined ? {} : { yes: options.yes }),
        });
      } catch (error) {
        fail(error);
      }
    });
}
