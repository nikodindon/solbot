import { SolbotError } from '../utils/errors.js';

/**
 * Convertit un montant décimal saisi par l'utilisateur en unités de base (bigint).
 * Accepte la virgule française (« 1,5 ») et les espaces. Rejette tout le reste.
 */
export function parseDecimalAmount(input: string, decimals: number): bigint {
  const normalized = input.trim().replace(/\s+/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new SolbotError(`Montant invalide : « ${input} »`, {
      hint: 'Format attendu : un nombre décimal (ex. 0.5, 1,5, 100).',
    });
  }

  const [integerPart = '0', fractionPart = ''] = normalized.split('.');
  if (fractionPart.length > decimals) {
    throw new SolbotError(
      `Montant trop précis : « ${input} » (maximum ${decimals} décimales pour ce token)`,
    );
  }
  const padded = fractionPart.padEnd(decimals, '0');
  const value = BigInt(`${integerPart}${padded}`);
  if (value <= 0n) {
    throw new SolbotError('Le montant doit être strictement positif');
  }
  return value;
}

/** Convertit des unités de base en chaîne décimale lisible (« 1500000 », 6 → « 1.5 »). */
export function formatBaseUnits(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, '0');
  const integerPart = digits.slice(0, -decimals);
  const fractionPart = digits.slice(-decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${integerPart}${fractionPart === '' ? '' : `.${fractionPart}`}`;
}

/**
 * Montant maximal dépensable à partir d'un solde, en gardant une réserve
 * (ex. `risk.sol_gas_reserve` pour le SOL). Lève si le solde ne couvre pas la réserve.
 */
export function maxSpendableBaseUnits(balanceBaseUnits: bigint, reserveBaseUnits = 0n): bigint {
  const spendable = balanceBaseUnits - reserveBaseUnits;
  if (spendable <= 0n) {
    throw new SolbotError('Solde insuffisant pour couvrir la réserve de gaz', {
      hint: 'Créditez le wallet en SOL (frais réseau) ou réduisez risk.sol_gas_reserve.',
    });
  }
  return spendable;
}
