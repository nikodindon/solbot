import { SolbotError } from '../utils/errors.js';

export interface JupiterApiErrorOptions {
  status?: number;
  endpoint?: string;
  hint?: string;
  cause?: unknown;
}

/** Erreur non retryable renvoyée par le client Jupiter (HTTP 4xx, schéma invalide, etc.). */
export class JupiterApiError extends SolbotError {
  readonly status?: number;
  readonly endpoint?: string;

  constructor(message: string, options: JupiterApiErrorOptions = {}) {
    super(message, options);
    if (options.status !== undefined) this.status = options.status;
    if (options.endpoint !== undefined) this.endpoint = options.endpoint;
  }
}
