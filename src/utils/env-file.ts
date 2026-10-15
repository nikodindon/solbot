import fs from 'node:fs';
import { getEnvPath, getProjectRoot } from './paths.js';

const KEY_PATTERN = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")));
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

/** Parse un contenu `.env` en Map (dernière occurrence gagnante, commentaires ignorés). */
export function parseEnvContent(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = KEY_PATTERN.exec(line);
    if (!match || match[1] === undefined || match[2] === undefined) continue;
    entries.set(match[1], unquote(match[2]));
  }
  return entries;
}

/**
 * Met à jour (ou ajoute) `KEY=value` en préservant l'ordre, les commentaires
 * et les autres variables. Les doublons éventuels de `key` sont supprimés.
 */
export function upsertEnvVar(content: string, key: string, value: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const isKeyLine = (line: string): boolean => KEY_PATTERN.exec(line.trim())?.[1] === key;
  const newLine = `${key}=${value}`;

  const lines = content === '' ? [] : content.split(/\r?\n/);
  const firstIndex = lines.findIndex(isKeyLine);

  if (firstIndex === -1) {
    const base = content !== '' && !content.endsWith('\n') ? content + eol : content;
    return base + newLine + eol;
  }

  const result: string[] = [];
  let inserted = false;
  for (const line of lines) {
    if (isKeyLine(line)) {
      if (!inserted) {
        result.push(newLine);
        inserted = true;
      }
      // doublons supprimés
    } else {
      result.push(line);
    }
  }
  return result.join(eol);
}

/** Masque un secret pour affichage (`1234…cdef`) — les valeurs courtes sont masquées intégralement. */
export function maskSecret(secret: string): string {
  return secret.length <= 8 ? '********' : `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

/**
 * Charge le fichier `.env` dans `target` (par défaut `process.env`).
 * Les variables déjà définies (non vides) ne sont jamais écrasées.
 * Retourne `false` si le fichier est absent.
 */
export function loadEnvFile(
  root: string = getProjectRoot(),
  target: NodeJS.ProcessEnv = process.env,
): boolean {
  const envPath = getEnvPath(root);
  if (!fs.existsSync(envPath)) return false;

  const entries = parseEnvContent(fs.readFileSync(envPath, 'utf8'));
  for (const [key, value] of entries) {
    if (target[key] === undefined || target[key] === '') target[key] = value;
  }
  return true;
}
