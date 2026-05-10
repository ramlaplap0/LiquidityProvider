import fs from 'fs/promises';
import path from 'path';
import { Decimal } from 'decimal.js';
import { CONFIG } from '@/config';
import type { BotState, BotOverallState } from '@/types';
import { BotStateSchema } from '@/utils/validator';
import { logError, logDebug } from '@/utils/logger';

// In-memory cache
let botStateCache: BotState | null = null;

/** Serialize Decimal fields to strings */
function serializeBotState(state: BotState): Record<string, unknown> {
  return {
    ...state,
    totalFeesClaimedUsd: state.totalFeesClaimedUsd.toString(),
    totalGasSpentUsd: state.totalGasSpentUsd.toString(),
    totalIlRealizedUsd: state.totalIlRealizedUsd.toString(),
    feeReserveUsd: state.feeReserveUsd.toString(),
    totalCapital: state.totalCapital.toString(),
    pair1Allocation: state.pair1Allocation.toString(),
    pair2Allocation: state.pair2Allocation.toString(),
    gasReserve: state.gasReserve.toString(),
  };
}

/** Deserialize strings back to Decimals */
function deserializeBotState(raw: Record<string, unknown>): BotState {
  return {
    ...raw as unknown as BotState,
    totalFeesClaimedUsd: new Decimal(raw.totalFeesClaimedUsd as string),
    totalGasSpentUsd: new Decimal(raw.totalGasSpentUsd as string),
    totalIlRealizedUsd: new Decimal(raw.totalIlRealizedUsd as string),
    feeReserveUsd: new Decimal(raw.feeReserveUsd as string),
    totalCapital: new Decimal(raw.totalCapital as string),
    pair1Allocation: new Decimal(raw.pair1Allocation as string),
    pair2Allocation: new Decimal(raw.pair2Allocation as string),
    gasReserve: new Decimal(raw.gasReserve as string),
  };
}

/** Load bot state from disk */
export async function loadBotState(): Promise<BotState> {
  try {
    const data = await fs.readFile(CONFIG.botStatePath, 'utf-8');
    const parsed = JSON.parse(data);
    const validated = BotStateSchema.safeParse(parsed);
    if (!validated.success) {
      logError('loadBotState: validation failed, creating default', {
        errors: validated.error.issues.map((i: { message: string }) => i.message),
      });
      return createDefaultBotState();
    }
    botStateCache = deserializeBotState(parsed);
    logDebug('loadBotState: loaded', { state: botStateCache.overallState });
    return botStateCache;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logDebug('loadBotState: bot_state.json not found, creating default');
      const defaultState = createDefaultBotState();
      await saveBotState(defaultState);
      return defaultState;
    }
    logError('loadBotState: unexpected error', { error: String(error) });
    throw error;
  }
}

/** Save bot state to disk (atomic write) */
export async function saveBotState(state: BotState): Promise<void> {
  try {
    const serialized = serializeBotState(state);
    const tempPath = `${CONFIG.botStatePath}.tmp`;
    await fs.mkdir(path.dirname(CONFIG.botStatePath), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(serialized, null, 2), 'utf-8');
    await fs.rename(tempPath, CONFIG.botStatePath);
    botStateCache = state;
    logDebug('saveBotState: saved', { state: state.overallState });
  } catch (error) {
    logError('saveBotState: failed to write', { error: String(error) });
    throw error;
  }
}

/** Create fresh default bot state */
export function createDefaultBotState(): BotState {
  return {
    overallState: 'RUNNING',
    consecutiveLossCount: 0,
    totalFeesClaimedUsd: new Decimal(0),
    totalGasSpentUsd: new Decimal(0),
    totalIlRealizedUsd: new Decimal(0),
    feeReserveUsd: new Decimal(0),
    totalCapital: CONFIG.totalCapital,
    pair1Allocation: CONFIG.pairAllocation,
    pair2Allocation: CONFIG.pairAllocation,
    gasReserve: CONFIG.gasReserve,
    circuitBreakerTriggeredAt: null,
    pausedAt: null,
    pauseReason: null,
    lastPositionClosedAt: null,
  };
}

/** Update just the overall state */
export async function updateOverallState(newState: BotOverallState): Promise<void> {
  const state = botStateCache ?? await loadBotState();
  const updated: BotState = {
    ...state,
    overallState: newState,
    pausedAt: newState === 'PAUSED' ? new Date().toISOString() : state.pausedAt,
  };
  await saveBotState(updated);
}

/** Check current overall state */
export async function getOverallState(): Promise<BotOverallState> {
  const state = botStateCache ?? await loadBotState();
  return state.overallState;
}

/** Update fee reserve */
export async function updateFeeReserve(deltaUsd: Decimal): Promise<void> {
  const state = botStateCache ?? await loadBotState();
  const updated: BotState = {
    ...state,
    feeReserveUsd: state.feeReserveUsd.plus(deltaUsd),
  };
  await saveBotState(updated);
}

/** Increment consecutive loss count */
export async function incrementConsecutiveLoss(): Promise<void> {
  const state = botStateCache ?? await loadBotState();
  const updated: BotState = {
    ...state,
    consecutiveLossCount: state.consecutiveLossCount + 1,
  };
  await saveBotState(updated);
}

/** Reset consecutive loss count (on profit) */
export async function resetConsecutiveLoss(): Promise<void> {
  const state = botStateCache ?? await loadBotState();
  if (state.consecutiveLossCount === 0) return;
  const updated: BotState = { ...state, consecutiveLossCount: 0 };
  await saveBotState(updated);
}
