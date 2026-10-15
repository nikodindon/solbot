import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { parseEnvContent, upsertEnvVar } from '../utils/env-file.js';
import { SolbotError } from '../utils/errors.js';
import {
  ensureDir,
  getConfigExamplePath,
  getConfigPath,
  getEnvPath,
  getProjectRoot,
} from '../utils/paths.js';
import { createWallet } from '../wallet/create.js';
import { fail, printHeader, ICONS } from './ui.js';

const ENV_HEADER = `# solbot — généré par \`npm run solbot -- init\`
# ⚠ CE FICHIER CONTIENT VOTRE CLÉ PRIVÉE : ne le commitez jamais, ne le partagez jamais.`;

const ENV_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ['JUPITER_API_KEY', ''],
  ['JUPITER_RPS', ''],
  ['SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'],
  ['SOLANA_RPC_URL_FALLBACK', ''],
  ['TELEGRAM_BOT_TOKEN', ''],
  ['TELEGRAM_CHAT_ID', ''],
  ['LOG_LEVEL', 'info'],
];

export interface InitResult {
  address: string;
  envPath: string;
  configPath: string;
  configCreated: boolean;
  replacedWallet: boolean;
}

/**
 * Crée (ou remplace) le wallet de trading et initialise `.env` + `config.yaml`.
 * - Ne touche jamais aux autres variables du `.env` existant.
 * - Refuse d'écraser un wallet existant sans `force`.
 */
export function runInit(options: { force?: boolean; root?: string } = {}): InitResult {
  const root = options.root ?? getProjectRoot();
  const envPath = getEnvPath(root);
  const configPath = getConfigPath(root);

  let content = '';
  if (fs.existsSync(envPath)) content = fs.readFileSync(envPath, 'utf8');

  const previousKey = parseEnvContent(content).get('BS58_PRIVATE_KEY')?.trim() ?? '';
  if (previousKey !== '' && !options.force) {
    throw new SolbotError('Un wallet est déjà configuré dans .env', {
      hint: "Pour le remplacer (⚠ l'ancien wallet et ses fonds seront abandonnés) : npm run solbot -- init --force",
    });
  }

  const wallet = createWallet();

  if (content.trim() === '') content = `${ENV_HEADER}\n\n`;
  content = upsertEnvVar(content, 'BS58_PRIVATE_KEY', wallet.secretKeyBase58);

  const presentKeys = parseEnvContent(content);
  for (const [key, value] of ENV_DEFAULTS) {
    if (!presentKeys.has(key)) content = upsertEnvVar(content, key, value);
  }
  if (!content.endsWith('\n')) content += '\n';

  fs.writeFileSync(envPath, content, { mode: 0o600 });
  fs.chmodSync(envPath, 0o600); // garantit 600 même si le fichier préexistait

  let configCreated = false;
  if (!fs.existsSync(configPath)) {
    const examplePath = getConfigExamplePath(root);
    if (fs.existsSync(examplePath)) {
      ensureDir(path.dirname(configPath));
      fs.copyFileSync(examplePath, configPath);
      configCreated = true;
    }
  }

  return {
    address: wallet.address,
    envPath,
    configPath,
    configCreated,
    replacedWallet: previousKey !== '',
  };
}

export function initCommand(): Command {
  return new Command('init')
    .description('Crée un wallet de trading (premier lancement) et initialise .env + config.yaml')
    .option('--force', 'remplace le wallet existant dans .env (⚠ irréversible)')
    .action((options: { force?: boolean }) => {
      try {
        const result = runInit({ force: Boolean(options.force) });
        printHeader('solbot init — création du wallet de trading');
        if (result.replacedWallet) {
          console.log(`  ${ICONS.warn} L'ancien wallet a été remplacé (--force).`);
        }
        console.log(`  ${ICONS.ok} Wallet généré : ${result.address}`);
        console.log(`  ${ICONS.ok} .env mis à jour (${result.envPath}) — permissions 600`);
        if (result.configCreated) {
          console.log(`  ${ICONS.ok} ${result.configPath} créé depuis l'exemple`);
        }
        console.log('');
        console.log('  ⚠ Cette clé contrôle des fonds réels :');
        console.log('    • sauvegardez-la dans votre gestionnaire de mots de passe ;');
        console.log('    • ne la partagez JAMAIS, ne la committez JAMAIS.');
        console.log('');
        console.log('  Étapes suivantes :');
        console.log(`   1. Envoyez du SOL (≥ 0.05) sur ${result.address} → frais réseau`);
        console.log('   2. Envoyez des USDC → capital de trading');
        console.log(
          '   3. Renseignez JUPITER_API_KEY dans .env (https://developers.jup.ag/portal)',
        );
        console.log('   4. Vérifiez : npm run solbot -- doctor');
      } catch (error) {
        fail(error);
      }
    });
}
