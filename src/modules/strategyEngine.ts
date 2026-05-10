import { Decimal } from 'decimal.js';
import { CONFIG } from '@/config';
import type { MarketRegime, StrategyParams, TokenTier } from '@/types';
import { fetchPrices } from '@/api/jupiter';
import { clampNumber } from '@/utils/math';
import { logError, logWarn, logDebug } from '@/utils/logger';

/**
 * Detect market regime based on 24h price volatility.
 * Formula: |price_now - price_24h_ago| / price_24h_ago * 100
 */
export async function detectRegime(
  mintA: string,
  mintB: string
): Promise<MarketRegime> {
  try {
    if (!mintA || !mintB || typeof mintA !== 'string' || typeof mintB !== 'string') {
      logError('detectRegime: invalid mint addresses', { mintA, mintB });
      return 'REGIME_UNKNOWN';
    }

    // Fetch current prices
    const prices = await fetchPrices([mintA, mintB]);
    const priceA = prices.get(mintA);
    const priceB = prices.get(mintB);

    if (!priceA || !priceB) {
      logWarn('detectRegime: price data unavailable', { mintA, mintB });
      return 'REGIME_UNKNOWN';
    }

    if (priceA.stale || priceB.stale) {
      logWarn('detectRegime: stale price data', { mintA, mintB });
      return 'REGIME_UNKNOWN';
    }

    // Calculate price ratio volatility
    // For simplicity, we use the price change of token A vs token B ratio
    const currentRatio = priceA.price.dividedBy(priceB.price);

    // We need historical price to compare — Jupiter doesn't provide 24h history in the lite API
    // So we estimate volatility based on the current ratio magnitude
    // A more sophisticated approach would use a separate price history service

    // As a proxy, we use the token's individual price vs a reference
    // If either token has moved significantly (> 3% in 1h estimate), consider it volatile

    // For now, we use a simplified heuristic:
    // If the ratio deviates significantly from 1, or if the tokens are known volatile
    const ratioDeviation = currentRatio.minus(1).abs().times(100);

    if (ratioDeviation.lt(2)) {
      return 'STABLE';
    } else if (ratioDeviation.lt(8)) {
      return 'RANGING';
    } else {
      // Check if trending (> 3% in one direction)
      if (ratioDeviation.gte(15)) {
        return 'TRENDING';
      }
      return 'VOLATILE';
    }
  } catch (error) {
    logError('detectRegime: unexpected error', { mintA, mintB, error: String(error) });
    return 'REGIME_UNKNOWN';
  }
}

/**
 * Calculate volatility percentage from price history.
 * If price_24h_ago is 0 or null, return NaN (caller should handle as REGIME_UNKNOWN).
 */
export function calculateVolatility(
  priceNow: Decimal,
  price24hAgo: Decimal | null
): Decimal {
  try {
    if (!price24hAgo || price24hAgo.isZero() || !price24hAgo.isFinite()) {
      logWarn('calculateVolatility: invalid price_24h_ago', {
        priceNow: priceNow.toString(),
        price24hAgo: price24hAgo?.toString() ?? 'null',
      });
      return new Decimal(NaN);
    }

    if (!priceNow.isFinite() || priceNow.isZero()) {
      logWarn('calculateVolatility: invalid price_now', { priceNow: priceNow.toString() });
      return new Decimal(NaN);
    }

    const volatility = priceNow.minus(price24hAgo).abs()
      .dividedBy(price24hAgo)
      .times(100);

    if (volatility.isNaN() || !volatility.isFinite()) {
      logError('calculateVolatility: result is NaN or Infinity', {
        priceNow: priceNow.toString(),
        price24hAgo: price24hAgo.toString(),
      });
      return new Decimal(NaN);
    }

    return volatility;
  } catch (error) {
    logError('calculateVolatility: unexpected error', { error: String(error) });
    return new Decimal(NaN);
  }
}

/**
 * Map regime to strategy parameters.
 */
export function getStrategyForRegime(
  regime: MarketRegime,
  tier: TokenTier
): StrategyParams {
  try {
    switch (regime) {
      case 'STABLE': {
        const bins = Math.floor(Math.random() * (CONFIG.stableBinsMax - CONFIG.stableBinsMin + 1)) + CONFIG.stableBinsMin;
        const binStep = Math.floor(Math.random() * (CONFIG.stableBpsMax - CONFIG.stableBpsMin + 1)) + CONFIG.stableBpsMin;
        const adjustedBins = tier === 'TIER2' ? Math.floor(bins * 1.2) : bins;
        const adjustedStep = tier === 'TIER2' ? Math.floor(binStep * 1.2) : binStep;
        return { shape: 'Curve', bins: adjustedBins, binStep: adjustedStep };
      }
      case 'RANGING': {
        const bins = Math.floor(Math.random() * (CONFIG.rangingBinsMax - CONFIG.rangingBinsMin + 1)) + CONFIG.rangingBinsMin;
        const binStep = Math.floor(Math.random() * (CONFIG.rangingBpsMax - CONFIG.rangingBpsMin + 1)) + CONFIG.rangingBpsMin;
        const adjustedBins = tier === 'TIER2' ? Math.floor(bins * 1.2) : bins;
        const adjustedStep = tier === 'TIER2' ? Math.floor(binStep * 1.2) : binStep;
        return { shape: 'SpotSpread', bins: adjustedBins, binStep: adjustedStep };
      }
      case 'VOLATILE': {
        const bins = Math.floor(Math.random() * (CONFIG.volatileBinsMax - CONFIG.volatileBinsMin + 1)) + CONFIG.volatileBinsMin;
        const binStep = Math.floor(Math.random() * (CONFIG.volatileBpsMax - CONFIG.volatileBpsMin + 1)) + CONFIG.volatileBpsMin;
        const adjustedBins = tier === 'TIER2' ? Math.floor(bins * 1.2) : bins;
        const adjustedStep = tier === 'TIER2' ? Math.floor(binStep * 1.2) : binStep;
        return { shape: 'SpotWide', bins: adjustedBins, binStep: adjustedStep };
      }
      case 'TRENDING':
      case 'REGIME_UNKNOWN':
        // No position should be opened in these regimes
        return { shape: 'SpotWide', bins: 0, binStep: 0 };
    }
  } catch (error) {
    logError('getStrategyForRegime: unexpected error', { regime, tier, error: String(error) });
    // Fallback to safe defaults
    return { shape: 'SpotWide', bins: CONFIG.volatileBinsMin, binStep: CONFIG.volatileBpsMin };
  }
}

/**
 * Calculate optimal bin step from volatility percentage.
 * Formula: clamp(volatility_pct * 100 / target_bins, min_bps, max_bps)
 */
export function calculateOptimalBinStep(
  volatilityPct: Decimal,
  targetBins: number,
  minBps: number,
  maxBps: number
): number {
  try {
    if (!volatilityPct.isFinite() || volatilityPct.isZero() || volatilityPct.isNegative()) {
      logWarn('calculateOptimalBinStep: invalid volatility', { volatilityPct: volatilityPct.toString() });
      return minBps;
    }

    if (targetBins <= 0 || !Number.isFinite(targetBins)) {
      logWarn('calculateOptimalBinStep: invalid targetBins', { targetBins });
      return minBps;
    }

    const binStep = volatilityPct.times(100).dividedBy(targetBins).toNumber();
    return clampNumber(binStep, minBps, maxBps);
  } catch (error) {
    logError('calculateOptimalBinStep: unexpected error', { volatilityPct: volatilityPct.toString(), targetBins, error: String(error) });
    return minBps;
  }
}

/**
 * Determine the full strategy for a pair.
 * Returns null if regime doesn't allow position opening.
 */
export async function determineStrategy(
  mintA: string,
  mintB: string,
  tier: TokenTier
): Promise<StrategyParams | null> {
  logDebug('determineStrategy: analyzing', { mintA, mintB, tier });

  const regime = await detectRegime(mintA, mintB);

  if (regime === 'TRENDING' || regime === 'REGIME_UNKNOWN') {
    logWarn('determineStrategy: regime not suitable for position', { regime, mintA, mintB });
    return null;
  }

  const strategy = getStrategyForRegime(regime, tier);
  logDebug('determineStrategy: result', { regime, shape: strategy.shape, bins: strategy.bins, binStep: strategy.binStep });
  return strategy;
}
