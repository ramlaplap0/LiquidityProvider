import { logWarn, logError, formatErrorContext } from './logger';

export interface RetryOptions {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly timeoutMs?: number;
  readonly fnName: string;
  readonly context?: Record<string, unknown>;
}

/**
 * Retry a function with exponential backoff.
 * Delays: baseDelay * 2^attempt (e.g., 1s, 2s, 4s)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, timeoutMs = 60000, fnName, context = {} } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        logWarn(`${fnName}: attempt ${attempt + 1} failed, retrying in ${delay}ms`, {
          ...context,
          error: lastError.message,
          nextAttempt: attempt + 2,
        });
        await sleep(delay);
      }
    }
  }

  logError(`${fnName}: all ${maxRetries} attempts failed`, formatErrorContext(fnName, context, lastError ?? new Error('unknown error')));
  throw lastError ?? new Error(`${fnName}: all retries exhausted`);
}

/** Simple sleep helper */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Timeout wrapper for promises */
export function withTimeout<T>(promise: Promise<T>, ms: number, context?: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${context ?? 'operation'} exceeded ${ms}ms`)), ms)
    ),
  ]);
}
