import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  CACHE_CREATION_1H_MULTIPLIER,
  CACHE_CREATION_5M_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
  estimateCostUsd,
  formatRatesForLog,
  getRatesOrThrow,
  type ModelRates,
  type PricingTable,
  type UsageTokens,
} from './pricing.js';

// Toy rates — deliberately round numbers so expected costs are easy to hand-check.
const rates: ModelRates = { inputPerMillion: 3, outputPerMillion: 15 };

const tokenBucketNames = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreation5mTokens',
  'cacheCreation1hTokens',
] as const;

const invalidTokenValues: ReadonlyArray<readonly [string, number]> = [
  ['negative', -1],
  ['fractional', 0.5],
  ['NaN', Number.NaN],
  ['positive infinity', Number.POSITIVE_INFINITY],
  ['negative infinity', Number.NEGATIVE_INFINITY],
  ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
];

const rateNames = ['inputPerMillion', 'outputPerMillion'] as const;
const invalidRateValues: ReadonlyArray<readonly [string, number]> = [
  ['negative', -1],
  ['NaN', Number.NaN],
  ['positive infinity', Number.POSITIVE_INFINITY],
  ['negative infinity', Number.NEGATIVE_INFINITY],
];

describe('estimateCostUsd — basic input/output', () => {
  it('prices plain uncached input and output at the base rates', () => {
    const cost = estimateCostUsd(rates, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(3 + 15, 6);
  });

  it('treats missing fields as zero', () => {
    expect(estimateCostUsd(rates, {})).toBe(0);
  });

  it('preserves the inherited result for the independently reviewed large input', () => {
    expect(
      estimateCostUsd(
        { inputPerMillion: 32.41542859468609, outputPerMillion: 84.89569439552724 },
        {
          inputTokens: 836_287_760,
          outputTokens: 108_828_860,
          cacheReadTokens: 202_490_199,
          cacheCreation5mTokens: 73_905_380,
          cacheCreation1hTokens: 981_670_132,
        },
      ),
    ).toBe(103_641.217812);
  });

  it('preserves multiply-sum-divide rounding for a deterministic operation-order edge', () => {
    expect(
      estimateCostUsd(
        { inputPerMillion: 19.921824941411614, outputPerMillion: 60.61670910567045 },
        {
          inputTokens: 669_684_661,
          outputTokens: 106_113_399,
          cacheReadTokens: 766_381_311,
          cacheCreation5mTokens: 199_910_199,
          cacheCreation1hTokens: 745_939_054,
        },
      ),
    ).toBe(55_999.511541);
  });
});

describe('estimateCostUsd — validates its public numeric inputs', () => {
  describe.each(tokenBucketNames)('%s', (field) => {
    it.each(invalidTokenValues)('rejects a %s value with a RangeError', (_label, value) => {
      expect(() => estimateCostUsd(rates, { [field]: value })).toThrow(new RegExp(field));
      expect(() => estimateCostUsd(rates, { [field]: value })).toThrow(RangeError);
    });

    it('rejects an explicitly supplied null value with a TypeError', () => {
      expect(() => estimateCostUsd(rates, { [field]: null })).toThrow(new RegExp(field));
      expect(() => estimateCostUsd(rates, { [field]: null })).toThrow(TypeError);
    });
  });

  describe.each(rateNames)('%s', (field) => {
    it.each(invalidRateValues)('rejects a %s value with a RangeError', (_label, value) => {
      expect(() => estimateCostUsd({ ...rates, [field]: value }, {})).toThrow(new RegExp(field));
      expect(() => estimateCostUsd({ ...rates, [field]: value }, {})).toThrow(RangeError);
    });
  });

  it('rejects non-numeric values with a TypeError, without echoing them in errors', () => {
    expect(() =>
      estimateCostUsd({ ...rates, inputPerMillion: 'private-rate' as unknown as number }, {}),
    ).toThrowError('estimateCostUsd: rates.inputPerMillion must be a non-negative finite number');
    expect(() =>
      estimateCostUsd({ ...rates, inputPerMillion: 'private-rate' as unknown as number }, {}),
    ).toThrow(TypeError);
    expect(() =>
      estimateCostUsd(rates, { inputTokens: 'private-token-value' as unknown as number }),
    ).toThrowError('estimateCostUsd: usage.inputTokens must be a non-negative safe integer');
    expect(() =>
      estimateCostUsd(rates, { inputTokens: 'private-token-value' as unknown as number }),
    ).toThrow(TypeError);
  });

  it('treats an explicitly undefined token bucket as the documented zero default', () => {
    expect(estimateCostUsd(rates, { inputTokens: undefined })).toBe(0);
  });

  it('accepts zero token counts and non-negative decimal rates', () => {
    expect(
      estimateCostUsd(
        { inputPerMillion: 0.25, outputPerMillion: 1.5 },
        {
          inputTokens: 4_000_000,
          outputTokens: 2_000_000,
          cacheReadTokens: 0,
          cacheCreation5mTokens: 0,
          cacheCreation1hTokens: 0,
        },
      ),
    ).toBe(4);
  });

  it('accepts the largest safe integer token count', () => {
    expect(() =>
      estimateCostUsd(
        { inputPerMillion: 0, outputPerMillion: 0 },
        { inputTokens: Number.MAX_SAFE_INTEGER },
      ),
    ).not.toThrow();
  });

  it('rejects a cost calculation that overflows finite arithmetic', () => {
    expect(() =>
      estimateCostUsd(
        { inputPerMillion: Number.MAX_VALUE, outputPerMillion: 0 },
        { inputTokens: Number.MAX_SAFE_INTEGER },
      ),
    ).toThrow(/finite.*cost|cost.*finite/i);
  });

  it('rejects the reproduced negative-output-token cost bypass', () => {
    expect(() => estimateCostUsd(rates, { outputTokens: -1_000_000 })).toThrow(/outputTokens/);
  });

  it('rejects an Anthropic-style snake_case usage block instead of pricing it at $0', () => {
    // The provider's own field names. Before this check they were ignored,
    // every bucket defaulted to 0, and a real 1M-in/1M-out call priced at $0.
    const providerUsage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(() => estimateCostUsd(rates, providerUsage as unknown as UsageTokens)).toThrow(
      /unknown field "input_tokens"/,
    );
    expect(() => estimateCostUsd(rates, providerUsage as unknown as UsageTokens)).toThrow(TypeError);
  });

  it('rejects a misspelled bucket name instead of silently dropping it', () => {
    const typo = { cacheCreationTokens: 1_000_000 };
    expect(() => estimateCostUsd(rates, typo as unknown as UsageTokens)).toThrow(
      /unknown field "cacheCreationTokens"/,
    );
    expect(() => estimateCostUsd(rates, typo as unknown as UsageTokens)).toThrow(TypeError);
  });

  it('rejects a known bucket mixed with an unknown one', () => {
    const mixed = { inputTokens: 10, model: 'toy-model-a' };
    expect(() => estimateCostUsd(rates, mixed as unknown as UsageTokens)).toThrow(/unknown field "model"/);
    expect(() => estimateCostUsd(rates, mixed as unknown as UsageTokens)).toThrow(TypeError);
  });

  it.each([
    ['null', null],
    ['a number', 5],
    ['a string', 'inputTokens'],
    ['an array', [1_000_000]],
  ])('rejects %s as the usage argument with a TypeError', (_label, usage) => {
    expect(() => estimateCostUsd(rates, usage as unknown as UsageTokens)).toThrow(
      /usage must be an object of token counts/,
    );
    expect(() => estimateCostUsd(rates, usage as unknown as UsageTokens)).toThrow(TypeError);
  });
});

describe('estimateCostUsd — the three cache multipliers are applied distinctly', () => {
  it('bills cache_read at 0.1x the input rate', () => {
    const cost = estimateCostUsd(rates, { cacheReadTokens: 1_000_000 });
    expect(cost).toBeCloseTo(rates.inputPerMillion * CACHE_READ_MULTIPLIER, 6); // 0.3
  });

  it('bills cache_creation_5m at 1.25x the input rate', () => {
    const cost = estimateCostUsd(rates, { cacheCreation5mTokens: 1_000_000 });
    expect(cost).toBeCloseTo(rates.inputPerMillion * CACHE_CREATION_5M_MULTIPLIER, 6); // 3.75
  });

  it('bills cache_creation_1h at 2.0x the input rate — a DIFFERENT multiplier from 5m', () => {
    const cost = estimateCostUsd(rates, { cacheCreation1hTokens: 1_000_000 });
    expect(cost).toBeCloseTo(rates.inputPerMillion * CACHE_CREATION_1H_MULTIPLIER, 6); // 6.0
  });

  it('sums all five buckets as independent line items in one call', () => {
    const usage = {
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheReadTokens: 200_000,
      cacheCreation5mTokens: 10_000,
      cacheCreation1hTokens: 10_000,
    };
    const expected =
      (100_000 * rates.inputPerMillion +
        200_000 * rates.inputPerMillion * CACHE_READ_MULTIPLIER +
        10_000 * rates.inputPerMillion * CACHE_CREATION_5M_MULTIPLIER +
        10_000 * rates.inputPerMillion * CACHE_CREATION_1H_MULTIPLIER +
        50_000 * rates.outputPerMillion) /
      1_000_000;
    expect(estimateCostUsd(rates, usage)).toBeCloseTo(expected, 6);
  });
});

describe('estimateCostUsd — proves the real bug is fixed (37.5% under-report)', () => {
  it('gives a DIFFERENT number than the old buggy single-multiplier calculation for a 1h-cache turn', () => {
    const tokens = 1_000_000;

    // Correct: 1h-cache creation billed at its own 2.0x multiplier.
    const correctCost = estimateCostUsd(rates, { cacheCreation1hTokens: tokens });

    // The real historical bug: a single flat multiplier (1.25x, the 5m rate)
    // was applied to BOTH cache-creation TTLs, so a 1h-cache write was
    // silently billed as if it were a 5m-cache write.
    const buggyCollapsedCost = (tokens * rates.inputPerMillion * CACHE_CREATION_5M_MULTIPLIER) / 1_000_000;

    expect(correctCost).not.toBe(buggyCollapsedCost);
    expect(correctCost).toBeCloseTo(6, 6); // 1.0 * 3 * 2.0
    expect(buggyCollapsedCost).toBeCloseTo(3.75, 6); // 1.0 * 3 * 1.25

    // The under-report fraction the collapsed bug produces vs. the correct cost.
    const underReportFraction = (correctCost - buggyCollapsedCost) / correctCost;
    expect(underReportFraction).toBeCloseTo(0.375, 3); // ~37.5%, matches the documented real-world bug
  });
});

describe('cache multiplier constants', () => {
  it('have the documented values', () => {
    expect(CACHE_READ_MULTIPLIER).toBe(0.1);
    expect(CACHE_CREATION_5M_MULTIPLIER).toBe(1.25);
    expect(CACHE_CREATION_1H_MULTIPLIER).toBe(2);
  });
});

// Independent hand calculations. Each expected value is worked out in
// integer "rate x tokens" units first, then divided by 1,000,000, so the
// expectation does not reuse the library's own formula.
describe('estimateCostUsd — hand-calculated examples', () => {
  it('prices the README example at $0.0195', () => {
    // input 1,200 x 3 = 3,600; cache read 8,000 x 3 x 0.1 = 2,400;
    // 5m write 2,000 x 3 x 1.25 = 7,500; 1h write 0; output 400 x 15 = 6,000.
    // Sum 19,500 / 1,000,000 = 0.0195.
    expect(
      estimateCostUsd(rates, {
        inputTokens: 1_200,
        outputTokens: 400,
        cacheReadTokens: 8_000,
        cacheCreation5mTokens: 2_000,
        cacheCreation1hTokens: 0,
      }),
    ).toBe(0.0195);
  });

  it('prices all five buckets at once at $0.14625', () => {
    // rates 5 / 25: input 10,000 x 5 = 50,000; cache read 40,000 x 5 x 0.1 = 20,000;
    // 5m write 3,000 x 5 x 1.25 = 18,750; 1h write 2,000 x 5 x 2 = 20,000;
    // output 1,500 x 25 = 37,500. Sum 146,250 / 1,000,000 = 0.14625.
    expect(
      estimateCostUsd(
        { inputPerMillion: 5, outputPerMillion: 25 },
        {
          inputTokens: 10_000,
          cacheReadTokens: 40_000,
          cacheCreation5mTokens: 3_000,
          cacheCreation1hTokens: 2_000,
          outputTokens: 1_500,
        },
      ),
    ).toBe(0.14625);
  });

  it("matches the token lines of Anthropic's published caching worked example ($0.445)", () => {
    // Anthropic pricing page (fetched 2026-09-24), cached worked example at
    // $5 / $25: uncached input 10,000 -> $0.05, cache reads 40,000 -> $0.02,
    // output 15,000 -> $0.375. Token lines total $0.445.
    expect(
      estimateCostUsd(
        { inputPerMillion: 5, outputPerMillion: 25 },
        { inputTokens: 10_000, cacheReadTokens: 40_000, outputTokens: 15_000 },
      ),
    ).toBe(0.445);
  });

  it('can price a model with a different cache-read rate by scaling the input rate for that bucket alone', () => {
    // Documented workaround for models whose cache reads are not 0.1x
    // (for example 0.025x): price cache reads separately with
    // inputPerMillion = base x (0.025 / 0.1). 1,000,000 reads at a $10 base
    // and 0.025x cost $0.25.
    expect(
      estimateCostUsd({ inputPerMillion: 10 * 0.25, outputPerMillion: 0 }, { cacheReadTokens: 1_000_000 }),
    ).toBe(0.25);
  });
});

describe('estimateCostUsd — optional cacheReadPerMillion overrides the fixed 0.1x ratio', () => {
  it('prices cache reads at cacheReadPerMillion directly instead of inputPerMillion x 0.1', () => {
    // Illustrative rates: inputPerMillion 3 would give 0.1x = $0.3/M for cache
    // reads; cacheReadPerMillion overrides that entirely to $1/M.
    const overridden: ModelRates = { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 1 };
    const cost = estimateCostUsd(overridden, { cacheReadTokens: 1_000_000 });
    expect(cost).toBe(1); // NOT 0.3 (the 0.1x default)
  });

  it('leaves the default 0.1x ratio in place when cacheReadPerMillion is omitted', () => {
    const withoutOverride: ModelRates = { inputPerMillion: 3, outputPerMillion: 15 };
    expect(estimateCostUsd(withoutOverride, { cacheReadTokens: 1_000_000 })).toBe(0.3);
  });

  it('combines with the other four buckets, which stay priced off inputPerMillion', () => {
    // input 10,000 x 3 = 30,000; cache read 40,000 x 1 (override) = 40,000;
    // 5m write 3,000 x 3 x 1.25 = 11,250; 1h write 2,000 x 3 x 2 = 12,000;
    // output 1,500 x 15 = 22,500. Sum 115,750 / 1,000,000 = 0.11575.
    const rates: ModelRates = { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 1 };
    expect(
      estimateCostUsd(rates, {
        inputTokens: 10_000,
        cacheReadTokens: 40_000,
        cacheCreation5mTokens: 3_000,
        cacheCreation1hTokens: 2_000,
        outputTokens: 1_500,
      }),
    ).toBe(0.11575);
  });

  it('can price the real 0.025x and 0.05x models exactly, without the input-rate-scaling workaround', () => {
    // Same models the README calls out as over-estimated by the fixed 0.1x
    // ratio: at a $10/M input rate, 0.025x is $0.25/M and 0.05x is $0.50/M.
    const quarterMultiplier: ModelRates = { inputPerMillion: 10, outputPerMillion: 0, cacheReadPerMillion: 10 * 0.025 };
    const halfMultiplier: ModelRates = { inputPerMillion: 10, outputPerMillion: 0, cacheReadPerMillion: 10 * 0.05 };
    expect(estimateCostUsd(quarterMultiplier, { cacheReadTokens: 1_000_000 })).toBe(0.25);
    expect(estimateCostUsd(halfMultiplier, { cacheReadTokens: 1_000_000 })).toBe(0.5);
  });

  it.each(invalidRateValues)('rejects a %s cacheReadPerMillion instead of silently ignoring it', (_label, value) => {
    expect(() =>
      estimateCostUsd({ inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: value }, {}),
    ).toThrow(/cacheReadPerMillion/);
  });

  it('accepts zero as an explicit cacheReadPerMillion (free cache reads)', () => {
    const rates: ModelRates = { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0 };
    expect(estimateCostUsd(rates, { cacheReadTokens: 1_000_000 })).toBe(0);
  });

  it('does not require cacheReadPerMillion to price a call with no cache-read tokens', () => {
    const rates: ModelRates = { inputPerMillion: 3, outputPerMillion: 15 };
    expect(estimateCostUsd(rates, { inputTokens: 1_000 })).toBe(0.003);
  });
});

describe('estimateCostUsd — rounding policy (nearest micro-dollar)', () => {
  const inputOnly = (inputPerMillion: number) => ({ inputPerMillion, outputPerMillion: 0 });

  it('rounds a cost below half a micro-dollar down to $0', () => {
    expect(estimateCostUsd(inputOnly(0.25), { inputTokens: 1 })).toBe(0); // 0.25 micro-dollars
    expect(estimateCostUsd(inputOnly(0.4), { inputTokens: 1 })).toBe(0); // 0.4 micro-dollars
    expect(estimateCostUsd(rates, { cacheReadTokens: 1 })).toBe(0); // 3 x 0.1 = 0.3 micro-dollars
  });

  it('rounds a cost above half a micro-dollar up', () => {
    expect(estimateCostUsd(inputOnly(0.6), { inputTokens: 1 })).toBe(0.000001);
  });

  it('rounds an exact binary half up (Math.round semantics)', () => {
    expect(estimateCostUsd(inputOnly(0.5), { inputTokens: 1 })).toBe(0.000001);
    expect(estimateCostUsd(inputOnly(2.5), { inputTokens: 1 })).toBe(0.000003);
  });

  it('can round a decimal half down, because the arithmetic is binary floating point', () => {
    // Exact decimal: 50 x 0.29 = 14.5 micro-dollars. In doubles,
    // 50 * 0.29 === 14.499999999999998, so the result is 14, not 15.
    expect(50 * 0.29).toBeLessThan(14.5);
    expect(estimateCostUsd(inputOnly(0.29), { inputTokens: 50 })).toBe(0.000014);
  });

  it('returns the double nearest a whole number of micro-dollars', () => {
    const cost = estimateCostUsd(rates, { inputTokens: 10_000, outputTokens: 2_000 });
    expect(cost).toBe(0.06);
    expect(Number.isInteger(Math.round(cost * 1e6))).toBe(true);
    expect(Math.round(cost * 1e6) / 1e6).toBe(cost);
  });
});

describe('formatRatesForLog', () => {
  it('renders a human-readable, loggable rate string', () => {
    expect(formatRatesForLog(rates)).toBe('$3/M in, $15/M out');
  });

  it('prints decimal rates as JavaScript formats them, without rounding', () => {
    expect(formatRatesForLog({ inputPerMillion: 0.25, outputPerMillion: 1.25 })).toBe('$0.25/M in, $1.25/M out');
  });

  it('does not validate; an invalid rate is printed so it can be seen', () => {
    expect(formatRatesForLog({ inputPerMillion: Number.NaN, outputPerMillion: -1 })).toBe('$NaN/M in, $-1/M out');
  });
});

describe('getRatesOrThrow', () => {
  const table: PricingTable = {
    'toy-model-a': { inputPerMillion: 3, outputPerMillion: 15 },
  };

  it('returns the rates for a known model', () => {
    expect(getRatesOrThrow(table, 'toy-model-a')).toEqual(table['toy-model-a']);
  });

  it('throws — never silently defaults — for an unknown model', () => {
    expect(() => getRatesOrThrow(table, 'unknown-model')).toThrow(/no pricing entry/i);
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])(
    'throws for the inherited Object member name %s instead of returning it as rates',
    (model) => {
      expect(() => getRatesOrThrow(table, model)).toThrow(/no pricing entry/i);
    },
  );

  it('lists "(empty table)" when the table has no entries', () => {
    expect(() => getRatesOrThrow({}, 'any-model')).toThrow(/Known models: \(empty table\)/);
  });

  it('works with a table that has no prototype', () => {
    const bare = Object.assign(Object.create(null) as PricingTable, { 'toy-model-a': rates });
    expect(getRatesOrThrow(bare, 'toy-model-a')).toBe(rates);
    expect(() => getRatesOrThrow(bare, 'toy-model-b')).toThrow(/no pricing entry/i);
  });
});

// ---------------------------------------------------------------------------
// CGK-001: every record must be plain (or null-prototype); nothing that is not
// a plain record may be read as "zero usage" or "empty table".
// ---------------------------------------------------------------------------

class UsageClass {
  inputTokens = 1_000_000;
}
class RatesClass {
  inputPerMillion = 3;
  outputPerMillion = 15;
}

const nonPlainRecords: ReadonlyArray<readonly [string, unknown]> = [
  ['a Map', new Map([['inputTokens', 1_000_000]])],
  ['a Set', new Set(['inputTokens'])],
  ['a Date', new Date(0)],
  ['a RegExp', /inputTokens/],
  ['a class instance', new UsageClass()],
  ['a function', () => 1],
  ['a boxed number', Object.assign(Object(1), { inputTokens: 1 })],
];

describe('estimateCostUsd — usage must be a plain or null-prototype object (CGK-001)', () => {
  it.each(nonPlainRecords)('rejects %s as usage with a TypeError instead of pricing it at $0', (_label, usage) => {
    expect(() => estimateCostUsd(rates, usage as UsageTokens)).toThrow(TypeError);
    expect(() => estimateCostUsd(rates, usage as UsageTokens)).toThrow(/usage must be an object of token counts/);
  });

  it('rejects an object whose prototype is an ordinary object', () => {
    const usage = Object.create({ inputTokens: 5 }) as UsageTokens;
    expect(() => estimateCostUsd(rates, usage)).toThrow(TypeError);
  });

  it('still accepts an ordinary object, a null-prototype dictionary and an empty record', () => {
    const bare = Object.assign(Object.create(null) as UsageTokens, { inputTokens: 1_000_000 });
    expect(estimateCostUsd(rates, { inputTokens: 1_000_000 })).toBe(3);
    expect(estimateCostUsd(rates, bare)).toBe(3);
    expect(estimateCostUsd(rates, {})).toBe(0);
  });

  it('accepts an ordinary record made in another realm (same shape, different Object.prototype)', () => {
    const foreign = runInNewContext('({ inputTokens: 1000000 })') as UsageTokens;
    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
    expect(estimateCostUsd(rates, foreign)).toBe(3);
  });
});

describe('estimateCostUsd — rates must be a plain or null-prototype object (CGK-001)', () => {
  it.each(nonPlainRecords)('rejects %s as rates with a TypeError', (_label, badRates) => {
    expect(() => estimateCostUsd(badRates as ModelRates, {})).toThrow(TypeError);
    expect(() => estimateCostUsd(badRates as ModelRates, {})).toThrow(/rates must be an object/);
  });

  it('rejects a class instance even when its fields are valid', () => {
    expect(() => estimateCostUsd(new RatesClass(), { inputTokens: 1 })).toThrow(TypeError);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 3],
    ['an array', [3, 15]],
  ])('rejects %s as rates with a TypeError that names rates', (_label, badRates) => {
    expect(() => estimateCostUsd(badRates as unknown as ModelRates, {})).toThrow(TypeError);
    expect(() => estimateCostUsd(badRates as unknown as ModelRates, {})).toThrow(/rates must be an object/);
  });

  it('still accepts a null-prototype rates record', () => {
    const bare = Object.assign(Object.create(null) as ModelRates, { inputPerMillion: 3, outputPerMillion: 15 });
    expect(estimateCostUsd(bare, { inputTokens: 1_000_000 })).toBe(3);
  });
});

describe('estimateCostUsd — caller input is read once, then validated and priced from the same copy', () => {
  it('prices a rate getter that answers differently on a second read using the value it validated', () => {
    let reads = 0;
    const flipping = {
      get inputPerMillion(): number {
        reads++;
        return reads === 1 ? 3 : -1_000;
      },
      outputPerMillion: 15,
    };
    expect(estimateCostUsd(flipping, { inputTokens: 1_000_000 })).toBe(3);
    expect(reads).toBe(1);
  });

  it('reads outputPerMillion and cacheReadPerMillion once each', () => {
    const reads = { output: 0, cacheRead: 0 };
    const counted: ModelRates = {
      inputPerMillion: 10,
      get outputPerMillion(): number {
        reads.output++;
        return 50;
      },
      get cacheReadPerMillion(): number {
        reads.cacheRead++;
        return 0.25;
      },
    };
    expect(estimateCostUsd(counted, { cacheReadTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(50.25);
    expect(reads).toEqual({ output: 1, cacheRead: 1 });
  });

  it('reads each usage field once', () => {
    const reads: Record<string, number> = {};
    const counted = {} as UsageTokens;
    for (const name of tokenBucketNames) {
      Object.defineProperty(counted, name, {
        enumerable: true,
        get(): number {
          reads[name] = (reads[name] ?? 0) + 1;
          return 1;
        },
      });
    }
    estimateCostUsd(rates, counted);
    expect(reads).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheCreation5mTokens: 1,
      cacheCreation1hTokens: 1,
    });
  });
});

describe('estimateCostUsd — error text stays safe and never echoes a rejected value', () => {
  it('escapes control and bidi characters in an unknown usage key', () => {
    const usage = { 'evil\n\u001b[31m\u202e\u2066': 1 } as unknown as UsageTokens;
    let message = '';
    try {
      estimateCostUsd(rates, usage);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/unknown field/);
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(message).toContain('\\u{202E}');
  });
});

describe('formatRatesForLog — plain records, one read, safe text', () => {
  it.each(nonPlainRecords)('rejects %s with a TypeError', (_label, badRates) => {
    expect(() => formatRatesForLog(badRates as ModelRates)).toThrow(TypeError);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s with a TypeError', (_label, badRates) => {
    expect(() => formatRatesForLog(badRates as unknown as ModelRates)).toThrow(TypeError);
    expect(() => formatRatesForLog(badRates as unknown as ModelRates)).toThrow(/rates must be an object/);
  });

  it('cannot be made to print a terminal escape or a forged line through a string rate', () => {
    const line = formatRatesForLog({
      inputPerMillion: '\u001b[2J\nFAKE' as unknown as number,
      outputPerMillion: '\u202egnp' as unknown as number,
    });
    expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(line).toContain('in, ');
  });

  it('does not run a rate object\'s toString or throw for a hostile rate', () => {
    const hostile = {
      toString(): string {
        throw new RangeError('boom');
      },
    };
    expect(() =>
      formatRatesForLog({ inputPerMillion: hostile as unknown as number, outputPerMillion: Symbol('x') as unknown as number }),
    ).not.toThrow();
  });

  it('reads each rate once', () => {
    let reads = 0;
    const counted = {
      get inputPerMillion(): number {
        reads++;
        return 3;
      },
      get outputPerMillion(): number {
        reads++;
        return 15;
      },
    };
    expect(formatRatesForLog(counted)).toBe('$3/M in, $15/M out');
    expect(reads).toBe(2);
  });
});

describe('getRatesOrThrow — the table is a plain record and the model is a string (CGK-001, class 10)', () => {
  const table: PricingTable = { 'toy-model-a': { inputPerMillion: 3, outputPerMillion: 15 } };

  it.each([
    ['a Map', new Map([['toy-model-a', rates]])],
    ['a Set', new Set(['toy-model-a'])],
    ['an array', [rates]],
    ['null', null],
    ['undefined', undefined],
    ['a class instance', Object.assign(new UsageClass(), { 'toy-model-a': rates })],
  ])('rejects %s as the table with a TypeError, not "(empty table)"', (_label, badTable) => {
    expect(() => getRatesOrThrow(badTable as unknown as PricingTable, 'toy-model-a')).toThrow(TypeError);
    expect(() => getRatesOrThrow(badTable as unknown as PricingTable, 'toy-model-a')).toThrow(/table must be an object/);
  });

  it.each([
    ['a String object', new String('toy-model-a')],
    ['an array holding the name', ['toy-model-a']],
    ['an object whose toString returns the name', { toString: () => 'toy-model-a' }],
    ['a number', 1],
    ['a symbol', Symbol('toy-model-a')],
    ['undefined', undefined],
    ['null', null],
  ])('rejects %s as the model instead of coercing it to a key', (_label, model) => {
    expect(() => getRatesOrThrow(table, model as unknown as string)).toThrow(TypeError);
    expect(() => getRatesOrThrow(table, model as unknown as string)).toThrow(/model must be a string/);
  });

  it('raises a TypeError, not the error a hostile toString throws', () => {
    const hostile = {
      toString(): string {
        throw new RangeError('boom');
      },
    };
    expect(() => getRatesOrThrow(table, hostile as unknown as string)).toThrow(TypeError);
  });

  it('escapes control and bidi characters from the model and the known-model list', () => {
    const noisy: PricingTable = { 'line1\nline2\u001b[31m': rates };
    let message = '';
    try {
      getRatesOrThrow(noisy, 'evil"\r\n\u202e\u2066model');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/no pricing entry for model/);
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(message).toContain('line1\\nline2');
  });
});
