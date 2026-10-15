import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Racine du projet.
 * - Détectée depuis l'emplacement du module : `src/utils` → racine, `dist/utils` → racine.
 * - Surchargeable via `SOLBOT_HOME` (tests, instances multiples).
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const detectedRoot = path.resolve(moduleDir, '..', '..');

export function getProjectRoot(): string {
  const override = process.env.SOLBOT_HOME?.trim();
  return override ? path.resolve(override) : detectedRoot;
}

export function getEnvPath(root = getProjectRoot()): string {
  return path.join(root, '.env');
}

export function getConfigPath(root = getProjectRoot()): string {
  return path.join(root, 'config', 'config.yaml');
}

export function getConfigExamplePath(root = getProjectRoot()): string {
  return path.join(root, 'config', 'config.example.yaml');
}

export function getDataDir(root = getProjectRoot()): string {
  return path.join(root, 'data');
}

export function getPackageJsonPath(root = getProjectRoot()): string {
  return path.join(root, 'package.json');
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
