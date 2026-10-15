import { Command } from 'commander';
import { getPackageVersion } from '../utils/package.js';

export function versionCommand(): Command {
  return new Command('version')
    .description("Affiche la version de solbot et l'environnement d'exécution")
    .action(() => {
      console.log(
        `  solbot v${getPackageVersion()} — Node ${process.version} (${process.platform} ${process.arch})`,
      );
    });
}
