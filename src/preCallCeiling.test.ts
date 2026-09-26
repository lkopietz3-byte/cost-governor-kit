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

  it('denies when already-spent alone is at the ceiling, even for a $0 next call', () => {
    const result = checkPreCallCeiling({
      spentSoFarUsd: 5.000001,
      ceilingUsd: 5,
      estimatedNextCallUsage: {},
      rates,
    });
    expect(result.allowed).toBe(false);
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
