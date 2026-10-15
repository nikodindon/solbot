import fs from 'node:fs';
import { getPackageJsonPath, getProjectRoot } from './paths.js';

/** Version du package lue depuis package.json (fallback : '0.0.0'). */
export function getPackageVersion(root: string = getProjectRoot()): string {
  try {
    const raw = fs.readFileSync(getPackageJsonPath(root), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
