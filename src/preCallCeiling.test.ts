import { describe, expect, it } from 'vitest';
import { checkPreCallCeiling } from './preCallCeiling.js';
import type { ModelRates, UsageTokens } from './pricing.js';

const rates: ModelRates = { inputPerMillion: 3, outputPerMillion: 15 };

describe('checkPreCallCeiling — allows calls under the ceiling', () => {
  it('allows a small call when far under the ceiling', () => {
    const result = checkPreCallCeiling({
      spentSoFarUsd: 1,
      ceilingUsd: 5,
      estimatedNextCallUsage: { inputTokens: 10_000, outputTokens: 2_000 },
      rates,
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
    // projected: (10_000*3 + 2_000*15) / 1e6 = 0.06; total = 1.06
    expect(result.projectedNextCallCostUsd).toBeCloseTo(0.06, 6);
    expect(result.projectedTotalUsd).toBeCloseTo(1.06, 6);
  });

  it('allows a call that lands exactly on the ceiling', () => {
    // The original fixture used a fractional token count to produce a $1 call.
    // Integer tokens at a $1/M rate preserve the same exact-ceiling guarantee
    // while honoring UsageTokens' non-negative-safe-integer contract.
    const result = checkPreCallCeiling({
      spentSoFarUsd: 4,
      ceilingUsd: 5,
      estimatedNextCallUsage: { inputTokens: 1_000_000 },
      rates: { inputPerMillion: 1, outputPerMillion: 15 },
    });
    expect(result.projectedTotalUsd).toBeCloseTo(5, 6);
    expect(result.allowed).toBe(true);
  });
});

describe('checkPreCallCeiling — denies BEFORE any side effect when the call would exceed the ceiling', () => {
  it('denies a call that would push cumulative spend past the ceiling', () => {
    let upstreamCallWasMade = false; // stand-in for "the real side effect" (an API call)

    const result = checkPreCallCeiling({
      spentSoFarUsd: 4.9,
      ceilingUsd: 5,
      estimatedNextCallUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000 }, // costs $18 — way over
      rates,
    });

    // The whole point: the caller checks `allowed` and only THEN would make
    // the real call. Since this never runs, upstreamCallWasMade stays false —
    // proving the ceiling is enforced before, not after, the side effect.
    if (result.allowed) {
      upstreamCallWasMade = true;
    }

    expect(result.allowed).toBe(false);
    expect(upstreamCallWasMade).toBe(false);
    expect(result.reason).toMatch(/would exceed the ceiling/i);
    expect(result.projectedTotalUsd).toBeGreaterThan(result.ceilingUsd);
  });

  it('denies when already-spent alone is above the ceiling, even for a $0 next call', () => {
    const result = checkPreCallCeiling({
      spentSoFarUsd: 5.000001,
      ceilingUsd: 5,
      estimatedNextCallUsage: {},
      rates,
    });
    expect(result.allowed).toBe(false);
  });
});

describe('checkPreCallCeiling — boundaries at micro-dollar resolution', () => {
  const oneMicroDollarCall: UsageTokens = { inputTokens: 1 };
  const dollarPerToken = { inputPerMillion: 1, outputPerMillion: 0 }; // 1 token = $0.000001

  const check = (spentSoFarUsd: number, ceilingUsd: number, usage = oneMicroDollarCall, r: ModelRates = dollarPerToken) =>
    checkPreCallCeiling({ spentSoFarUsd, ceilingUsd, estimatedNextCallUsage: usage, rates: r });

  it('allows a total one micro-dollar below, and exactly at, the ceiling', () => {
    expect(check(4.999998, 5).allowed).toBe(true);
    expect(check(4.999999, 5)).toMatchObject({ allowed: true, projectedTotalUsd: 5 });
  });

  it('denies a total one micro-dollar above the ceiling', () => {
    const result = check(5, 5);
    expect(result).toMatchObject({ allowed: false, projectedTotalUsd: 5.000001, ceilingUsd: 5 });
    expect(result.reason).toBe(
      'Projected total spend $5.000001 (already spent $5.000000 + projected next call $0.000001) ' +
        'would exceed the ceiling of $5.000000. Refusing to make the call.',
    );
  });

  it('allows a $0 call at a $0 ceiling but denies any priced call', () => {
    expect(check(0, 0, {}).allowed).toBe(true);
    expect(check(0, 0).allowed).toBe(false);
  });

  it('absorbs floating-point noise: $0.1 + $0.2 fits a $0.3 ceiling', () => {
    expect(0.1 + 0.2).toBeGreaterThan(0.3);
    expect(check(0.1, 0.3, { inputTokens: 200_000 })).toMatchObject({ allowed: true, projectedTotalUsd: 0.3 });
  });

  it('documented limit: a call cheaper than half a micro-dollar is priced at $0 and allowed at the ceiling', () => {
    const result = check(5, 5, { inputTokens: 1 }, { inputPerMillion: 0.4, outputPerMillion: 0 });
    expect(result).toMatchObject({ allowed: true, projectedNextCallCostUsd: 0, projectedTotalUsd: 5 });
  });

  it('compares a ceiling that is not a whole micro-dollar against the rounded total', () => {
    // round6(4.9999996) = 5 > 4.9999996, so an exact-equal total is denied here.
    expect(check(4.9999996, 4.9999996, {}).allowed).toBe(false);
    // round6(4.9999994) = 4.999999 <= 4.9999994, so this one is allowed.
    expect(check(4.9999994, 4.9999994, {}).allowed).toBe(true);
  });
});

describe('checkPreCallCeiling — spend and ceiling inputs', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '5' as unknown as number],
  ])('rejects a %s ceiling', (_label, ceilingUsd) => {
    expect(() =>
      checkPreCallCeiling({ spentSoFarUsd: 0, ceilingUsd, estimatedNextCallUsage: {}, rates }),
    ).toThrow(/ceilingUsd must be a non-negative finite number/);
  });

  it.each([
    ['negative', -0.01],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '1' as unknown as number],
  ])('rejects a %s spentSoFarUsd', (_label, spentSoFarUsd) => {
    expect(() =>
      checkPreCallCeiling({ spentSoFarUsd, ceilingUsd: 5, estimatedNextCallUsage: {}, rates }),
    ).toThrow(/spentSoFarUsd must be a non-negative finite number/);
  });

  it('does not mutate its input', () => {
    const input = { spentSoFarUsd: 1, ceilingUsd: 5, estimatedNextCallUsage: { inputTokens: 10 }, rates: { ...rates } };
    const snapshot = JSON.parse(JSON.stringify(input)) as typeof input;
    checkPreCallCeiling(input);
    expect(input).toEqual(snapshot);
  });
});

describe('checkPreCallCeiling — rates must be explicit, never defaulted', () => {
  it('throws if rates is missing', () => {
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 5,
        estimatedNextCallUsage: {},
        // @ts-expect-error — intentionally omitting the required rates param
        rates: undefined,
      }),
    ).toThrow(/rates.*required/is);
  });

  it('throws if rates has a non-numeric field', () => {
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 5,
        estimatedNextCallUsage: {},
        // @ts-expect-error — intentionally malformed rates
        rates: { inputPerMillion: 'stale-string-price', outputPerMillion: 15 },
      }),
    ).toThrow();
  });

  it('rejects a negative ceiling', () => {
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: -1,
        estimatedNextCallUsage: {},
        rates,
      }),
    ).toThrow(/ceilingUsd/);
  });
});

describe('checkPreCallCeiling — invalid estimates fail closed', () => {
  it('rejects the reproduced negative-input-rate bypass before returning allowed', () => {
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 0,
        estimatedNextCallUsage: { inputTokens: 1_000_000 },
        rates: { inputPerMillion: -3, outputPerMillion: 15 },
      }),
    ).toThrow(/inputPerMillion/);
  });

  it('rejects the reproduced negative-input-token bypass before returning allowed', () => {
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 4,
        ceilingUsd: 5,
        estimatedNextCallUsage: { inputTokens: -1_000_000 },
        rates,
      }),
    ).toThrow(/inputTokens/);
  });

  it.each([
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreation5mTokens',
    'cacheCreation1hTokens',
  ] as const)('rejects a negative %s estimate', (field) => {
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 5,
        estimatedNextCallUsage: { [field]: -1 },
        rates,
      }),
    ).toThrow(new RegExp(field));
  });

  it.each([
    ['fractional', 0.5],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('rejects a %s token estimate', (_label, inputTokens) => {
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 5,
        estimatedNextCallUsage: { inputTokens },
        rates,
      }),
    ).toThrow(/inputTokens/);
  });

  it.each(['inputPerMillion', 'outputPerMillion'] as const)(
    'rejects invalid %s rates',
    (field) => {
      for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(() =>
          checkPreCallCeiling({
            spentSoFarUsd: 0,
            ceilingUsd: 5,
            estimatedNextCallUsage: {},
            rates: { ...rates, [field]: value },
          }),
        ).toThrow(new RegExp(field));
      }
    },
  );

  it('rejects a provider-shaped usage estimate instead of allowing it under a $0 ceiling', () => {
    // Before the unknown-field check, these keys were ignored, the call priced
    // at $0, and a 5M-token call was "allowed" under a $0 ceiling.
    const providerShaped = { input_tokens: 5_000_000 } as unknown as UsageTokens;
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 0,
        estimatedNextCallUsage: providerShaped,
        rates,
      }),
    ).toThrow(/unknown field "input_tokens"/);
  });

  it('rejects projected-total rounding that overflows finite arithmetic', () => {
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: Number.MAX_VALUE,
        ceilingUsd: Number.MAX_VALUE,
        estimatedNextCallUsage: {},
        rates,
      }),
    ).toThrow(/rounded projected total.*finite/i);
  });
});
