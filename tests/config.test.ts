import { isStablecoin, STABLECOINS, STABLECOIN_SYMBOLS } from '@/config';

describe('Config — isStablecoin', () => {
  test('recognizes USDC mint', () => {
    expect(isStablecoin('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
  });

  test('recognizes USDT symbol', () => {
    expect(isStablecoin('USDT')).toBe(true);
  });

  test('recognizes lowercase', () => {
    expect(isStablecoin('usdc')).toBe(true);
  });

  test('non-stablecoin returns false', () => {
    expect(isStablecoin('SOL')).toBe(false);
    expect(isStablecoin('BONK')).toBe(false);
    expect(isStablecoin('random')).toBe(false);
  });

  test('empty string returns false', () => {
    expect(isStablecoin('')).toBe(false);
  });

  test('all stablecoin symbols are covered', () => {
    for (const sym of STABLECOIN_SYMBOLS) {
      expect(isStablecoin(sym)).toBe(true);
    }
  });

  test('all stablecoin mints are covered', () => {
    for (const mint of STABLECOINS) {
      expect(isStablecoin(mint)).toBe(true);
    }
  });
});
