import { Decimal } from 'decimal.js';
import { logError, logWarn } from './logger';

/** ================================================================
 *  FINANCIAL CALCULATIONS — All use Decimal.js, no native float
 *  ================================================================ */

/**
 * Calculate estimated APR from 24h fee and TVL.
 * Formula: (fee_24h / tvl) * 365 * 100
 */
export function calculateApr(fee24h: Decimal, tvl: Decimal): Decimal | null {
  try {
    if (tvl.isZero()) {
      logError('calculateApr: TVL is zero', { fee24h: fee24h.toString(), tvl: tvl.toString() });
      return null;
    }
    if (fee24h.isNeg() || fee24h.isZero()) {
      logWarn('calculateApr: fee_24h is null, zero or negative', { fee24h: fee24h.toString() });
      return null;
    }
    const apr = fee24h.dividedBy(tvl).times(365).times(100);
    return apr;
  } catch (error) {
    logError('calculateApr: unexpected error', { fee24h: fee24h.toString(), tvl: tvl.toString(), error: String(error) });
    return null;
  }
}

/**
 * Calculate fee stability score: std_dev(daily_fees) / avg(daily_fees)
 * Lower = more stable.
 */
export function calculateFeeStabilityScore(dailyFees: Decimal[]): Decimal {
  try {
    if (dailyFees.length === 0) return new Decimal(Infinity);

    const sum = dailyFees.reduce((acc, v) => acc.plus(v), new Decimal(0));
    const avg = sum.dividedBy(dailyFees.length);

    if (avg.isZero()) return new Decimal(Infinity);

    const variance = dailyFees.reduce((acc, v) => {
      const diff = v.minus(avg);
      return acc.plus(diff.pow(2));
    }, new Decimal(0)).dividedBy(dailyFees.length);

    const stdDev = variance.sqrt();
    return stdDev.dividedBy(avg).abs();
  } catch (error) {
    logError('calculateFeeStabilityScore: unexpected error', { dailyFeesCount: dailyFees.length, error: String(error) });
    return new Decimal(Infinity);
  }
}

/**
 * Calculate pair score for ranking.
 * Formula: (estimated_apr * 0.5) + (volume_tvl_ratio * 0.3 * 100) + ((1 - fee_stability_score) * 0.2 * 100)
 */
export function calculatePairScore(
  estimatedApr: Decimal,
  volumeTvlRatio: Decimal,
  feeStabilityScore: Decimal
): Decimal {
  try {
    const normalizedStability = Decimal.max(0, Decimal.min(1, new Decimal(1).minus(feeStabilityScore)));
    const score = estimatedApr.times(0.5)
      .plus(volumeTvlRatio.times(0.3).times(100))
      .plus(normalizedStability.times(0.2).times(100));
    return score;
  } catch (error) {
    logError('calculatePairScore: unexpected error', {
      estimatedApr: estimatedApr.toString(),
      volumeTvlRatio: volumeTvlRatio.toString(),
      feeStabilityScore: feeStabilityScore.toString(),
      error: String(error),
    });
    return new Decimal(0);
  }
}

/**
 * Calculate IL percentage.
 * Formula: ((current_value / hodl_value) - 1) * 100
 */
export function calculateIlPct(currentValue: Decimal, hodlValue: Decimal): Decimal | null {
  try {
    if (hodlValue.isZero()) {
      logError('calculateIlPct: hodl_value is zero', {
        currentValue: currentValue.toString(),
        hodlValue: hodlValue.toString(),
      });
      return null;
    }
    const ilPct = currentValue.dividedBy(hodlValue).minus(1).times(100);
    return ilPct;
  } catch (error) {
    logError('calculateIlPct: unexpected error', {
      currentValue: currentValue.toString(),
      hodlValue: hodlValue.toString(),
      error: String(error),
    });
    return null;
  }
}

/**
 * Calculate bins drift: |active_bin - center_bin|
 */
export function calculateBinsDrift(activeBin: number, centerBin: number): number {
  try {
    if (!Number.isFinite(activeBin) || !Number.isFinite(centerBin)) {
      logError('calculateBinsDrift: invalid input', { activeBin, centerBin });
      return 0;
    }
    return Math.abs(activeBin - centerBin);
  } catch (error) {
    logError('calculateBinsDrift: unexpected error', { activeBin, centerBin, error: String(error) });
    return 0;
  }
}

/**
 * Clamp a Decimal value between min and max.
 */
export function clampDecimal(value: Decimal, min: Decimal, max: Decimal): Decimal {
  return Decimal.max(min, Decimal.min(max, value));
}

/**
 * Clamp a number value between min and max.
 */
export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * Calculate standard deviation of an array of Decimals.
 */
export function stdDev(values: Decimal[]): Decimal {
  try {
    if (values.length === 0) return new Decimal(0);
    const avg = values.reduce((a, b) => a.plus(b), new Decimal(0)).dividedBy(values.length);
    const variance = values.reduce((a, b) => {
      const diff = b.minus(avg);
      return a.plus(diff.pow(2));
    }, new Decimal(0)).dividedBy(values.length);
    return variance.sqrt();
  } catch (error) {
    logError('stdDev: unexpected error', { count: values.length, error: String(error) });
    return new Decimal(0);
  }
}

/**
 * Calculate mean of an array of Decimals.
 */
export function mean(values: Decimal[]): Decimal {
  try {
    if (values.length === 0) return new Decimal(0);
    return values.reduce((a, b) => a.plus(b), new Decimal(0)).dividedBy(values.length);
  } catch (error) {
    logError('mean: unexpected error', { count: values.length, error: String(error) });
    return new Decimal(0);
  }
}

/**
 * Is value a valid finite Decimal?
 */
export function isValidDecimal(d: unknown): d is Decimal {
  return d instanceof Decimal && d.isFinite() && !d.isNaN();
}

/**
 * Is value a valid finite number?
 */
export function isValidNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Safely convert string/number to Decimal, return null if invalid.
 */
export function toDecimal(value: unknown): Decimal | null {
  try {
    if (value instanceof Decimal) return value.isFinite() ? value : null;
    if (typeof value === 'string' || typeof value === 'number') {
      const d = new Decimal(value);
      return d.isFinite() ? d : null;
    }
    return null;
  } catch {
    return null;
  }
}
