import { CONFIG } from '@/config';
import { Decimal } from 'decimal.js';
import { JupiterPriceResponseSchema, JupiterTokenListResponseSchema } from '@/utils/validator';
import { withRetry, withTimeout } from '@/utils/retry';
import { logError, logWarn, logDebug } from '@/utils/logger';
import type { PriceSnapshot } from '@/types';

// Token list cache
let tokenListCache: Set<string> | null = null;
let tokenListTimestamp = 0;
const TOKEN_LIST_TTL_MS = 300000; // 5 minutes

/**
 * Fetch token prices from Jupiter Price API v2.
 */
export async function fetchPrices(mintAddresses: string[]): Promise<Map<string, PriceSnapshot>> {
  try {
    if (!Array.isArray(mintAddresses) || mintAddresses.length === 0) {
      logError('fetchPrices: invalid input', { mintAddresses });
      return new Map();
    }

    const idsParam = mintAddresses.join(',');

    const result = await withRetry(
      async () => {
        const response = await withTimeout(
          fetch(`${CONFIG.jupiterPriceUrl}?ids=${encodeURIComponent(idsParam)}`),
          CONFIG.apiTimeoutMs,
          'Jupiter fetchPrices'
        );

        if (!response.ok) {
          throw new Error(`Jupiter API error: ${response.status} ${response.statusText}`);
        }

        const json = await response.json();
        const validated = JupiterPriceResponseSchema.safeParse(json);

        if (!validated.success) {
          logWarn('fetchPrices: response validation failed', {
            errors: validated.error.issues.map((i: { message: string }) => i.message),
          });
          return new Map<string, PriceSnapshot>();
        }

        const prices = new Map<string, PriceSnapshot>();
        for (const [mint, data] of Object.entries(validated.data.data)) {
          const entry = data as { price?: string };
          if (entry && entry.price) {
            try {
              const price = new Decimal(entry.price);
              if (price.isZero() || price.isNegative() || !price.isFinite()) {
                logWarn('fetchPrices: invalid price value', { mint, price: entry.price });
                continue;
              }
              prices.set(mint, {
                price,
                timestamp: new Date().toISOString(),
                stale: false,
              });
            } catch {
              logWarn('fetchPrices: failed to parse price', { mint, price: entry.price });
            }
          }
        }

        return prices;
      },
      { maxRetries: 3, baseDelayMs: 1000, fnName: 'fetchPrices', context: { mintCount: mintAddresses.length } }
    );

    logDebug('fetchPrices: fetched', { requested: mintAddresses.length, received: result.size });
    return result;
  } catch (error) {
    logError('fetchPrices: failed after retries', { mintCount: mintAddresses.length, error: String(error) });
    return new Map();
  }
}

/**
 * Fetch single token price.
 */
export async function fetchPrice(mintAddress: string): Promise<PriceSnapshot | null> {
  if (!mintAddress || typeof mintAddress !== 'string') {
    logError('fetchPrice: invalid mint address', { mintAddress });
    return null;
  }
  const prices = await fetchPrices([mintAddress]);
  return prices.get(mintAddress) ?? null;
}

/**
 * Fetch and cache Jupiter token list.
 */
export async function fetchTokenList(): Promise<Set<string>> {
  try {
    const now = Date.now();
    if (tokenListCache && now - tokenListTimestamp < TOKEN_LIST_TTL_MS) {
      return tokenListCache;
    }

    const result = await withRetry(
      async () => {
        const response = await withTimeout(
          fetch(CONFIG.jupiterTokenListUrl),
          CONFIG.apiTimeoutMs,
          'Jupiter fetchTokenList'
        );

        if (!response.ok) {
          throw new Error(`Jupiter Token List API error: ${response.status} ${response.statusText}`);
        }

        const json = await response.json();
        const validated = JupiterTokenListResponseSchema.safeParse(json);

        if (!validated.success) {
          logWarn('fetchTokenList: validation failed', {
            errors: validated.error.issues.map((i: { message: string }) => i.message),
          });
          return new Set<string>();
        }

        const verified = new Set<string>();
        for (const token of validated.data.mints) {
          if (token.address) {
            verified.add(token.address);
          }
        }

        return verified;
      },
      { maxRetries: 3, baseDelayMs: 1000, fnName: 'fetchTokenList' }
    );

    tokenListCache = result;
    tokenListTimestamp = Date.now();
    logDebug('fetchTokenList: fetched', { count: result.size });
    return result;
  } catch (error) {
    logError('fetchTokenList: failed', { error: String(error) });
    return tokenListCache ?? new Set();
  }
}

/**
 * Check verification status of a token on Jupiter.
 * Returns: VERIFIED (strict list), SEMI_VERIFIED (all list), REJECTED (not found)
 */
export async function checkTokenVerification(mintAddress: string): Promise<'VERIFIED' | 'SEMI_VERIFIED' | 'REJECTED'> {
  if (!mintAddress || typeof mintAddress !== 'string') {
    logWarn('checkTokenVerification: invalid mint', { mintAddress });
    return 'REJECTED';
  }

  try {
    // For now, the "all" list includes everything Jupiter knows about.
    // Strict list filtering would require fetching the strict list specifically.
    // We use a simplified approach: if token is in our cached list, consider it at least SEMI_VERIFIED.
    const list = await fetchTokenList();

    if (list.has(mintAddress)) {
      // TODO: differentiate strict vs all list if Jupiter API supports it
      return 'SEMI_VERIFIED';
    }
    return 'REJECTED';
  } catch (error) {
    logError('checkTokenVerification: error', { mintAddress, error: String(error) });
    return 'REJECTED';
  }
}

/**
 * Check if Jupiter API is responsive (for startup validation).
 */
export async function pingJupiter(): Promise<boolean> {
  try {
    const response = await withTimeout(
      fetch(`${CONFIG.jupiterPriceUrl}?ids=So11111111111111111111111111111111111111112`),
      5000,
      'Jupiter ping'
    );
    return response.ok;
  } catch {
    return false;
  }
}
