/**
 * pricing.ts — pure, zero-dependency pricing math for LLM API cost estimation.
 *
 * Extracted from the pricing/cache-multiplier pattern used across a portfolio
 * of Anthropic-Claude-calling apps (cruise-almanac's and first's
 * `api/_cost-monitoring.js`, themselves forked from the same lineage). No I/O,
 * no SDK dependency, no product-specific field names — just token counts in,
 * dollars out.
 *
 * THE BUG THIS FIXES
 * -------------------
 * Anthropic's usage payload reports FIVE separate token buckets per call:
 *   - input_tokens                  (uncached, full price)
 *   - cache_read_input_tokens       (served from cache: 0.1x the input rate)
 *   - cache_creation_input_tokens   (writing to cache — but this bucket
 *                                    actually splits into two DIFFERENT TTLs
 *                                    with DIFFERENT multipliers)
 *       - 5-minute cache writes: 1.25x the input rate
 *       - 1-hour cache writes:   2.0x  the input rate
 *   - output_tokens                 (full output price)
 *
 * A real bug in this lineage (AUDIT-2026-05-01-v2, finding A3-CC-E-1)
 * collapsed both cache-creation TTLs into a single flat 1.25x multiplier.
 * That is correct for 5-minute writes but WRONG for 1-hour writes, which
 * actually cost 2.0x. Applying 1.25x to a 1-hour-cache turn under-reports
 * its true cost by (2.0 - 1.25) / 2.0 = 37.5%.
 *
 * That is not a rounding error — it is a cost-tracking system silently
 * telling you a class of calls costs 37.5% less than it actually does. The
 * fix, mirrored here, is to never collapse the two cache-creation buckets:
 * keep cache_read, cache_creation_5m, and cache_creation_1h as three
 * distinct line items, each multiplied by its own rate, always summed
 * separately. See `pricing.test.ts` for a test that proves the collapsed
 * calculation gives a different (wrong) number than the correct one.
 */

/** Per-model list-price rates. Always pass these in explicitly — see preCallCeiling.ts
 * for why this library never ships a hardcoded/default price table. */
export interface ModelRates {
  /** USD per 1,000,000 INPUT tokens, uncached, at list price. */
  inputPerMillion: number;
  /** USD per 1,000,000 OUTPUT tokens, at list price. */
  outputPerMillion: number;
}

/** A pricing table keyed by model id/name, e.g. `{ "claude-sonnet-5": { inputPerMillion: 3, outputPerMillion: 15 } }`.
 * This is a plain data shape — build it however you like (hardcoded map, config file, remote fetch);
 * this library never bundles one, because a bundled price table is exactly the kind of stale-price
 * risk the pre-call ceiling in preCallCeiling.ts is designed to prevent. */
export type PricingTable = Record<string, ModelRates>;

/** cache_read_input_tokens are billed at 10% of the base input rate (a 90% discount). */
export const CACHE_READ_MULTIPLIER = 0.1;

/** Cache-creation writes with a 5-minute TTL are billed at 125% of the base input rate. */
export const CACHE_CREATION_5M_MULTIPLIER = 1.25;

/** Cache-creation writes with a 1-hour TTL are billed at 200% of the base input rate.
 * THIS IS DELIBERATELY DIFFERENT FROM CACHE_CREATION_5M_MULTIPLIER — see the module
 * doc comment above. Never collapse these two into one "cache_creation" multiplier. */
export const CACHE_CREATION_1H_MULTIPLIER = 2.0;

/** Token counts for a single call (or a projected/estimated single call).
 * All fields are optional and default to 0, so callers can pass only what they have —
 * e.g. a caller with no cache usage can pass just `{ inputTokens, outputTokens }`. */
export interface UsageTokens {
  /** Uncached input tokens, billed at the model's full input rate. */
  inputTokens?: number;
  /** Output tokens, billed at the model's full output rate. */
  outputTokens?: number;
  /** Tokens served from a warm cache. Billed at CACHE_READ_MULTIPLIER x the input rate. */
  cacheReadTokens?: number;
  /** Tokens written to cache with a 5-minute TTL. Billed at CACHE_CREATION_5M_MULTIPLIER x the input rate. */
  cacheCreation5mTokens?: number;
  /** Tokens written to cache with a 1-hour TTL. Billed at CACHE_CREATION_1H_MULTIPLIER x the input rate.
   * KEEP THIS SEPARATE from cacheCreation5mTokens — see module doc comment. */
  cacheCreation1hTokens?: number;
}

/**
 * Compute the USD cost of a call (or a projected/estimated call) given its
 * token usage and the model's list-price rates.
 *
 * Every token bucket is priced as its own line item and summed — cache_read,
 * cache_creation_5m, and cache_creation_1h are never collapsed into a single
 * multiplier. This is the fix for the 37.5% under-reporting bug described in
 * the module doc comment.
 *
 * `rates` is a required parameter with no default — see preCallCeiling.ts for
 * why a stale hardcoded price must never silently corrupt a cost estimate.
 */
export function estimateCostUsd(rates: ModelRates, usage: UsageTokens): number {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheCreation5mTokens = usage.cacheCreation5mTokens ?? 0;
  const cacheCreation1hTokens = usage.cacheCreation1hTokens ?? 0;

  const costUsd =
    (inputTokens * rates.inputPerMillion +
      cacheReadTokens * rates.inputPerMillion * CACHE_READ_MULTIPLIER +
      cacheCreation5mTokens * rates.inputPerMillion * CACHE_CREATION_5M_MULTIPLIER +
      cacheCreation1hTokens * rates.inputPerMillion * CACHE_CREATION_1H_MULTIPLIER +
      outputTokens * rates.outputPerMillion) /
    1_000_000;

  return roundToMicroDollar(costUsd);
}

/** Round to 6 decimal places (micro-dollar precision) — enough resolution for
 * per-call cost tracking without accumulating floating-point noise across
 * many summed calls. */
function roundToMicroDollar(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

/**
 * Format a rate pair for logging, mirroring the discipline of printing the
 * rates on every run so a stale/wrong number is visible immediately rather
 * than silently corrupting a cost estimate.
 */
export function formatRatesForLog(rates: ModelRates): string {
  return `$${rates.inputPerMillion}/M in, $${rates.outputPerMillion}/M out`;
}

/** Look up a model's rates in a pricing table, throwing rather than silently
 * falling back to a guessed default. A cost-governance library that quietly
 * substitutes a "close enough" price for an unrecognized model defeats the
 * entire point of computing an exact ceiling — fail loudly instead. */
export function getRatesOrThrow(table: PricingTable, model: string): ModelRates {
  const rates = table[model];
  if (!rates) {
    const known = Object.keys(table).join(', ') || '(empty table)';
    throw new Error(
      `cost-governor-kit: no pricing entry for model "${model}". Known models: ${known}. ` +
        `Add it to your pricing table rather than falling back to a default — a wrong default price ` +
        `defeats the point of a cost ceiling.`,
    );
  }
  return rates;
}
