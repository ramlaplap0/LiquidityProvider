import { Mutex } from 'async-mutex';

// ── Global mutex store per resource key ──────────────────────────
const mutexStore = new Map<string, Mutex>();

/**
 * Get or create a Mutex for a given resource key.
 * Keys should follow pattern: "PAIR_1", "PAIR_2", "FEE_HARVESTER", etc.
 */
export function getMutex(key: string): Mutex {
  if (!key || typeof key !== 'string') {
    throw new Error(`getMutex: invalid key "${String(key)}"`);
  }
  let mutex = mutexStore.get(key);
  if (!mutex) {
    mutex = new Mutex();
    mutexStore.set(key, mutex);
  }
  return mutex;
}

/**
 * Check if a mutex is currently locked.
 */
export function isMutexLocked(key: string): boolean {
  const mutex = mutexStore.get(key);
  return mutex ? mutex.isLocked() : false;
}

/**
 * Release all mutexes. Used during graceful shutdown.
 */
export async function releaseAllMutexes(): Promise<void> {
  for (const [key, mutex] of mutexStore.entries()) {
    if (mutex.isLocked()) {
      // Note: we can't force-release from outside,
      // but we track which ones are locked for logging.
      console.warn(`Mutex ${key} still locked during shutdown`);
    }
  }
}

/**
 * Execute a function with mutex lock, auto-release on error.
 */
export async function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const mutex = getMutex(key);
  const release = await mutex.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
