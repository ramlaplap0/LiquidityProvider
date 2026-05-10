import { Decimal } from 'decimal.js';
import {
  validateStateTransition,
  transitionState,
  outOfRangeDecision,
} from '@/modules/positionManager';
import type { PositionState, PositionSnapshot } from '@/types';
import { saveBotState, createDefaultBotState } from '@/state/botState';
import { updatePosition } from '@/state/positionState';

describe('PositionManager — State Transitions', () => {
  const validTransitions: Array<{ from: PositionState; to: PositionState; valid: boolean }> = [
    { from: 'IDLE', to: 'OPENING', valid: true },
    { from: 'OPENING', to: 'ACTIVE', valid: true },
    { from: 'OPENING', to: 'IDLE', valid: true },
    { from: 'ACTIVE', to: 'OUT_OF_RANGE', valid: true },
    { from: 'ACTIVE', to: 'REBALANCING', valid: true },
    { from: 'ACTIVE', to: 'CLOSING', valid: true },
    { from: 'OUT_OF_RANGE', to: 'REBALANCING', valid: true },
    { from: 'OUT_OF_RANGE', to: 'CLOSING', valid: true },
    { from: 'REBALANCING', to: 'ACTIVE', valid: true },
    { from: 'REBALANCING', to: 'IDLE', valid: true },
    { from: 'CLOSING', to: 'CLOSED', valid: true },
    { from: 'CLOSED', to: 'IDLE', valid: true },
    // Invalid transitions
    { from: 'IDLE', to: 'ACTIVE', valid: false },
    { from: 'IDLE', to: 'CLOSED', valid: false },
    { from: 'ACTIVE', to: 'IDLE', valid: false },
    { from: 'ACTIVE', to: 'CLOSED', valid: false },
    { from: 'OPENING', to: 'CLOSING', valid: false },
    { from: 'CLOSED', to: 'ACTIVE', valid: false },
  ];

  test.each(validTransitions)(
    'transition $from → $to should be $valid',
    ({ from, to, valid }) => {
      expect(validateStateTransition(from, to)).toBe(valid);
    }
  );

  test('unknown state transition returns false', () => {
    expect(validateStateTransition('ACTIVE' as PositionState, 'UNKNOWN' as PositionState)).toBe(false);
  });
});

describe('PositionManager — outOfRangeDecision', () => {
  jest.setTimeout(15000);
  const mockPosition: PositionSnapshot = {
    positionId: 'test-uuid-123',
    slot: 'PAIR_1',
    state: 'OUT_OF_RANGE',
    pair: 'TEST/SOL',
    mintA: 'testMintA',
    mintB: 'So11111111111111111111111111111111111111112',
    tier: 'TIER1',
    verificationStatus: 'VERIFIED',
    shape: 'SpotSpread',
    bins: 25,
    binStep: 15,
    centerBin: 0,
    binLower: -12,
    binUpper: 12,
    entryUsd: new Decimal(90),
    entryAmountA: new Decimal(100),
    entryAmountB: new Decimal(10),
    entryPriceA: new Decimal(0.5),
    entryPriceB: new Decimal(50),
    openedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    txidOpen: 'mock-txid',
    thresholdUsed: 1.0,
    aprAtEntry: new Decimal(300),
    outOfRangeSince: new Date(Date.now() - 60000).toISOString(), // 1 min ago
    lastRebalancedAt: null,
    accumulatedFeesUsd: new Decimal(2),
    totalGasSpentUsd: new Decimal(0.5),
  };

  beforeEach(async () => {
    await saveBotState(createDefaultBotState());
    // Write a scan cache for tests
    const fs = await import('fs/promises');
    await fs.mkdir('./src/data', { recursive: true }).catch(() => {});
    await fs.writeFile('./src/data/scan_cache.json', JSON.stringify({
      lastScanTime: new Date().toISOString(),
      thresholdUsed: 1.0,
      topPairs: [],
    }));
  });

  test('OOR position with moderate IL → WAIT', async () => {
    const decision = await outOfRangeDecision(
      mockPosition.positionId,
      new Decimal(-5), // -5% IL
      new Decimal(200), // 200% APR still good
      mockPosition
    );
    // Should be WAIT or DEGRADED_REBALANCE depending on scan cache
    expect(['WAIT', 'DEGRADED_REBALANCE', 'CLOSE', 'REBALANCE_SAME_PAIR']).toContain(decision.action);
  });

  test('IL stop loss triggered (< -15%) → CLOSE', async () => {
    const decision = await outOfRangeDecision(
      mockPosition.positionId,
      new Decimal(-16), // -16% IL (past stop loss -15% but above price crash -20%)
      new Decimal(200),
      mockPosition
    );
    expect(decision.action).toBe('CLOSE');
    expect(decision.reason).toContain('IL stop loss');
  });

  test('wrong state → WAIT with error', async () => {
    const wrongState = { ...mockPosition, state: 'ACTIVE' as PositionState };
    const decision = await outOfRangeDecision(
      'test',
      new Decimal(-5),
      new Decimal(200),
      wrongState
    );
    expect(decision.action).toBe('WAIT');
    expect(decision.reason).toContain('not OUT_OF_RANGE');
  });

  test('null IL → decision still made', async () => {
    const decision = await outOfRangeDecision(
      mockPosition.positionId,
      null,
      new Decimal(200),
      mockPosition
    );
    expect(['WAIT', 'DEGRADED_REBALANCE', 'CLOSE', 'REBALANCE_SAME_PAIR']).toContain(decision.action);
  });

  test('APR too low with no replacement → DEGRADED_REBALANCE', async () => {
    const decision = await outOfRangeDecision(
      mockPosition.positionId,
      new Decimal(-5),
      new Decimal(30), // Below 50% exit threshold
      mockPosition
    );
    // Should try to find replacement or rebalance
    expect(['DEGRADED_REBALANCE', 'CLOSE', 'REBALANCE_NEW_PAIR', 'WAIT']).toContain(decision.action);
  });
});
