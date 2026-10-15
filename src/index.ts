#!/usr/bin/env node
// ⚠ Doit rester le premier import : masque l'avertissement `node:sqlite` avant
// que les modules suivants ne le chargent (cf. src/utils/warnings.ts).
import './utils/warnings.js';
import { Command } from 'commander';
import { backtestCommand } from './cli/backtest.js';
import { balanceCommand } from './cli/balance.js';
import { doctorCommand } from './cli/doctor.js';
import { initCommand } from './cli/init.js';
import { priceCommand } from './cli/price.js';
import { reportCommand } from './cli/report.js';
import { scanCommand } from './cli/scan.js';
import { startCommand } from './cli/start.js';
import { swapCommand } from './cli/swap.js';
import { versionCommand } from './cli/version.js';
import { watchCommand } from './cli/watch.js';
import { getPackageVersion } from './utils/package.js';

const program = new Command();

program
  .name('solbot')
  .description(
    'Bot de trading spot autonome sur Solana via Jupiter (Swap API V2) — mode paper par défaut',
  )
  .version(getPackageVersion(), '-v, --version', 'affiche la version');

// `backtest` et sa sous-commande `import` partagent des options homonymes
// (--days/--timeframe/--mints) : sans options positionnelles, Commander
// attribue au parent les options écrites après le nom de la sous-commande.
// Requis sur la racine ET sur `backtest` (cf. tests/cli-backtest-options.test.ts).
program.enablePositionalOptions();

// Commandes implémentées (Phases 0–4)
program.addCommand(initCommand());
program.addCommand(doctorCommand());
program.addCommand(balanceCommand());
program.addCommand(scanCommand());
program.addCommand(priceCommand());
program.addCommand(watchCommand());
program.addCommand(swapCommand());
program.addCommand(startCommand());
program.addCommand(versionCommand());

// Phase 4 : backtest offline (garde-fou live) + rapport de métriques
program.addCommand(backtestCommand());
program.addCommand(reportCommand());

program.showHelpAfterError('(lancez `solbot --help` pour la liste des commandes)');

await program.parseAsync(process.argv);
