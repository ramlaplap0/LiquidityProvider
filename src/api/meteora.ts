import { CONFIG } from '@/config';
import type { PoolData } from '@/types';
import { MeteoraPoolsResponseSchema } from '@/utils/validator';
import { withRetry, withTimeout } from '@/utils/retry';
import { logError, logWarn, logDebug } from '@/utils/logger';

// In-memory cache
let poolCache: PoolData[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60000; // 60s

/**
 * Fetch all DLMM pools from Meteora API.
 * Returns raw pool data — filtering happens in PairScanner.
 */
export async function fetchAllPools(): Promise<PoolData[]> {
  try {
    // Check cache first
    const now = Date.now();
    if (poolCache && now - cacheTimestamp < CACHE_TTL_MS) {
      logDebug('fetchAllPools: returning cached data', { count: poolCache.length });
      return poolCache;
    }

    const result = await withRetry(
      async () => {
        const response = await withTimeout(
          fetch(`${CONFIG.meteoraApiUrl}/pair/all`),
          CONFIG.apiTimeoutMs,
          'Meteora fetchAllPools'
        );

        if (!response.ok) {
          throw new Error(`Meteora API error: ${response.status} ${response.statusText}`);
        }

        const json = await response.json();
        const validated = MeteoraPoolsResponseSchema.safeParse(json);

        if (!validated.success) {
          logWarn('fetchAllPools: response validation failed', {
            errors: validated.error.errors.map((e) => e.message),
          });
          // Return empty rather than crash
          return [] as PoolData[];
        }

        return validated.data.pools;
      },
      { maxRetries: 3, baseDelayMs: 1000, fnName: 'fetchAllPools' }
    );

    poolCache = result;
    cacheTimestamp = Date.now();
    logDebug('fetchAllPools: fetched', { count: result.length });
    return result;
  } catch (error) {
    logError('fetchAllPools: failed after retries', { error: String(error) });
    // Return cached data if available, empty otherwise
    return poolCache ?? [];
  }
}

/**
 * Fetch single pool details by address.
 */
export async function fetchPoolByAddress(poolAddress: string): Promise<PoolData | null> {
  try {
    if (!poolAddress || typeof poolAddress !== 'string') {
      logError('fetchPoolByAddress: invalid pool address', { poolAddress });
      return null;
    }

    const result = await withRetry(
      async () => {
        const response = await withTimeout(
          fetch(`${CONFIG.meteoraApiUrl}/pool/${poolAddress}`),
          CONFIG.apiTimeoutMs,
          'Meteora fetchPoolByAddress'
        );

        if (!response.ok) {
          throw new Error(`Meteora API error: ${response.status} ${response.statusText}`);
        }

        const json = await response.json();
        const validated = MeteoraPoolsResponseSchema.safeParse(json);

        if (!validated.success || !validated.data.pools[0]) {
          logWarn('fetchPoolByAddress: validation failed or pool not found', { poolAddress });
          return null;
        }

        return validated.data.pools[0];
      },
      { maxRetries: 3, baseDelayMs: 1000, fnName: 'fetchPoolByAddress', context: { poolAddress } }
    );

    return result;
  } catch (error) {
    logError('fetchPoolByAddress: failed', { poolAddress, error: String(error) });
    return null;
  }
}

/**
 * Invalidate cache (used after major state changes).
 */
export function invalidatePoolCache(): void {
  poolCache = null;
  cacheTimestamp = 0;
  logDebug('invalidatePoolCache: cache cleared');
}

/**
 * Check if Meteora API is responsive (for startup validation).
 */
export async function pingMeteora(): Promise<boolean> {
  try {
    const response = await withTimeout(
      fetch(`${CONFIG.meteoraApiUrl}/health`),
      5000,
      'Meteora ping'
    );
    return response.ok;
  } catch {
    return false;
  }
}
