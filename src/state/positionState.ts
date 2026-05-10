import fs from 'fs/promises';
import path from 'path';
import { Decimal } from 'decimal.js';
import { CONFIG } from '@/config';
import type { PositionSnapshot, PositionState } from '@/types';
import { PositionStateSchema } from '@/utils/validator';
import { logError, logDebug } from '@/utils/logger';

// In-memory cache
let positionCache: Map<string, PositionSnapshot> | null = null;

/** Serialize Decimal fields to strings for JSON */
function serializePosition(pos: PositionSnapshot): Record<string, unknown> {
  return {
    ...pos,
    entryUsd: pos.entryUsd.toString(),
    entryAmountA: pos.entryAmountA.toString(),
    entryAmountB: pos.entryAmountB.toString(),
    entryPriceA: pos.entryPriceA.toString(),
    entryPriceB: pos.entryPriceB.toString(),
    aprAtEntry: pos.aprAtEntry.toString(),
    accumulatedFeesUsd: pos.accumulatedFeesUsd.toString(),
    totalGasSpentUsd: pos.totalGasSpentUsd.toString(),
  };
}

/** Deserialize strings back to Decimals */
function deserializePosition(raw: Record<string, unknown>): PositionSnapshot {
  return {
    ...raw as unknown as PositionSnapshot,
    entryUsd: new Decimal(raw.entryUsd as string),
    entryAmountA: new Decimal(raw.entryAmountA as string),
    entryAmountB: new Decimal(raw.entryAmountB as string),
    entryPriceA: new Decimal(raw.entryPriceA as string),
    entryPriceB: new Decimal(raw.entryPriceB as string),
    aprAtEntry: new Decimal(raw.aprAtEntry as string),
    accumulatedFeesUsd: new Decimal(raw.accumulatedFeesUsd as string),
    totalGasSpentUsd: new Decimal(raw.totalGasSpentUsd as string),
  };
}

/** Read all positions from disk */
export async function loadAllPositions(): Promise<Map<string, PositionSnapshot>> {
  try {
    const data = await fs.readFile(CONFIG.positionsPath, 'utf-8');
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) {
      logError('loadAllPositions: positions.json is not an array, rebuilding');
      return new Map();
    }
    const map = new Map<string, PositionSnapshot>();
    for (const item of parsed) {
      const validated = PositionStateSchema.safeParse(item);
      if (validated.success) {
        map.set(item.positionId, deserializePosition(item));
      } else {
        logError('loadAllPositions: invalid position entry, skipping', {
          positionId: item.positionId,
          errors: validated.error.issues.map((i: { message: string }) => i.message),
        });
      }
    }
    positionCache = map;
    logDebug('loadAllPositions: loaded', { count: map.size });
    return map;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logDebug('loadAllPositions: positions.json not found, starting fresh');
      positionCache = new Map();
      await saveAllPositions(positionCache);
      return positionCache;
    }
    logError('loadAllPositions: unexpected error', { error: String(error) });
    throw error;
  }
}

/** Save all positions to disk (atomic write) */
export async function saveAllPositions(positions: Map<string, PositionSnapshot>): Promise<void> {
  try {
    const serialized = Array.from(positions.values()).map(serializePosition);
    const tempPath = `${CONFIG.positionsPath}.tmp`;
    await fs.mkdir(path.dirname(CONFIG.positionsPath), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(serialized, null, 2), 'utf-8');
    await fs.rename(tempPath, CONFIG.positionsPath);
    positionCache = positions;
    logDebug('saveAllPositions: saved', { count: positions.size });
  } catch (error) {
    logError('saveAllPositions: failed to write', { error: String(error) });
    throw error;
  }
}

/** Get a single position by ID */
export async function getPosition(positionId: string): Promise<PositionSnapshot | undefined> {
  const cache = positionCache ?? await loadAllPositions();
  return cache.get(positionId);
}

/** Update a single position (merge into map and save) */
export async function updatePosition(position: PositionSnapshot): Promise<void> {
  if (!position || !position.positionId) {
    throw new Error('updatePosition: invalid position object');
  }
  const cache = positionCache ?? await loadAllPositions();
  cache.set(position.positionId, position);
  await saveAllPositions(cache);
}

/** Get positions for a specific slot */
export async function getPositionsBySlot(slot: 'PAIR_1' | 'PAIR_2'): Promise<PositionSnapshot | undefined> {
  const cache = positionCache ?? await loadAllPositions();
  for (const pos of cache.values()) {
    if (pos.slot === slot) return pos;
  }
  return undefined;
}

/** Get all active positions (not IDLE or CLOSED) */
export async function getActivePositions(): Promise<PositionSnapshot[]> {
  const cache = positionCache ?? await loadAllPositions();
  return Array.from(cache.values()).filter(
    (p) => p.state !== 'IDLE' && p.state !== 'CLOSED'
  );
}

/** Count active positions */
export async function countActivePositions(): Promise<number> {
  const active = await getActivePositions();
  return active.length;
}

/** Check if a slot is available (IDLE or CLOSED) */
export async function isSlotAvailable(slot: 'PAIR_1' | 'PAIR_2'): Promise<boolean> {
  const pos = await getPositionsBySlot(slot);
  return !pos || pos.state === 'IDLE' || pos.state === 'CLOSED';
}

/** Update just the state field of a position */
export async function updatePositionState(
  positionId: string,
  newState: PositionState
): Promise<void> {
  const pos = await getPosition(positionId);
  if (!pos) {
    throw new Error(`updatePositionState: position ${positionId} not found`);
  }
  // Return a new object with updated state (immutable update)
  const updated: PositionSnapshot = {
    ...pos,
    state: newState,
  };
  await updatePosition(updated);
}

/** Remove a position from disk entirely */
export async function removePosition(positionId: string): Promise<void> {
  const cache = positionCache ?? await loadAllPositions();
  cache.delete(positionId);
  await saveAllPositions(cache);
}
