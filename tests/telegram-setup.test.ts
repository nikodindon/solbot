import { describe, expect, it } from 'vitest';
import { findTelegramChats, getTelegramBotInfo } from '../src/notifications/telegram-setup.js';

function fakeFetch(payload: unknown, status = 200): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe('Telegram — validation du token (getMe)', () => {
  it('retourne les informations du bot', async () => {
    const { fetchImpl, urls } = fakeFetch({
      ok: true,
      result: { id: 123, username: 'solbot_bot', first_name: 'solbot' },
    });
    const info = await getTelegramBotInfo({ token: 'TOKEN', fetchImpl });
    expect(info).toEqual({ id: 123, username: 'solbot_bot', firstName: 'solbot' });
    expect(urls[0]).toContain('/botTOKEN/getMe');
  });

  it('échoue proprement avec un token invalide', async () => {
    const { fetchImpl } = fakeFetch({ ok: false, description: 'Unauthorized' }, 401);
    await expect(getTelegramBotInfo({ token: 'BAD', fetchImpl })).rejects.toThrow(/Unauthorized/);
  });

  it('gère un username absent', async () => {
    const { fetchImpl } = fakeFetch({ ok: true, result: { id: 7, first_name: 'x' } });
    const info = await getTelegramBotInfo({ token: 'T', fetchImpl });
    expect(info.username).toBeNull();
  });
});

describe('Telegram — découverte du chat_id (getUpdates)', () => {
  it('déduplique les conversations et prend le libellé du message', async () => {
    const { fetchImpl, urls } = fakeFetch({
      ok: true,
      result: [
        { message: { chat: { id: 42, type: 'private', first_name: 'Niko' } } },
        { message: { chat: { id: 42, type: 'private', first_name: 'Niko' } } },
        { message: { chat: { id: -100, type: 'group', title: 'Trading' } } },
      ],
    });
    const chats = await findTelegramChats({ token: 'TOKEN', fetchImpl });
    expect(chats).toEqual([
      { id: '42', type: 'private', label: 'Niko' },
      { id: '-100', type: 'group', label: 'Trading' },
    ]);
    expect(urls[0]).toContain('/botTOKEN/getUpdates');
  });

  it('retrouve une conversation depuis channel_post', async () => {
    const { fetchImpl } = fakeFetch({
      ok: true,
      result: [{ channel_post: { chat: { id: -5, type: 'channel', title: 'Canal' } } }],
    });
    const chats = await findTelegramChats({ token: 'T', fetchImpl });
    expect(chats).toEqual([{ id: '-5', type: 'channel', label: 'Canal' }]);
  });

  it('retourne [] quand le bot n’a reçu aucun message', async () => {
    const { fetchImpl } = fakeFetch({ ok: true, result: [] });
    expect(await findTelegramChats({ token: 'T', fetchImpl })).toEqual([]);
  });
});
