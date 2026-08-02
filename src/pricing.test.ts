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
} from './pricing.js';

// Toy rates — deliberately round numbers so expected costs are easy to hand-check.
const rates: ModelRates = { inputPerMillion: 3, outputPerMillion: 15 };

describe('estimateCostUsd — basic input/output', () => {
  it('prices plain uncached input and output at the base rates', () => {
    const cost = estimateCostUsd(rates, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(3 + 15, 6);
  });

  it('treats missing fields as zero', () => {
    expect(estimateCostUsd(rates, {})).toBe(0);
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

describe('formatRatesForLog', () => {
  it('renders a human-readable, loggable rate string', () => {
    expect(formatRatesForLog(rates)).toBe('$3/M in, $15/M out');
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
});
