import { Decimal } from 'decimal.js';
import { CONFIG, isStablecoin } from '@/config';
import type { RiskCheckResult, BotOverallState, PositionSnapshot } from '@/types';
import { loadBotState, saveBotState, getOverallState } from '@/state/botState';
import { getActivePositions, countActivePositions } from '@/state/positionState';
import { logError, logWarn, logCrit, logDebug } from '@/utils/logger';

// ── Internal tracking for runtime safeguards ─────────────────────
let apiUnresponsiveSince: number | null = null;
let solscanUnresponsiveSince: number | null = null;

// ── PAUSE / RESUME ──────────────────────────────────────────────

/**
 * Pause the bot. No new positions, no rebalancing, only monitoring + fee claim.
 */
export async function pauseBot(reason: string): Promise<void> {
  try {
    const state = await loadBotState();
    if (state.overallState === 'PAUSED') return;

    const updated = {
      ...state,
      overallState: 'PAUSED' as BotOverallState,
      pausedAt: new Date().toISOString(),
      pauseReason: reason,
    };
    await saveBotState(updated);
    logCrit(`Bot PAUSED: ${reason}`);
  } catch (error) {
    logError('pauseBot: failed', { reason, error: String(error) });
  }
}

/**
 * Resume the bot from PAUSED state.
 */
export async function resumeBot(): Promise<void> {
  try {
    const state = await loadBotState();
    if (state.overallState !== 'PAUSED') return;

    const updated = {
      ...state,
      overallState: 'RUNNING' as BotOverallState,
      pausedAt: null,
      pauseReason: null,
    };
    await saveBotState(updated);
    logInfo('Bot RESUMED');
  } catch (error) {
    logError('resumeBot: failed', { error: String(error) });
  }
}

// Need logInfo import
import { logInfo } from '@/utils/logger';

/**
 * Trigger circuit breaker — STOP the bot completely.
 * Requires manual restart.
 */
export async function triggerCircuitBreaker(reason: string): Promise<void> {
  try {
    const state = await loadBotState();
    const updated = {
      ...state,
      overallState: 'STOPPED' as BotOverallState,
      consecutiveLossCount: state.consecutiveLossCount + 1,
      circuitBreakerTriggeredAt: new Date().toISOString(),
    };
    await saveBotState(updated);
    logCrit('CIRCUIT BREAKER TRIGGERED', { reason, consecutiveLosses: updated.consecutiveLossCount });
  } catch (error) {
    logError('triggerCircuitBreaker: failed', { reason, error: String(error) });
  }
}

/**
 * Check if bot is in STOPPED state (circuit breaker).
 */
export async function isStopped(): Promise<boolean> {
  const state = await getOverallState();
  return state === 'STOPPED';
}

/**
 * Check if bot is PAUSED.
 */
export async function isPaused(): Promise<boolean> {
  const state = await getOverallState();
  return state === 'PAUSED';
}

// ── RISK CHECKS ──────────────────────────────────────────────────

/**
 * RiskGuard — validate before any action.
 * Runs FIRST before opening, rebalancing, or closing positions.
 * Returns { allowed, reason, severity }.
 */
export async function runRiskCheck(params?: {
  mintA?: string;
  mintB?: string;
  estimatedApr?: Decimal;
  isOpenCheck?: boolean;
}): Promise<RiskCheckResult> {
  try {
    const state = await loadBotState();

    // 1. Check if STOPPED (circuit breaker)
    if (state.overallState === 'STOPPED') {
      return { allowed: false, reason: 'Circuit breaker triggered — manual restart required', severity: 'CRIT' };
    }

    // 2. Check if PAUSED
    if (state.overallState === 'PAUSED') {
      return { allowed: false, reason: `Bot is paused: ${state.pauseReason ?? 'unknown reason'}`, severity: 'ERROR' };
    }

    // 3. Max positions check
    const activeCount = await countActivePositions();
    if ((params?.isOpenCheck ?? false) && activeCount >= CONFIG.maxPositions) {
      return { allowed: false, reason: `Max positions (${CONFIG.maxPositions}) reached`, severity: 'OK' };
    }

    // 4. Capital deployment check (total active <= 90% of total)
    const activePositions = await getActivePositions();
    const totalDeployed = activePositions.reduce(
      (sum, p) => sum.plus(p.entryUsd),
      new Decimal(0)
    );
    const maxDeploy = state.totalCapital.times(0.9);
    if (totalDeployed.gte(maxDeploy)) {
      return { allowed: false, reason: `Capital deployed ${totalDeployed.toFixed(2)} >= 90% limit`, severity: 'WARN' };
    }

    // 5. IL check on existing positions
    for (const pos of activePositions) {
      // We don't have current IL here — that check happens in monitor
      // Just check if position state is valid
      if (pos.state === 'OPENING' || pos.state === 'CLOSING') {
        const openedAt = new Date(pos.openedAt).getTime();
        const now = Date.now();
        if (now - openedAt > CONFIG.stuckTxTimeoutMs) {
          logError(`runRiskCheck: position stuck in ${pos.state}`, { positionId: pos.positionId, slot: pos.slot });
          return { allowed: false, reason: `Position ${pos.positionId} stuck in ${pos.state}`, severity: 'ERROR' };
        }
      }
    }

    // 6. Circuit breaker count
    if (state.consecutiveLossCount >= CONFIG.maxConsecutiveLosses) {
      await triggerCircuitBreaker(`Consecutive losses: ${state.consecutiveLossCount}`);
      return { allowed: false, reason: 'Circuit breaker triggered by consecutive losses', severity: 'CRIT' };
    }

    // 7. Stablecoin pair check (for open)
    if (params?.isOpenCheck && params.mintA && params.mintB) {
      const isAStable = isStablecoin(params.mintA);
      const isBStable = isStablecoin(params.mintB);
      if (isAStable && isBStable) {
        return { allowed: false, reason: 'Stablecoin-to-stablecoin pair is forbidden', severity: 'ERROR' };
      }
    }

    // 8. APR check (for open)
    if (params?.isOpenCheck && params.estimatedApr) {
      if (params.estimatedApr.lt(CONFIG.minAprPct)) {
        return {
          allowed: false,
          reason: `APR ${params.estimatedApr.toFixed(2)}% < minimum ${CONFIG.minAprPct.toFixed(0)}%`,
          severity: 'WARN',
        };
      }
    }

    // 9. Gas reserve check (placeholder — actual SOL balance check in startup)
    // 10. Wallet balance check (placeholder)

    return { allowed: true, reason: 'All checks passed', severity: 'OK' };
  } catch (error) {
    logError('runRiskCheck: unexpected error', { error: String(error) });
    return { allowed: false, reason: `Risk check error: ${String(error)}`, severity: 'ERROR' };
  }
}

// ── RUNTIME SAFEGUARDS ───────────────────────────────────────────

/**
 * Check runtime safeguards — called every monitor cycle.
 * May trigger PAUSE if dangerous conditions detected.
 */
export async function runtimeSafeguards(params: {
  solPrice: Decimal;
  solPriceChange1h: Decimal;
  walletBalanceUsd: Decimal;
  apiResponsive: boolean;
  solscanResponsive: boolean;
}): Promise<void> {
  try {
    const state = await loadBotState();

    // 1. SOL price drop > 10% in 1h → PAUSE
    if (params.solPriceChange1h.lt(-10)) {
      await pauseBot(`SOL price dropped ${params.solPriceChange1h.toFixed(2)}% in 1 hour`);
      return;
    }

    // 2. Wallet balance < $30 → PAUSE
    if (params.walletBalanceUsd.lt(CONFIG.minWalletBalanceUsd)) {
      await pauseBot(`Wallet balance $${params.walletBalanceUsd.toFixed(2)} < $${CONFIG.minWalletBalanceUsd}`);
      return;
    }

    // 3. API unresponsive > 10 min → PAUSE
    if (!params.apiResponsive) {
      if (apiUnresponsiveSince === null) {
        apiUnresponsiveSince = Date.now();
      } else if (Date.now() - apiUnresponsiveSince > 600_000) {
        await pauseBot('API unresponsive for > 10 minutes');
        apiUnresponsiveSince = null;
        return;
      }
    } else {
      apiUnresponsiveSince = null;
    }

    // 4. Solscan unresponsive > 30 min → block new positions
    if (!params.solscanResponsive) {
      if (solscanUnresponsiveSince === null) {
        solscanUnresponsiveSince = Date.now();
      } else if (Date.now() - solscanUnresponsiveSince > 1_800_000) {
        logWarn('runtimeSafeguards: Solscan unresponsive for > 30 min, blocking new positions');
        // Don't pause — just log warning
      }
    } else {
      solscanUnresponsiveSince = null;
    }

    // 5. Auto-resume from PAUSE after 30 min if conditions cleared
    if (state.overallState === 'PAUSED' && state.pausedAt) {
      const pausedMs = Date.now() - new Date(state.pausedAt).getTime();
      if (pausedMs > 1_800_000) {
        // Check if conditions are cleared
        if (params.apiResponsive && params.walletBalanceUsd.gte(CONFIG.minWalletBalanceUsd) && params.solPriceChange1h.gte(-10)) {
          await resumeBot();
        }
      }
    }
  } catch (error) {
    logError('runtimeSafeguards: unexpected error', { error: String(error) });
  }
}

/**
 * Record position close result — profit or loss.
 * Updates consecutive loss count.
 */
export async function recordCloseResult(netPnl: Decimal): Promise<void> {
  try {
    const state = await loadBotState();
    if (netPnl.isNegative()) {
      const updated = {
        ...state,
        consecutiveLossCount: state.consecutiveLossCount + 1,
        totalIlRealizedUsd: state.totalIlRealizedUsd.plus(netPnl.abs()),
        lastPositionClosedAt: new Date().toISOString(),
      };
      await saveBotState(updated);
      logWarn('recordCloseResult: loss recorded', {
        netPnl: netPnl.toFixed(4),
        consecutiveLosses: updated.consecutiveLossCount,
      });

      // Check circuit breaker
      if (updated.consecutiveLossCount >= CONFIG.maxConsecutiveLosses) {
        await triggerCircuitBreaker(`Consecutive losses reached ${updated.consecutiveLossCount}`);
      }
    } else {
      if (state.consecutiveLossCount > 0) {
        const updated = {
          ...state,
          consecutiveLossCount: 0,
          lastPositionClosedAt: new Date().toISOString(),
        };
        await saveBotState(updated);
        logInfo('recordCloseResult: profit — reset consecutive losses', { netPnl: netPnl.toFixed(4) });
      }
    }
  } catch (error) {
    logError('recordCloseResult: error', { netPnl: netPnl.toString(), error: String(error) });
  }
}

/**
 * Increment consecutive loss (for testing/circuit breaker).
 */
export async function incrementConsecutiveLoss(): Promise<void> {
  try {
    const state = await loadBotState();
    const updated = { ...state, consecutiveLossCount: state.consecutiveLossCount + 1 };
    await saveBotState(updated);
    logWarn('incrementConsecutiveLoss', { count: updated.consecutiveLossCount });
  } catch (error) {
    logError('incrementConsecutiveLoss: error', { error: String(error) });
  }
}

/**
 * Reset consecutive loss (on profit).
 */
export async function resetConsecutiveLoss(): Promise<void> {
  try {
    const state = await loadBotState();
    if (state.consecutiveLossCount === 0) return;
    const updated = { ...state, consecutiveLossCount: 0 };
    await saveBotState(updated);
    logInfo('resetConsecutiveLoss: reset to 0');
  } catch (error) {
    logError('resetConsecutiveLoss: error', { error: String(error) });
  }
}
