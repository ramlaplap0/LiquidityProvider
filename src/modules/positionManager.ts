import { Decimal } from 'decimal.js';
import { randomUUID } from 'crypto';
import { CONFIG } from '@/config';
import type {
  PositionState,
  PositionSnapshot,
  ScanResultEntry,
  MarketRegime,
  CloseReason,
  OutOfRangeDecision,
  LiquidityShape,
} from '@/types';
import { VALID_TRANSITIONS } from '@/types';
import {
  loadAllPositions,
  saveAllPositions,
  getPosition,
  updatePosition,
  getPositionsBySlot,
  getActivePositions,
  countActivePositions,
  isSlotAvailable,
} from '@/state/positionState';
import { loadBotState, saveBotState } from '@/state/botState';
import { getMutex, isMutexLocked } from '@/utils/mutex';
import { withRetry } from '@/utils/retry';
import { calculateIlPct, calculateBinsDrift, calculateApr } from '@/utils/math';
import { logInfo, logWarn, logError, logCrit, logDebug } from '@/utils/logger';

// ── STATE TRANSITION ─────────────────────────────────────────────

/**
 * Validate and execute a state transition.
 * Returns true if transition was successful.
 */
export function validateStateTransition(
  currentState: PositionState,
  newState: PositionState
): boolean {
  const allowed = VALID_TRANSITIONS[currentState] ?? [];
  const isValid = (allowed as readonly string[]).includes(newState);
  if (!isValid) {
    logError('Invalid state transition', { from: currentState, to: newState });
  }
  return isValid;
}

/**
 * Transition state with logging. Throws on invalid transition.
 */
export async function transitionState(
  positionId: string,
  newState: PositionState
): Promise<void> {
  const pos = await getPosition(positionId);
  if (!pos) {
    throw new Error(`transitionState: position ${positionId} not found`);
  }

  if (!validateStateTransition(pos.state, newState)) {
    throw new Error(
      `Invalid state transition for ${positionId}: ${pos.state} → ${newState}`
    );
  }

  const updated: PositionSnapshot = { ...pos, state: newState };
  await updatePosition(updated);

  logInfo(`State transition: ${pos.state} → ${newState}`, {
    positionId,
    slot: pos.slot,
    pair: pos.pair,
    timestamp: new Date().toISOString(),
  });
}

// ── OPEN POSITION ────────────────────────────────────────────────

export interface OpenPositionParams {
  slot: 'PAIR_1' | 'PAIR_2';
  pair: ScanResultEntry;
  regime: MarketRegime;
  shape: string;
  bins: number;
  binStep: number;
  centerBin: number;
  binLower: number;
  binUpper: number;
  entryUsd: Decimal;
  entryAmountA: Decimal;
  entryAmountB: Decimal;
  entryPriceA: Decimal;
  entryPriceB: Decimal;
  txidOpen: string;
}

/**
 * Open a new position. Full flow:
 * 1. Acquire mutex
 * 2. Validate state = IDLE
 * 3. Set state = OPENING
 * 4. Submit TX (mocked for now)
 * 5. On confirm → ACTIVE
 * 6. Save state
 */
export async function openPosition(params: OpenPositionParams): Promise<PositionSnapshot> {
  const { slot, pair, shape, bins, binStep, centerBin, binLower, binUpper } = params;
  const mutexKey = slot;

  // Check if mutex is locked
  if (isMutexLocked(mutexKey)) {
    logWarn('openPosition: previous cycle still running', { slot });
    throw new Error(`Mutex locked for ${slot}`);
  }

  const mutex = getMutex(mutexKey);
  const release = await mutex.acquire();

  try {
    // 1. Validate slot is available
    const available = await isSlotAvailable(slot);
    if (!available) {
      throw new Error(`Slot ${slot} is not available`);
    }

    // 2. Validate active positions < 2
    const activeCount = await countActivePositions();
    if (activeCount >= CONFIG.maxPositions) {
      throw new Error(`Max positions (${CONFIG.maxPositions}) reached`);
    }

    // 3. Create position with OPENING state
    const positionId = randomUUID();
    const now = new Date().toISOString();

    const position: PositionSnapshot = {
      positionId,
      slot,
      state: 'OPENING',
      pair: pair.pair,
      mintA: pair.mintA,
      mintB: pair.mintB,
      tier: pair.tier,
      verificationStatus: pair.verificationStatus,
      shape: shape as LiquidityShape,
      bins,
      binStep,
      centerBin,
      binLower,
      binUpper,
      entryUsd: params.entryUsd,
      entryAmountA: params.entryAmountA,
      entryAmountB: params.entryAmountB,
      entryPriceA: params.entryPriceA,
      entryPriceB: params.entryPriceB,
      openedAt: now,
      lastVerifiedAt: now,
      txidOpen: params.txidOpen,
      thresholdUsed: pair.thresholdUsed,
      aprAtEntry: pair.estimatedApr,
      outOfRangeSince: null,
      lastRebalancedAt: null,
      accumulatedFeesUsd: new Decimal(0),
      totalGasSpentUsd: new Decimal(0),
    };

    // Save OPENING state
    await updatePosition(position);
    logInfo('Position OPENING', { positionId, slot, pair: pair.pair });

    // 4. Simulate TX confirmation (in real impl, this would be confirmTransaction())
    // For now, we transition directly to ACTIVE
    // In production: await confirmTransaction(txidOpen, CONFIG.confirmTimeoutMs);

    // 5. Transition to ACTIVE
    const activePosition: PositionSnapshot = { ...position, state: 'ACTIVE' };
    await updatePosition(activePosition);
    logInfo('Position ACTIVE', { positionId, slot, pair: pair.pair, txid: params.txidOpen });

    return activePosition;
  } catch (error) {
    logError('openPosition: failed', {
      slot,
      pair: pair.pair,
      error: error instanceof Error ? error.message : String(error),
    });
    // Rollback to IDLE
    try {
      const existing = await getPositionsBySlot(slot);
      if (existing && existing.state === 'OPENING') {
        await transitionState(existing.positionId, 'IDLE');
      }
    } catch (rollbackError) {
      logError('openPosition: rollback failed', { error: String(rollbackError) });
    }
    throw error;
  } finally {
    release();
  }
}

// ── MONITOR POSITION ─────────────────────────────────────────────

export interface MonitorPositionResult {
  position: PositionSnapshot;
  isInRange: boolean;
  ilPct: Decimal | null;
  binsDrift: number;
  currentApr: Decimal | null;
  activeBin: number;
  actions: string[];
}

/**
 * Monitor a single position. Called every 5 min (3 min for VOLATILE).
 */
export async function monitorPosition(positionId: string): Promise<MonitorPositionResult> {
  const actions: string[] = [];

  const pos = await getPosition(positionId);
  if (!pos) {
    throw new Error(`monitorPosition: position ${positionId} not found`);
  }

  const mutexKey = pos.slot;

  // 1. Check mutex
  if (isMutexLocked(mutexKey)) {
    logWarn('monitorPosition: previous cycle still running', { positionId, slot: pos.slot });
    return {
      position: pos,
      isInRange: false,
      ilPct: null,
      binsDrift: 0,
      currentApr: null,
      activeBin: 0,
      actions: ['SKIPPED_MUTEX_CONFLICT'],
    };
  }

  const mutex = getMutex(mutexKey);
  const release = await mutex.acquire();

  try {
    // 2. Validate state
    if (pos.state !== 'ACTIVE' && pos.state !== 'OUT_OF_RANGE') {
      logDebug('monitorPosition: position not active/oor, skipping', {
        positionId,
        state: pos.state,
      });
      return {
        position: pos,
        isInRange: false,
        ilPct: null,
        binsDrift: 0,
        currentApr: null,
        activeBin: 0,
        actions: ['SKIPPED_WRONG_STATE'],
      };
    }

    // 3. Fetch active bin (mock — in real impl, fetch from Meteora SDK)
    // For simulation, we estimate active bin based on price drift
    const activeBin = pos.centerBin + Math.floor(Math.random() * 6) - 3; // Simulate drift

    if (!Number.isFinite(activeBin)) {
      logWarn('monitorPosition: invalid active bin', { positionId, activeBin });
      return {
        position: pos,
        isInRange: false,
        ilPct: null,
        binsDrift: 0,
        currentApr: null,
        activeBin: 0,
        actions: ['SKIPPED_INVALID_BIN'],
      };
    }

    // 4. Calculate is_in_range
    const isInRange = activeBin >= pos.binLower && activeBin <= pos.binUpper;

    // 5. Calculate bins drift
    const binsDrift = calculateBinsDrift(activeBin, pos.centerBin);

    // 6. Calculate IL
    // Fetch current prices
    const { fetchPrices } = await import('@/api/jupiter');
    const prices = await fetchPrices([pos.mintA, pos.mintB]);
    const currentPriceA = prices.get(pos.mintA)?.price ?? pos.entryPriceA;
    const currentPriceB = prices.get(pos.mintB)?.price ?? pos.entryPriceB;

    const hodlValue = pos.entryAmountA.times(currentPriceA).plus(
      pos.entryAmountB.times(currentPriceB)
    );
    // Estimate current LP value (simplified — in real impl, use Meteora SDK)
    const currentValue = hodlValue.times(0.985); // Simulate 1.5% IL

    const ilPct = calculateIlPct(currentValue, hodlValue);

    // 7. Fetch accumulated fees (mock)
    const feesEarned = pos.accumulatedFeesUsd.plus(new Decimal(Math.random() * 0.3));

    // 8. Calculate current APR
    const { fetchPoolByAddress } = await import('@/api/meteora');
    // Use pair as pool address proxy
    const poolData = await fetchPoolByAddress(pos.pair);
    let currentApr: Decimal | null = null;
    if (poolData) {
      currentApr = calculateApr(new Decimal(poolData.fee24h), new Decimal(poolData.tvl));
    }

    // 9. State transitions based on conditions
    let newState = pos.state;

    // Transition: ACTIVE → OUT_OF_RANGE
    if (pos.state === 'ACTIVE' && !isInRange) {
      newState = 'OUT_OF_RANGE';
      await transitionState(positionId, 'OUT_OF_RANGE');
      actions.push('TRANSITIONED_OUT_OF_RANGE');
    }

    // Transition: OUT_OF_RANGE → ACTIVE (back in range)
    if (pos.state === 'OUT_OF_RANGE' && isInRange) {
      newState = 'ACTIVE';
      await transitionState(positionId, 'ACTIVE');
      actions.push('TRANSITIONED_BACK_IN_RANGE');
    }

    // 10. APR_EXIT_CHECK
    if (currentApr && currentApr.lt(CONFIG.exitAprPct)) {
      logWarn('APR_EXIT_CHECK: APR dropped below exit threshold', {
        positionId,
        currentApr: currentApr.toFixed(2),
        threshold: CONFIG.exitAprPct.toString(),
      });
      actions.push('APR_EXIT_TRIGGERED');

      // Trigger close
      await closePosition(positionId, 'APR_TOO_LOW');
      actions.push('CLOSED');
    }

    // 11. OUT_OF_RANGE_DECISION
    if (newState === 'OUT_OF_RANGE') {
      const decision = await outOfRangeDecision(positionId, ilPct, currentApr, pos);
      actions.push(`OOR_DECISION_${decision.action}`);

      if (decision.action === 'CLOSE') {
        await closePosition(positionId, 'IL_STOP_LOSS');
        actions.push('CLOSED');
      } else if (decision.action === 'REBALANCE_SAME_PAIR' || decision.action === 'REBALANCE_NEW_PAIR' || decision.action === 'DEGRADED_REBALANCE') {
        // Trigger rebalance
        await rebalancePosition(positionId, decision.targetPair);
        actions.push('REBALANCED');
      }
    }

    // 12. REBALANCE_TRIGGER (in-range)
    if (isInRange && ilPct) {
      const ilThreshold = pos.tier === 'TIER1' ? CONFIG.ilTier1Threshold : CONFIG.ilTier2Threshold;
      if (ilPct.lte(ilThreshold)) {
        logWarn('REBALANCE_TRIGGER: IL threshold breached', {
          positionId,
          ilPct: ilPct.toFixed(2),
          threshold: ilThreshold.toString(),
        });
        actions.push('IL_REBALANCE_TRIGGERED');
        await rebalancePosition(positionId);
        actions.push('REBALANCED');
      }

      if (binsDrift >= CONFIG.rebalanceDriftThreshold) {
        logWarn('REBALANCE_TRIGGER: bins drift too high', {
          positionId,
          binsDrift,
          threshold: CONFIG.rebalanceDriftThreshold,
        });
        actions.push('DRIFT_REBALANCE_TRIGGERED');
        await rebalancePosition(positionId);
        actions.push('REBALANCED');
      }
    }

    // 13. Save updated position state
    const updated: PositionSnapshot = {
      ...pos,
      state: newState,
      accumulatedFeesUsd: feesEarned,
      // Update outOfRangeSince
      outOfRangeSince: newState === 'OUT_OF_RANGE' && !pos.outOfRangeSince
        ? new Date().toISOString()
        : newState === 'ACTIVE'
        ? null
        : pos.outOfRangeSince,
    };
    await updatePosition(updated);

    return {
      position: updated,
      isInRange,
      ilPct,
      binsDrift,
      currentApr,
      activeBin,
      actions,
    };
  } catch (error) {
    logError('monitorPosition: error', {
      positionId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    release();
  }
}

// ── OUT OF RANGE DECISION ────────────────────────────────────────

/**
 * Make a decision when position is out of range.
 */
export async function outOfRangeDecision(
  positionId: string,
  ilPct: Decimal | null,
  currentApr: Decimal | null,
  pos: PositionSnapshot
): Promise<OutOfRangeDecision> {
  try {
    // STEP 0: Guard — must be OUT_OF_RANGE
    if (pos.state !== 'OUT_OF_RANGE') {
      logError('outOfRangeDecision: wrong state', { positionId, state: pos.state });
      return { action: 'WAIT', reason: 'Position is not OUT_OF_RANGE' };
    }

    // Set outOfRangeSince if not set
    if (!pos.outOfRangeSince) {
      const updated = { ...pos, outOfRangeSince: new Date().toISOString() };
      await updatePosition(updated);
    }

    const oorDuration = pos.outOfRangeSince
      ? Date.now() - new Date(pos.outOfRangeSince).getTime()
      : 0;

    // STEP 1: Check trending
    const { detectRegime } = await import('@/modules/strategyEngine');
    const regime = await detectRegime(pos.mintA, pos.mintB);

    if (regime === 'TRENDING') {
      if (oorDuration > CONFIG.oorMaxWaitMs) {
        logCrit('outOfRangeDecision: trending timeout, closing position', { positionId });
        return { action: 'CLOSE', reason: 'Trending + OOR > 30 min (IL protection)' };
      }
      logInfo('outOfRangeDecision: waiting for trend to end', { positionId });
      return { action: 'WAIT', reason: 'Waiting for trend to end' };
    }

    // STEP 2: Price crash check (> 20% from entry)
    const priceCrashThreshold = CONFIG.priceCrashPct.abs();
    if (ilPct && ilPct.abs().gte(priceCrashThreshold)) {
      logCrit('outOfRangeDecision: PRICE CRASH detected', {
        positionId,
        ilPct: ilPct.toFixed(2),
      });
      return { action: 'CLOSE', reason: `Price crash: IL ${ilPct.toFixed(2)}%` };
    }

    // STEP 3: IL stop loss
    if (ilPct && ilPct.lte(CONFIG.ilStopLoss)) {
      logCrit('outOfRangeDecision: IL STOP LOSS triggered', {
        positionId,
        ilPct: ilPct.toFixed(2),
      });
      return { action: 'CLOSE', reason: `IL stop loss: ${ilPct.toFixed(2)}%` };
    }

    // STEP 4: Check if pair still in top 2
    // Read scan cache
    try {
      const fs = await import('fs/promises');
      const cacheRaw = await fs.readFile(CONFIG.scanCachePath, 'utf-8');
      const cache = JSON.parse(cacheRaw);
      const stillTop2 = cache.topPairs?.some(
        (p: { pair: string }) => p.pair === pos.pair
      );

      if (stillTop2 && currentApr && currentApr.gte(CONFIG.exitAprPct)) {
        // STEP 4a: Rebalance same pair if cost-benefit is good
        const gasCost = new Decimal(0.01); // Estimate gas cost
        const expectedFee24h = pos.entryUsd.times(currentApr.dividedBy(100)).dividedBy(365);
        if (expectedFee24h.gte(gasCost.times(CONFIG.rebalanceFeeMultiplier))) {
          return { action: 'REBALANCE_SAME_PAIR', reason: 'Cost-benefit favorable for same-pair rebalance' };
        }
        return { action: 'WAIT', reason: 'Cost-benefit not favorable yet' };
      }

      // STEP 5: Find replacement pair
      const replacement = cache.topPairs?.find(
        (p: { pair: string; estimatedApr: string }) =>
          p.pair !== pos.pair && new Decimal(p.estimatedApr).gte(CONFIG.minAprPct)
      );

      if (replacement) {
        // Parse the serialized Decimal back
        const parsedApr = new Decimal(replacement.estimatedApr);
        return {
          action: 'REBALANCE_NEW_PAIR',
          reason: `Better pair available: ${replacement.pair} with APR ${parsedApr.toFixed(0)}%`,
          targetPair: {
            ...replacement,
            estimatedApr: parsedApr,
            volumeTvlRatio: new Decimal(replacement.volumeTvlRatio),
            feeStabilityScore: new Decimal(replacement.feeStabilityScore),
            volume24h: new Decimal(replacement.volume24h),
            tvl: new Decimal(replacement.tvl),
            fee24h: new Decimal(replacement.fee24h),
            pairScore: new Decimal(replacement.pairScore),
          },
        };
      }

      // No replacement available
      return {
        action: 'DEGRADED_REBALANCE',
        reason: 'No replacement pair available, rebalancing in place',
      };
    } catch (error) {
      logWarn('outOfRangeDecision: error reading scan cache', { error: String(error) });
      return { action: 'DEGRADED_REBALANCE', reason: 'Scan cache unavailable' };
    }
  } catch (error) {
    logError('outOfRangeDecision: unexpected error', { positionId, error: String(error) });
    return { action: 'WAIT', reason: `Error: ${String(error)}` };
  }
}

// ── REBALANCE POSITION ──────────────────────────────────────────

/**
 * Rebalance a position.
 * 1. Claim fees
 * 2. Remove liquidity
 * 3. Open new position (same or different pair)
 */
export async function rebalancePosition(
  positionId: string,
  targetPair?: ScanResultEntry
): Promise<void> {
  const pos = await getPosition(positionId);
  if (!pos) {
    throw new Error(`rebalancePosition: position ${positionId} not found`);
  }

  const mutex = getMutex(pos.slot);
  const release = await mutex.acquire();

  try {
    // 1. Transition to REBALANCING
    await transitionState(positionId, 'REBALANCING');

    // 2. Claim fees (mock)
    logInfo('rebalancePosition: claiming fees', { positionId });

    // 3. Remove liquidity (mock)
    logInfo('rebalancePosition: removing liquidity', { positionId });

    // 4. If target pair provided, close and open new
    if (targetPair) {
      // Close current
      await transitionState(positionId, 'CLOSING');
      await transitionState(positionId, 'CLOSED');

      // Open new position in same slot
      const { determineStrategy } = await import('@/modules/strategyEngine');
      const strategy = await determineStrategy(
        targetPair.mintA,
        targetPair.mintB,
        targetPair.tier
      );

      if (!strategy) {
        logWarn('rebalancePosition: no strategy for target pair, going IDLE');
        await transitionState(positionId, 'IDLE');
        return;
      }

      // Create new position
      const newPosition = await openPosition({
        slot: pos.slot,
        pair: targetPair,
        regime: 'RANGING', // Will be re-detected
        shape: strategy.shape,
        bins: strategy.bins,
        binStep: strategy.binStep,
        centerBin: 0, // Will be set from active bin
        binLower: -Math.floor(strategy.bins / 2),
        binUpper: Math.floor(strategy.bins / 2),
        entryUsd: pos.entryUsd,
        entryAmountA: pos.entryAmountA,
        entryAmountB: pos.entryAmountB,
        entryPriceA: pos.entryPriceA,
        entryPriceB: pos.entryPriceB,
        txidOpen: `mock-txid-${Date.now()}`,
      });

      logInfo('rebalancePosition: opened new position', {
        oldPositionId: positionId,
        newPositionId: newPosition.positionId,
        pair: targetPair.pair,
      });
    } else {
      // Same pair rebalance — just transition back to ACTIVE
      // In real impl, would adjust bin range
      await transitionState(positionId, 'ACTIVE');
      logInfo('rebalancePosition: same-pair rebalance complete', { positionId });
    }
  } catch (error) {
    logError('rebalancePosition: failed', {
      positionId,
      error: error instanceof Error ? error.message : String(error),
    });

    // Rollback to ACTIVE
    try {
      const current = await getPosition(positionId);
      if (current && current.state === 'REBALANCING') {
        await transitionState(positionId, 'ACTIVE');
      }
    } catch (rollbackError) {
      logError('rebalancePosition: rollback failed', { error: String(rollbackError) });
    }

    throw error;
  } finally {
    release();
  }
}

// ── CLOSE POSITION ───────────────────────────────────────────────

/**
 * Close a position completely.
 * 1. Claim all fees
 * 2. Remove all liquidity
 * 3. Calculate P&L
 * 4. Update circuit breaker
 * 5. Go to CLOSED → IDLE
 */
export async function closePosition(
  positionId: string,
  reason: CloseReason
): Promise<void> {
  const pos = await getPosition(positionId);
  if (!pos) {
    throw new Error(`closePosition: position ${positionId} not found`);
  }

  const mutex = getMutex(pos.slot);
  const release = await mutex.acquire();

  try {
    logInfo(`closePosition: initiating (${reason})`, { positionId, slot: pos.slot, pair: pos.pair });

    // 1. Transition to CLOSING
    await transitionState(positionId, 'CLOSING');

    // 2. Claim fees (mock)
    const feesEarned = pos.accumulatedFeesUsd;

    // 3. Remove liquidity (mock)
    // In real impl: await removeLiquidity(...);

    // 4. Calculate P&L
    const gasCost = new Decimal(0.5); // Mock gas cost
    const netPnl = feesEarned.minus(gasCost);

    logInfo('closePosition: P&L', {
      positionId,
      feesEarned: feesEarned.toFixed(4),
      gasCost: gasCost.toFixed(4),
      netPnl: netPnl.toFixed(4),
    });

    // 5. Update circuit breaker
    const { recordCloseResult } = await import('@/modules/riskGuard');
    await recordCloseResult(netPnl);

    // 6. Transition to CLOSED
    await transitionState(positionId, 'CLOSED');

    // 7. Save final state for audit
    const state = await loadBotState();
    const updatedState = {
      ...state,
      lastPositionClosedAt: new Date().toISOString(),
      totalFeesClaimedUsd: state.totalFeesClaimedUsd.plus(feesEarned),
      totalGasSpentUsd: state.totalGasSpentUsd.plus(gasCost),
    };
    await saveBotState(updatedState);

    // 8. Transition to IDLE for slot reuse
    const closedPos = await getPosition(positionId);
    if (closedPos) {
      const idlePosition: PositionSnapshot = { ...closedPos, state: 'IDLE' };
      await updatePosition(idlePosition);
    }

    logInfo('closePosition: completed', { positionId, reason, netPnl: netPnl.toFixed(4) });
  } catch (error) {
    logError('closePosition: failed', {
      positionId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });

    // Alert operator
    logCrit('closePosition: CRITICAL — cannot close position', {
      positionId,
      reason,
    });

    throw error;
  } finally {
    release();
  }
}

/**
 * Close all positions (for shutdown/emergency).
 */
export async function closeAllPositions(): Promise<void> {
  const activePositions = await getActivePositions();
  logInfo('closeAllPositions: closing all positions', { count: activePositions.length });

  for (const pos of activePositions) {
    try {
      await closePosition(pos.positionId, 'EMERGENCY_EXIT');
    } catch (error) {
      logError('closeAllPositions: failed to close position', {
        positionId: pos.positionId,
        error: String(error),
      });
    }
  }
}
