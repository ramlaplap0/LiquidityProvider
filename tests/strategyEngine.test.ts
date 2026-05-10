import { Decimal } from 'decimal.js';
import {
  calculateVolatility,
  getStrategyForRegime,
  calculateOptimalBinStep,
} from '@/modules/strategyEngine';
import type { MarketRegime, TokenTier } from '@/types';

describe('StrategyEngine — calculateVolatility', () => {
  test('happy path: 5% change', () => {
    const now = new Decimal(105);
    const ago = new Decimal(100);
    const result = calculateVolatility(now, ago);
    expect(result.isFinite()).toBe(true);
    expect(result.toFixed(2)).toBe('5.00');
  });

  test('no change → 0', () => {
    const result = calculateVolatility(new Decimal(100), new Decimal(100));
    expect(result.toFixed(2)).toBe('0.00');
  });

  test('edge case: price_24h_ago = null → NaN', () => {
    const result = calculateVolatility(new Decimal(100), null);
    expect(result.isNaN()).toBe(true);
  });

  test('edge case: price_24h_ago = 0 → NaN', () => {
    const result = calculateVolatility(new Decimal(100), new Decimal(0));
    expect(result.isNaN()).toBe(true);
  });

  test('edge case: price_now = 0 → NaN', () => {
    const result = calculateVolatility(new Decimal(0), new Decimal(100));
    expect(result.isNaN()).toBe(true);
  });

  test('edge case: negative prices', () => {
    const result = calculateVolatility(new Decimal(-100), new Decimal(100));
    expect(result.isFinite()).toBe(true);
    expect(result.toFixed(2)).toBe('200.00');
  });

  test('edge case: very small change', () => {
    const result = calculateVolatility(new Decimal(100.001), new Decimal(100));
    expect(result.toNumber()).toBeGreaterThan(0);
    expect(result.toNumber()).toBeLessThan(1);
  });
});

describe('StrategyEngine — getStrategyForRegime', () => {
  test('STABLE regime → Curve shape', () => {
    const strategy = getStrategyForRegime('STABLE', 'TIER1');
    expect(strategy.shape).toBe('Curve');
    expect(strategy.bins).toBeGreaterThanOrEqual(15);
    expect(strategy.bins).toBeLessThanOrEqual(20);
  });

  test('RANGING regime → SpotSpread shape', () => {
    const strategy = getStrategyForRegime('RANGING', 'TIER1');
    expect(strategy.shape).toBe('SpotSpread');
    expect(strategy.bins).toBeGreaterThanOrEqual(20);
    expect(strategy.bins).toBeLessThanOrEqual(30);
  });

  test('VOLATILE regime → SpotWide shape', () => {
    const strategy = getStrategyForRegime('VOLATILE', 'TIER1');
    expect(strategy.shape).toBe('SpotWide');
    expect(strategy.bins).toBeGreaterThanOrEqual(40);
    expect(strategy.bins).toBeLessThanOrEqual(50);
  });

  test('TRENDING regime → returns shape but bins=0', () => {
    const strategy = getStrategyForRegime('TRENDING', 'TIER1');
    expect(strategy.bins).toBe(0);
  });

  test('REGIME_UNKNOWN → returns shape but bins=0', () => {
    const strategy = getStrategyForRegime('REGIME_UNKNOWN', 'TIER1');
    expect(strategy.bins).toBe(0);
  });

  test('TIER2 gets wider bins', () => {
    const t1 = getStrategyForRegime('RANGING', 'TIER1');
    const t2 = getStrategyForRegime('RANGING', 'TIER2');
    expect(t2.bins).toBeGreaterThanOrEqual(t1.bins);
  });

  test('all regimes return valid binStep > 0 (except TRENDING/UNKNOWN)', () => {
    const regimes: MarketRegime[] = ['STABLE', 'RANGING', 'VOLATILE'];
    for (const regime of regimes) {
      const strategy = getStrategyForRegime(regime, 'TIER1');
      expect(strategy.binStep).toBeGreaterThan(0);
    }
  });
});

describe('StrategyEngine — calculateOptimalBinStep', () => {
  test('happy path: normal volatility', () => {
    const result = calculateOptimalBinStep(new Decimal(5), 30, 1, 50);
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(50);
  });

  test('very low volatility → min bps', () => {
    const result = calculateOptimalBinStep(new Decimal(0.5), 30, 10, 50);
    expect(result).toBe(10); // Should be clamped to min
  });

  test('very high volatility → max bps', () => {
    const result = calculateOptimalBinStep(new Decimal(100), 10, 1, 50);
    expect(result).toBe(50); // Should be clamped to max
  });

  test('edge case: invalid volatility → returns min', () => {
    expect(calculateOptimalBinStep(new Decimal(NaN), 30, 1, 50)).toBe(1);
    expect(calculateOptimalBinStep(new Decimal(0), 30, 1, 50)).toBe(1);
    expect(calculateOptimalBinStep(new Decimal(-5), 30, 1, 50)).toBe(1);
  });

  test('edge case: zero target bins → returns min', () => {
    const result = calculateOptimalBinStep(new Decimal(5), 0, 1, 50);
    expect(result).toBe(1);
  });
});
