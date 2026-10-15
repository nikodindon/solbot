import { z } from 'zod';
import { messageOf } from '../utils/errors.js';
import { sleep } from '../utils/retry.js';
import { sendTelegramMessage, type TelegramSendResult } from './telegram.js';

/** Contrôleur exécutant les commandes reçues (implémenté par le superviseur). */
export interface TelegramCommandController {
  status(): Promise<string> | string;
  positions(): Promise<string> | string;
  pnl(args: string[]): Promise<string> | string;
  pause(): Promise<string> | string;
  resume(): Promise<string> | string;
  kill(): Promise<string> | string;
  help(): string;
}

export interface ParsedCommand {
  command: string;
  args: string[];
}

/** `/status`, `/pnl@mon_bot 7`, … → `{ command: 'pnl', args: ['7'] }`. */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [raw = '', ...args] = trimmed.split(/\s+/);
  const command = raw.slice(1).split('@')[0]?.toLowerCase() ?? '';
  if (command === '') return null;
  return { command, args };
}

const TelegramUpdateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      chat: z.object({ id: z.union([z.number(), z.string()]) }),
      text: z.string().optional(),
    })
    .optional(),
});

const UpdatesResponseSchema = z.object({
  ok: z.boolean(),
  result: z.array(TelegramUpdateSchema).default([]),
});

export interface TelegramCommandPollerOptions {
  token: string;
  /** Seul ce chat est autorisé à commander (les autres sont ignorés). */
  chatId: string;
  controller: TelegramCommandController;
  fetchImpl?: typeof fetch;
  /** Long polling : attente côté Telegram (s). */
  pollTimeoutS?: number;
  /** Injectable pour les tests (défaut : API Bot). */
  send?: (input: { token: string; chatId: string; text: string }) => Promise<TelegramSendResult>;
  onError?: (message: string) => void;
  onLog?: (line: string) => void;
}

/**
 * Écoute les commandes Telegram en long polling (`getUpdates`) et répond via
 * le contrôleur. Un seul chat autorisé ; les messages non-commandes sont
 * ignorés ; l'`offset` avance même pour les chats non autorisés (pas de boucle).
 */
export class TelegramCommandPoller {
  private offset = 0;
  private running = false;
  private abort: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly options: TelegramCommandPollerOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loopPromise?.catch(() => undefined);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.running) break;
        this.options.onError?.(messageOf(error));
        await sleep(3000);
      }
    }
  }

  /** Une passe : récupère les updates, répond aux commandes autorisées. */
  async pollOnce(): Promise<number> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    this.abort = new AbortController();
    const response = await fetchImpl(
      `https://api.telegram.org/bot${this.options.token}/getUpdates`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          offset: this.offset,
          timeout: this.options.pollTimeoutS ?? 25,
          allowed_updates: ['message'],
        }),
        signal: this.abort.signal,
      },
    );
    const payload = (await response.json().catch(() => null)) as { ok?: boolean } | null;
    const parsed = UpdatesResponseSchema.safeParse(payload);
    if (payload === null || payload.ok !== true || !parsed.success) {
      throw new Error(`réponse getUpdates invalide (HTTP ${response.status})`);
    }

    let handled = 0;
    for (const update of parsed.data.result) {
      this.offset = Math.max(this.offset, update.update_id + 1);
      const message = update.message;
      if (message === undefined || message.text === undefined) continue;
      const chatId = String(message.chat.id);
      if (chatId !== this.options.chatId) {
        this.options.onLog?.(`commande ignorée (chat non autorisé : ${chatId})`);
        continue;
      }
      const reply = await this.dispatch(message.text);
      if (reply === null) continue; // message non-commande
      handled += 1;
      const send = this.options.send ?? ((input) => sendTelegramMessage(input));
      const result = await send({
        token: this.options.token,
        chatId: this.options.chatId,
        text: reply,
      });
      if (!result.ok) {
        this.options.onLog?.(`réponse Telegram en échec : ${result.description ?? 'inconnu'}`);
      }
    }
    return handled;
  }

  private async dispatch(text: string): Promise<string | null> {
    const parsed = parseCommand(text);
    if (parsed === null) return null;
    const { controller } = this.options;
    switch (parsed.command) {
      case 'help':
        return controller.help();
      case 'status':
        return controller.status();
      case 'positions':
      case 'pos':
        return controller.positions();
      case 'pnl':
        return controller.pnl(parsed.args);
      case 'pause':
        return controller.pause();
      case 'resume':
        return controller.resume();
      case 'kill':
        return controller.kill();
      default:
        return `commande inconnue « /${parsed.command} »\n\n${controller.help()}`;
    }
  }
}
