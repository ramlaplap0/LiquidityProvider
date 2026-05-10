import winston from 'winston';
import { CONFIG } from '@/config';

// ── Log levels ───────────────────────────────────────────────────
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  crit: 4,
} as const;

type LogLevel = keyof typeof LOG_LEVELS;

// ── Custom level for CRIT ────────────────────────────────────────
const customLevels: winston.config.AbstractConfigSetLevels = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  crit: 4,
};

const customColors: winston.config.AbstractConfigSetColors = {
  debug: 'blue',
  info: 'green',
  warn: 'yellow',
  error: 'red',
  crit: 'magenta',
};

winston.addColors(customColors);

// ── Winston logger instance ──────────────────────────────────────
export const logger = winston.createLogger({
  level: CONFIG.logLevel,
  levels: customLevels,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'meteora-lp-bot' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.printf(({ level, message, timestamp, ...rest }) => {
          const meta = Object.keys(rest).length ? JSON.stringify(rest, null, 0) : '';
          return `[${timestamp}] ${level}: ${message} ${meta}`;
        })
      ),
    }),
    new winston.transports.File({
      filename: 'logs/bot.log',
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/bot-error.log',
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
  exitOnError: false,
});

// ── Typed helpers (no silent failure ever) ───────────────────────
export function logInfo(message: string, meta?: Record<string, unknown>): void {
  logger.info(message, meta ?? {});
}

export function logWarn(message: string, meta?: Record<string, unknown>): void {
  logger.warn(message, meta ?? {});
}

export function logError(message: string, meta?: Record<string, unknown>): void {
  logger.error(message, meta ?? {});
}

export function logCrit(message: string, meta?: Record<string, unknown>): void {
  logger.crit(message, meta ?? {});
}

/** Log a function entry with its parameters */
export function logDebug(message: string, meta?: Record<string, unknown>): void {
  logger.debug(message, meta ?? {});
}

/** Format error for structured logging — never empty */
export function formatErrorContext(
  fn: string,
  params: Record<string, unknown>,
  error: unknown
): Record<string, unknown> {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    function: fn,
    params,
    errorMessage: err.message,
    stack: err.stack ?? 'no stack',
    errorType: err.constructor.name,
  };
}

export default logger;
