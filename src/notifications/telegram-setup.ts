/**
 * Assistant de configuration Telegram (`solbot telegram-setup`) : validation du
 * token via `getMe` et découverte automatique du `chat_id` via `getUpdates`.
 * Aucune écriture : la mise à jour de `.env` reste à la charge du CLI.
 */

import { SolbotError } from '../utils/errors.js';

export interface TelegramBotInfo {
  id: number;
  username: string | null;
  firstName: string;
}

export interface TelegramChat {
  id: string;
  type: string;
  label: string;
}

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  result?: unknown;
}

interface TelegramChatPayload {
  id: number;
  type?: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramUpdate {
  message?: { chat?: TelegramChatPayload };
  edited_message?: { chat?: TelegramChatPayload };
  channel_post?: { chat?: TelegramChatPayload };
  my_chat_member?: { chat?: TelegramChatPayload };
}

export interface TelegramApiInput {
  token: string;
  fetchImpl?: typeof fetch;
}

async function callApi<T>(method: string, input: TelegramApiInput): Promise<T> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${input.token}/${method}`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new SolbotError(
      `Telegram injoignable (${method}) : ${error instanceof Error ? error.message : String(error)}`,
      { hint: 'Vérifiez votre connexion réseau, puis relancez la commande.' },
    );
  }

  const payload = (await response.json().catch(() => null)) as TelegramApiResponse | null;
  if (!response.ok || payload?.ok !== true) {
    throw new SolbotError(
      `Telegram a refusé ${method} : ${payload?.description ?? `HTTP ${response.status}`}`,
      {
        hint:
          method === 'getMe'
            ? 'Token invalide — recopiez celui fourni par @BotFather.'
            : 'Réessayez dans quelques secondes.',
      },
    );
  }
  return payload.result as T;
}

/** Informations du bot (`getMe`) — sert surtout à valider le token et afficher @pseudo. */
export async function getTelegramBotInfo(input: TelegramApiInput): Promise<TelegramBotInfo> {
  const result = await callApi<{ id: number; username?: string; first_name?: string }>(
    'getMe',
    input,
  );
  return { id: result.id, username: result.username ?? null, firstName: result.first_name ?? '' };
}

/** Conversations vues par le bot (`getUpdates`), dédupliquées, la plus récente en dernier. */
export async function findTelegramChats(input: TelegramApiInput): Promise<TelegramChat[]> {
  const updates = await callApi<TelegramUpdate[]>('getUpdates', input);
  const chats = new Map<string, TelegramChat>();
  for (const update of updates ?? []) {
    const chat =
      update.message?.chat ??
      update.edited_message?.chat ??
      update.channel_post?.chat ??
      update.my_chat_member?.chat;
    if (chat === undefined || chat.id === undefined) continue;
    const id = String(chat.id);
    if (chats.has(id)) continue;
    const label =
      chat.title ??
      [chat.first_name, chat.last_name].filter(Boolean).join(' ') ??
      chat.username ??
      id;
    chats.set(id, { id, type: chat.type ?? '?', label: label === '' ? id : label });
  }
  return [...chats.values()];
}
