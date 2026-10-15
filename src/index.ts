#!/usr/bin/env node
// ⚠ Doit rester le premier import : masque l'avertissement `node:sqlite` avant
// que les modules suivants ne le chargent (cf. src/utils/warnings.ts).
import './utils/warnings.js';
import { Command } from 'commander';
import { balanceCommand } from './cli/balance.js';
import { doctorCommand } from './cli/doctor.js';
import { initCommand } from './cli/init.js';
import { priceCommand } from './cli/price.js';
import { scanCommand } from './cli/scan.js';
import { stubCommand } from './cli/stub.js';
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

// Commandes implémentées (Phases 0–2)
program.addCommand(initCommand());
program.addCommand(doctorCommand());
program.addCommand(balanceCommand());
program.addCommand(scanCommand());
program.addCommand(priceCommand());
program.addCommand(watchCommand());
program.addCommand(swapCommand());
program.addCommand(versionCommand());

// Commandes prévues par la roadmap (stubs explicites, voir README → section 13)
program.addCommand(stubCommand('start', 'Phase 3 — Moteur autonome'));
program.addCommand(stubCommand('backtest', 'Phase 4 — Backtesting'));

program.showHelpAfterError('(lancez `solbot --help` pour la liste des commandes)');

await program.parseAsync(process.argv);
