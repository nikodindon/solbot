import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { backtestCommand } from '../src/cli/backtest.js';

interface Built {
  program: Command;
  backtest: Command;
  backtestOpts: () => Record<string, unknown> | null;
  importOpts: () => Record<string, unknown> | null;
}

/**
 * Arbre de commandes réel (racine + `backtest` + `import`), avec les actions
 * remplacées par des captures : les options de `import` portent les mêmes noms
 * que celles de `backtest` (--days/--timeframe/--mints), ce qui exige les
 * options positionnelles (cf. src/index.ts) pour router correctement.
 */
function build(): Built {
  const program = new Command('solbot');
  program.exitOverride();
  program.enablePositionalOptions();
  const backtest = backtestCommand();
  let backtestOpts: Record<string, unknown> | null = null;
  let importOpts: Record<string, unknown> | null = null;
  backtest.action((options: Record<string, unknown>) => {
    backtestOpts = options;
  });
  const importCommand = backtest.commands.find((child) => child.name() === 'import');
  if (importCommand === undefined) throw new Error('sous-commande import absente de backtest');
  importCommand.action((options: Record<string, unknown>) => {
    importOpts = options;
  });
  program.addCommand(backtest);
  return {
    program,
    backtest,
    backtestOpts: () => backtestOpts,
    importOpts: () => importOpts,
  };
}

describe('routage des options backtest/import', () => {
  it('attribue à `import` les options écrites après son nom (homonymes du parent)', async () => {
    const env = build();
    await env.program.parseAsync([
      'node',
      'solbot',
      'backtest',
      'import',
      '--days',
      '7',
      '--pause',
      '300',
      '--mints',
      'AAA,BBB',
    ]);
    expect(env.importOpts()).toEqual({ days: '7', pause: '300', mints: 'AAA,BBB' });
    // `--no-store` du parent : valeur par défaut `store: true` uniquement.
    expect(env.backtest.opts()).toEqual({ store: true });
  });

  it('conserve les options de `backtest` exécuté directement', async () => {
    const env = build();
    await env.program.parseAsync(['node', 'solbot', 'backtest', '--days', '3', '--label', 'mom']);
    expect(env.backtestOpts()).toEqual({ days: '3', label: 'mom', store: true });
    expect(env.importOpts()).toBeNull();
  });

  it('laisse au parent les options écrites avant le nom de la sous-commande', async () => {
    const env = build();
    await env.program.parseAsync(['node', 'solbot', 'backtest', '--label', 'mom', 'import']);
    expect(env.importOpts()).toEqual({});
    expect(env.backtest.opts()).toEqual({ label: 'mom', store: true });
  });
});
