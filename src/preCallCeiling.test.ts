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
  ])('rejects a %s ceiling with a RangeError', (_label, ceilingUsd) => {
    expect(() =>
      checkPreCallCeiling({ spentSoFarUsd: 0, ceilingUsd, estimatedNextCallUsage: {}, rates }),
    ).toThrow(/ceilingUsd must be a non-negative finite number/);
    expect(() =>
      checkPreCallCeiling({ spentSoFarUsd: 0, ceilingUsd, estimatedNextCallUsage: {}, rates }),
    ).toThrow(RangeError);
  });

  it('rejects a non-numeric ceiling with a TypeError', () => {
    const ceilingUsd = '5' as unknown as number;
    expect(() =>
      checkPreCallCeiling({ spentSoFarUsd: 0, ceilingUsd, estimatedNextCallUsage: {}, rates }),
    ).toThrow(/ceilingUsd must be a non-negative finite number/);
    expect(() =>
      checkPreCallCeiling({ spentSoFarUsd: 0, ceilingUsd, estimatedNextCallUsage: {}, rates }),
    ).toThrow(TypeError);
  });

  it.each([
    ['negative', -0.01],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects a %s spentSoFarUsd with a RangeError', (_label, spentSoFarUsd) => {
    expect(() =>
      checkPreCallCeiling({ spentSoFarUsd, ceilingUsd: 5, estimatedNextCallUsage: {}, rates }),
    ).toThrow(/spentSoFarUsd must be a non-negative finite number/);
    expect(() =>
      checkPreCallCeiling({ spentSoFarUsd, ceilingUsd: 5, estimatedNextCallUsage: {}, rates }),
    ).toThrow(RangeError);
  });

  it('rejects a non-numeric spentSoFarUsd with a TypeError', () => {
    const spentSoFarUsd = '1' as unknown as number;
    expect(() =>
      checkPreCallCeiling({ spentSoFarUsd, ceilingUsd: 5, estimatedNextCallUsage: {}, rates }),
    ).toThrow(/spentSoFarUsd must be a non-negative finite number/);
    expect(() =>
      checkPreCallCeiling({ spentSoFarUsd, ceilingUsd: 5, estimatedNextCallUsage: {}, rates }),
    ).toThrow(TypeError);
  });

  it('does not mutate its input', () => {
    const input = { spentSoFarUsd: 1, ceilingUsd: 5, estimatedNextCallUsage: { inputTokens: 10 }, rates: { ...rates } };
    const snapshot = JSON.parse(JSON.stringify(input)) as typeof input;
    checkPreCallCeiling(input);
    expect(input).toEqual(snapshot);
  });
});

describe('checkPreCallCeiling — rates must be explicit, never defaulted', () => {
  it('throws a TypeError if rates is missing', () => {
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 5,
        estimatedNextCallUsage: {},
        // @ts-expect-error — intentionally omitting the required rates param
        rates: undefined,
      }),
    ).toThrow(/rates.*required/is);
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 5,
        estimatedNextCallUsage: {},
        // @ts-expect-error — intentionally omitting the required rates param
        rates: undefined,
      }),
    ).toThrow(TypeError);
  });

  it('throws a TypeError if rates has a non-numeric field', () => {
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 5,
        estimatedNextCallUsage: {},
        // @ts-expect-error — intentionally malformed rates
        rates: { inputPerMillion: 'stale-string-price', outputPerMillion: 15 },
      }),
    ).toThrow(TypeError);
  });

  it('rejects a negative ceiling with a RangeError', () => {
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: -1,
        estimatedNextCallUsage: {},
        rates,
      }),
    ).toThrow(/ceilingUsd/);
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: -1,
        estimatedNextCallUsage: {},
        rates,
      }),
    ).toThrow(RangeError);
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
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 0,
        estimatedNextCallUsage: { inputTokens: 1_000_000 },
        rates: { inputPerMillion: -3, outputPerMillion: 15 },
      }),
    ).toThrow(RangeError);
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
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 4,
        ceilingUsd: 5,
        estimatedNextCallUsage: { inputTokens: -1_000_000 },
        rates,
      }),
    ).toThrow(RangeError);
  });

  it.each([
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreation5mTokens',
    'cacheCreation1hTokens',
  ] as const)('rejects a negative %s estimate with a RangeError', (field) => {
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 5,
        estimatedNextCallUsage: { [field]: -1 },
        rates,
      }),
    ).toThrow(new RegExp(field));
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 5,
        estimatedNextCallUsage: { [field]: -1 },
        rates,
      }),
    ).toThrow(RangeError);
  });

  it.each([
    ['fractional', 0.5],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('rejects a %s token estimate with a RangeError', (_label, inputTokens) => {
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 5,
        estimatedNextCallUsage: { inputTokens },
        rates,
      }),
    ).toThrow(/inputTokens/);
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 5,
        estimatedNextCallUsage: { inputTokens },
        rates,
      }),
    ).toThrow(RangeError);
  });

  it.each(['inputPerMillion', 'outputPerMillion'] as const)(
    'rejects invalid %s rates with a RangeError',
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
        expect(() =>
          checkPreCallCeiling({
            spentSoFarUsd: 0,
            ceilingUsd: 5,
            estimatedNextCallUsage: {},
            rates: { ...rates, [field]: value },
          }),
        ).toThrow(RangeError);
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
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 0,
        estimatedNextCallUsage: providerShaped,
        rates,
      }),
    ).toThrow(TypeError);
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

// ---------------------------------------------------------------------------
// CGK-001 at the ceiling level: a malformed container must throw before any
// allow/deny decision, including under a $0 ceiling where "zero usage" would
// have been allowed.
// ---------------------------------------------------------------------------

class UsageClass {
  inputTokens = 1_000_000;
}

const nonPlain: ReadonlyArray<readonly [string, unknown]> = [
  ['a Map', new Map([['inputTokens', 1_000_000]])],
  ['a Set', new Set(['inputTokens'])],
  ['a Date', new Date(0)],
  ['a RegExp', /inputTokens/],
  ['a class instance', new UsageClass()],
];

describe('checkPreCallCeiling — malformed containers never reach a cost decision (CGK-001)', () => {
  it.each(nonPlain)('rejects %s as estimatedNextCallUsage even under a zero-dollar ceiling', (_label, usage) => {
    const check = () =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 0,
        estimatedNextCallUsage: usage as UsageTokens,
        rates,
      });
    expect(check).toThrow(TypeError);
    expect(check).toThrow(/usage must be an object of token counts/);
  });

  it.each(nonPlain)('rejects %s as rates', (_label, badRates) => {
    const check = () =>
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 100,
        estimatedNextCallUsage: {},
        rates: badRates as ModelRates,
      });
    expect(check).toThrow(TypeError);
    expect(check).toThrow(/rates.*required/is);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a Map', new Map()],
    ['an array', []],
    ['a class instance', new UsageClass()],
  ])('rejects %s as the check itself with a TypeError', (_label, badCheck) => {
    expect(() => checkPreCallCeiling(badCheck as never)).toThrow(TypeError);
    expect(() => checkPreCallCeiling(badCheck as never)).toThrow(/check must be an object/);
  });

  it('still accepts null-prototype records for the check, the rates and the usage', () => {
    const bare = <T extends object>(value: T): T => Object.assign(Object.create(null) as T, value);
    const result = checkPreCallCeiling(
      bare({
        spentSoFarUsd: 0,
        ceilingUsd: 3,
        estimatedNextCallUsage: bare({ inputTokens: 1_000_000 }),
        rates: bare({ inputPerMillion: 3, outputPerMillion: 15 }),
      }),
    );
    expect(result.allowed).toBe(true);
    expect(result.projectedTotalUsd).toBe(3);
  });

  it('keeps the exact rounding regression values', () => {
    const result = checkPreCallCeiling({
      spentSoFarUsd: 24.99,
      ceilingUsd: 25,
      estimatedNextCallUsage: { inputTokens: 2_000, outputTokens: 500 },
      rates,
    });
    expect(result.projectedNextCallCostUsd).toBe(0.0135);
    expect(result.projectedTotalUsd).toBe(25.0035);
    expect(result.allowed).toBe(false);
  });
});

describe('checkPreCallCeiling — caller input is read once', () => {
  it('validates and decides on the same ceiling and echoes it', () => {
    let reads = 0;
    const flipping = {
      spentSoFarUsd: 1,
      get ceilingUsd(): number {
        reads++;
        return reads === 1 ? 5 : 0;
      },
      estimatedNextCallUsage: { inputTokens: 10_000 },
      rates,
    };
    const result = checkPreCallCeiling(flipping);
    expect(result.allowed).toBe(true);
    expect(result.ceilingUsd).toBe(5);
    expect(reads).toBe(1);
  });

  it('validates and decides on the same spentSoFarUsd', () => {
    let reads = 0;
    const flipping = {
      get spentSoFarUsd(): number {
        reads++;
        return reads === 1 ? 1 : -1_000;
      },
      ceilingUsd: 5,
      estimatedNextCallUsage: { inputTokens: 10_000 },
      rates,
    };
    const result = checkPreCallCeiling(flipping);
    expect(result.projectedTotalUsd).toBe(1.03);
    expect(reads).toBe(1);
  });

  it('reads check.rates and each rate once, so a rate that flips negative cannot bypass the ceiling', () => {
    let rateReads = 0;
    let inputReads = 0;
    const check = {
      spentSoFarUsd: 4.99,
      ceilingUsd: 5,
      estimatedNextCallUsage: { inputTokens: 1_000_000 },
      get rates(): ModelRates {
        rateReads++;
        return {
          get inputPerMillion(): number {
            inputReads++;
            return inputReads === 1 ? 3 : -1_000;
          },
          outputPerMillion: 15,
        };
      },
    };
    const result = checkPreCallCeiling(check);
    expect(result.projectedNextCallCostUsd).toBe(3);
    expect(result.allowed).toBe(false);
    expect(rateReads).toBe(1);
    expect(inputReads).toBe(1);
  });

  it('reads estimatedNextCallUsage once', () => {
    let reads = 0;
    const check = {
      spentSoFarUsd: 0,
      ceilingUsd: 5,
      get estimatedNextCallUsage(): UsageTokens {
        reads++;
        return { inputTokens: 1_000 };
      },
      rates,
    };
    checkPreCallCeiling(check);
    expect(reads).toBe(1);
  });
});

describe('checkPreCallCeiling — error text cannot be broken by a hostile value', () => {
  const hostile = {
    toString(): string {
      throw new RangeError('boom');
    },
  };
  const nullProto = Object.create(null) as object;

  it.each([
    ['a throwing toString', hostile],
    ['a null-prototype object', nullProto],
    ['a symbol', Symbol('x')],
    ['a bigint', 5n],
  ])('reports %s as ceilingUsd with a TypeError that names the field', (_label, ceilingUsd) => {
    const check = () =>
      checkPreCallCeiling({ spentSoFarUsd: 0, ceilingUsd: ceilingUsd as number, estimatedNextCallUsage: {}, rates });
    expect(check).toThrow(TypeError);
    expect(check).toThrow(/ceilingUsd must be a non-negative finite number/);
  });

  it.each([
    ['a throwing toString', hostile],
    ['a null-prototype object', nullProto],
  ])('reports %s as spentSoFarUsd with a TypeError that names the field', (_label, spentSoFarUsd) => {
    const check = () =>
      checkPreCallCeiling({ spentSoFarUsd: spentSoFarUsd as number, ceilingUsd: 5, estimatedNextCallUsage: {}, rates });
    expect(check).toThrow(TypeError);
    expect(check).toThrow(/spentSoFarUsd must be a non-negative finite number/);
  });

  it('does not echo a rejected string value verbatim (control characters are escaped)', () => {
    let message = '';
    try {
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 'x\u001b[31m\n\u202e' as unknown as number,
        estimatedNextCallUsage: {},
        rates,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/ceilingUsd must be a non-negative finite number/);
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  });
});

// ---------------------------------------------------------------------------
// Mutation-driven additions: rate range checks run before ceiling and spend
// checks, zero is a valid rate, and both overflow guards fire.
// ---------------------------------------------------------------------------

const RATES_MESSAGE = /`rates` \(a plain object with non-negative finite numeric inputPerMillion\/outputPerMillion\) is required\. This library never defaults or hardcodes a price — pass the live rate explicitly, the same way classify-batch\.mjs takes --input-rate\/--output-rate as CLI arguments, so a stale price cannot silently corrupt the spend cap\./;

describe('checkPreCallCeiling — the rates range check comes first and names rates', () => {
  it.each([
    ['NaN inputPerMillion', { inputPerMillion: Number.NaN, outputPerMillion: 15 }],
    ['NaN outputPerMillion', { inputPerMillion: 3, outputPerMillion: Number.NaN }],
    ['Infinity inputPerMillion', { inputPerMillion: Number.POSITIVE_INFINITY, outputPerMillion: 15 }],
    ['Infinity outputPerMillion', { inputPerMillion: 3, outputPerMillion: Number.POSITIVE_INFINITY }],
    ['negative inputPerMillion', { inputPerMillion: -1, outputPerMillion: 15 }],
    ['negative outputPerMillion', { inputPerMillion: 3, outputPerMillion: -1 }],
    ['-Infinity inputPerMillion', { inputPerMillion: Number.NEGATIVE_INFINITY, outputPerMillion: 15 }],
    ['-Infinity outputPerMillion', { inputPerMillion: 3, outputPerMillion: Number.NEGATIVE_INFINITY }],
  ])('raises the rates RangeError for %s even when the ceiling and spend are also invalid', (_label, badRates) => {
    const check = () =>
      checkPreCallCeiling({ spentSoFarUsd: -1, ceilingUsd: -1, estimatedNextCallUsage: { inputTokens: -1 }, rates: badRates });
    expect(check).toThrow(RangeError);
    expect(check).toThrow(RATES_MESSAGE);
  });

  it('raises the rates TypeError for a missing or non-numeric rate even when the ceiling is invalid', () => {
    const check = (badRates: unknown) => () =>
      checkPreCallCeiling({ spentSoFarUsd: 0, ceilingUsd: -1, estimatedNextCallUsage: {}, rates: badRates as ModelRates });
    expect(check({ outputPerMillion: 15 })).toThrow(TypeError);
    expect(check({ outputPerMillion: 15 })).toThrow(RATES_MESSAGE);
    expect(check({ inputPerMillion: 3 })).toThrow(RATES_MESSAGE);
    expect(check({ inputPerMillion: '3', outputPerMillion: 15 })).toThrow(RATES_MESSAGE);
    expect(check({ inputPerMillion: '3', outputPerMillion: 15 })).toThrow(TypeError);
    expect(check({ inputPerMillion: 3, outputPerMillion: '15' })).toThrow(TypeError);
  });

  it('accepts zero for either rate and prices the call at zero', () => {
    const result = checkPreCallCeiling({
      spentSoFarUsd: 0,
      ceilingUsd: 0,
      estimatedNextCallUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      rates: { inputPerMillion: 0, outputPerMillion: 0 },
    });
    expect(result).toMatchObject({ allowed: true, projectedNextCallCostUsd: 0, projectedTotalUsd: 0 });
  });

  it('accepts a zero output rate and a zero input rate independently', () => {
    expect(
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 1,
        estimatedNextCallUsage: { inputTokens: 1_000_000 },
        rates: { inputPerMillion: 1, outputPerMillion: 0 },
      }).projectedTotalUsd,
    ).toBe(1);
    expect(
      checkPreCallCeiling({
        spentSoFarUsd: 0,
        ceilingUsd: 1,
        estimatedNextCallUsage: { outputTokens: 1_000_000 },
        rates: { inputPerMillion: 0, outputPerMillion: 1 },
      }).projectedTotalUsd,
    ).toBe(1);
  });

  it('names the plain-object rule when the check is not a plain object', () => {
    expect(() => checkPreCallCeiling(null as never)).toThrowError(
      'checkPreCallCeiling: check must be an object with spentSoFarUsd, ceilingUsd, estimatedNextCallUsage and rates ' +
        '(a plain object; not null, an array, a Map, a Date or a class instance)',
    );
  });
});

describe('checkPreCallCeiling — finite-result guards', () => {
  it('rejects a projected total whose unrounded sum overflows', () => {
    expect(() =>
      checkPreCallCeiling({
        spentSoFarUsd: Number.MAX_VALUE,
        ceilingUsd: Number.MAX_VALUE,
        estimatedNextCallUsage: { inputTokens: Number.MAX_SAFE_INTEGER },
        rates: { inputPerMillion: 1e290, outputPerMillion: 0 },
      }),
    ).toThrowError('checkPreCallCeiling: projected total must remain finite');
  });
});
