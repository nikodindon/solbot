import { sendTelegramMessage, type TelegramSendResult } from './telegram.js';

/** Types de notification, alignés sur `notifications.telegram.notify_on`. */
export type NotifyKind = 'trade' | 'error' | 'daily_report' | 'alert' | 'backup';

export interface NotifierOptions {
  enabled: boolean;
  token: string | undefined;
  chatId: string | undefined;
  notifyOn: readonly NotifyKind[];
  /** Injectable pour les tests (défaut : API Bot Telegram). */
  send?: (input: { token: string; chatId: string; text: string }) => Promise<TelegramSendResult>;
  /** Observabilité : appelé après chaque tentative (métriques). */
  onResult?: (kind: NotifyKind, result: TelegramSendResult) => void;
  /** Journalisation des échecs (défaut : silencieux). */
  onLog?: (line: string) => void;
}

/**
 * Émetteur de notifications Telegram commun au moteur et au rapport :
 * respecte `enabled`, la présence du token/chat id et `notify_on`.
 * Les échecs d'envoi ne font jamais échouer le moteur (best effort).
 */
export class Notifier {
  constructor(private readonly options: NotifierOptions) {}

  /** Token + chat id présents (indépendamment de `enabled`). */
  get configured(): boolean {
    const { token, chatId } = this.options;
    return token !== undefined && token !== '' && chatId !== undefined && chatId !== '';
  }

  /** Émission possible : activé, configuré, et type autorisé. */
  get active(): boolean {
    return this.options.enabled && this.configured;
  }

  allows(kind: NotifyKind): boolean {
    return this.options.notifyOn.includes(kind);
  }

  /** Envoie (best effort). Retourne `null` si le type est filtré/désactivé. */
  async notify(kind: NotifyKind, text: string): Promise<TelegramSendResult | null> {
    if (!this.active || !this.allows(kind)) return null;
    const { token, chatId } = this.options;
    if (token === undefined || chatId === undefined) return null;
    const send = this.options.send ?? ((input) => sendTelegramMessage(input));
    const result = await send({ token, chatId, text });
    this.options.onResult?.(kind, result);
    if (!result.ok) {
      this.options.onLog?.(
        `notification ${kind} en échec : ${result.description ?? 'cause inconnue'}`,
      );
    }
    return result;
  }
}

/** Message de trade : les lignes du moteur (achat/vente) sont réutilisées telles quelles. */
export function formatTradeMessage(
  mode: string,
  entries: string[],
  exits: string[],
): string | null {
  if (entries.length === 0 && exits.length === 0) return null;
  const lines = [`solbot · ${mode} · trade`];
  for (const entry of entries) lines.push(`🟢 ${entry}`);
  for (const exit of exits) lines.push(`🔴 ${exit}`);
  return lines.join('\n');
}

export function formatTickErrorMessage(
  mode: string,
  consecutive: number,
  max: number,
  message: string,
): string {
  return `🚨 solbot · ${mode} · erreur de tick (${consecutive}/${max})\n${message}`;
}

export interface DailyReportInput {
  mode: string;
  /** Jour UTC `YYYY-MM-DD` du rapport. */
  dayKey: string;
  navUsd: number | null;
  /** PnL réalisé sur les dernières 24 h (USD). */
  netPnlUsd: number;
  closedTrades: number;
  feesUsd: number;
  openCount: number;
  paused: boolean;
  killSwitch: boolean;
}

export function formatDailyReportMessage(input: DailyReportInput): string {
  const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)} $`;
  const lines = [
    `📊 solbot · ${input.mode} · rapport quotidien (${input.dayKey})`,
    `PnL réalisé 24 h : ${signed(input.netPnlUsd)} (${input.closedTrades} clôture(s)) · frais ${input.feesUsd.toFixed(2)} $`,
    `NAV : ${input.navUsd === null ? 'n/d' : `${input.navUsd.toFixed(2)} $`} · positions ouvertes : ${input.openCount}`,
  ];
  const flags: string[] = [];
  if (input.paused) flags.push('⏸ entrées en pause');
  if (input.killSwitch) flags.push('⛔ kill-switch actif');
  if (flags.length > 0) lines.push(flags.join(' · '));
  return lines.join('\n');
}

export function formatAlertMessage(ruleLabel: string, message: string): string {
  return `⚠️ solbot · alerte ${ruleLabel}\n${message}`;
}

export function formatBackupMessage(path: string, bytes: number): string {
  return `💾 backup SQLite : ${path} (${formatBytes(bytes)})`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}
