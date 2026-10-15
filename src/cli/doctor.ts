import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { DEFAULT_RPC_URL, MIN_NODE_MAJOR, USDC_MINT } from '../constants.js';
import { probeJupiterApi } from '../jupiter/health.js';
import { fetchTokenBalances } from '../solana/tokens.js';
import { resolveConnection } from '../solana/connection.js';
import { loadEnvFile } from '../utils/env-file.js';
import { loadConfig, parseEnv, type Config, type Env } from '../utils/config.js';
import { messageOf } from '../utils/errors.js';
import { ensureDir, getDataDir, getEnvPath, getProjectRoot } from '../utils/paths.js';
import { withTimeout } from '../utils/retry.js';
import { EnvSigner } from '../wallet/env-signer.js';
import type { Signer } from '../wallet/signer.js';
import { fail, printHeader, ICONS } from './ui.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** Exécute toutes les vérifications de l'environnement (sans effet de bord hors dossier data/). */
export async function runDoctor(options: { root?: string } = {}): Promise<DoctorCheck[]> {
  const root = options.root ?? getProjectRoot();
  const checks: DoctorCheck[] = [];

  // 1. Node.js
  const nodeMajor = Number.parseInt(process.version.replace(/^v/, '').split('.')[0] ?? '0', 10);
  checks.push(
    nodeMajor >= MIN_NODE_MAJOR
      ? { name: 'Node.js', status: 'ok', detail: process.version }
      : {
          name: 'Node.js',
          status: 'fail',
          detail: `${process.version} — Node ${MIN_NODE_MAJOR}+ requis`,
        },
  );

  // 2. Présence du .env
  const envFileExists = loadEnvFile(root);
  checks.push(
    envFileExists
      ? { name: '.env', status: 'ok', detail: getEnvPath(root) }
      : {
          name: '.env',
          status: 'warn',
          detail:
            'absent — lancez `npm run solbot -- init` (les variables système restent utilisées)',
        },
  );

  // 3. Validité des variables
  let env: Env | undefined;
  try {
    env = parseEnv(process.env);
    checks.push({ name: 'Variables', status: 'ok', detail: 'valides' });
  } catch (error) {
    checks.push({ name: 'Variables', status: 'fail', detail: messageOf(error) });
  }

  // 4. Wallet
  let signer: Signer | undefined;
  if (env) {
    try {
      signer = EnvSigner.fromEnv(env);
      checks.push({ name: 'Wallet', status: 'ok', detail: `adresse ${signer.address}` });
    } catch (error) {
      checks.push({ name: 'Wallet', status: 'fail', detail: messageOf(error) });
    }
  }

  // 5. Configuration
  let config: Config | undefined;
  try {
    const loaded = loadConfig({ root });
    config = loaded.config;
    if (loaded.sources.usedExample) {
      checks.push({
        name: 'Configuration',
        status: 'warn',
        detail: 'config.yaml absent — défauts de config.example.yaml utilisés',
      });
    } else {
      checks.push({
        name: 'Configuration',
        status: 'ok',
        detail: `config.yaml valide (mode : ${config.mode})`,
      });
    }
  } catch (error) {
    checks.push({ name: 'Configuration', status: 'fail', detail: messageOf(error) });
  }

  // 6. RPC Solana
  if (env) {
    try {
      const resolved = await resolveConnection(env, 8_000);
      const isPublic = resolved.url === DEFAULT_RPC_URL;
      checks.push({
        name: 'RPC Solana',
        status: isPublic ? 'warn' : 'ok',
        detail: [
          `v${resolved.probe.solanaCore}`,
          `${resolved.probe.latencyMs} ms`,
          resolved.usedFallback ? '(RPC de secours)' : '',
          isPublic
            ? '— endpoint public rate-limité, un RPC dédié est recommandé en production'
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      });

      // 7. Soldes
      if (signer) {
        try {
          const lamports = await withTimeout(
            resolved.connection.getBalance(signer.publicKey, 'confirmed'),
            8_000,
            'getBalance',
          );
          const sol = lamports / LAMPORTS_PER_SOL;
          const reserve = config?.risk.sol_gas_reserve ?? 0.05;
          checks.push(
            sol === 0
              ? {
                  name: 'Solde SOL',
                  status: 'fail',
                  detail: '0 SOL — financez le wallet pour payer les frais réseau',
                }
              : sol < reserve
                ? {
                    name: 'Solde SOL',
                    status: 'warn',
                    detail: `${sol.toFixed(4)} SOL — sous la réserve de gaz configurée (${reserve})`,
                  }
                : { name: 'Solde SOL', status: 'ok', detail: `${sol.toFixed(4)} SOL` },
          );
        } catch (error) {
          checks.push({ name: 'Solde SOL', status: 'warn', detail: messageOf(error) });
        }

        try {
          const balances = await withTimeout(
            fetchTokenBalances(resolved.connection, signer.publicKey),
            10_000,
            'getParsedTokenAccountsByOwner',
          );
          const usdc = balances.find((balance) => balance.mint === USDC_MINT)?.amount ?? 0;
          checks.push(
            usdc > 0
              ? { name: 'Solde USDC', status: 'ok', detail: usdc.toFixed(2) }
              : {
                  name: 'Solde USDC',
                  status: 'warn',
                  detail: 'aucun USDC — capital de trading vide',
                },
          );
        } catch (error) {
          checks.push({ name: 'Solde USDC', status: 'warn', detail: messageOf(error) });
        }
      }
    } catch (error) {
      checks.push({ name: 'RPC Solana', status: 'fail', detail: messageOf(error) });
    }
  }

  // 8. API Jupiter
  if (env) {
    const probe = await probeJupiterApi(env.JUPITER_API_KEY);
    checks.push({
      name: 'API Jupiter',
      status: probe.ok ? 'ok' : 'fail',
      detail: probe.detail,
    });
  }

  // 9. Dossier data/ inscriptible
  try {
    const dataDir = getDataDir(root);
    ensureDir(dataDir);
    const probeFile = path.join(dataDir, `.write-test-${process.pid}`);
    fs.writeFileSync(probeFile, 'ok');
    fs.unlinkSync(probeFile);
    checks.push({ name: 'Dossier data/', status: 'ok', detail: dataDir });
  } catch (error) {
    checks.push({ name: 'Dossier data/', status: 'fail', detail: messageOf(error) });
  }

  return checks;
}

export function doctorCommand(): Command {
  return new Command('doctor')
    .description("Vérifie l'environnement : Node, wallet, config, RPC, soldes, API Jupiter")
    .action(async () => {
      try {
        const checks = await runDoctor();
        printHeader('solbot doctor — vérification de l’environnement');
        for (const check of checks) {
          console.log(`  ${ICONS[check.status]} ${check.name.padEnd(14)} ${check.detail}`);
        }
        const ok = checks.filter((check) => check.status === 'ok').length;
        const warn = checks.filter((check) => check.status === 'warn').length;
        const failed = checks.filter((check) => check.status === 'fail').length;
        console.log('');
        if (failed > 0) {
          console.log(
            `  ${ok} ok · ${warn} avertissement(s) · ${failed} erreur(s) — corrigez les erreurs avant de continuer.`,
          );
          process.exitCode = 1;
        } else {
          console.log(`  ${ok} ok · ${warn} avertissement(s) · 0 erreur — environnement prêt. ✔`);
        }
      } catch (error) {
        fail(error);
      }
    });
}
