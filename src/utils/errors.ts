/**
 * Erreur applicative avec indice actionnable affiché à l'utilisateur
 * (ex. « lancez `npm run solbot -- init` »).
 */
export class SolbotError extends Error {
  readonly hint?: string;

  constructor(message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    if (options.hint !== undefined) this.hint = options.hint;
  }
}

export class ConfigError extends SolbotError {}
export class WalletError extends SolbotError {}
export class RpcError extends SolbotError {}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
