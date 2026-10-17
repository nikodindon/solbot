import fs from 'node:fs';
import os from 'node:os';
import { Command } from 'commander';
import {
  openReadonlyDatabase,
  startDashboardServer,
  type DashboardRequirement,
} from '../monitoring/dashboard.js';
import { resolveDatabasePath } from '../state/db.js';
import { buildStrategies } from '../strategy/registry.js';
import { loadConfig, type Config } from '../utils/config.js';
import { SolbotError } from '../utils/errors.js';
import { getPackageVersion } from '../utils/package.js';
import { getProjectRoot } from '../utils/paths.js';
import { fail, ICONS, parseIntOption, printHeader } from './ui.js';

export interface WebCliOptions {
  host?: string;
  port?: string;
  root?: string;
}

/**
 * Exigences cumulées des stratégies actives : pour chaque timeframe, le nombre
 * de bougies maximal exigé (définit le compteur « prêts x/y » du tableau de bord).
 */
export function dashboardRequirements(config: Config): DashboardRequirement[] {
  const byTimeframe = new Map<string, number>();
  for (const strategy of buildStrategies(config)) {
    for (const requirement of strategy.requiredData) {
      byTimeframe.set(
        requirement.timeframe,
        Math.max(byTimeframe.get(requirement.timeframe) ?? 0, requirement.bars),
      );
    }
  }
  return [...byTimeframe.entries()].map(([timeframe, bars]) => ({ timeframe, bars }));
}

/** Adresses IPv4 non-internes de la machine (accès depuis le réseau local). */
function lanAddresses(port: number): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(`${entry.address}:${port}`);
    }
  }
  return addresses;
}

/**
 * `solbot web` : tableau de bord temps réel (page + `/api/overview`) exposé sur
 * `dashboard.host:dashboard.port` (défaut 0.0.0.0:4100). **Lecture seule** :
 * la base est ouverte sans droit d'écriture, le moteur peut tourner en parallèle.
 */
export async function runWebCli(options: WebCliOptions = {}): Promise<void> {
  const root = options.root ?? getProjectRoot();
  const { config } = loadConfig({ root });
  const dbPath = resolveDatabasePath(root, config.database.path);
  if (!fs.existsSync(dbPath)) {
    throw new SolbotError(`Base introuvable : ${dbPath}`, {
      hint: 'Lancez d’abord un run (npm run solbot -- start --paper) ou un scan, puis relancez `solbot web`.',
    });
  }

  const host = options.host ?? config.dashboard.host;
  const port =
    options.port === undefined
      ? config.dashboard.port
      : parseIntOption(options.port, '--port', 1, 65535);

  let requirements: DashboardRequirement[];
  try {
    requirements = dashboardRequirements(config);
  } catch {
    requirements = [];
  }

  const db = openReadonlyDatabase(dbPath);
  const server = await startDashboardServer({
    host,
    port,
    context: {
      db,
      root,
      version: getPackageVersion(),
      mode: config.mode,
      baseCurrency: config.base_currency,
      initialUsdc: config.mode === 'paper' ? config.paper.initial_usdc : null,
      requirements,
      recentLimit: config.dashboard.recent_limit,
    },
  });

  printHeader('solbot web — tableau de bord temps réel (lecture seule)');
  console.log(`  base      : ${dbPath}`);
  console.log(`  écoute    : http://${host}:${server.port}`);
  for (const address of lanAddresses(server.port)) {
    console.log(`  réseau    : http://${address}`);
  }
  if (host === '0.0.0.0' || host === '::') {
    console.log(
      `  ${ICONS.warn} aucune authentification — à réserver à votre réseau local (pas d'exposition Internet)`,
    );
  }
  console.log('  Ctrl+C pour arrêter');

  await new Promise<void>((resolve) => {
    const shutdown = (): void => resolve();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  await server.close();
  db.close();
  console.log('\n  ' + ICONS.ok + ' tableau de bord arrêté');
}

export function webCommand(): Command {
  return new Command('web')
    .description('tableau de bord web temps réel du bot (lecture seule de la base)')
    .option('--host <host>', "adresse d'écoute (défaut : dashboard.host de config.yaml)")
    .option('--port <port>', "port d'écoute (défaut : dashboard.port de config.yaml)")
    .action(async (options: WebCliOptions) => {
      try {
        await runWebCli({
          ...(options.host === undefined ? {} : { host: options.host }),
          ...(options.port === undefined ? {} : { port: options.port }),
        });
      } catch (error) {
        fail(error);
      }
    });
}
