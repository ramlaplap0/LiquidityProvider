import { Decimal } from 'decimal.js';
import { CONFIG } from '@/config';
import type { PositionSnapshot } from '@/types';
import { getActivePositions, updatePosition } from '@/state/positionState';
import { loadBotState, saveBotState } from '@/state/botState';
import { getMutex } from '@/utils/mutex';
import { logInfo, logWarn, logError, logDebug } from '@/utils/logger';

// ── FEE CLAIM ────────────────────────────────────────────────────

/**
 * Check if a position has claimable fees and claim them.
 * Returns fees claimed in USD.
 */
export async function checkAndClaimFees(positionId: string): Promise<Decimal> {
  try {
    const positions = await getActivePositions();
    const pos = positions.find((p) => p.positionId === positionId);

    if (!pos) {
      logDebug('checkAndClaimFees: position not found or not active', { positionId });
      return new Decimal(0);
    }

    // Only claim if ACTIVE and in-range
    if (pos.state !== 'ACTIVE') {
      logDebug('checkAndClaimFees: position not ACTIVE', { positionId, state: pos.state });
      return new Decimal(0);
    }

    // Check if fees exceed minimum claim threshold
    // In real impl, fetch actual fees from Meteora SDK
    const claimableFees = new Decimal(Math.random() * 0.8); // Mock accumulated fees

    if (claimableFees.lt(CONFIG.minClaimUsd)) {
      logDebug('checkAndClaimFees: fees below threshold', {
        positionId,
        claimable: claimableFees.toFixed(4),
        threshold: CONFIG.minClaimUsd.toString(),
      });
      return new Decimal(0);
    }

    // Claim fees (mock)
    logInfo('checkAndClaimFees: claiming fees', {
      positionId,
      amount: claimableFees.toFixed(4),
    });

    // Update position fees
    const updated: PositionSnapshot = {
      ...pos,
      accumulatedFeesUsd: pos.accumulatedFeesUsd.plus(claimableFees),
    };
    await updatePosition(updated);

    // Update bot state
    const state = await loadBotState();
    const updatedState = {
      ...state,
      totalFeesClaimedUsd: state.totalFeesClaimedUsd.plus(claimableFees),
      feeReserveUsd: state.feeReserveUsd.plus(claimableFees),
    };
    await saveBotState(updatedState);

    logInfo('checkAndClaimFees: claimed', {
      positionId,
      amount: claimableFees.toFixed(4),
    });

    return claimableFees;
  } catch (error) {
    logError('checkAndClaimFees: error', { positionId, error: String(error) });
    return new Decimal(0);
  }
}

// ── AUTO-COMPOUND ────────────────────────────────────────────────

/**
 * Auto-compound fee reserve into active in-range positions.
 * Rules:
 * - If fee_reserve > $5 AND positions in-range → compound 50/50 to both
 * - If only 1 in-range → compound all to that one
 * - If no in-range → keep in reserve
 */
export async function autoCompound(): Promise<void> {
  try {
    const state = await loadBotState();

    if (state.feeReserveUsd.lt(CONFIG.compoundThresholdUsd)) {
      logDebug('autoCompound: fee reserve below threshold', {
        reserve: state.feeReserveUsd.toFixed(4),
        threshold: CONFIG.compoundThresholdUsd.toString(),
      });
      return;
    }

    // Find in-range active positions
    const activePositions = await getActivePositions();
    const inRangePositions = activePositions.filter((p) => p.state === 'ACTIVE');

    if (inRangePositions.length === 0) {
      // Check if large idle reserve
      if (state.feeReserveUsd.gte(CONFIG.feeReserveWarnUsd)) {
        logWarn('autoCompound: large idle fee reserve with no in-range positions', {
          reserve: state.feeReserveUsd.toFixed(4),
        });
      }
      return;
    }

    // Calculate compound amount
    const compoundAmount = state.feeReserveUsd.times(0.5); // Compound 50% of reserve
    const perPositionAmount = compoundAmount.dividedBy(inRangePositions.length);

    logInfo('autoCompound: compounding fees', {
      reserve: state.feeReserveUsd.toFixed(4),
      compoundAmount: compoundAmount.toFixed(4),
      inRangeCount: inRangePositions.length,
      perPosition: perPositionAmount.toFixed(4),
    });

    for (const pos of inRangePositions) {
      try {
        // Add to position entry value (reinvest)
        const updated: PositionSnapshot = {
          ...pos,
          entryUsd: pos.entryUsd.plus(perPositionAmount),
          accumulatedFeesUsd: pos.accumulatedFeesUsd.plus(perPositionAmount),
        };
        await updatePosition(updated);

        logDebug('autoCompound: compounded to position', {
          positionId: pos.positionId,
          amount: perPositionAmount.toFixed(4),
        });
      } catch (error) {
        logError('autoCompound: failed to compound to position', {
          positionId: pos.positionId,
          error: String(error),
        });
        // Save to reserve instead
      }
    }

    // Reduce fee reserve
    const newReserve = state.feeReserveUsd.minus(compoundAmount);
    const updatedState = {
      ...state,
      feeReserveUsd: Decimal.max(0, newReserve),
    };
    await saveBotState(updatedState);

    logInfo('autoCompound: completed', {
      compounded: compoundAmount.toFixed(4),
      remainingReserve: updatedState.feeReserveUsd.toFixed(4),
    });
  } catch (error) {
    logError('autoCompound: error', { error: String(error) });
  }
}

// ── BATCH CLAIM ALL ──────────────────────────────────────────────

/**
 * Claim fees from all active positions.
 */
export async function claimAllFees(): Promise<Decimal> {
  try {
    const activePositions = await getActivePositions();
    let totalClaimed = new Decimal(0);

    logInfo('claimAllFees: claiming from all positions', { count: activePositions.length });

    for (const pos of activePositions) {
      try {
        const claimed = await checkAndClaimFees(pos.positionId);
        totalClaimed = totalClaimed.plus(claimed);
      } catch (error) {
        logError('claimAllFees: failed for position', {
          positionId: pos.positionId,
          error: String(error),
        });
      }
    }

    logInfo('claimAllFees: total claimed', { total: totalClaimed.toFixed(4) });
    return totalClaimed;
  } catch (error) {
    logError('claimAllFees: error', { error: String(error) });
    return new Decimal(0);
  }
}

// ── MONITORING ───────────────────────────────────────────────────

/**
 * Run fee harvester cycle:
 * 1. Claim fees from all active positions
 * 2. Auto-compound if threshold met
 */
export async function runFeeHarvesterCycle(): Promise<{
  totalClaimed: Decimal;
  feeReserve: Decimal;
}> {
  logDebug('=== FEE HARVESTER CYCLE ===');

  // 1. Claim all fees
  const totalClaimed = await claimAllFees();

  // 2. Auto-compound
  await autoCompound();

  // 3. Get final state
  const state = await loadBotState();

  return {
    totalClaimed,
    feeReserve: state.feeReserveUsd,
  };
}
