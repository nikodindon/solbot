import { Command } from 'commander';
import { SOL_MINT, USDC_MINT } from '../constants.js';
import { JupiterClient } from '../jupiter/client.js';
import { PriceApi } from '../jupiter/price.js';
import { TokensApi } from '../jupiter/tokens.js';
import { parseEnv } from '../utils/config.js';
import { loadEnvFile } from '../utils/env-file.js';
import { SolbotError } from '../utils/errors.js';
import { getProjectRoot } from '../utils/paths.js';
import {
  fail,
  formatPct,
  formatPriceUsd,
  formatRatio,
  formatUsdCompact,
  ICONS,
  printHeader,
  shorten,
} from './ui.js';

const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SYMBOL_ALIASES = new Map<string, string>([
  ['SOL', SOL_MINT],
  ['WSOL', SOL_MINT],
  ['USDC', USDC_MINT],
]);

export interface ResolvedAsset {
  mint: string;
  label: string;
}

/** Résout un argument CLI (symbole, nom ou mint) en adresse mint. */
export async function resolveAsset(tokensApi: TokensApi, input: string): Promise<ResolvedAsset> {
  const trimmed = input.trim();
  const upper = trimmed.toUpperCase();

  const alias = SYMBOL_ALIASES.get(upper);
  if (alias !== undefined) return { mint: alias, label: upper === 'WSOL' ? 'SOL' : upper };
  if (BASE58_PATTERN.test(trimmed)) return { mint: trimmed, label: shorten(trimmed, 4, 4) };

  const results = await tokensApi.search(trimmed);
  const exact = results.find((token) => token.symbol.toUpperCase() === upper) ?? results[0];
  if (exact === undefined) {
    throw new SolbotError(`Aucun token trouvé pour « ${input} »`, {
      hint: 'Essayez un symbole exact (ex. BONK), un nom, ou une adresse mint complète.',
    });
  }
  return { mint: exact.id, label: exact.symbol || shorten(exact.id, 4, 4) };
}

/** Affiche le prix USD (Price v3) des actifs demandés + paire implicite si deux actifs. */
export async function runPrice(inputs: string[], options: { root?: string } = {}): Promise<void> {
  const root = options.root ?? getProjectRoot();
  loadEnvFile(root);
  const env = parseEnv();

  const client = new JupiterClient({
    apiKey: env.JUPITER_API_KEY,
    ratePerSecond: env.JUPITER_RPS,
  });
  const tokensApi = new TokensApi(client);
  const priceApi = new PriceApi(client);

  const assets: ResolvedAsset[] = [];
  for (const input of inputs) assets.push(await resolveAsset(tokensApi, input));

  const prices = await priceApi.getPrices(
    assets.map((asset) => asset.mint),
    { useCache: false },
  );

  printHeader(`solbot price — ${assets.map((asset) => asset.label).join(' / ')}`);
  for (const asset of assets) {
    const info = prices.get(asset.mint);
    if (info === undefined) {
      console.log(
        `  ${ICONS.warn} ${asset.label.padEnd(12)} ${shorten(asset.mint, 6, 6).padEnd(14)} prix indisponible (mint invalide ou liquidité insuffisante ?)`,
      );
      continue;
    }
    console.log(
      `  ${asset.label.padEnd(12)} ${shorten(asset.mint, 6, 6).padEnd(14)} ` +
        `${formatPriceUsd(info.usdPrice).padEnd(14)} ${formatPct(info.priceChange24h ?? null).padEnd(11)} ` +
        `liquidité ${formatUsdCompact(info.liquidity)}`,
    );
  }

  if (assets.length === 2) {
    const [first, second] = assets as [ResolvedAsset, ResolvedAsset];
    const priceFirst = prices.get(first.mint)?.usdPrice;
    const priceSecond = prices.get(second.mint)?.usdPrice;
    if (priceFirst !== undefined && priceSecond !== undefined && priceSecond > 0) {
      console.log('');
      console.log(`  1 ${first.label} ≈ ${formatRatio(priceFirst / priceSecond)} ${second.label}`);
    }
  }
}

export function priceCommand(): Command {
  return new Command('price')
    .description('Prix USD en direct (Price API v3) — symbole, nom ou mint')
    .argument('<actifs...>', 'ex. : SOL USDC — ou un mint complet')
    .action(async (assets: string[]) => {
      try {
        await runPrice(assets);
      } catch (error) {
        fail(error);
      }
    });
}
