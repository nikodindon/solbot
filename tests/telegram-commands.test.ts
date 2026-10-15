import { describe, expect, it } from 'vitest';
import {
  parseCommand,
  TelegramCommandPoller,
  type TelegramCommandController,
} from '../src/notifications/telegram-commands.js';

const CHAT = '424242';

function makeController(): TelegramCommandController & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    status: () => {
      calls.push('status');
      return 'statut ok';
    },
    positions: () => {
      calls.push('positions');
      return 'aucune position';
    },
    pnl: (args) => {
      calls.push(`pnl:${args.join(',')}`);
      return 'pnl ok';
    },
    pause: () => {
      calls.push('pause');
      return 'en pause';
    },
    resume: () => {
      calls.push('resume');
      return 'repris';
    },
    kill: () => {
      calls.push('kill');
      return 'kill-switch';
    },
    help: () => 'aide',
  };
}

interface FetchCall {
  url: string;
  body: { offset: number; timeout: number };
}

function fakeFetch(updates: Array<Record<string, unknown>>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let queue = updates;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as FetchCall['body'],
    });
    // Les mises à jour ne sont servies qu'une fois (comme l'API réelle avec offset).
    const result = queue;
    queue = [];
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function poller(
  controller: TelegramCommandController,
  updates: Array<Record<string, unknown>>,
  overrides: { chatId?: string } = {},
): { poller: TelegramCommandPoller; replies: string[]; calls: FetchCall[]; logs: string[] } {
  const replies: string[] = [];
  const logs: string[] = [];
  const { fetchImpl, calls } = fakeFetch(updates);
  return {
    poller: new TelegramCommandPoller({
      token: 'TOKEN',
      chatId: overrides.chatId ?? CHAT,
      controller,
      fetchImpl,
      send: async (input) => {
        replies.push(input.text);
        return { ok: true, description: null };
      },
      onLog: (line) => logs.push(line),
    }),
    replies,
    calls,
    logs,
  };
}

function message(updateId: number, text: string, chatId = CHAT): Record<string, unknown> {
  return { update_id: updateId, message: { chat: { id: chatId }, text } };
}

describe('parseCommand', () => {
  it('extrait la commande, ses arguments et le suffixe @bot', () => {
    expect(parseCommand('/status')).toEqual({ command: 'status', args: [] });
    expect(parseCommand('  /pnl 7  ')).toEqual({ command: 'pnl', args: ['7'] });
    expect(parseCommand('/status@solbot_bot')).toEqual({ command: 'status', args: [] });
    expect(parseCommand('bonjour')).toBeNull();
    expect(parseCommand('/')).toBeNull();
  });
});

describe('TelegramCommandPoller', () => {
  it('répond aux commandes du chat autorisé et avance l’offset', async () => {
    const controller = makeController();
    const {
      poller: p,
      replies,
      calls,
    } = poller(controller, [
      message(7, '/status'),
      message(8, '/pnl 7'),
      message(9, 'salut (pas une commande)'),
    ]);

    const handled = await p.pollOnce();

    expect(handled).toBe(2);
    expect(controller.calls).toEqual(['status', 'pnl:7']);
    expect(replies).toEqual(['statut ok', 'pnl ok']);
    expect(calls[0]?.url).toContain('/botTOKEN/getUpdates');
    expect(calls[0]?.body.offset).toBe(0);

    // L'offset avance même pour les mises à jour ignorées : pas de rejeu.
    await p.pollOnce();
    expect(calls[1]?.body.offset).toBe(10);
    expect(replies).toHaveLength(2);
  });

  it('ignore les commandes d’un chat non autorisé (sans réponse)', async () => {
    const controller = makeController();
    const {
      poller: p,
      replies,
      logs,
    } = poller(controller, [message(1, '/kill', '999999'), message(2, '/status')]);

    const handled = await p.pollOnce();

    expect(handled).toBe(1);
    expect(controller.calls).toEqual(['status']);
    expect(replies).toEqual(['statut ok']);
    expect(logs.join(' ')).toContain('chat non autorisé');
  });

  it('répond l’aide sur commande inconnue', async () => {
    const controller = makeController();
    const { poller: p, replies } = poller(controller, [message(1, '/danse')]);
    await p.pollOnce();
    expect(replies[0]).toContain('commande inconnue « /danse »');
    expect(replies[0]).toContain('aide');
  });

  it('route /positions, /pause, /resume, /kill et /help', async () => {
    const controller = makeController();
    const { poller: p, replies } = poller(controller, [
      message(1, '/positions'),
      message(2, '/pause'),
      message(3, '/resume'),
      message(4, '/kill'),
      message(5, '/help'),
    ]);
    await p.pollOnce();
    expect(controller.calls).toEqual(['positions', 'pause', 'resume', 'kill']);
    expect(replies).toHaveLength(5);
  });

  it('lève une erreur explicite sur réponse getUpdates invalide', async () => {
    const controller = makeController();
    const { poller: p } = poller(controller, []);
    const broken = new TelegramCommandPoller({
      token: 'TOKEN',
      chatId: CHAT,
      controller,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: false, description: 'unauthorized' }), {
          status: 401,
        })) as unknown as typeof fetch,
    });
    await expect(broken.pollOnce()).rejects.toThrow(/getUpdates invalide/);
    void p;
  });
});
