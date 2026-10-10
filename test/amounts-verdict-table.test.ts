/**
 * amounts-verdict-table.test.ts: verdicts for dollar amounts on strict
 * reservations, integer-micro dated price tables, "unknown"-aware provider
 * usage readers and commit-once reporting (2026-10-10).
 *
 * Section 1 is the named table: honest inputs that must pass and bad inputs
 * that must be flagged. Section 2 holds the hostile-input rows. Section 3
 * runs the whole flow. The provider fixtures were written by hand from the
 * providers' documented response shapes, not captured live, and every price
 * in this file is made up for the test.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  assertPricingFresh,
  costMicros,
  createCommitOnce,
  definePricingTable,
  priceFor,
  readAnthropicUsage,
  readOpenAIUsage,
  withCapacityReservation,
  type CapacityReservationLedger,
  type CapacityWorkOutcome,
  type MicrosPrice,
  type ReserveCapacityRequest,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Log {
  requests: ReserveCapacityRequest[];
  confirms: unknown[][];
  releases: number;
}

function newLog(): Log {
  return { requests: [], confirms: [], releases: 0 };
}

function ledger(log: Log): CapacityReservationLedger {
  return {
    reserveCapacity: async (request) => {
      log.requests.push(request);
      return {
        status: 'acquired',
        reservation: { id: 'r-1', key: request.key, operationId: request.operationId, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      };
    },
    confirmReservation: async (...args: unknown[]) => {
      log.confirms.push(args);
    },
    releaseReservation: async () => {
      log.releases++;
    },
  };
}

const req = { key: 'budget:2026-10-10', limit: 5_000_000, operationId: 'op-1', amount: 12_000 };

/** Run the work and return the result plus the log. `settle` is what the work reports. */
async function reserveWith(settle: unknown, hasSettle = true) {
  const log = newLog();
  const result = await withCapacityReservation(ledger(log), req, async (): Promise<CapacityWorkOutcome<string>> => {
    const outcome = { status: 'succeeded', value: 'ok' } as Record<string, unknown>;
    if (hasSettle) outcome.settle = settle;
    return outcome as unknown as CapacityWorkOutcome<string>;
  });
  return { log, result };
}

// Illustrative, made-up prices in micro-dollars per million tokens.
const price: MicrosPrice = {
  inputPerMTokMicros: 3_000_000,
  outputPerMTokMicros: 15_000_000,
  cacheWritePerMTokMicros: 3_750_000,
  cacheWrite1hPerMTokMicros: 6_000_000,
  cacheReadPerMTokMicros: 300_000,
};

const table = definePricingTable({
  checkedAt: '2026-10-01',
  source: 'illustrative numbers for tests',
  rates: {
    'anthropic:test-model': price,
    'openai:test-model': { inputPerMTokMicros: 2_000_000, outputPerMTokMicros: 8_000_000, cacheReadPerMTokMicros: 500_000 },
  },
});

const anthropicUsage = {
  input_tokens: 2_095,
  output_tokens: 503,
  cache_creation_input_tokens: 2_051,
  cache_read_input_tokens: 12,
  cache_creation: { ephemeral_5m_input_tokens: 51, ephemeral_1h_input_tokens: 2_000 },
  service_tier: 'standard',
};

// ---------------------------------------------------------------------------
// 1. The verdict table
// ---------------------------------------------------------------------------

describe('verdict table: amounts, pricing, commit-once', () => {
  it('V1 honest reserve/confirm, actual below the estimate: records the actual, no overrun', async () => {
    const { log, result } = await reserveWith({ actualAmount: 9_100 });
    expect(log.requests[0]?.amount).toBe(12_000);
    expect(log.confirms[0]?.[1]).toEqual({ usage: 'reported', amount: 9_100, reservedAmount: 12_000 });
    expect(result.status).toBe('confirmed');
    expect(Object.hasOwn(result, 'overrunAmount')).toBe(false);
  });

  it('V2 usage unknown keeps the reserved estimate, never zero', async () => {
    for (const explicit of [{ usage: 'unknown' }, undefined]) {
      const { log } = await reserveWith(explicit, explicit !== undefined);
      expect(log.confirms[0]?.[1]).toEqual({ usage: 'unknown', amount: 12_000, reservedAmount: 12_000 });
    }
  });

  it('V3 actual above the estimate is recorded as is and reported on the result', async () => {
    const { log, result } = await reserveWith({ actualAmount: 30_000 });
    expect(log.confirms[0]?.[1]).toEqual({ usage: 'reported', amount: 30_000, reservedAmount: 12_000 });
    expect(result).toMatchObject({ status: 'confirmed', overrunAmount: 18_000 });
  });

  it('V3b an actual equal to the estimate is not an overrun', async () => {
    const { result } = await reserveWith({ actualAmount: 12_000 });
    expect(Object.hasOwn(result, 'overrunAmount')).toBe(false);
  });

  it('V4 an unknown model is rejected: no price, no fallback', () => {
    expect(priceFor(table, 'anthropic:other-model')).toEqual({ status: 'unknown-model', key: 'anthropic:other-model' });
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'Anthropic:test-model', 'test-model']) {
      expect(priceFor(table, key).status).toBe('unknown-model');
    }
    expect(priceFor(table, undefined as never).status).toBe('unknown-model');
    expect(priceFor(table, 'anthropic:test-model')).toMatchObject({ status: 'found', key: 'anthropic:test-model', price });
  });

  it('V5 a stale table is rejected; a fresh one passes (now comes from the caller)', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    expect(() => assertPricingFresh(table, { now, maxAgeDays: 30 })).not.toThrow();
    expect(() => assertPricingFresh(table, { now: new Date('2026-12-10T12:00:00Z'), maxAgeDays: 30 })).toThrow(/days old/);
  });

  it('V6 an OpenAI response missing usage gives unknown, not zero', () => {
    const response = JSON.parse('{"id":"chatcmpl-1","choices":[]}') as { usage?: unknown };
    expect(readOpenAIUsage(response.usage)).toBe('unknown');
    expect(readOpenAIUsage(undefined)).toBe('unknown');
    expect(readOpenAIUsage(null)).toBe('unknown');
    expect(readOpenAIUsage({})).toBe('unknown');
  });

  it('V7 a string "123" token count gives unknown', () => {
    expect(readOpenAIUsage({ prompt_tokens: '123', completion_tokens: 5 })).toBe('unknown');
    expect(readOpenAIUsage({ prompt_tokens: 123, completion_tokens: '5' })).toBe('unknown');
    expect(readAnthropicUsage({ input_tokens: '123', output_tokens: 5 })).toBe('unknown');
    expect(readAnthropicUsage({ input_tokens: 123, output_tokens: 5, cache_read_input_tokens: '1' })).toBe('unknown');
    expect(readAnthropicUsage({ input_tokens: 123, output_tokens: 5, cache_creation_input_tokens: '1' })).toBe('unknown');
    expect(readAnthropicUsage({ ...anthropicUsage, cache_creation: { ephemeral_5m_input_tokens: '51', ephemeral_1h_input_tokens: 2_000 } })).toBe('unknown');
  });

  it('V8 cache tokens are priced, each bucket at its own rate', () => {
    const usage = readAnthropicUsage(anthropicUsage);
    expect(usage).toEqual({ inputTokens: 2_095, outputTokens: 503, cacheReadTokens: 12, cacheCreation5mTokens: 51, cacheCreation1hTokens: 2_000 });
    if (usage === 'unknown') throw new Error('unreachable');
    // 6,285 + 7,545 + 3.6 + 191.25 + 12,000 = 26,024.85 micro-dollars, rounded up.
    expect(costMicros(usage, price)).toBe(26_025);
    expect(costMicros({ cacheReadTokens: 1_000_000 }, price)).toBe(300_000);
    expect(costMicros({ cacheCreation5mTokens: 1_000_000 }, price)).toBe(3_750_000);
    expect(costMicros({ cacheCreation1hTokens: 1_000_000 }, price)).toBe(6_000_000);
  });

  it('V8b a missing cache_creation object does not drop cache_creation_input_tokens', () => {
    expect(readAnthropicUsage({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 700 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreation5mTokens: 700,
      cacheCreation1hTokens: 0,
    });
  });

  it('V9 commit-once under 100 concurrent calls commits once and says who ran it', async () => {
    let runs = 0;
    const commit = createCommitOnce(async () => {
      runs++;
      await Promise.resolve();
      return 'counted';
    });
    const results = await Promise.all(Array.from({ length: 100 }, () => commit.attempt()));
    expect(runs).toBe(1);
    expect(results.filter((r) => r.ran)).toHaveLength(1);
    for (const r of results) expect(r).toMatchObject({ status: 'committed', value: 'counted' });
    expect((await commit.attempt()).ran).toBe(false);
    expect(runs).toBe(1);
    expect(commit.state).toBe('committed');
  });

  it('V9b a throwing commit is reported as failed, ran true once, and is never retried', async () => {
    let runs = 0;
    const boom = new Error('write lost');
    const commit = createCommitOnce(() => {
      runs++;
      throw boom;
    });
    const first = await commit.attempt();
    expect(first).toEqual({ ran: true, status: 'failed', error: boom });
    const second = await commit.attempt();
    expect(second).toEqual({ ran: false, status: 'failed', error: boom });
    await expect(commit()).rejects.toBe(boom);
    expect(runs).toBe(1);
    expect(commit.state).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// 2. Hostile inputs
// ---------------------------------------------------------------------------

describe('hostile inputs', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -1],
    ['fractional', 0.5],
    ['2^53', 2 ** 53],
    ['2^53+1', 2 ** 53 + 1],
    ['a BigInt', 9_007_199_254_740_993n],
    ['a string', '100'],
  ])('actualAmount %s keeps the hold: work_outcome_ambiguous, no confirm, no release', async (_label, actualAmount) => {
    const { log, result } = await reserveWith({ actualAmount });
    expect(result.status).toBe('work_outcome_ambiguous');
    expect(log.confirms).toEqual([]);
    expect(log.releases).toBe(0);
  });

  it.each([
    ['NaN', Number.NaN, RangeError],
    ['Infinity', Number.POSITIVE_INFINITY, RangeError],
    ['-0', -0, RangeError],
    ['2^53+1', 2 ** 53 + 1, RangeError],
    ['a BigInt', 5n, TypeError],
  ])('a reserve amount of %s throws before the adapter is called', async (_label, amount, ErrorType) => {
    const log = newLog();
    await expect(
      withCapacityReservation(ledger(log), { ...req, amount: amount as number }, async () => ({ status: 'succeeded', value: 1 })),
    ).rejects.toThrow(ErrorType);
    expect(log.requests).toEqual([]);
  });

  it('actualAmount -0 is recorded as +0 (a real zero), not -0', async () => {
    const { log } = await reserveWith({ actualAmount: -0 });
    const settlement = log.confirms[0]?.[1] as { amount: number };
    expect(Object.is(settlement.amount, 0)).toBe(true);
  });

  it('an actualAmount of 0 is a real zero, not unknown', async () => {
    const { log } = await reserveWith({ actualAmount: 0 });
    expect(log.confirms[0]?.[1]).toEqual({ usage: 'reported', amount: 0, reservedAmount: 12_000 });
  });

  it('a getter settle is read once, and so is a getter actualAmount', async () => {
    let settleReads = 0;
    let amountReads = 0;
    const log = newLog();
    await withCapacityReservation(ledger(log), req, async () => {
      const outcome = { status: 'succeeded', value: 1 } as Record<string, unknown>;
      Object.defineProperty(outcome, 'settle', {
        enumerable: true,
        get() {
          settleReads++;
          const s = {};
          Object.defineProperty(s, 'actualAmount', {
            enumerable: true,
            get() {
              amountReads++;
              return amountReads === 1 ? 1_000 : 'second read is hostile';
            },
          });
          return s;
        },
      });
      return outcome as unknown as CapacityWorkOutcome<number>;
    });
    expect(settleReads).toBe(1);
    expect(amountReads).toBe(1);
    expect(log.confirms[0]?.[1]).toEqual({ usage: 'reported', amount: 1_000, reservedAmount: 12_000 });
  });

  it('a throwing settle getter keeps the hold', async () => {
    const log = newLog();
    const result = await withCapacityReservation(ledger(log), req, async () => {
      const outcome = { status: 'succeeded', value: 1 };
      Object.defineProperty(outcome, 'settle', {
        enumerable: true,
        get() {
          throw new Error('hostile');
        },
      });
      return outcome as unknown as CapacityWorkOutcome<number>;
    });
    expect(result.status).toBe('work_outcome_ambiguous');
    expect(log.confirms).toEqual([]);
  });

  it('a Proxy usage object is read once per field and a throwing trap gives unknown', () => {
    const reads: Record<string, number> = {};
    const target = { input_tokens: 10, output_tokens: 5 };
    const proxy = new Proxy(target, {
      get(t, prop, receiver) {
        if (typeof prop === 'string') reads[prop] = (reads[prop] ?? 0) + 1;
        return Reflect.get(t, prop, receiver) as unknown;
      },
    });
    expect(readAnthropicUsage(proxy)).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 });
    expect(Object.keys(reads).length).toBeGreaterThan(0);
    for (const [field, count] of Object.entries(reads)) expect([field, count]).toEqual([field, 1]);
    const hostile = new Proxy(target, {
      get() {
        throw new Error('trap');
      },
    });
    expect(readAnthropicUsage(hostile)).toBe('unknown');
    const noKeys = new Proxy(target, {
      ownKeys() {
        throw new Error('trap');
      },
    });
    expect(readOpenAIUsage(noKeys)).toBe('unknown');
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(readAnthropicUsage(revoked)).toBe('unknown');
  });

  it('a getter that answers differently the second time cannot change the reading', () => {
    let reads = 0;
    const usage = { output_tokens: 5 };
    Object.defineProperty(usage, 'input_tokens', {
      enumerable: true,
      get() {
        reads++;
        return reads === 1 ? 100 : -1;
      },
    });
    expect(readAnthropicUsage(usage)).toMatchObject({ inputTokens: 100 });
    expect(reads).toBe(1);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-1', -1],
    ['1.5', 1.5],
    ['2^53', 2 ** 53],
    ['a BigInt', 5n],
    ['null input', null],
    ['an array', []],
  ])('a token count of %s is unknown', (_label, bad) => {
    expect(readAnthropicUsage({ input_tokens: bad, output_tokens: 1 })).toBe('unknown');
    expect(readOpenAIUsage({ prompt_tokens: bad, completion_tokens: 1 })).toBe('unknown');
    expect(readOpenAIUsage({ input_tokens: bad, output_tokens: 1 })).toBe('unknown');
  });

  it('a token count of -0 reads as +0', () => {
    const usage = readAnthropicUsage({ input_tokens: -0, output_tokens: 1 });
    if (usage === 'unknown') throw new Error('expected a reading');
    expect(Object.is(usage.inputTokens, 0)).toBe(true);
  });

  it('a field the readers do not know is unknown, so the estimate is kept', () => {
    expect(readAnthropicUsage({ ...anthropicUsage, new_billed_bucket: 5 })).toBe('unknown');
    expect(readOpenAIUsage({ prompt_tokens: 5, completion_tokens: 1, new_billed_bucket: 5 })).toBe('unknown');
  });

  it('a non-object usage is unknown', () => {
    for (const bad of ['usage', 5, true, Symbol('s'), () => 1, new Map(), [], new Date()]) {
      expect(readAnthropicUsage(bad)).toBe('unknown');
      expect(readOpenAIUsage(bad)).toBe('unknown');
    }
  });

  it('OpenAI cached tokens are split out of the prompt, both shapes', () => {
    expect(readOpenAIUsage({ prompt_tokens: 1_000, completion_tokens: 50, total_tokens: 1_050, prompt_tokens_details: { cached_tokens: 400 } })).toEqual({
      inputTokens: 600,
      outputTokens: 50,
      cacheReadTokens: 400,
    });
    expect(readOpenAIUsage({ input_tokens: 1_000, output_tokens: 50, input_tokens_details: { cached_tokens: 400 } })).toEqual({
      inputTokens: 600,
      outputTokens: 50,
      cacheReadTokens: 400,
    });
  });

  describe('pricing table', () => {
    const base = { checkedAt: '2026-10-01', source: 'illustrative' };
    const okRates = { inputPerMTokMicros: 1, outputPerMTokMicros: 2 };

    it.each([
      ['NaN', Number.NaN, RangeError],
      ['Infinity', Number.POSITIVE_INFINITY, RangeError],
      ['negative', -1, RangeError],
      ['fractional', 1.5, RangeError],
      ['2^53+1 (not a safe integer; BigInt is not accepted either)', 2 ** 53 + 1, RangeError],
      ['a BigInt', 5n, TypeError],
      ['a string', '5', TypeError],
      ['null', null, TypeError],
    ])('a rate of %s is rejected', (_label, bad, ErrorType) => {
      for (const field of ['inputPerMTokMicros', 'outputPerMTokMicros', 'cacheReadPerMTokMicros', 'cacheWritePerMTokMicros', 'cacheWrite1hPerMTokMicros']) {
        expect(() => definePricingTable({ ...base, rates: { 'a:b': { ...okRates, [field]: bad } } } as never)).toThrow(ErrorType);
      }
    });

    it('a rate of -0 is read as 0', () => {
      const t = definePricingTable({ ...base, rates: { 'a:b': { inputPerMTokMicros: -0, outputPerMTokMicros: 2 } } });
      const found = priceFor(t, 'a:b');
      if (found.status !== 'found') throw new Error('expected found');
      expect(Object.is(found.price.inputPerMTokMicros, 0)).toBe(true);
    });

    it('requires input and output rates and rejects unknown fields', () => {
      expect(() => definePricingTable({ ...base, rates: { 'a:b': { inputPerMTokMicros: 1 } } } as never)).toThrow(TypeError);
      expect(() => definePricingTable({ ...base, rates: { 'a:b': { ...okRates, cacheWritePerMillion: 1 } } } as never)).toThrow(/unknown field/);
    });

    it('rejects a table that mixes the two entry shapes', () => {
      expect(() =>
        definePricingTable({ ...base, rates: { 'a:b': okRates, 'a:c': { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1 } } } as never),
      ).toThrow(RangeError);
    });

    it('returns a deeply frozen copy that later edits of the input cannot change', () => {
      const input = { ...okRates, longContext: { aboveInputTokens: 200_000, inputPerMTokMicros: 3, outputPerMTokMicros: 4 } };
      const t = definePricingTable({ ...base, rates: { 'a:b': input } });
      expect(Object.isFrozen(t)).toBe(true);
      expect(Object.isFrozen(t.rates)).toBe(true);
      expect(Object.isFrozen(t.rates['a:b'])).toBe(true);
      expect(Object.isFrozen(t.rates['a:b']?.longContext)).toBe(true);
      input.inputPerMTokMicros = 999;
      input.longContext.inputPerMTokMicros = 999;
      expect(t.rates['a:b']?.inputPerMTokMicros).toBe(1);
      expect(t.rates['a:b']?.longContext?.inputPerMTokMicros).toBe(3);
    });

    it('priceFor returns a fresh frozen copy, so editing it cannot change the table', () => {
      const found = priceFor(table, 'anthropic:test-model');
      if (found.status !== 'found') throw new Error('expected found');
      expect(found.price).not.toBe(table.rates['anthropic:test-model']);
      expect(Object.isFrozen(found.price)).toBe(true);
    });

    it('rejects bad dates, a blank source, an empty table and bad keys', () => {
      expect(() => definePricingTable({ checkedAt: '2026-02-30', source: 's', rates: { 'a:b': okRates } })).toThrow(RangeError);
      expect(() => definePricingTable({ checkedAt: '2026-10-01T00:00:00', source: 's', rates: { 'a:b': okRates } })).toThrow(RangeError);
      expect(() => definePricingTable({ checkedAt: '2026-10-01', source: ' ​ ', rates: { 'a:b': okRates } })).toThrow(RangeError);
      expect(() => definePricingTable({ checkedAt: '2026-10-01', source: 's', rates: {} })).toThrow(RangeError);
      expect(() => definePricingTable({ checkedAt: '2026-10-01', source: 's', rates: { 'no-colon': okRates } })).toThrow(RangeError);
      expect(() => definePricingTable({ checkedAt: '2026-10-01', source: 's', rates: { 'A:b': okRates } })).toThrow(RangeError);
    });

    it('validates longContext', () => {
      const bad = (longContext: unknown) => () => definePricingTable({ ...base, rates: { 'a:b': { ...okRates, longContext } } } as never);
      expect(bad({ inputPerMTokMicros: 3, outputPerMTokMicros: 4 })).toThrow(TypeError); // no threshold
      expect(bad({ aboveInputTokens: 0, inputPerMTokMicros: 3, outputPerMTokMicros: 4 })).toThrow(RangeError);
      expect(bad({ aboveInputTokens: 1.5, inputPerMTokMicros: 3, outputPerMTokMicros: 4 })).toThrow(RangeError);
      expect(bad({ aboveInputTokens: 5, inputPerMTokMicros: 3 })).toThrow(TypeError);
      expect(bad({ aboveInputTokens: 5, inputPerMTokMicros: 3, outputPerMTokMicros: 4, longContext: {} })).toThrow(/unknown field/);
      expect(bad(null)).toThrow(TypeError);
      expect(bad([])).toThrow(TypeError);
    });

    it('a getter entry is read once', () => {
      let reads = 0;
      const entry = { outputPerMTokMicros: 2 };
      Object.defineProperty(entry, 'inputPerMTokMicros', {
        enumerable: true,
        get() {
          reads++;
          return reads === 1 ? 7 : -1;
        },
      });
      const t = definePricingTable({ ...base, rates: { 'a:b': entry as never } });
      expect(reads).toBe(1);
      expect(t.rates['a:b']?.inputPerMTokMicros).toBe(7);
    });

    it('priceFor on a malformed table throws instead of returning a price', () => {
      expect(() => priceFor(null as never, 'a:b')).toThrow(TypeError);
      expect(() => priceFor({ checkedAt: '2026-10-01', source: 's', rates: [] } as never, 'a:b')).toThrow(TypeError);
      // A table in the older per-million shape is not a micros table.
      const legacy = definePricingTable({ checkedAt: '2026-10-01', source: 's', rates: { 'a:b': { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1 } } });
      expect(() => priceFor(legacy as never, 'a:b')).toThrow(TypeError);
    });
  });

  describe('assertPricingFresh options form', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    it('the boundary: exactly maxAgeDays old passes, one millisecond older fails', () => {
      const t = definePricingTable({ checkedAt: '2026-09-10', source: 's', rates: { 'a:b': { inputPerMTokMicros: 1, outputPerMTokMicros: 2 } } });
      expect(() => assertPricingFresh(t, { now, maxAgeDays: 30 })).not.toThrow();
      expect(() => assertPricingFresh(t, { now: new Date(now.getTime() + 1), maxAgeDays: 30 })).toThrow(/days old/);
    });
    it('a table dated more than a day ahead is rejected', () => {
      const t = definePricingTable({ checkedAt: '2026-10-20', source: 's', rates: { 'a:b': { inputPerMTokMicros: 1, outputPerMTokMicros: 2 } } });
      expect(() => assertPricingFresh(t, { now, maxAgeDays: 30 })).toThrow(RangeError);
    });
    it.each([
      ['NaN', Number.NaN],
      ['0', 0],
      ['-1', -1],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('maxAgeDays %s is rejected (never read as "no limit")', (_label, maxAgeDays) => {
      expect(() => assertPricingFresh(table, { now, maxAgeDays })).toThrow(RangeError);
    });
    it('rejects a missing or invalid now, a non-number maxAgeDays and extra keys', () => {
      expect(() => assertPricingFresh(table, { maxAgeDays: 30 } as never)).toThrow(TypeError);
      expect(() => assertPricingFresh(table, { now: '2026-10-10', maxAgeDays: 30 } as never)).toThrow(TypeError);
      expect(() => assertPricingFresh(table, { now: new Date(Number.NaN), maxAgeDays: 30 })).toThrow(RangeError);
      expect(() => assertPricingFresh(table, { now, maxAgeDays: '30' } as never)).toThrow(TypeError);
      expect(() => assertPricingFresh(table, { now, maxAgeDays: 30, extra: 1 } as never)).toThrow(TypeError);
      expect(() => assertPricingFresh(table, null as never)).toThrow(TypeError);
    });
    it('options getters are read once', () => {
      let reads = 0;
      const options = { maxAgeDays: 30 };
      Object.defineProperty(options, 'now', {
        enumerable: true,
        get() {
          reads++;
          return reads === 1 ? now : new Date(0);
        },
      });
      expect(() => assertPricingFresh(table, options as never)).not.toThrow();
      expect(reads).toBe(1);
    });
    it('the older (table, Date, number) form still works', () => {
      expect(() => assertPricingFresh(table, new Date('2026-10-10T12:00:00Z'), 30)).not.toThrow();
      expect(() => assertPricingFresh(table, new Date('2027-10-10T12:00:00Z'), 30)).toThrow(/days old/);
    });
  });

  describe('costMicros', () => {
    it('is exact integer math: rounds up once on the sum, never below the true cost', () => {
      // 1 input token at 500,000 micros per million = 0.5 micro; plus 1 output token at 500,000 = 0.5 micro; sum 1.
      const half: MicrosPrice = { inputPerMTokMicros: 500_000, outputPerMTokMicros: 500_000 };
      expect(costMicros({ inputTokens: 1, outputTokens: 1 }, half)).toBe(1);
      expect(costMicros({ inputTokens: 1 }, half)).toBe(1);
      expect(costMicros({ inputTokens: 3 }, half)).toBe(2);
      expect(costMicros({}, half)).toBe(0);
      expect(costMicros({ inputTokens: 0, outputTokens: 0 }, half)).toBe(0);
      // 7 tokens at 100,000 micros per million = 0.7 micro; the answer is 1.
      expect(costMicros({ inputTokens: 7 }, { inputPerMTokMicros: 100_000, outputPerMTokMicros: 0 })).toBe(1);
      // Exact multiples are not bumped by noise.
      expect(costMicros({ inputTokens: 3_000_000 }, { inputPerMTokMicros: 100_000, outputPerMTokMicros: 0 })).toBe(300_000);
    });

    it('a zero rate costs 0; a positive rate never rounds a used bucket to 0', () => {
      expect(costMicros({ inputTokens: 1_000 }, { inputPerMTokMicros: 0, outputPerMTokMicros: 0 })).toBe(0);
      expect(costMicros({ inputTokens: 1 }, { inputPerMTokMicros: 1, outputPerMTokMicros: 0 })).toBe(1);
    });

    it('a bucket with tokens and no configured price throws: no fallback multiplier, no zero', () => {
      const bare: MicrosPrice = { inputPerMTokMicros: 1, outputPerMTokMicros: 2 };
      expect(() => costMicros({ cacheReadTokens: 1 }, bare)).toThrow(RangeError);
      expect(() => costMicros({ cacheCreation5mTokens: 1 }, bare)).toThrow(RangeError);
      expect(() => costMicros({ cacheCreation1hTokens: 1 }, bare)).toThrow(RangeError);
      expect(costMicros({ cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 }, bare)).toBe(0);
    });

    it('long context: above the threshold the long rates apply to every bucket; at the threshold the base rates do', () => {
      const lc: MicrosPrice = {
        inputPerMTokMicros: 3_000_000,
        outputPerMTokMicros: 15_000_000,
        cacheReadPerMTokMicros: 300_000,
        longContext: { aboveInputTokens: 200_000, inputPerMTokMicros: 6_000_000, outputPerMTokMicros: 22_500_000, cacheReadPerMTokMicros: 600_000 },
      };
      expect(costMicros({ inputTokens: 200_000, outputTokens: 1_000 }, lc)).toBe(600_000 + 15_000);
      expect(costMicros({ inputTokens: 200_001, outputTokens: 1_000 }, lc)).toBe(1_200_006 + 22_500);
      // Cache reads count toward the prompt size: 600,000 + 60,000.6 rounds up to 660,001.
      expect(costMicros({ inputTokens: 100_000, cacheReadTokens: 100_001 }, lc)).toBe(660_001);
      // The long tier lacks a cache-write price: a write there is unpriceable, not borrowed from the base tier.
      expect(() => costMicros({ inputTokens: 200_001, cacheCreation5mTokens: 1 }, { ...lc, cacheWritePerMTokMicros: 1 })).toThrow(RangeError);
    });

    it('does not lose precision at large counts and refuses a result past the safe-integer range', () => {
      expect(costMicros({ inputTokens: 9_007_199_254_740_991 }, { inputPerMTokMicros: 1_000_000, outputPerMTokMicros: 0 })).toBe(9_007_199_254_740_991);
      expect(() => costMicros({ inputTokens: 9_007_199_254_740_991 }, { inputPerMTokMicros: 2_000_000, outputPerMTokMicros: 0 })).toThrow(RangeError);
      expect(costMicros({ inputTokens: 9_007_199_254_740_991 }, { inputPerMTokMicros: 1, outputPerMTokMicros: 0 })).toBe(9_007_199_255);
    });

    it('rejects bad usage: unknown keys, non-integers, NaN, Infinity, strings, "unknown", non-objects', () => {
      expect(() => costMicros({ input_tokens: 5 } as never, price)).toThrow(TypeError);
      expect(() => costMicros({ inputTokens: 1.5 }, price)).toThrow(RangeError);
      expect(() => costMicros({ inputTokens: Number.NaN }, price)).toThrow(RangeError);
      expect(() => costMicros({ inputTokens: Number.POSITIVE_INFINITY }, price)).toThrow(RangeError);
      expect(() => costMicros({ inputTokens: -1 }, price)).toThrow(RangeError);
      expect(() => costMicros({ inputTokens: 2 ** 53 }, price)).toThrow(RangeError);
      expect(() => costMicros({ inputTokens: '123' } as never, price)).toThrow(TypeError);
      expect(() => costMicros({ inputTokens: 5n } as never, price)).toThrow(TypeError);
      expect(() => costMicros('unknown' as never, price)).toThrow(TypeError);
      expect(() => costMicros(null as never, price)).toThrow(TypeError);
      expect(() => costMicros(new Map() as never, price)).toThrow(TypeError);
      expect(() => costMicros({}, null as never)).toThrow(TypeError);
      expect(() => costMicros({}, { inputPerMTokMicros: Number.NaN, outputPerMTokMicros: 1 })).toThrow(RangeError);
    });

    it('usage and price getters are read once', () => {
      let usageReads = 0;
      let priceReads = 0;
      const usage = {};
      Object.defineProperty(usage, 'inputTokens', {
        enumerable: true,
        get() {
          usageReads++;
          return usageReads === 1 ? 1_000_000 : 5;
        },
      });
      const p = { outputPerMTokMicros: 0 };
      Object.defineProperty(p, 'inputPerMTokMicros', {
        enumerable: true,
        get() {
          priceReads++;
          return priceReads === 1 ? 2 : 999;
        },
      });
      expect(costMicros(usage, p as never)).toBe(2);
      expect(usageReads).toBe(1);
      expect(priceReads).toBe(1);
    });

    it('a Proxy usage with a throwing trap throws rather than pricing at 0', () => {
      const hostile = new Proxy({}, {
        ownKeys() {
          throw new Error('trap');
        },
      });
      expect(() => costMicros(hostile, price)).toThrow();
    });
  });

  describe('commit-once reporting', () => {
    it('attempt() never rejects, and ran is true only for the call that ran fn', async () => {
      const commit = createCommitOnce(() => 5);
      const [a, b] = await Promise.all([commit.attempt(), commit.attempt()]);
      expect(a).toEqual({ ran: true, status: 'committed', value: 5 });
      expect(b).toEqual({ ran: false, status: 'committed', value: 5 });
    });

    it('commit() first, then attempt(): attempt joins and reports ran false', async () => {
      let runs = 0;
      const commit = createCommitOnce(() => ++runs);
      const first = commit();
      expect(await commit.attempt()).toEqual({ ran: false, status: 'committed', value: 1 });
      expect(await first).toBe(1);
      expect(runs).toBe(1);
    });

    it('a rejecting fn is a failed result, with the original error object', async () => {
      const boom = { not: 'an Error' };
      // A deliberately non-Error rejection: it must come back as is.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      const commit = createCommitOnce(() => Promise.reject(boom));
      expect(await commit.attempt()).toEqual({ ran: true, status: 'failed', error: boom });
      expect(await commit.attempt()).toEqual({ ran: false, status: 'failed', error: boom });
    });

    it('a falsy rejection is still a failed result with an own error property', async () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      const commit = createCommitOnce(() => Promise.reject(undefined));
      const r = await commit.attempt();
      expect(r.status).toBe('failed');
      expect(Object.hasOwn(r, 'error')).toBe(true);
    });

    it('a re-entrant attempt from inside fn joins instead of running fn again', async () => {
      let runs = 0;
      let inner: unknown;
      const commit: ReturnType<typeof createCommitOnce<string>> = createCommitOnce(() => {
        runs++;
        void commit.attempt().then((r) => {
          inner = r;
        });
        return 'done';
      });
      await commit.attempt();
      await Promise.resolve();
      expect(runs).toBe(1);
      expect(inner).toMatchObject({ ran: false });
    });

    it('existing behavior: commit() is still the same promise for every caller', () => {
      const commit = createCommitOnce(() => 1);
      expect(commit()).toBe(commit());
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Flow: reading usage into an amount
// ---------------------------------------------------------------------------

describe('flow: provider usage to a settled amount', () => {
  const pricing = priceFor(table, 'anthropic:test-model');
  if (pricing.status !== 'found') throw new Error('expected found');
  const flowPrice = pricing.price;

  async function run(responseUsage: unknown): Promise<unknown[][]> {
    const log = newLog();
    await withCapacityReservation(ledger(log), { ...req, amount: 40_000 }, async () => {
      const reading = readAnthropicUsage(responseUsage);
      return {
        status: 'succeeded' as const,
        value: 'reply',
        settle: reading === 'unknown' ? ({ usage: 'unknown' } as const) : { actualAmount: costMicros(reading, flowPrice) },
      };
    });
    return log.confirms;
  }

  it('real usage settles the actual amount', async () => {
    const confirms = await run(anthropicUsage);
    expect(confirms[0]?.[1]).toEqual({ usage: 'reported', amount: 26_025, reservedAmount: 40_000 });
  });

  it('missing usage settles the full estimate', async () => {
    const confirms = await run(undefined);
    expect(confirms[0]?.[1]).toEqual({ usage: 'unknown', amount: 40_000, reservedAmount: 40_000 });
  });
});

// ---------------------------------------------------------------------------
// 4. Self-hunt additions
// ---------------------------------------------------------------------------

describe('self-hunt: found by attacking the first version', () => {
  it('assertPricingFresh: a maxAgeDays passed beside an options object is rejected, not ignored', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    expect(() => (assertPricingFresh as (t: unknown, o: unknown, n: unknown) => void)(table, { now, maxAgeDays: 30 }, 1)).toThrow(TypeError);
  });

  it('assertPricingFresh: a class instance or symbol-keyed options object is not read as options', () => {
    class Opts {
      now = new Date('2026-10-10T00:00:00Z');
      maxAgeDays = 30;
    }
    expect(() => assertPricingFresh(table, new Opts() as never)).toThrow(TypeError);
    expect(() => assertPricingFresh(table, { now: new Date('2026-10-10T00:00:00Z'), maxAgeDays: 30, [Symbol('x')]: 1 } as never)).toThrow(TypeError);
  });

  it('usage with an own __proto__ key (from JSON) is unknown, not priced', () => {
    const usage = JSON.parse('{"input_tokens":5,"output_tokens":1,"__proto__":{"input_tokens":1}}') as unknown;
    expect(readAnthropicUsage(usage)).toBe('unknown');
    expect(() => costMicros(JSON.parse('{"inputTokens":5,"__proto__":{}}') as never, price)).toThrow(TypeError);
  });

  it('a null-prototype usage and a null-prototype price are accepted', () => {
    const usage = Object.assign(Object.create(null) as object, { inputTokens: 2_000_000 });
    const p = Object.assign(Object.create(null) as object, { inputPerMTokMicros: 1_500_000, outputPerMTokMicros: 0 });
    expect(costMicros(usage, p as MicrosPrice)).toBe(3_000_000);
  });

  it('costMicros matches an independent integer reference on random inputs, and never undercounts', () => {
    let seed = 12345;
    const next = (max: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % (max + 1);
    };
    for (let i = 0; i < 2_000; i++) {
      const usage = { inputTokens: next(200_000), outputTokens: next(50_000), cacheReadTokens: next(100_000), cacheCreation5mTokens: next(10_000), cacheCreation1hTokens: next(10_000) };
      const p: MicrosPrice = {
        inputPerMTokMicros: next(30_000_000),
        outputPerMTokMicros: next(150_000_000),
        cacheReadPerMTokMicros: next(3_000_000),
        cacheWritePerMTokMicros: next(40_000_000),
        cacheWrite1hPerMTokMicros: next(60_000_000),
      };
      const total =
        usage.inputTokens * p.inputPerMTokMicros +
        usage.outputTokens * p.outputPerMTokMicros +
        usage.cacheReadTokens * (p.cacheReadPerMTokMicros ?? 0) +
        usage.cacheCreation5mTokens * (p.cacheWritePerMTokMicros ?? 0) +
        usage.cacheCreation1hTokens * (p.cacheWrite1hPerMTokMicros ?? 0);
      expect(total).toBeLessThan(1e15); // exact in doubles, so the reference below is exact
      const expected = total % 1_000_000 === 0 ? total / 1_000_000 : Math.floor(total / 1_000_000) + 1;
      expect(costMicros(usage, p)).toBe(expected);
    }
  });

  it('a polluted Object.prototype never supplies a price, a tier or a token count', () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    const bare: MicrosPrice = { inputPerMTokMicros: 1_000_000, outputPerMTokMicros: 1_000_000 };
    try {
      proto.cacheReadPerMTokMicros = 0;
      proto.cacheWritePerMTokMicros = 0;
      proto.longContext = { aboveInputTokens: 1, inputPerMTokMicros: 0, outputPerMTokMicros: 0 };
      proto.inputTokens = 5;
      expect(() => costMicros({ cacheReadTokens: 1_000_000 }, bare)).toThrow(RangeError);
      expect(() => costMicros({ cacheCreation5mTokens: 1 }, bare)).toThrow(RangeError);
      expect(costMicros({ inputTokens: 1_000_000 }, bare)).toBe(1_000_000);
      expect(costMicros({}, bare)).toBe(0);
    } finally {
      for (const key of ['cacheReadPerMTokMicros', 'cacheWritePerMTokMicros', 'longContext', 'inputTokens']) delete proto[key];
    }
  });

  it('hostile input scales linearly: a long bad key and a huge unknown-key usage', () => {
    const cpu = (fn: () => void): number => {
      const start = process.cpuUsage();
      fn();
      const used = process.cpuUsage(start);
      return used.user + used.system;
    };
    const badKey = (n: number) => `a:${'x'.repeat(n)} y`;
    const table = (n: number) => () => {
      try {
        definePricingTable({ checkedAt: '2026-10-01', source: 's', rates: { [badKey(n)]: { inputPerMTokMicros: 1, outputPerMTokMicros: 1 } } });
      } catch {
        /* expected */
      }
    };
    const huge = (n: number) => () => {
      const usage: Record<string, number> = {};
      for (let i = 0; i < n; i++) usage[`k${i}`] = i;
      readAnthropicUsage(usage);
      readOpenAIUsage(usage);
    };
    for (const make of [table, huge]) {
      make(2_000)(); // warm up
      const small = Math.max(cpu(make(20_000)), 1);
      const large = cpu(make(80_000));
      expect(large / small).toBeLessThan(16);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The README example is run as written
// ---------------------------------------------------------------------------

describe('README: integer-micro price table example', () => {
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  function block(anchor: string): string {
    const from = readme.indexOf(anchor);
    expect(from, `README anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0);
    const open = '```js\n';
    const start = readme.indexOf(open, from);
    return readme.slice(start + open.length, readme.indexOf('\n```', start + open.length));
  }
  // The example is dated 2026-10-01, so pin "now" instead of reading the real clock.
  class PinnedDate extends Date {
    constructor(...args: [] | [string | number]) {
      if (args.length === 0) super('2026-10-10T00:00:00Z');
      else super(...args);
    }
  }

  it('runs and prices 2,000 input + 500 output tokens', () => {
    const snippet = block('For budgets that count integers');
    const micros = vm.runInNewContext(`${snippet}\nmicros;`, { definePricingTable, assertPricingFresh, priceFor, costMicros, Date: PinnedDate }) as number;
    expect(micros).toBe(13_500);
  });

  it('the unknown-aware settle snippet runs for both a reading and unknown', () => {
    const snippet = block('These two wrap them for the settle step');
    const run = (usage: unknown): unknown =>
      vm.runInNewContext(`${snippet}\nsettle;`, { readAnthropicUsage, costMicros, response: { usage }, found: { price } });
    expect(run({ input_tokens: 2_000, output_tokens: 500 })).toEqual({ actualAmount: 13_500 });
    expect(run(undefined)).toEqual({ usage: 'unknown' });
  });
});
