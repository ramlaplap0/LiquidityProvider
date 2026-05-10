import { Decimal } from 'decimal.js';

/** ================================================================
 *  POSITION STATE MACHINE
 *  ================================================================ */
export type PositionState =
  | 'IDLE'
  | 'OPENING'
  | 'ACTIVE'
  | 'OUT_OF_RANGE'
  | 'REBALANCING'
  | 'CLOSING'
  | 'CLOSED';

/** Valid state transitions — any transition not in this map is illegal */
export const VALID_TRANSITIONS: Readonly<Record<PositionState, readonly PositionState[]>> = {
  IDLE: ['OPENING'],
  OPENING: ['ACTIVE', 'IDLE'],
  ACTIVE: ['OUT_OF_RANGE', 'REBALANCING', 'CLOSING'],
  OUT_OF_RANGE: ['REBALANCING', 'CLOSING'],
  REBALANCING: ['ACTIVE', 'IDLE'],
  CLOSING: ['CLOSED'],
  CLOSED: ['IDLE'],
} as const;

/** ================================================================
 *  MARKET REGIME
 *  ================================================================ */
export type MarketRegime =
  | 'STABLE'
  | 'RANGING'
  | 'VOLATILE'
  | 'TRENDING'
  | 'REGIME_UNKNOWN';

/** ================================================================
 *  TOKEN / PAIR TIER
 *  ================================================================ */
export type TokenTier = 'TIER1' | 'TIER2';
export type VerificationStatus = 'VERIFIED' | 'SEMI_VERIFIED' | 'REJECTED';

/** ================================================================
 *  LIQUIDITY SHAPE
 *  ================================================================ */
export type LiquidityShape = 'Curve' | 'SpotSpread' | 'SpotWide';

/** ================================================================
 *  BOT OVERALL STATE
 *  ================================================================ */
export type BotOverallState = 'RUNNING' | 'PAUSED' | 'STOPPED';

/** ================================================================
 *  CLOSE REASON
 *  ================================================================ */
export type CloseReason =
  | 'APR_TOO_LOW'
  | 'IL_STOP_LOSS'
  | 'PRICE_CRASH'
  | 'CIRCUIT_BREAKER'
  | 'EMERGENCY_EXIT'
  | 'MANUAL_CLOSE'
  | 'DEGRADED_TIMEOUT'
  | 'TRENDING_TIMEOUT';

/** ================================================================
 *  RISK GUARD
 *  ================================================================ */
export type RiskSeverity = 'OK' | 'WARN' | 'ERROR' | 'CRIT';

export interface RiskCheckResult {
  readonly allowed: boolean;
  readonly reason: string;
  readonly severity: RiskSeverity;
}

/** ================================================================
 *  SCAN RESULT ENTRY
 *  ================================================================ */
export interface ScanResultEntry {
  readonly pair: string;
  readonly poolAddress: string;
  readonly mintA: string;
  readonly mintB: string;
  readonly estimatedApr: Decimal;
  readonly volumeTvlRatio: Decimal;
  readonly feeStabilityScore: Decimal;
  readonly volume24h: Decimal;
  readonly tvl: Decimal;
  readonly fee24h: Decimal;
  readonly poolAgeDays: number;
  readonly pairScore: Decimal;
  readonly verificationStatus: VerificationStatus;
  readonly tier: TokenTier;
  readonly thresholdUsed: number; // 1.0 or 0.7
}

/** ================================================================
 *  CACHED SCAN RESULT
 *  ================================================================ */
export interface ScanCache {
  readonly lastScanTime: string; // ISO8601
  readonly thresholdUsed: number;
  readonly topPairs: ScanResultEntry[];
}

/** ================================================================
 *  POSITION SNAPSHOT (persisted to disk)
 *  ================================================================ */
export interface PositionSnapshot {
  readonly positionId: string;
  readonly slot: 'PAIR_1' | 'PAIR_2';
  readonly state: PositionState;
  readonly pair: string;
  readonly mintA: string;
  readonly mintB: string;
  readonly tier: TokenTier;
  readonly verificationStatus: VerificationStatus;
  readonly shape: LiquidityShape;
  readonly bins: number;
  readonly binStep: number;
  readonly centerBin: number;
  readonly binLower: number;
  readonly binUpper: number;
  readonly entryUsd: Decimal;
  readonly entryAmountA: Decimal;
  readonly entryAmountB: Decimal;
  readonly entryPriceA: Decimal;
  readonly entryPriceB: Decimal;
  readonly openedAt: string; // ISO8601
  readonly lastVerifiedAt: string; // ISO8601
  readonly txidOpen: string;
  readonly thresholdUsed: number;
  readonly aprAtEntry: Decimal;
  readonly outOfRangeSince: string | null;
  readonly lastRebalancedAt: string | null;
  readonly accumulatedFeesUsd: Decimal;
  readonly totalGasSpentUsd: Decimal;
}

/** ================================================================
 *  POSITION WITH RUNTIME METRICS (enriched for monitoring)
 *  ================================================================ */
export interface PositionWithMetrics extends PositionSnapshot {
  readonly regime: MarketRegime;
  readonly isInRange: boolean;
  readonly currentUsd: Decimal;
  readonly ilPct: Decimal;
  readonly feesEarnedUsd: Decimal;
  readonly binsDrift: number;
  readonly activeBin: number;
  readonly currentApr: Decimal | null;
  readonly pairScore: Decimal;
  readonly volumeTvlRatio: Decimal;
  readonly stillInScanTop2: boolean;
  readonly mutexLocked: boolean;
}

/** ================================================================
 *  BOT STATE (persisted to disk)
 *  ================================================================ */
export interface BotState {
  readonly overallState: BotOverallState;
  readonly consecutiveLossCount: number;
  readonly totalFeesClaimedUsd: Decimal;
  readonly totalGasSpentUsd: Decimal;
  readonly totalIlRealizedUsd: Decimal;
  readonly feeReserveUsd: Decimal;
  readonly totalCapital: Decimal;
  readonly pair1Allocation: Decimal;
  readonly pair2Allocation: Decimal;
  readonly gasReserve: Decimal;
  readonly circuitBreakerTriggeredAt: string | null;
  readonly pausedAt: string | null;
  readonly pauseReason: string | null;
  readonly lastPositionClosedAt: string | null;
}

/** ================================================================
 *  BLACKLIST ENTRY
 *  ================================================================ */
export interface BlacklistEntry {
  readonly mintAddress: string;
  readonly reason: string;
  readonly blacklistedAt: string; // ISO8601
  readonly expiryAt: string | null; // null = permanent
  readonly permanent: boolean;
}

/** ================================================================
 *  STRATEGY PARAMS
 *  ================================================================ */
export interface StrategyParams {
  readonly shape: LiquidityShape;
  readonly bins: number;
  readonly binStep: number;
}

/** ================================================================
 *  POOL DATA (raw from Meteora API)
 *  ================================================================ */
export interface PoolData {
  readonly address: string;
  readonly pair: string;
  readonly mintA: string;
  readonly mintB: string;
  readonly tokenA: string;
  readonly tokenB: string;
  readonly tvl: number;
  readonly volume24h: number;
  readonly fee24h: number;
  readonly dailyFees7d: number[];
  readonly poolAgeDays: number;
  readonly tvlChange24h: number; // negative = drop
  readonly binStep: number;
  readonly baseFee: number;
}

/** ================================================================
 *  TOKEN METADATA (from Solscan)
 *  ================================================================ */
export interface TokenMetadata {
  readonly tokenType: string | null;
  readonly holder: number;
  readonly mintAuthority: string | null;
  readonly freezeAuthority: string | null;
  readonly supply: string;
  readonly decimals: number;
  readonly topHolders: Array<{ address: string; amount: string; percentage: number }>;
}

/** ================================================================
 *  MONITORING LOG ENTRY
 *  ================================================================ */
export interface MonitorLogEntry {
  readonly timestamp: string;
  readonly botState: BotOverallState;
  readonly totalPortfolioUsd: Decimal;
  readonly feesEarned24hUsd: Decimal;
  readonly gasSpent24hUsd: Decimal;
  readonly netPnl24hUsd: Decimal;
  readonly compoundAprPct: Decimal;
  readonly gasBalanceSol: Decimal;
  readonly feeReserveUsd: Decimal;
  readonly circuitBreakerCount: number;
  readonly maxPositions: number;
  readonly scanThresholdUsed: number;
  readonly activePositions: Array<{
    readonly slot: string;
    readonly positionId: string;
    readonly state: PositionState;
    readonly pair: string;
    readonly tier: TokenTier;
    readonly verificationStatus: VerificationStatus;
    readonly shape: LiquidityShape;
    readonly regime: MarketRegime;
    readonly isInRange: boolean;
    readonly outOfRangeSince: string | null;
    readonly entryUsd: Decimal;
    readonly currentUsd: Decimal;
    readonly ilPct: Decimal;
    readonly feesEarnedUsd: Decimal;
    readonly binsDrift: number;
    readonly centerBin: number;
    readonly activeBin: number;
    readonly binLower: number;
    readonly binUpper: number;
    readonly aprAtEntry: Decimal;
    readonly currentApr: Decimal | null;
    readonly pairScore: Decimal;
    readonly volumeTvlRatio: Decimal;
    readonly stillInScanTop2: boolean;
    readonly thresholdUsed: number;
    readonly mutexLocked: boolean;
    readonly openedAt: string;
    readonly lastVerifiedAt: string;
    readonly lastRebalancedAt: string | null;
    readonly txidOpen: string;
  }>;
  readonly scannerLastRun: string;
  readonly scanResultTop1: string | null;
  readonly scanResultTop2: string | null;
  readonly pairsScanned: number;
  readonly pairsRejectedStablecoin: number;
  readonly pairsRejectedApr: number;
  readonly pairsRejectedVerification: number;
  readonly pairsPassedFilter: number;
  readonly pairsSelected: number;
  readonly alerts: Array<{ level: string; message: string; context?: unknown }>;
}

/** ================================================================
 *  FEE HARVESTER STATE
 *  ================================================================ */
export interface FeeHarvesterState {
  readonly feeReserveUsd: Decimal;
  readonly totalFeesClaimedUsd: Decimal;
  readonly totalGasSpentOnClaimsUsd: Decimal;
  readonly lastClaimedAt: string | null;
  readonly lastCompoundedAt: string | null;
}

/** ================================================================
 *  OUT-OF-RANGE DECISION RESULT
 *  ================================================================ */
export interface OutOfRangeDecision {
  readonly action: 'REBALANCE_SAME_PAIR' | 'REBALANCE_NEW_PAIR' | 'CLOSE' | 'WAIT' | 'DEGRADED_REBALANCE';
  readonly reason: string;
  readonly targetPair?: ScanResultEntry;
}

/** ================================================================
 *  PRICE SNAPSHOT
 *  ================================================================ */
export interface PriceSnapshot {
  readonly price: Decimal;
  readonly timestamp: string;
  readonly stale: boolean;
}
