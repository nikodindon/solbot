import { SolbotError, messageOf } from '../utils/errors.js';

export const ICONS = { ok: '✔', warn: '⚠', fail: '✖' } as const;

/** Affiche une erreur avec son indice actionnable et positionne le code de sortie à 1. */
export function fail(error: unknown): void {
  process.exitCode = 1;
  if (error instanceof SolbotError) {
    console.error(`\n  ${ICONS.fail} ${error.message}`);
    if (error.hint) console.error(`    → ${error.hint}`);
    return;
  }
  console.error(`\n  ${ICONS.fail} ${messageOf(error)}`);
}

export function printHeader(title: string): void {
  console.log(`\n  ${title}`);
  console.log(`  ${'─'.repeat(Math.max(title.length, 44))}`);
}

/** Raccourcit une adresse/mint pour l'affichage : `4k3D…9xQz`. */
export function shorten(value: string, head = 4, tail = 4): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

/** Prix unitaire en USD : précision adaptative ($147.48, $0.0421, $0.00000421). */
export function formatPriceUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1) return `$${value.toFixed(2)}`;
  if (abs >= 1e-6) return `$${String(Number(value.toPrecision(3)))}`;
  return `$${value.toExponential(2)}`;
}

/** Montant compact : $621.7M, $1.20B, $4.2k. */
export function formatUsdCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

/** Variation signée : `+1.29 %` / `-0.05 %`. */
export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)} %`;
}

/** Ratio entre deux actifs : décimal si raisonnable, notation scientifique compacte sinon. */
export function formatRatio(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  const trimmed = Number(value.toPrecision(6));
  if (trimmed >= 1e-4 && trimmed < 1e15) return String(trimmed);
  return value.toExponential(4);
}

/** Convertit une option CLI numérique, avec bornes explicites (erreur sinon). */
export function parseIntOption(raw: string, label: string, min = 1, max?: number): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    const bounds = max === undefined ? `≥ ${min}` : `entre ${min} et ${max}`;
    throw new SolbotError(`${label} invalide : « ${raw} » (entier ${bounds} attendu)`);
  }
  return value;
}
