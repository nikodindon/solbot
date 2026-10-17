import fs from 'node:fs';
import { Command } from 'commander';
import { sendTelegramMessage } from '../notifications/telegram.js';
import { findTelegramChats, getTelegramBotInfo } from '../notifications/telegram-setup.js';
import { parseEnv } from '../utils/config.js';
import { loadEnvFile, upsertEnvVar } from '../utils/env-file.js';
import { SolbotError } from '../utils/errors.js';
import { getEnvPath, getProjectRoot } from '../utils/paths.js';
import { fail, ICONS, printHeader } from './ui.js';

export interface TelegramSetupCliOptions {
  /** Token du bot (sinon `TELEGRAM_BOT_TOKEN` du `.env`). */
  token?: string;
  /** `chat_id` explicite (sinon détection automatique via `getUpdates`). */
  chatId?: string;
  /** Envoie un message de test à la fin (défaut : true). */
  test?: boolean;
  root?: string;
}

/**
 * `solbot telegram-setup` : valide le token du bot, découvre le `chat_id`,
 * écrit les deux variables dans `.env` et envoie un message de test.
 *
 * Prérequis côté Telegram : créer un bot avec @BotFather puis lui envoyer
 * `/start` depuis la conversation cible (sinon `getUpdates` est vide).
 */
export async function runTelegramSetupCli(options: TelegramSetupCliOptions = {}): Promise<void> {
  const root = options.root ?? getProjectRoot();
  loadEnvFile(root);
  const env = parseEnv();

  printHeader('solbot telegram-setup — notifications & commandes');

  const token = (options.token ?? env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (token === '') {
    throw new SolbotError('Token de bot Telegram manquant', {
      hint: 'Telegram → @BotFather → /newbot → copiez le token, puis : npm run solbot -- telegram-setup --token <token>',
    });
  }

  const info = await getTelegramBotInfo({ token });
  const handle = info.username === null ? '?' : `@${info.username}`;
  console.log(`  ${ICONS.ok} bot reconnu : ${handle} (${info.firstName || 'sans nom'})`);

  let chatId = (options.chatId ?? '').trim();
  if (chatId === '') {
    const chats = await findTelegramChats({ token });
    if (chats.length === 0) {
      throw new SolbotError('Aucune conversation trouvée', {
        hint: `Ouvrez Telegram, cherchez ${handle}, envoyez-lui /start, puis relancez cette commande.`,
      });
    }
    const chosen = chats[chats.length - 1]!;
    chatId = chosen.id;
    console.log(`  ${ICONS.ok} destinataire : ${chosen.label} (id ${chatId}, ${chosen.type})`);
    if (chats.length > 1) {
      console.log(
        `    ${ICONS.warn} ${chats.length} conversations vues — utilisez --chat-id <id> pour en choisir une autre :`,
      );
      for (const chat of chats) console.log(`      · ${chat.label} — ${chat.id} (${chat.type})`);
    }
  } else {
    console.log(`  destinataire : id ${chatId} (fourni)`);
  }

  const envPath = getEnvPath(root);
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  let updated = upsertEnvVar(content, 'TELEGRAM_BOT_TOKEN', token);
  updated = upsertEnvVar(updated, 'TELEGRAM_CHAT_ID', chatId);
  fs.writeFileSync(envPath, updated, { mode: 0o600 });
  console.log(`  ${ICONS.ok} .env mis à jour : ${envPath}`);

  if (options.test !== false) {
    const result = await sendTelegramMessage({
      token,
      chatId,
      text: [
        '🤖 solbot — configuration Telegram réussie.',
        'Vous recevrez ici les alertes de trade, les erreurs et le rapport PnL quotidien.',
        'Commandes : /status, /pause, /resume, /kill.',
      ].join('\n'),
    });
    if (result.ok) {
      console.log(`  ${ICONS.ok} message de test envoyé`);
    } else {
      console.log(
        `  ${ICONS.warn} message de test non envoyé : ${result.description ?? 'inconnu'}`,
      );
    }
  }

  console.log('\n  Étape suivante — activez les notifications dans config/config.yaml :');
  console.log('    notifications:');
  console.log('      telegram:');
  console.log('        enabled: true');
  console.log('  puis relancez le bot (npm run solbot -- start --paper …).');
}

export function telegramSetupCommand(): Command {
  return new Command('telegram-setup')
    .description('configure Telegram (token + chat_id) dans .env et envoie un test')
    .option('--token <token>', 'token du bot (@BotFather) — sinon TELEGRAM_BOT_TOKEN du .env')
    .option('--chat-id <id>', 'chat_id cible — sinon détection automatique via getUpdates')
    .option('--no-test', 'ne pas envoyer de message de test')
    .action(async (options: TelegramSetupCliOptions) => {
      try {
        await runTelegramSetupCli({
          ...(options.token === undefined ? {} : { token: options.token }),
          ...(options.chatId === undefined ? {} : { chatId: options.chatId }),
          ...(options.test === undefined ? {} : { test: options.test }),
        });
      } catch (error) {
        fail(error);
      }
    });
}
