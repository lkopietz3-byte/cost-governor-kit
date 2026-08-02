import { describe, expect, it } from 'vitest';
import { checkPreCallCeiling } from './preCallCeiling.js';
import type { ModelRates } from './pricing.js';

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
    const result = checkPreCallCeiling({
      spentSoFarUsd: 4,
      ceilingUsd: 5,
      // (0 in + outputTokens*15)/1e6 == 1 exactly when outputTokens = 66_666.67 → use input instead for a clean number
      estimatedNextCallUsage: { inputTokens: 1_000_000 / 3 },
      rates,
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
