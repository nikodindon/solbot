/**
 * Notification Telegram minimale (Phase 4) : envoi de texte via l'API Bot.
 * Les commandes interactives et l'alerting complet arrivent en Phase 5.
 */

export interface TelegramSendInput {
  token: string;
  chatId: string;
  text: string;
  fetchImpl?: typeof fetch;
}

export interface TelegramSendResult {
  ok: boolean;
  description: string | null;
}

export async function sendTelegramMessage(input: TelegramSendInput): Promise<TelegramSendResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${input.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: input.text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;
    if (!response.ok || payload?.ok !== true) {
      return {
        ok: false,
        description: payload?.description ?? `HTTP ${response.status}`,
      };
    }
    return { ok: true, description: null };
  } catch (error) {
    return {
      ok: false,
      description: error instanceof Error ? error.message : String(error),
    };
  }
}
