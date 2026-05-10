import { Decimal } from 'decimal.js';
import { CONFIG } from '@/config';
import { loadBotState, saveBotState, updateOverallState } from '@/state/botState';
import {
  loadAllPositions,
  getActivePositions,
  getPositionsBySlot,
  isSlotAvailable,
} from '@/state/positionState';
import { scanPairs } from '@/modules/pairScanner';
import { determineStrategy, detectRegime } from '@/modules/strategyEngine';
import {
  openPosition,
  monitorPosition,
  closeAllPositions,
} from '@/modules/positionManager';
import { runFeeHarvesterCycle } from '@/modules/feeHarvester';
import { runRiskCheck, runtimeSafeguards, isStopped, isPaused } from '@/modules/riskGuard';
import { fetchPrices } from '@/api/jupiter';
import { pingMeteora } from '@/api/meteora';
import { pingJupiter } from '@/api/jupiter';
import { pingSolscan } from '@/api/solscan';
import { sleep } from '@/utils/retry';
import { logInfo, logWarn, logError, logCrit } from '@/utils/logger';

// ── BOT STATE ────────────────────────────────────────────────────
let isShuttingDown = false;
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let monitorTimer: ReturnType<typeof setTimeout> | null = null;
let lastScanResult: Awaited<ReturnType<typeof scanPairs>> | null = null;

// ── STARTUP VALIDATION ───────────────────────────────────────────

export interface StartupValidationResult {
  success: boolean;
  errors: string[];
}

export async function runStartupValidation(): Promise<StartupValidationResult> {
  const errors: string[] = [];

  logInfo('=== STARTUP VALIDATION ===');

  // 1. Env vars
  try {
    if (!CONFIG.privateKey || CONFIG.privateKey === 'your_private_key_here') {
      errors.push('PRIVATE_KEY not configured');
    }
    if (!CONFIG.rpcUrl) {
      errors.push('RPC_URL not configured');
    }
    logInfo('Startup: env vars OK');
  } catch (error) {
    errors.push(`Env vars: ${String(error)}`);
  }

  // 2. RPC connection
  try {
    const { Connection } = await import('@solana/web3.js');
    const connection = new Connection(CONFIG.rpcUrl);
    const blockHeight = await connection.getBlockHeight();
    logInfo('Startup: RPC connected', { blockHeight });
  } catch (error) {
    errors.push(`RPC connection: ${String(error)}`);
  }

  // 3. Wallet balance (mock — would check actual SOL balance)
  // For now, we assume sufficient balance
  logInfo('Startup: wallet balance check (mock OK)');

  // 4. Meteora API
  const meteoraOk = await pingMeteora();
  if (!meteoraOk) {
    errors.push('Meteora API not responsive');
  } else {
    logInfo('Startup: Meteora API OK');
  }

  // 5. Jupiter API
  const jupiterOk = await pingJupiter();
  if (!jupiterOk) {
    errors.push('Jupiter API not responsive');
  } else {
    logInfo('Startup: Jupiter API OK');
  }

  // 6. Solscan API
  const solscanOk = await pingSolscan();
  if (!solscanOk) {
    logWarn('Startup: Solscan API not responsive (non-critical)');
  } else {
    logInfo('Startup: Solscan API OK');
  }

  // 7. Data files
  try {
    await loadAllPositions();
    await loadBotState();
    logInfo('Startup: data files OK');
  } catch (error) {
    errors.push(`Data files: ${String(error)}`);
  }

  if (errors.length > 0) {
    logError('Startup validation FAILED', { errors });
    return { success: false, errors };
  }

  logInfo('=== STARTUP VALIDATION PASSED ===');
  return { success: true, errors: [] };
}

// ── MONITORING CYCLE ────────────────────────────────────────────

/**
 * Main monitoring cycle.
 * Runs every 5 minutes (3 minutes when volatile).
 */
async function runMonitorCycle(): Promise<void> {
  try {
    if (isShuttingDown) return;

    logDebug('=== MONITOR CYCLE ===');

    // 1. Load state
    const botState = await loadBotState();

    // 2. Check if STOPPED (circuit breaker)
    if (await isStopped()) {
      logWarn('Monitor: bot is STOPPED (circuit breaker)');
      return;
    }

    // 3. Get active positions
    const activePositions = await getActivePositions();

    // 4. Runtime safeguards
    try {
      const solPrice = new Decimal(150); // Mock SOL price
      const solPriceChange1h = new Decimal(-2); // Mock 1h change
      const walletBalanceUsd = new Decimal(50); // Mock balance

      await runtimeSafeguards({
        solPrice,
        solPriceChange1h,
        walletBalanceUsd,
        apiResponsive: true,
        solscanResponsive: true,
      });
    } catch (error) {
      logError('Monitor: runtime safeguards error', { error: String(error) });
    }

    // 5. Check if PAUSED
    if (await isPaused()) {
      logDebug('Monitor: bot is PAUSED, skipping actions');
      // Still do fee claims
      await runFeeHarvesterCycle();
      return;
    }

    // 6. Monitor each active position
    for (const pos of activePositions) {
      try {
        const result = await monitorPosition(pos.positionId);
        logDebug('Monitor: position checked', {
          positionId: pos.positionId,
          pair: pos.pair,
          isInRange: result.isInRange,
          ilPct: result.ilPct?.toFixed(4) ?? 'N/A',
          actions: result.actions,
        });
      } catch (error) {
        logError('Monitor: error monitoring position', {
          positionId: pos.positionId,
          error: String(error),
        });
      }
    }

    // 7. Run fee harvester
    await runFeeHarvesterCycle();

    // 8. Try to open positions if slots available
    await tryOpenPositions();

    logDebug('=== MONITOR CYCLE COMPLETE ===');
  } catch (error) {
    logError('Monitor cycle error', { error: String(error) });
  }
}

// ── SCAN CYCLE ──────────────────────────────────────────────────

/**
 * Scan cycle — runs every 30 minutes.
 */
async function runScanCycle(): Promise<void> {
  try {
    if (isShuttingDown) return;

    logInfo('=== SCAN CYCLE ===');

    // Check if stopped
    if (await isStopped()) {
      logWarn('Scan: bot is STOPPED');
      return;
    }

    const result = await scanPairs();
    lastScanResult = result;

    logInfo('Scan: completed', {
      pairsFound: result.topPairs.length,
      thresholdUsed: result.thresholdUsed,
      top1: result.topPairs[0]?.pair ?? 'none',
      top2: result.topPairs[1]?.pair ?? 'none',
    });

    // Try to open positions if we have scan results
    if (result.topPairs.length > 0) {
      await tryOpenPositions();
    }
  } catch (error) {
    logError('Scan cycle error', { error: String(error) });
  }
}

// ── POSITION OPENING ────────────────────────────────────────────

/**
 * Try to open positions in available slots.
 */
async function tryOpenPositions(): Promise<void> {
  try {
    // Get scan result
    const scanResult = lastScanResult;
    if (!scanResult || scanResult.topPairs.length === 0) {
      logDebug('tryOpenPositions: no scan results available');
      return;
    }

    // Check available slots
    const slot1Available = await isSlotAvailable('PAIR_1');
    const slot2Available = await isSlotAvailable('PAIR_2');

    if (!slot1Available && !slot2Available) {
      logDebug('tryOpenPositions: all slots occupied');
      return;
    }

    // Run RiskGuard
    const riskCheck = await runRiskCheck({ isOpenCheck: true });
    if (!riskCheck.allowed) {
      logDebug('tryOpenPositions: RiskGuard blocked', { reason: riskCheck.reason });
      return;
    }

    // Try to fill each available slot
    let pairIndex = 0;

    if (slot1Available && scanResult.topPairs[pairIndex]) {
      const pair = scanResult.topPairs[pairIndex];

      // Validate APR
      if (pair.estimatedApr.lt(CONFIG.minAprPct)) {
        logWarn('tryOpenPositions: APR below threshold for slot 1', {
          pair: pair.pair,
          apr: pair.estimatedApr.toFixed(2),
        });
      } else {
        await openPositionInSlot('PAIR_1', pair);
      }
      pairIndex++;
    }

    if (slot2Available && scanResult.topPairs[pairIndex]) {
      const pair = scanResult.topPairs[pairIndex];

      if (pair.estimatedApr.lt(CONFIG.minAprPct)) {
        logWarn('tryOpenPositions: APR below threshold for slot 2', {
          pair: pair.pair,
          apr: pair.estimatedApr.toFixed(2),
        });
      } else {
        await openPositionInSlot('PAIR_2', pair);
      }
    }
  } catch (error) {
    logError('tryOpenPositions: error', { error: String(error) });
  }
}

/**
 * Open a position in a specific slot.
 */
async function openPositionInSlot(
  slot: 'PAIR_1' | 'PAIR_2',
  pair: typeof lastScanResult extends null ? never : NonNullable<typeof lastScanResult>['topPairs'][0]
): Promise<void> {
  try {
    logInfo(`Opening position in ${slot}`, { pair: pair.pair, apr: pair.estimatedApr.toFixed(2) });

    // Determine strategy
    const strategy = await determineStrategy(pair.mintA, pair.mintB, pair.tier);
    if (!strategy) {
      logWarn(`Cannot determine strategy for ${pair.pair}`);
      return;
    }

    // Fetch prices for entry
    const prices = await fetchPrices([pair.mintA, pair.mintB]);
    const priceA = prices.get(pair.mintA);
    const priceB = prices.get(pair.mintB);

    if (!priceA || !priceB) {
      logWarn(`Price unavailable for ${pair.pair}`);
      return;
    }

    // Calculate amounts (mock — in real impl, use Jupiter swap)
    const allocation = slot === 'PAIR_1' ? CONFIG.pairAllocation : CONFIG.pairAllocation;
    const halfAllocation = allocation.dividedBy(2);
    const amountA = halfAllocation.dividedBy(priceA.price);
    const amountB = halfAllocation.dividedBy(priceB.price);

    // Mock TX — in real implementation, this would be a real blockchain TX
    const txid = `mock-txid-${Date.now()}-${slot}`;

    await openPosition({
      slot,
      pair,
      regime: 'RANGING', // Will be detected after open
      shape: strategy.shape,
      bins: strategy.bins,
      binStep: strategy.binStep,
      centerBin: 0,
      binLower: -Math.floor(strategy.bins / 2),
      binUpper: Math.floor(strategy.bins / 2),
      entryUsd: allocation,
      entryAmountA: amountA,
      entryAmountB: amountB,
      entryPriceA: priceA.price,
      entryPriceB: priceB.price,
      txidOpen: txid,
    });

    logInfo(`Position opened in ${slot}`, { pair: pair.pair, txid });
  } catch (error) {
    logError(`Failed to open position in ${slot}`, {
      pair: pair.pair,
      error: String(error),
    });
  }
}

// ── SCHEDULERS ──────────────────────────────────────────────────

function scheduleScans(): void {
  const runAndSchedule = async () => {
    await runScanCycle();
    if (!isShuttingDown) {
      scanTimer = setTimeout(runAndSchedule, CONFIG.scanIntervalMs);
    }
  };
  scanTimer = setTimeout(runAndSchedule, 5000); // First scan after 5s
}

function scheduleMonitors(): void {
  const runAndSchedule = async () => {
    const startTime = Date.now();
    await runMonitorCycle();
    if (isShuttingDown) return;

    // Dynamic interval: 3 min if volatile, 5 min otherwise
    const elapsed = Date.now() - startTime;
    const activePositions = await getActivePositions();
    const isVolatile = activePositions.some((p) => p.shape === 'SpotWide');
    const interval = isVolatile ? CONFIG.volatileMonitorMs : CONFIG.monitorIntervalMs;
    const nextDelay = Math.max(1000, interval - elapsed);

    monitorTimer = setTimeout(runAndSchedule, nextDelay);
  };
  monitorTimer = setTimeout(runAndSchedule, 3000); // First monitor after 3s
}

// ── GRACEFUL SHUTDOWN ───────────────────────────────────────────

export async function gracefulShutdown(signal: string): Promise<void> {
  logInfo(`Received ${signal}, initiating graceful shutdown...`);
  isShuttingDown = true;

  // Clear timers
  if (scanTimer) clearTimeout(scanTimer);
  if (monitorTimer) clearTimeout(monitorTimer);

  // Finish current cycle (positions will complete their current operations)
  // No new transactions

  // Save state
  try {
    await loadBotState().then(async (state) => {
      const updated = { ...state };
      await saveBotState(updated);
    });
    logInfo('State saved during shutdown');
  } catch (error) {
    logError('Failed to save state during shutdown', { error: String(error) });
  }

  logInfo('Bot shutting down gracefully');
  process.exit(0);
}

// ── MAIN LOOP ────────────────────────────────────────────────────

export async function startBot(): Promise<void> {
  logInfo('=== BOT STARTING ===');

  // 1. Startup validation
  const validation = await runStartupValidation();
  if (!validation.success) {
    logCrit('Startup validation failed, bot will not start', {
      errors: validation.errors,
    });
    process.exit(1);
  }

  // 2. Initialize state
  await loadAllPositions();
  await loadBotState();

  // 3. Schedule cycles
  scheduleScans();
  scheduleMonitors();

  // 4. Setup signal handlers
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  logInfo('=== BOT RUNNING ===');
  logInfo('Press Ctrl+C to stop');
}

// Import logDebug used in monitor cycle
import { logDebug } from '@/utils/logger';
