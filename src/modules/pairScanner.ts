import { Decimal } from 'decimal.js';
import { CONFIG, isStablecoin } from '@/config';
import { fetchAllPools } from '@/api/meteora';
import { fetchPrices } from '@/api/jupiter';
import { validateTokenContract, checkAntiRugHeuristic } from '@/api/solscan';
import { checkTokenVerification } from '@/api/jupiter';
import type { PoolData, ScanResultEntry } from '@/types';
import type { ScanCache } from '@/types';
import { calculateApr, calculateFeeStabilityScore, calculatePairScore } from '@/utils/math';
import { logInfo, logWarn, logDebug } from '@/utils/logger';
import fs from 'fs/promises';

// ── Counters for logging ─────────────────────────────────────────
let lastScanStats = {
  pairsScanned: 0,
  rejectedStablecoin: 0,
  rejectedApr: 0,
  rejectedVerification: 0,
  passedFilter: 0,
  selected: 0,
};

export function getLastScanStats(): typeof lastScanStats {
  return { ...lastScanStats };
}

// ── FILTER TAHAP 1: Quantitative Filter ──────────────────────────
async function filterTahap1Quantitative(
  pools: PoolData[],
  volumeTvlThreshold: Decimal
): Promise<PoolData[]> {
  const prices = await fetchPrices([
    ...new Set(pools.flatMap((p) => [p.mintA, p.mintB])),
  ]);

  const passed: PoolData[] = [];

  for (const pool of pools) {
    // 1. Stablecoin-to-stablecoin filter (MOST IMPORTANT)
    const isAStable = isStablecoin(pool.mintA) || isStablecoin(pool.tokenA);
    const isBStable = isStablecoin(pool.mintB) || isStablecoin(pool.tokenB);
    if (isAStable && isBStable) {
      lastScanStats.rejectedStablecoin++;
      logDebug('filterTahap1: stablecoin pair rejected', { pair: pool.pair });
      continue;
    }

    // 2. Min volume $100k
    if (new Decimal(pool.volume24h).lt(CONFIG.minVolume24h)) {
      continue;
    }

    // 3. Min TVL $100k
    if (new Decimal(pool.tvl).lt(CONFIG.minTvl)) {
      continue;
    }

    // 4. Volume/TVL ratio
    const volumeTvl = new Decimal(pool.volume24h).dividedBy(pool.tvl);
    if (volumeTvl.lt(volumeTvlThreshold)) {
      continue;
    }

    // 5. Min APR 250%
    const apr = calculateApr(new Decimal(pool.fee24h), new Decimal(pool.tvl));
    if (!apr || apr.lt(CONFIG.minAprPct)) {
      lastScanStats.rejectedApr++;
      logDebug('filterTahap1: APR too low', { pair: pool.pair, apr: apr?.toFixed(2) ?? 'null' });
      continue;
    }

    // 6. Pool age min 7 days
    if (pool.poolAgeDays < CONFIG.minPoolAgeDays) {
      continue;
    }

    // 7. Valid prices from Jupiter
    const priceA = prices.get(pool.mintA);
    const priceB = prices.get(pool.mintB);
    if (!priceA || !priceB || priceA.stale || priceB.stale) {
      logDebug('filterTahap1: price unavailable', { pair: pool.pair });
      continue;
    }

    passed.push(pool);
  }

  return passed;
}

// ── FILTER TAHAP 2: Token Verification ───────────────────────────
async function filterTahap2Verification(pool: PoolData): Promise<{
  passed: boolean;
  status: 'VERIFIED' | 'SEMI_VERIFIED' | 'REJECTED';
  reason?: string;
}> {
  try {
    // Level 1: Jupiter token list
    const mintAStatus = await checkTokenVerification(pool.mintA);
    const mintBStatus = await checkTokenVerification(pool.mintB);

    if (mintAStatus === 'REJECTED' || mintBStatus === 'REJECTED') {
      return { passed: false, status: 'REJECTED', reason: 'Token not on Jupiter list' };
    }

    const jupiterStatus = mintAStatus === 'VERIFIED' && mintBStatus === 'VERIFIED'
      ? 'VERIFIED'
      : 'SEMI_VERIFIED';

    // Level 2: Solscan contract check
    const [metaA, metaB] = await Promise.all([
      validateTokenContract(pool.mintA),
      validateTokenContract(pool.mintB),
    ]);

    if (!metaA.valid) {
      return { passed: false, status: 'REJECTED', reason: `Token A: ${metaA.reason}` };
    }
    if (!metaB.valid) {
      return { passed: false, status: 'REJECTED', reason: `Token B: ${metaB.reason}` };
    }

    return { passed: true, status: jupiterStatus };
  } catch (error) {
    logWarn('filterTahap2: error during verification', { pair: pool.pair, error: String(error) });
    return { passed: false, status: 'REJECTED', reason: `Verification error: ${String(error)}` };
  }
}

// ── FILTER TAHAP 3: Anti-Rug Heuristic ──────────────────────────
function filterTahap3AntiRug(pool: PoolData, metadataA: TokenMetadata | null, metadataB: TokenMetadata | null): {
  passed: boolean;
  reason?: string;
} {
  // Top holder check
  if (metadataA) {
    const rugA = checkAntiRugHeuristic(metadataA);
    if (!rugA.safe) return { passed: false, reason: `Token A: ${rugA.reason}` };
  }
  if (metadataB) {
    const rugB = checkAntiRugHeuristic(metadataB);
    if (!rugB.safe) return { passed: false, reason: `Token B: ${rugB.reason}` };
  }

  // Liquidity drop check (> 40% in 24h)
  if (pool.tvlChange24h < -40) {
    return { passed: false, reason: `TVL dropped ${pool.tvlChange24h.toFixed(1)}% in 24h` };
  }

  // Price consistency: Jupiter vs pool price < 5%
  // (Requires pool price data - simplified for now)

  return { passed: true };
}

import type { TokenMetadata } from '@/types';

// ── FILTER TAHAP 4: Stability Score ──────────────────────────────
function filterTahap4Stability(pool: PoolData): {
  passed: boolean;
  score: Decimal;
} {
  const fees7d = pool.dailyFees7d.map((f) => new Decimal(f));
  const stabilityScore = calculateFeeStabilityScore(fees7d);

  if (stabilityScore.gt(1)) {
    logDebug('filterTahap4: stability score too high', { pair: pool.pair, score: stabilityScore.toFixed(4) });
    return { passed: false, score: stabilityScore };
  }

  return { passed: true, score: stabilityScore };
}

// ── SCORING & SELECTION ──────────────────────────────────────────
function scorePair(
  pool: PoolData,
  stabilityScore: Decimal,
  verificationStatus: 'VERIFIED' | 'SEMI_VERIFIED'
): ScanResultEntry {
  const estimatedApr = calculateApr(new Decimal(pool.fee24h), new Decimal(pool.tvl)) ?? new Decimal(0);
  const volumeTvlRatio = new Decimal(pool.volume24h).dividedBy(pool.tvl);
  const pairScore = calculatePairScore(estimatedApr, volumeTvlRatio, stabilityScore);

  return {
    pair: pool.pair,
    poolAddress: pool.address,
    mintA: pool.mintA,
    mintB: pool.mintB,
    estimatedApr,
    volumeTvlRatio,
    feeStabilityScore: stabilityScore,
    volume24h: new Decimal(pool.volume24h),
    tvl: new Decimal(pool.tvl),
    fee24h: new Decimal(pool.fee24h),
    poolAgeDays: pool.poolAgeDays,
    pairScore,
    verificationStatus,
    tier: verificationStatus === 'VERIFIED' ? 'TIER1' : 'TIER2',
    thresholdUsed: CONFIG.volumeTvlPrimary.toNumber(),
  };
}

// ── MAIN SCAN FUNCTION ───────────────────────────────────────────
export async function scanPairs(): Promise<ScanCache> {
  logInfo('=== PAIR SCAN STARTED ===');

  // Reset counters
  lastScanStats = {
    pairsScanned: 0,
    rejectedStablecoin: 0,
    rejectedApr: 0,
    rejectedVerification: 0,
    passedFilter: 0,
    selected: 0,
  };

  try {
    // 1. Fetch all pools
    const pools = await fetchAllPools();
    lastScanStats.pairsScanned = pools.length;

    if (pools.length === 0) {
      logWarn('scanPairs: no pools returned from Meteora API');
      return {
        lastScanTime: new Date().toISOString(),
        thresholdUsed: CONFIG.volumeTvlPrimary.toNumber(),
        topPairs: [],
      };
    }

    // 2. FILTER TAHAP 1 (primary threshold 1.0)
    let passedTahap1 = await filterTahap1Quantitative(pools, CONFIG.volumeTvlPrimary);

    // 3. Fallback threshold 0.7 if none passed
    let thresholdUsed = CONFIG.volumeTvlPrimary.toNumber();
    if (passedTahap1.length === 0) {
      logWarn('scanPairs: no pools passed primary threshold 1.0, trying fallback 0.7');
      passedTahap1 = await filterTahap1Quantitative(pools, CONFIG.volumeTvlFallback);
      thresholdUsed = CONFIG.volumeTvlFallback.toNumber();

      if (passedTahap1.length === 0) {
        logWarn('scanPairs: no pools passed fallback threshold 0.7, bot will idle');
        return {
          lastScanTime: new Date().toISOString(),
          thresholdUsed,
          topPairs: [],
        };
      }
    }

    // 4. FILTER TAHAP 2 + 3 + 4 per pool
    const scored: ScanResultEntry[] = [];

    for (const pool of passedTahap1) {
      try {
        // Tahap 2: Verification
        const verification = await filterTahap2Verification(pool);
        if (!verification.passed) {
          lastScanStats.rejectedVerification++;
          logDebug('scanPairs: verification failed', { pair: pool.pair, reason: verification.reason });
          continue;
        }

        // Tahap 3: Anti-rug
        // Fetch metadata for both tokens
        const { fetchTokenMetadata } = await import('@/api/solscan');
        const [metaA, metaB] = await Promise.all([
          fetchTokenMetadata(pool.mintA),
          fetchTokenMetadata(pool.mintB),
        ]);

        const antiRug = filterTahap3AntiRug(pool, metaA, metaB);
        if (!antiRug.passed) {
          lastScanStats.rejectedVerification++;
          logDebug('scanPairs: anti-rug failed', { pair: pool.pair, reason: antiRug.reason });
          continue;
        }

        // Tahap 4: Stability
        const stability = filterTahap4Stability(pool);
        if (!stability.passed) {
          logDebug('scanPairs: stability check failed', { pair: pool.pair });
          continue;
        }

        // All passed → score
        const entry = scorePair(pool, stability.score, verification.status);
        entry.thresholdUsed = thresholdUsed;
        scored.push(entry);
        lastScanStats.passedFilter++;
      } catch (error) {
        logWarn('scanPairs: error processing pool', { pair: pool.pair, error: String(error) });
        continue;
      }
    }

    // 5. Sort by pairScore descending, take top 2
    scored.sort((a, b) => b.pairScore.comparedTo(a.pairScore));

    const topPairs = scored.slice(0, 2);
    lastScanStats.selected = topPairs.length;

    // Edge case: if #1 and #2 are same token, take #3 as #2
    if (topPairs.length === 2) {
      const p1 = topPairs[0];
      const p2 = topPairs[1];
      if (p1.mintA === p2.mintA && p1.mintB === p2.mintB) {
        logWarn('scanPairs: top 2 are same token, taking #3');
        const p3 = scored[2];
        if (p3) {
          topPairs[1] = p3;
        } else {
          topPairs.pop();
        }
      }
    }

    // Edge case: only 1 pair available
    if (topPairs.length === 1) {
      logInfo('scanPairs: only 1 pair available');
    }

    logInfo('=== PAIR SCAN COMPLETED ===', {
      scanned: lastScanStats.pairsScanned,
      passed: lastScanStats.passedFilter,
      selected: lastScanStats.selected,
      top1: topPairs[0]?.pair ?? 'none',
      top2: topPairs[1]?.pair ?? 'none',
    });

    const cache: ScanCache = {
      lastScanTime: new Date().toISOString(),
      thresholdUsed,
      topPairs,
    };

    // Persist cache
    await fs.writeFile(CONFIG.scanCachePath, JSON.stringify({
      lastScanTime: cache.lastScanTime,
      thresholdUsed: cache.thresholdUsed,
      topPairs: cache.topPairs.map((p) => ({
        ...p,
        estimatedApr: p.estimatedApr.toString(),
        volumeTvlRatio: p.volumeTvlRatio.toString(),
        feeStabilityScore: p.feeStabilityScore.toString(),
        volume24h: p.volume24h.toString(),
        tvl: p.tvl.toString(),
        fee24h: p.fee24h.toString(),
        pairScore: p.pairScore.toString(),
      })),
    }, null, 2));

    return cache;
  } catch (error) {
    logWarn('scanPairs: unexpected error', { error: String(error) });
    return {
      lastScanTime: new Date().toISOString(),
      thresholdUsed: CONFIG.volumeTvlPrimary.toNumber(),
      topPairs: [],
    };
  }
}
