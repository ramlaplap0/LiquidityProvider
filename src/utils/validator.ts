import { z } from 'zod';

// ── Meteora Pool API Response ────────────────────────────────────
export const PoolDataSchema = z.object({
  address: z.string().min(1),
  pair: z.string().min(1),
  mintA: z.string().min(1),
  mintB: z.string().min(1),
  tokenA: z.string().min(1),
  tokenB: z.string().min(1),
  tvl: z.number().min(0),
  volume24h: z.number().min(0),
  fee24h: z.number().min(0),
  dailyFees7d: z.array(z.number().min(0)).max(7),
  poolAgeDays: z.number().min(0),
  tvlChange24h: z.number(),
  binStep: z.number().positive(),
  baseFee: z.number().positive(),
});

export const MeteoraPoolsResponseSchema = z.object({
  pools: z.array(PoolDataSchema).default([]),
});

// ── Jupiter Price API Response ───────────────────────────────────
export const JupiterPriceDataSchema = z.object({
  id: z.string().min(1),
  type: z.string().optional(),
  price: z.string().min(1),
  extra: z.record(z.string(), z.unknown()).optional(),
});

export const JupiterPriceResponseSchema = z.object({
  data: z.record(z.string(), JupiterPriceDataSchema),
  timeTaken: z.number().optional(),
});

// ── Jupiter Token List Response ──────────────────────────────────
export const JupiterTokenListItemSchema = z.object({
  address: z.string().min(1),
  name: z.string().optional(),
  symbol: z.string().optional(),
  decimals: z.number().optional(),
  tags: z.array(z.string()).optional(),
  logoURI: z.string().optional(),
  verified: z.boolean().optional(),
});

export const JupiterTokenListResponseSchema = z.object({
  mints: z.array(JupiterTokenListItemSchema),
});

// ── Solscan Token Metadata Response ──────────────────────────────
export const SolscanTopHolderSchema = z.object({
  address: z.string(),
  amount: z.string(),
  percentage: z.number(),
});

export const SolscanTokenMetaSchema = z.object({
  tokenType: z.string().nullable(),
  holder: z.number().min(0),
  mintAuthority: z.string().nullable(),
  freezeAuthority: z.string().nullable(),
  supply: z.string().min(1),
  decimals: z.number().min(0),
  topHolders: z.array(SolscanTopHolderSchema).optional().default([]),
});

export const SolscanTokenMetaResponseSchema = z.object({
  success: z.boolean(),
  data: SolscanTokenMetaSchema.nullable(),
});

// ── Position State Schema (for persistence validation) ───────────
export const PositionStateSchema = z.object({
  positionId: z.string().uuid(),
  slot: z.enum(['PAIR_1', 'PAIR_2']),
  state: z.enum(['IDLE', 'OPENING', 'ACTIVE', 'OUT_OF_RANGE', 'REBALANCING', 'CLOSING', 'CLOSED']),
  pair: z.string(),
  mintA: z.string(),
  mintB: z.string(),
  tier: z.enum(['TIER1', 'TIER2']),
  verificationStatus: z.enum(['VERIFIED', 'SEMI_VERIFIED', 'REJECTED']),
  shape: z.enum(['Curve', 'SpotSpread', 'SpotWide']),
  bins: z.number().int().positive(),
  binStep: z.number().positive(),
  centerBin: z.number().int(),
  binLower: z.number().int(),
  binUpper: z.number().int(),
  entryUsd: z.string(), // Decimal serialized as string
  entryAmountA: z.string(),
  entryAmountB: z.string(),
  entryPriceA: z.string(),
  entryPriceB: z.string(),
  openedAt: z.string().datetime(),
  lastVerifiedAt: z.string().datetime(),
  txidOpen: z.string(),
  thresholdUsed: z.number(),
  aprAtEntry: z.string(),
  outOfRangeSince: z.string().datetime().nullable(),
  lastRebalancedAt: z.string().datetime().nullable(),
  accumulatedFeesUsd: z.string(),
  totalGasSpentUsd: z.string(),
});

// ── Bot State Schema ─────────────────────────────────────────────
export const BotStateSchema = z.object({
  overallState: z.enum(['RUNNING', 'PAUSED', 'STOPPED']),
  consecutiveLossCount: z.number().int().min(0),
  totalFeesClaimedUsd: z.string(),
  totalGasSpentUsd: z.string(),
  totalIlRealizedUsd: z.string(),
  feeReserveUsd: z.string(),
  totalCapital: z.string(),
  pair1Allocation: z.string(),
  pair2Allocation: z.string(),
  gasReserve: z.string(),
  circuitBreakerTriggeredAt: z.string().datetime().nullable(),
  pausedAt: z.string().datetime().nullable(),
  pauseReason: z.string().nullable(),
  lastPositionClosedAt: z.string().datetime().nullable(),
});

// ── Blacklist Entry Schema ───────────────────────────────────────
export const BlacklistEntrySchema = z.object({
  mintAddress: z.string().min(1),
  reason: z.string().min(1),
  blacklistedAt: z.string().datetime(),
  expiryAt: z.string().datetime().nullable(),
  permanent: z.boolean(),
});

// ── Scan Cache Schema ────────────────────────────────────────────
export const ScanCacheEntrySchema = z.object({
  pair: z.string(),
  poolAddress: z.string(),
  mintA: z.string(),
  mintB: z.string(),
  estimatedApr: z.string(),
  volumeTvlRatio: z.string(),
  feeStabilityScore: z.string(),
  volume24h: z.string(),
  tvl: z.string(),
  fee24h: z.string(),
  poolAgeDays: z.number(),
  pairScore: z.string(),
  verificationStatus: z.enum(['VERIFIED', 'SEMI_VERIFIED', 'REJECTED']),
  tier: z.enum(['TIER1', 'TIER2']),
  thresholdUsed: z.number(),
});

export const ScanCacheSchema = z.object({
  lastScanTime: z.string().datetime(),
  thresholdUsed: z.number(),
  topPairs: z.array(ScanCacheEntrySchema),
});

// ── Monitoring Log Schema ────────────────────────────────────────
export const MonitorLogSchema = z.object({
  timestamp: z.string().datetime(),
  botState: z.enum(['RUNNING', 'PAUSED', 'STOPPED']),
  totalPortfolioUsd: z.string(),
  feesEarned24hUsd: z.string(),
  gasSpent24hUsd: z.string(),
  netPnl24hUsd: z.string(),
  compoundAprPct: z.string(),
  gasBalanceSol: z.string(),
  feeReserveUsd: z.string(),
  circuitBreakerCount: z.number(),
  maxPositions: z.number(),
  scanThresholdUsed: z.number(),
  activePositions: z.array(
    z.object({
      slot: z.string(),
      positionId: z.string(),
      state: z.string(),
      pair: z.string(),
      tier: z.string(),
      verificationStatus: z.string(),
      shape: z.string(),
      regime: z.string(),
      isInRange: z.boolean(),
      outOfRangeSince: z.string().nullable(),
      entryUsd: z.string(),
      currentUsd: z.string(),
      ilPct: z.string(),
      feesEarnedUsd: z.string(),
      binsDrift: z.number(),
      centerBin: z.number(),
      activeBin: z.number(),
      binLower: z.number(),
      binUpper: z.number(),
      aprAtEntry: z.string(),
      currentApr: z.string().nullable(),
      pairScore: z.string(),
      volumeTvlRatio: z.string(),
      stillInScanTop2: z.boolean(),
      thresholdUsed: z.number(),
      mutexLocked: z.boolean(),
      openedAt: z.string(),
      lastVerifiedAt: z.string(),
      lastRebalancedAt: z.string().nullable(),
      txidOpen: z.string(),
    })
  ),
  scannerLastRun: z.string(),
  scanResultTop1: z.string().nullable(),
  scanResultTop2: z.string().nullable(),
  pairsScanned: z.number(),
  pairsRejectedStablecoin: z.number(),
  pairsRejectedApr: z.number(),
  pairsRejectedVerification: z.number(),
  pairsPassedFilter: z.number(),
  pairsSelected: z.number(),
  alerts: z.array(
    z.object({
      level: z.string(),
      message: z.string(),
      context: z.unknown().optional(),
    })
  ),
});

// ── Fee Harvester State Schema ───────────────────────────────────
export const FeeHarvesterStateSchema = z.object({
  feeReserveUsd: z.string(),
  totalFeesClaimedUsd: z.string(),
  totalGasSpentOnClaimsUsd: z.string(),
  lastClaimedAt: z.string().datetime().nullable(),
  lastCompoundedAt: z.string().datetime().nullable(),
});
