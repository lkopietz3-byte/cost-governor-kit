/**
 * learning-round-readers.test.ts: verdict rows from the 2026-10-10 field trial
 * of the usage readers against current provider SDK response shapes. The
 * inputs are fresh synthetic objects with the field names and types the SDK
 * declares (read from the official TypeScript SDK type files); none of the
 * trial's own text is reproduced.
 *
 * Rule for every row: a field that the SDK declares as part of the current
 * response and that cannot change the bill is accepted; a field that could
 * change the bill and that the kit cannot price stays unknown.
 */
import { describe, expect, it } from 'vitest';
import { checkPreCallCeiling, usageFromAnthropic, usageFromAnthropicStream, usageFromOpenAI, usageFromOpenAIEmbeddings, type UsageReading } from '../src/index.js';

const known = (reading: UsageReading) => (reading.status === 'known' ? reading.usage : 'unknown');

/** The shape a current non-beta Anthropic response carries (every field the SDK declares). */
const sdkShaped = {
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  inference_geo: 'global',
  input_tokens: 120,
  output_tokens: 40,
  output_tokens_details: { thinking_tokens: 15 },
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  service_tier: 'standard',
};

describe('Anthropic: current SDK fields', () => {
  it('R1 a full SDK-shaped usage is known and priced on input and output only', () => {
    expect(known(usageFromAnthropic(sdkShaped))).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
    });
  });

  it('R1b null for every nullable SDK field is known', () => {
    const allNull = {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 1,
      output_tokens: 2,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    };
    expect(usageFromAnthropic(allNull).status).toBe('known');
  });

  it('R2 inference_geo: null and the default region are known; another region is unknown unless allowed', () => {
    expect(usageFromAnthropic({ ...sdkShaped, inference_geo: null }).status).toBe('known');
    const us = usageFromAnthropic({ ...sdkShaped, inference_geo: 'us' });
    expect(us.status).toBe('unknown');
    expect(us.status === 'unknown' && us.reason).toMatch(/inference_geo/);
    expect(usageFromAnthropic({ ...sdkShaped, inference_geo: 'us' }, { allowInferenceGeo: ['us'] }).status).toBe('known');
    expect(usageFromAnthropic({ ...sdkShaped, inference_geo: 'eu' }, { allowInferenceGeo: ['us'] }).status).toBe('unknown');
    expect(usageFromAnthropic({ ...sdkShaped, inference_geo: 5 }).status).toBe('unknown');
    expect(usageFromAnthropic({ ...sdkShaped, inference_geo: '' }).status).toBe('unknown');
  });

  it('R3 output_tokens_details is informational: thinking tokens must fit inside output_tokens', () => {
    expect(usageFromAnthropic({ ...sdkShaped, output_tokens_details: { thinking_tokens: 40 } }).status).toBe('known');
    expect(usageFromAnthropic({ ...sdkShaped, output_tokens_details: {} }).status).toBe('known');
    expect(usageFromAnthropic({ ...sdkShaped, output_tokens_details: { thinking_tokens: 41 } }).status).toBe('unknown');
    expect(usageFromAnthropic({ ...sdkShaped, output_tokens_details: { thinking_tokens: '5' } }).status).toBe('unknown');
    expect(usageFromAnthropic({ ...sdkShaped, output_tokens_details: { thinking_tokens: 5, mystery: 1 } }).status).toBe('unknown');
    expect(usageFromAnthropic({ ...sdkShaped, output_tokens_details: [] }).status).toBe('unknown');
    // The billed total is output_tokens; the detail never adds to it.
    expect(known(usageFromAnthropic(sdkShaped))).toMatchObject({ outputTokens: 40 });
  });

  it('R4 beta fields: null is known, a populated value that changes billing is unknown', () => {
    expect(usageFromAnthropic({ ...sdkShaped, speed: null, iterations: null, fallback_credit: null }).status).toBe('known');
    expect(usageFromAnthropic({ ...sdkShaped, speed: 'standard' }).status).toBe('known');
    expect(usageFromAnthropic({ ...sdkShaped, speed: 'fast' }).status).toBe('unknown');
    expect(usageFromAnthropic({ ...sdkShaped, iterations: [{ type: 'message', input_tokens: 1, output_tokens: 1 }] }).status).toBe('unknown');
    expect(usageFromAnthropic({ ...sdkShaped, fallback_credit: { status: { type: 'redeemed' } } }).status).toBe('unknown');
  });

  it('R5 a field the SDK does not declare is still unknown', () => {
    expect(usageFromAnthropic({ ...sdkShaped, brand_new_bucket: 3 }).status).toBe('unknown');
  });

  it('R6 options are static configuration: a malformed options object throws', () => {
    expect(() => usageFromAnthropic(sdkShaped, { allowInferenceGeo: 'us' } as never)).toThrow(TypeError);
    expect(() => usageFromAnthropic(sdkShaped, { allowInferenceGeo: [5] } as never)).toThrow(TypeError);
    expect(() => usageFromAnthropic(sdkShaped, { other: 1 } as never)).toThrow(TypeError);
    expect(() => usageFromAnthropic(sdkShaped, null as never)).toThrow(TypeError);
  });
});

describe('Anthropic: a stream is only final after message_delta', () => {
  const start = { ...sdkShaped, input_tokens: 377, output_tokens: 1, output_tokens_details: null, cache_creation_input_tokens: 0 };
  const delta = { input_tokens: null, output_tokens: 812, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null };

  it('R7 a message_start snapshot alone is the partial the field trial recorded as known: it is still what usageFromAnthropic reads (a snapshot cannot say it is partial)', () => {
    expect(usageFromAnthropic(start).status).toBe('known');
  });

  it('R8 usageFromAnthropicStream: no message_delta seen is unknown (an aborted stream is not nearly free)', () => {
    for (const missing of [undefined, null]) {
      const reading = usageFromAnthropicStream(start, missing);
      expect(reading.status).toBe('unknown');
      expect(reading.status === 'unknown' && reading.reason).toMatch(/message_delta/);
    }
  });

  it('R9 start plus final delta merges: the delta wins where it has a value, the start fills the nulls', () => {
    expect(known(usageFromAnthropicStream(start, delta))).toEqual({
      inputTokens: 377,
      outputTokens: 812,
      cacheReadTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
    });
    expect(known(usageFromAnthropicStream(start, { ...delta, input_tokens: 380, cache_read_input_tokens: 9 }))).toMatchObject({ inputTokens: 380, cacheReadTokens: 9 });
  });

  it('R10 a delta without a numeric output_tokens is not final, whatever the start says', () => {
    expect(usageFromAnthropicStream(start, { ...delta, output_tokens: null }).status).toBe('unknown');
    expect(usageFromAnthropicStream(start, { input_tokens: null }).status).toBe('unknown');
    expect(usageFromAnthropicStream(start, { ...delta, output_tokens: '812' }).status).toBe('unknown');
  });

  it('R11 a hostile delta or start is unknown, never a throw, and each field is read once', () => {
    const trap = new Proxy({}, { get() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); } });
    expect(usageFromAnthropicStream(start, trap).status).toBe('unknown');
    expect(usageFromAnthropicStream(trap, delta).status).toBe('unknown');
    expect(usageFromAnthropicStream('x', delta).status).toBe('unknown');
    let reads = 0;
    const counted = { ...delta };
    Object.defineProperty(counted, 'output_tokens', { enumerable: true, get() { reads++; return reads === 1 ? 50 : -1; } });
    expect(known(usageFromAnthropicStream(start, counted))).toMatchObject({ outputTokens: 50 });
    expect(reads).toBe(1);
  });

  it('R11b a field the reader does not know is refused even when the delta sends it as null (cx review finding)', () => {
    expect(usageFromAnthropicStream(start, { ...delta, new_billed_bucket: null }).status).toBe('unknown');
    expect(usageFromAnthropicStream(start, { ...delta, new_billed_bucket: undefined }).status).toBe('unknown');
    expect(usageFromAnthropicStream(start, { ...delta, new_billed_bucket: 0 }).status).toBe('unknown');
  });

  it('R12 a delta that changes the cache-write total away from the start split is unknown, not guessed', () => {
    const split = { ...start, cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 } };
    expect(usageFromAnthropicStream(split, { ...delta, cache_creation_input_tokens: 25 }).status).toBe('unknown');
    expect(known(usageFromAnthropicStream(split, { ...delta, cache_creation_input_tokens: 10 }))).toMatchObject({ cacheCreation5mTokens: 10 });
  });
});

describe('OpenAI: current SDK fields', () => {
  const responses = {
    input_tokens: 100,
    input_tokens_details: { cache_write_tokens: 0, cached_tokens: 20 },
    output_tokens: 50,
    output_tokens_details: { reasoning_tokens: 10 },
    total_tokens: 150,
  };

  it('R13 Responses usage with a zero cache_write_tokens is known', () => {
    expect(known(usageFromOpenAI(responses))).toEqual({ inputTokens: 80, outputTokens: 50, cacheReadTokens: 20 });
  });

  it('R14 a nonzero cache_write_tokens is unknown (no priced bucket for it), in both shapes', () => {
    const w = usageFromOpenAI({ ...responses, input_tokens_details: { cache_write_tokens: 5, cached_tokens: 0 } });
    expect(w.status).toBe('unknown');
    expect(w.status === 'unknown' && w.reason).toMatch(/cache_write_tokens/);
    expect(usageFromOpenAI({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cache_write_tokens: 5 } }).status).toBe('unknown');
    expect(usageFromOpenAI({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cache_write_tokens: 0 } }).status).toBe('known');
    expect(usageFromOpenAI({ ...responses, input_tokens_details: { cache_write_tokens: '0', cached_tokens: 0 } }).status).toBe('unknown');
  });

  it('R15 chat text_tokens are informational; image tokens could bill differently, so nonzero image tokens are unknown', () => {
    const chat = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    expect(usageFromOpenAI({ ...chat, prompt_tokens_details: { text_tokens: 100, image_tokens: 0 }, completion_tokens_details: { text_tokens: 20 } }).status).toBe('known');
    expect(usageFromOpenAI({ ...chat, prompt_tokens_details: { text_tokens: 60, image_tokens: 40 } }).status).toBe('unknown');
    expect(usageFromOpenAI({ ...chat, prompt_tokens_details: { text_tokens: -1 } }).status).toBe('unknown');
  });

  it('R16 an extra top-level field from another provider still makes the reading unknown', () => {
    expect(usageFromOpenAI({ prompt_tokens: 5, completion_tokens: 1, cached_tokens: 3 }).status).toBe('unknown');
  });
});

describe('OpenAI embeddings', () => {
  it('R17 prompt_tokens + total_tokens is a known input-only reading from the embeddings reader', () => {
    expect(known(usageFromOpenAIEmbeddings({ prompt_tokens: 12, total_tokens: 12 }))).toEqual({ inputTokens: 12 });
    expect(known(usageFromOpenAIEmbeddings({ prompt_tokens: 12 }))).toEqual({ inputTokens: 12 });
  });

  it('R18 the chat reader still refuses that shape (a chat usage with no completion_tokens is not read as input-only)', () => {
    expect(usageFromOpenAI({ prompt_tokens: 12, total_tokens: 12 }).status).toBe('unknown');
  });

  it('R19 the embeddings reader is strict: a mismatched total, extra fields, bad counts, missing usage are unknown', () => {
    for (const bad of [
      { prompt_tokens: 12, total_tokens: 13 },
      { prompt_tokens: 12, total_tokens: 12, completion_tokens: 0 },
      { prompt_tokens: '12', total_tokens: 12 },
      { prompt_tokens: -1, total_tokens: -1 },
      { total_tokens: 12 },
      {},
      null,
      undefined,
    ]) {
      expect(usageFromOpenAIEmbeddings(bad).status).toBe('unknown');
    }
  });
});

describe('checkPreCallCeiling: requireOutputTokens (a missing output bound priced at $0 was the field trial false pass)', () => {
  const rates = { inputPerMillion: 3, outputPerMillion: 15 };
  const base = { spentSoFarUsd: 24.99, ceilingUsd: 25, rates };

  it('P1 off by default: the old behavior is unchanged (a missing outputTokens is priced at $0)', () => {
    expect(checkPreCallCeiling({ ...base, estimatedNextCallUsage: { inputTokens: 2_000 } }).allowed).toBe(true);
  });

  it('P2 on: a missing outputTokens throws instead of allowing', () => {
    expect(() => checkPreCallCeiling({ ...base, estimatedNextCallUsage: { inputTokens: 2_000 }, requireOutputTokens: true })).toThrow(/outputTokens is required/);
    expect(() => checkPreCallCeiling({ ...base, estimatedNextCallUsage: { inputTokens: 2_000, outputTokens: undefined }, requireOutputTokens: true })).toThrow(TypeError);
  });

  it('P3 on: with outputTokens present the answer is the ordinary one (a bound of 0 is a real bound)', () => {
    const over = checkPreCallCeiling({ ...base, estimatedNextCallUsage: { inputTokens: 2_000, outputTokens: 4_000 }, requireOutputTokens: true });
    expect(over.allowed).toBe(false);
    expect(checkPreCallCeiling({ ...base, estimatedNextCallUsage: { inputTokens: 1, outputTokens: 0 }, requireOutputTokens: true }).allowed).toBe(true);
  });

  it('P4 requireOutputTokens must be a boolean, and false is the default', () => {
    expect(() => checkPreCallCeiling({ ...base, estimatedNextCallUsage: { outputTokens: 1 }, requireOutputTokens: 'yes' as never })).toThrow(TypeError);
    expect(checkPreCallCeiling({ ...base, estimatedNextCallUsage: { inputTokens: 1 }, requireOutputTokens: false }).allowed).toBe(true);
  });

  it('P6 an own __proto__ key in the usage is an unknown key, with the flag on or off (cx review finding)', () => {
    const usage = JSON.parse('{"inputTokens":1,"outputTokens":1,"__proto__":null}') as never;
    expect(() => checkPreCallCeiling({ ...base, estimatedNextCallUsage: usage })).toThrow(TypeError);
    expect(() => checkPreCallCeiling({ ...base, estimatedNextCallUsage: usage, requireOutputTokens: true })).toThrow(TypeError);
  });

  it('P5 the usage is read once even with the flag on, and bad usage is still rejected', () => {
    let reads = 0;
    const usage = { inputTokens: 1 };
    Object.defineProperty(usage, 'outputTokens', { enumerable: true, get() { reads++; return reads === 1 ? 10 : undefined; } });
    expect(checkPreCallCeiling({ ...base, estimatedNextCallUsage: usage, requireOutputTokens: true }).allowed).toBe(true);
    expect(reads).toBe(1);
    expect(() => checkPreCallCeiling({ ...base, estimatedNextCallUsage: { outputTokens: 1, surprise: 2 } as never, requireOutputTokens: true })).toThrow(TypeError);
    expect(() => checkPreCallCeiling({ ...base, estimatedNextCallUsage: new Map() as never, requireOutputTokens: true })).toThrow(TypeError);
  });
});
