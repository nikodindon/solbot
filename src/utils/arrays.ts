/** Découpe un tableau en lots de taille `size` (le dernier lot peut être plus petit). */
export function chunk<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error('size doit être un entier ≥ 1');
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** Dédoublonne en préservant l'ordre d'apparition. */
export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
