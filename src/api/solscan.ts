import { CONFIG } from '@/config';
import type { TokenMetadata } from '@/types';
import { SolscanTokenMetaResponseSchema } from '@/utils/validator';
import { withRetry, withTimeout } from '@/utils/retry';
import { logError, logWarn, logDebug } from '@/utils/logger';

/**
 * Fetch token metadata from Solscan API.
 */
export async function fetchTokenMetadata(mintAddress: string): Promise<TokenMetadata | null> {
  try {
    if (!mintAddress || typeof mintAddress !== 'string') {
      logError('fetchTokenMetadata: invalid mint address', { mintAddress });
      return null;
    }

    const result = await withRetry(
      async () => {
        const response = await withTimeout(
          fetch(`${CONFIG.solscanApiUrl}/token/meta?tokenAddress=${encodeURIComponent(mintAddress)}`),
          CONFIG.apiTimeoutMs,
          'Solscan fetchTokenMetadata'
        );

        if (!response.ok) {
          if (response.status === 404) {
            logWarn('fetchTokenMetadata: token not found on Solscan', { mintAddress });
            return null;
          }
          throw new Error(`Solscan API error: ${response.status} ${response.statusText}`);
        }

        const json = await response.json();
        const validated = SolscanTokenMetaResponseSchema.safeParse(json);

        if (!validated.success) {
          logWarn('fetchTokenMetadata: response validation failed', {
            mintAddress,
            errors: validated.error.errors.map((e) => e.message),
          });
          return null;
        }

        if (!validated.data.success || !validated.data.data) {
          logWarn('fetchTokenMetadata: Solscan returned success=false', { mintAddress });
          return null;
        }

        const data = validated.data.data;
        return {
          tokenType: data.tokenType,
          holder: data.holder,
          mintAuthority: data.mintAuthority,
          freezeAuthority: data.freezeAuthority,
          supply: data.supply,
          decimals: data.decimals,
          topHolders: data.topHolders ?? [],
        };
      },
      { maxRetries: 3, baseDelayMs: 1000, fnName: 'fetchTokenMetadata', context: { mintAddress } }
    );

    return result;
  } catch (error) {
    logError('fetchTokenMetadata: failed after retries', { mintAddress, error: String(error) });
    return null;
  }
}

/**
 * Check if Solscan API is responsive (for startup validation).
 */
export async function pingSolscan(): Promise<boolean> {
  try {
    const response = await withTimeout(
      fetch(`${CONFIG.solscanApiUrl}/token/meta?tokenAddress=So11111111111111111111111111111111111111112`),
      5000,
      'Solscan ping'
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Validate a token contract using Solscan metadata.
 * Returns true if token passes all checks.
 */
export async function validateTokenContract(mintAddress: string): Promise<{
  valid: boolean;
  metadata: TokenMetadata | null;
  reason?: string;
}> {
  const metadata = await fetchTokenMetadata(mintAddress);

  if (!metadata) {
    return { valid: false, metadata: null, reason: 'Failed to fetch metadata from Solscan' };
  }

  if (metadata.tokenType === null || metadata.tokenType === undefined) {
    return { valid: false, metadata, reason: 'tokenType is null' };
  }

  if (metadata.holder < 500) {
    return { valid: false, metadata, reason: `Holder count ${metadata.holder} < 500` };
  }

  // mintAuthority should be null (renounced)
  if (metadata.mintAuthority !== null) {
    return { valid: false, metadata, reason: `mintAuthority is ${metadata.mintAuthority}` };
  }

  // freezeAuthority should be null
  if (metadata.freezeAuthority !== null) {
    return { valid: false, metadata, reason: `freezeAuthority is ${metadata.freezeAuthority}` };
  }

  if (!metadata.supply || new RegExp('^0+$').test(metadata.supply)) {
    return { valid: false, metadata, reason: 'Invalid or zero supply' };
  }

  if (metadata.decimals < 0) {
    return { valid: false, metadata, reason: `Invalid decimals: ${metadata.decimals}` };
  }

  return { valid: true, metadata };
}

/**
 * Check anti-rug heuristic:
 * - Top 10 holder: no single wallet > 30%
 */
export function checkAntiRugHeuristic(metadata: TokenMetadata): {
  safe: boolean;
  reason?: string;
} {
  if (!metadata || !metadata.topHolders || metadata.topHolders.length === 0) {
    return { safe: false, reason: 'No top holder data available' };
  }

  // Check if any single top 10 holder has > 30%
  for (const holder of metadata.topHolders) {
    if (holder.percentage > 30) {
      return {
        safe: false,
        reason: `Top holder ${holder.address} owns ${holder.percentage.toFixed(2)}%`,
      };
    }
  }

  return { safe: true };
}
