import 'dotenv/config';
import { z } from 'zod';
import { Decimal } from 'decimal.js';

// ── Zod schema for environment variables ─────────────────────────
const envSchema = z.object({
  // ── Required ──
  PRIVATE_KEY: z.string().min(1, 'PRIVATE_KEY is required'),
  RPC_URL: z.string().url('RPC_URL must be a valid URL'),
  HELIUS_API_KEY: z.string().min(1, 'HELIUS_API_KEY is required'),

  // ── Capital ──
  TOTAL_CAPITAL_USD: z.string().default('200'),
  GAS_RESERVE_PCT: z.string().default('0.10'),

  // ── Thresholds ──
  MIN_APR_PCT: z.string().default('250'),
  EXIT_APR_PCT: z.string().default('50'),
  WARNING_APR_PCT: z.string().default('100'),
  VOLUME_TVL_PRIMARY: z.string().default('1.0'),
  VOLUME_TVL_FALLBACK: z.string().default('0.7'),

  // ── IL Thresholds ──
  IL_TIER1_THRESHOLD: z.string().default('-8'),
  IL_TIER2_THRESHOLD: z.string().default('-6'),
  IL_STOP_LOSS: z.string().default('-15'),
  PRICE_CRASH_PCT: z.string().default('-20'),

  // ── Monitoring ──
  MONITOR_INTERVAL_MS: z.string().default('300000'),   // 5 min
  VOLATILE_MONITOR_MS: z.string().default('180000'),    // 3 min
  SCAN_INTERVAL_MS: z.string().default('1800000'),      // 30 min
  STUCK_TX_TIMEOUT_MS: z.string().default('60000'),     // 60 sec
  OOR_MAX_WAIT_MS: z.string().default('900000'),        // 15 min

  // ── Fees ──
  MIN_CLAIM_USD: z.string().default('0.50'),
  COMPOUND_THRESHOLD_USD: z.string().default('5'),
  FEE_RESERVE_WARN_USD: z.string().default('20'),
  PRIORITY_FEE_VOLATILE: z.string().default('high'),
  PRIORITY_FEE_NORMAL: z.string().default('medium'),

  // ── Circuit breaker ──
  MAX_CONSECUTIVE_LOSSES: z.string().default('3'),

  // ── API timeouts ──
  API_TIMEOUT_MS: z.string().default('10000'),
  CONFIRM_TIMEOUT_MS: z.string().default('60000'),

  // ── Gas ──
  MIN_GAS_SOL: z.string().default('0.15'),
  MIN_WALLET_BALANCE_USD: z.string().default('30'),

  // ── Rebalance ──
  REBALANCE_DRIFT_THRESHOLD: z.string().default('8'),
  REBALANCE_FEE_MULTIPLIER: z.string().default('2'),
  VOLUME_DROP_PCT: z.string().default('60'),

  // ── Bin strategy ──
  STABLE_BINS_MIN: z.string().default('15'),
  STABLE_BINS_MAX: z.string().default('20'),
  STABLE_BPS_MIN: z.string().default('1'),
  STABLE_BPS_MAX: z.string().default('5'),

  RANGING_BINS_MIN: z.string().default('20'),
  RANGING_BINS_MAX: z.string().default('30'),
  RANGING_BPS_MIN: z.string().default('10'),
  RANGING_BPS_MAX: z.string().default('25'),

  VOLATILE_BINS_MIN: z.string().default('40'),
  VOLATILE_BINS_MAX: z.string().default('50'),
  VOLATILE_BPS_MIN: z.string().default('25'),
  VOLATILE_BPS_MAX: z.string().default('50'),

  TIER2_RANGE_PCT: z.string().default('20'),

  // ── Logging ──
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // ── Optional dev ──
  DEVNET: z.string().default('false'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const errorList = parsed.error.issues
    .map((issue: unknown) => {
      const i = issue as { path: PropertyKey[]; message: string };
      return `${String(i.path[0])}: ${i.message}`;
    })
    .join('\n');
  throw new Error(`Environment validation failed:\n${errorList}`);
}

const env = parsed.data;

// ── Derive capital allocations ───────────────────────────────────
const totalCapital = new Decimal(env.TOTAL_CAPITAL_USD);
const gasReservePct = new Decimal(env.GAS_RESERVE_PCT);
const gasReserve = totalCapital.times(gasReservePct);
const pairAllocation = totalCapital.minus(gasReserve).div(2);

// ── Stablecoin list (for filtering) ──────────────────────────────
export const STABLECOINS: ReadonlySet<string> = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwnjXaDC', // BUSD (wormhole)
  'EjmyN6qEC1yf1VQrUH4CGlnPCLE2TEqKJnwQEOoevPgY', // DAI (portal)
  'FR87nWEUxVgyWRfNR58zjcXnjvdy1QfxbkCy4Bw6yUW1', // FRAX
]);

export const STABLECOIN_SYMBOLS: ReadonlySet<string> = new Set([
  'USDC', 'USDT', 'BUSD', 'DAI', 'FRAX',
]);

// ── Exports ──────────────────────────────────────────────────────
export const CONFIG = {
  // Wallet
  privateKey: env.PRIVATE_KEY,
  rpcUrl: env.RPC_URL,
  heliusApiKey: env.HELIUS_API_KEY,
  isDevnet: env.DEVNET === 'true',

  // Capital
  totalCapital,
  gasReserve,
  pairAllocation,

  // Thresholds
  minAprPct: new Decimal(env.MIN_APR_PCT),
  exitAprPct: new Decimal(env.EXIT_APR_PCT),
  warningAprPct: new Decimal(env.WARNING_APR_PCT),
  volumeTvlPrimary: new Decimal(env.VOLUME_TVL_PRIMARY),
  volumeTvlFallback: new Decimal(env.VOLUME_TVL_FALLBACK),

  // IL
  ilTier1Threshold: new Decimal(env.IL_TIER1_THRESHOLD),
  ilTier2Threshold: new Decimal(env.IL_TIER2_THRESHOLD),
  ilStopLoss: new Decimal(env.IL_STOP_LOSS),
  priceCrashPct: new Decimal(env.PRICE_CRASH_PCT),

  // Intervals
  monitorIntervalMs: Number(env.MONITOR_INTERVAL_MS),
  volatileMonitorMs: Number(env.VOLATILE_MONITOR_MS),
  scanIntervalMs: Number(env.SCAN_INTERVAL_MS),
  stuckTxTimeoutMs: Number(env.STUCK_TX_TIMEOUT_MS),
  oorMaxWaitMs: Number(env.OOR_MAX_WAIT_MS),

  // Fees
  minClaimUsd: new Decimal(env.MIN_CLAIM_USD),
  compoundThresholdUsd: new Decimal(env.COMPOUND_THRESHOLD_USD),
  feeReserveWarnUsd: new Decimal(env.FEE_RESERVE_WARN_USD),
  priorityFeeVolatile: env.PRIORITY_FEE_VOLATILE,
  priorityFeeNormal: env.PRIORITY_FEE_NORMAL,

  // Circuit breaker
  maxConsecutiveLosses: Number(env.MAX_CONSECUTIVE_LOSSES),

  // Timeouts
  apiTimeoutMs: Number(env.API_TIMEOUT_MS),
  confirmTimeoutMs: Number(env.CONFIRM_TIMEOUT_MS),

  // Gas
  minGasSol: new Decimal(env.MIN_GAS_SOL),
  minWalletBalanceUsd: new Decimal(env.MIN_WALLET_BALANCE_USD),

  // Rebalance
  rebalanceDriftThreshold: Number(env.REBALANCE_DRIFT_THRESHOLD),
  rebalanceFeeMultiplier: Number(env.REBALANCE_FEE_MULTIPLIER),
  volumeDropPct: Number(env.VOLUME_DROP_PCT),

  // Bin strategy
  stableBinsMin: Number(env.STABLE_BINS_MIN),
  stableBinsMax: Number(env.STABLE_BINS_MAX),
  stableBpsMin: Number(env.STABLE_BPS_MIN),
  stableBpsMax: Number(env.STABLE_BPS_MAX),

  rangingBinsMin: Number(env.RANGING_BINS_MIN),
  rangingBinsMax: Number(env.RANGING_BINS_MAX),
  rangingBpsMin: Number(env.RANGING_BPS_MIN),
  rangingBpsMax: Number(env.RANGING_BPS_MAX),

  volatileBinsMin: Number(env.VOLATILE_BINS_MIN),
  volatileBinsMax: Number(env.VOLATILE_BINS_MAX),
  volatileBpsMin: Number(env.VOLATILE_BPS_MIN),
  volatileBpsMax: Number(env.VOLATILE_BPS_MAX),

  tier2RangePct: Number(env.TIER2_RANGE_PCT),

  // Logging
  logLevel: env.LOG_LEVEL,

  // Constants
  maxPositions: 2,
  minVolume24h: new Decimal(100_000),
  minTvl: new Decimal(100_000),
  minPoolAgeDays: 7,
  maxAprSuspicious: new Decimal(100_000),

  // File paths
  blacklistPath: './src/data/blacklist.json',
  scanCachePath: './src/data/scan_cache.json',
  positionsPath: './src/data/positions.json',
  botStatePath: './src/data/bot_state.json',

  // URLs
  meteoraApiUrl: 'https://dlmm-api.meteora.ag',
  jupiterPriceUrl: 'https://lite-api.jup.ag/price/v2',
  jupiterTokenListUrl: 'https://token-list-api.jupiterapi.com/v1/mints?tags=verified',
  solscanApiUrl: 'https://public-api.solscan.io',
} as const;

/** Quick check: is a symbol/name a known stablecoin? */
export function isStablecoin(symbolOrMint: string): boolean {
  return STABLECOIN_SYMBOLS.has(symbolOrMint.toUpperCase()) || STABLECOINS.has(symbolOrMint);
}

export default CONFIG;
