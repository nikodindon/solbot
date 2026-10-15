import { Command } from 'commander';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { USDC_MINT } from '../constants.js';
import { resolveConnection } from '../solana/connection.js';
import { fetchTokenBalances } from '../solana/tokens.js';
import { loadConfig, parseEnv } from '../utils/config.js';
import { loadEnvFile } from '../utils/env-file.js';
import { getProjectRoot } from '../utils/paths.js';
import { EnvSigner } from '../wallet/env-signer.js';
import { fail, printHeader, shorten, ICONS } from './ui.js';

export function balanceCommand(): Command {
  return new Command('balance')
    .description('Affiche les soldes SOL / USDC / jetons SPL du wallet de trading')
    .action(async () => {
      try {
        const root = getProjectRoot();
        loadEnvFile(root);
        const env = parseEnv(process.env);
        const { config } = loadConfig({ root });
        const signer = EnvSigner.fromEnv(env);
        const resolved = await resolveConnection(env);

        const [lamports, tokenBalances] = await Promise.all([
          resolved.connection.getBalance(signer.publicKey, 'confirmed'),
          fetchTokenBalances(resolved.connection, signer.publicKey),
        ]);

        const sol = lamports / LAMPORTS_PER_SOL;
        const usdc = tokenBalances.find((balance) => balance.mint === USDC_MINT)?.amount ?? 0;
        const others = tokenBalances.filter((balance) => balance.mint !== USDC_MINT);

        printHeader('solbot balance');
        console.log(`  Adresse : ${signer.address}`);
        console.log(
          `  SOL     : ${sol.toFixed(4)}${
            sol < config.risk.sol_gas_reserve
              ? `  ${ICONS.warn} sous la réserve de gaz (${config.risk.sol_gas_reserve})`
              : ''
          }`,
        );
        console.log(`  USDC    : ${usdc.toFixed(2)}`);
        if (others.length > 0) {
          console.log(`  Autres jetons (${others.length}) :`);
          for (const token of others.slice(0, 20)) {
            console.log(`    ${shorten(token.mint, 6, 6)}  ${token.amount}`);
          }
          if (others.length > 20) {
            console.log(`    … et ${others.length - 20} autre(s)`);
          }
        }
      } catch (error) {
        fail(error);
      }
    });
}
