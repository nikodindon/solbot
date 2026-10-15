import { pino, type Level, type Logger } from 'pino';

/**
 * Chemins systématiquement masqués dans les logs (défense en profondeur :
 * même en cas d'erreur de développement, aucun secret ne doit fuir).
 */
const REDACT_PATHS = [
  'BS58_PRIVATE_KEY',
  'JUPITER_API_KEY',
  'privateKey',
  'secretKey',
  'secretKeyBase58',
  'signedTransaction',
  '*.BS58_PRIVATE_KEY',
  '*.JUPITER_API_KEY',
  '*.privateKey',
  '*.secretKey',
  '*.secretKeyBase58',
  '*.signedTransaction',
];

export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level: level as Level,
    base: undefined,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  });
}

let instance: Logger | undefined;

export function initLogger(level?: string): Logger {
  instance = createLogger(level);
  return instance;
}

export function getLogger(): Logger {
  if (!instance) instance = createLogger();
  return instance;
}
