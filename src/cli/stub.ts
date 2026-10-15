import { Command } from 'commander';

/** Commande documentée mais non encore implémentée (pointe vers la roadmap). */
export function stubCommand(name: string, phase: string): Command {
  return new Command(name)
    .description(`(à venir — ${phase})`)
    .allowUnknownOption(true)
    .action(() => {
      console.log(
        `\n  ℹ La commande « ${name} » n'est pas encore implémentée (prévue en ${phase}).`,
      );
      console.log('    Roadmap détaillée : voir README.md → section 13.');
      process.exitCode = 2;
    });
}
