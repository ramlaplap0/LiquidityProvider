import { Decimal } from 'decimal.js';
import {
  calculateApr,
  calculateFeeStabilityScore,
  calculatePairScore,
  calculateIlPct,
  calculateBinsDrift,
  clampDecimal,
  clampNumber,
  stdDev,
  mean,
  isValidDecimal,
  isValidNumber,
  toDecimal,
} from '@/utils/math';

describe('Math Utils — calculateApr', () => {
  test('happy path: valid fee and TVL', () => {
    const fee = new Decimal(100);
    const tvl = new Decimal(10000);
    const result = calculateApr(fee, tvl);
    expect(result).not.toBeNull();
    expect(result!.toFixed(2)).toBe('365.00'); // (100/10000)*365*100 = 365
  });

  test('edge case: TVL = 0 → returns null', () => {
    const result = calculateApr(new Decimal(100), new Decimal(0));
    expect(result).toBeNull();
  });

  test('edge case: fee = 0 → returns null', () => {
    const result = calculateApr(new Decimal(0), new Decimal(10000));
    expect(result).toBeNull();
  });

  test('edge case: fee negative → returns null', () => {
    const result = calculateApr(new Decimal(-10), new Decimal(10000));
    expect(result).toBeNull();
  });

  test('edge case: very large APR', () => {
    const fee = new Decimal(10000);
    const tvl = new Decimal(1);
    const result = calculateApr(fee, tvl);
    expect(result).not.toBeNull();
    expect(result!.gt(100000)).toBe(true);
  });

  test('edge case: very small values', () => {
    const fee = new Decimal('0.001');
    const tvl = new Decimal('0.1');
    const result = calculateApr(fee, tvl);
    expect(result).not.toBeNull();
    expect(result!.isPositive()).toBe(true);
  });
});

describe('Math Utils — calculateFeeStabilityScore', () => {
  test('happy path: stable fees', () => {
    const fees = [
      new Decimal(100),
      new Decimal(102),
      new Decimal(98),
      new Decimal(101),
      new Decimal(99),
      new Decimal(100),
      new Decimal(101),
    ];
    const result = calculateFeeStabilityScore(fees);
    expect(result.isFinite()).toBe(true);
    expect(result.toNumber()).toBeLessThan(0.5); // Should be stable
  });

  test('edge case: empty array → Infinity', () => {
    const result = calculateFeeStabilityScore([]);
    expect(result.toNumber()).toBe(Infinity);
  });

  test('edge case: all zeros → Infinity', () => {
    const fees = [new Decimal(0), new Decimal(0), new Decimal(0)];
    const result = calculateFeeStabilityScore(fees);
    expect(result.toNumber()).toBe(Infinity);
  });

  test('edge case: very volatile fees', () => {
    const fees = [new Decimal(10), new Decimal(1000), new Decimal(5), new Decimal(500)];
    const result = calculateFeeStabilityScore(fees);
    expect(result.toNumber()).toBeGreaterThan(1); // Unstable
  });

  test('edge case: single value', () => {
    const result = calculateFeeStabilityScore([new Decimal(100)]);
    expect(result.isFinite()).toBe(true);
    expect(result.toNumber()).toBe(0); // Zero std dev with 1 value
  });
});

describe('Math Utils — calculatePairScore', () => {
  test('happy path: normal values', () => {
    const apr = new Decimal(300);
    const volumeTvl = new Decimal(1.2);
    const stability = new Decimal(0.3);
    const result = calculatePairScore(apr, volumeTvl, stability);
    expect(result.isFinite()).toBe(true);
    expect(result.isPositive()).toBe(true);
  });

  test('edge case: zero APR', () => {
    const result = calculatePairScore(new Decimal(0), new Decimal(1), new Decimal(0.5));
    expect(result.isFinite()).toBe(true);
  });

  test('edge case: high stability score (>1)', () => {
    const result = calculatePairScore(new Decimal(300), new Decimal(1), new Decimal(1.5));
    expect(result.isFinite()).toBe(true);
    // Stability component should be clamped to 0
  });

  test('edge case: negative stability score', () => {
    const result = calculatePairScore(new Decimal(300), new Decimal(1), new Decimal(-0.5));
    expect(result.isFinite()).toBe(true);
  });
});

describe('Math Utils — calculateIlPct', () => {
  test('happy path: positive IL', () => {
    const current = new Decimal(95);
    const hodl = new Decimal(100);
    const result = calculateIlPct(current, hodl);
    expect(result).not.toBeNull();
    expect(result!.toFixed(2)).toBe('-5.00');
  });

  test('happy path: negative IL (gain)', () => {
    const current = new Decimal(105);
    const hodl = new Decimal(100);
    const result = calculateIlPct(current, hodl);
    expect(result).not.toBeNull();
    expect(result!.toFixed(2)).toBe('5.00');
  });

  test('edge case: hodl_value = 0 → null', () => {
    const result = calculateIlPct(new Decimal(100), new Decimal(0));
    expect(result).toBeNull();
  });

  test('edge case: zero IL', () => {
    const result = calculateIlPct(new Decimal(100), new Decimal(100));
    expect(result).not.toBeNull();
    expect(result!.toNumber()).toBe(0);
  });
});

describe('Math Utils — calculateBinsDrift', () => {
  test('happy path: positive drift', () => {
    expect(calculateBinsDrift(10, 5)).toBe(5);
    expect(calculateBinsDrift(5, 10)).toBe(5);
  });

  test('edge case: NaN input → 0', () => {
    expect(calculateBinsDrift(NaN, 5)).toBe(0);
    expect(calculateBinsDrift(5, NaN)).toBe(0);
  });

  test('edge case: Infinity → 0', () => {
    expect(calculateBinsDrift(Infinity, 5)).toBe(0);
  });

  test('edge case: no drift', () => {
    expect(calculateBinsDrift(5, 5)).toBe(0);
  });

  test('edge case: negative bins', () => {
    expect(calculateBinsDrift(-10, -5)).toBe(5);
  });
});

describe('Math Utils — clampDecimal', () => {
  test('happy path: value in range', () => {
    const result = clampDecimal(new Decimal(5), new Decimal(0), new Decimal(10));
    expect(result.toNumber()).toBe(5);
  });

  test('below min → min', () => {
    const result = clampDecimal(new Decimal(-5), new Decimal(0), new Decimal(10));
    expect(result.toNumber()).toBe(0);
  });

  test('above max → max', () => {
    const result = clampDecimal(new Decimal(15), new Decimal(0), new Decimal(10));
    expect(result.toNumber()).toBe(10);
  });
});

describe('Math Utils — clampNumber', () => {
  test('happy path', () => {
    expect(clampNumber(5, 0, 10)).toBe(5);
    expect(clampNumber(-5, 0, 10)).toBe(0);
    expect(clampNumber(15, 0, 10)).toBe(10);
  });

  test('NaN → min', () => {
    expect(clampNumber(NaN, 0, 10)).toBe(0);
  });
});

describe('Math Utils — stdDev', () => {
  test('happy path', () => {
    const values = [new Decimal(2), new Decimal(4), new Decimal(4), new Decimal(4), new Decimal(5), new Decimal(5), new Decimal(7), new Decimal(9)];
    const result = stdDev(values);
    expect(result.isFinite()).toBe(true);
    expect(result.toNumber()).toBeGreaterThan(0);
  });

  test('empty array → 0', () => {
    expect(stdDev([]).toNumber()).toBe(0);
  });
});

describe('Math Utils — mean', () => {
  test('happy path', () => {
    const result = mean([new Decimal(10), new Decimal(20), new Decimal(30)]);
    expect(result.toNumber()).toBe(20);
  });

  test('empty array → 0', () => {
    expect(mean([]).toNumber()).toBe(0);
  });
});

describe('Math Utils — isValidDecimal', () => {
  test('valid finite Decimal', () => {
    expect(isValidDecimal(new Decimal(5))).toBe(true);
  });

  test('NaN → false', () => {
    expect(isValidDecimal(new Decimal(NaN))).toBe(false);
  });

  test('Infinity → false', () => {
    expect(isValidDecimal(new Decimal(Infinity))).toBe(false);
  });

  test('null → false', () => {
    expect(isValidDecimal(null)).toBe(false);
  });
});

describe('Math Utils — isValidNumber', () => {
  test('valid number', () => {
    expect(isValidNumber(5)).toBe(true);
  });

  test('NaN → false', () => {
    expect(isValidNumber(NaN)).toBe(false);
  });

  test('Infinity → false', () => {
    expect(isValidNumber(Infinity)).toBe(false);
  });

  test('string → false', () => {
    expect(isValidNumber('5')).toBe(false);
  });
});

describe('Math Utils — toDecimal', () => {
  test('valid string', () => {
    expect(toDecimal('5.5')).not.toBeNull();
    expect(toDecimal('5.5')!.toNumber()).toBe(5.5);
  });

  test('valid number', () => {
    expect(toDecimal(10)).not.toBeNull();
    expect(toDecimal(10)!.toNumber()).toBe(10);
  });

  test('Decimal input', () => {
    expect(toDecimal(new Decimal(7))).not.toBeNull();
  });

  test('invalid string → null', () => {
    expect(toDecimal('not_a_number')).toBeNull();
  });

  test('null → null', () => {
    expect(toDecimal(null)).toBeNull();
  });

  test('empty string → null', () => {
    expect(toDecimal('')).toBeNull();
  });
});
