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
 * e.g. a caller with no cache usage can pass just `{ inputTokens, outputTokens }`.
 * Every supplied count must be a non-negative safe integer. */
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
 * Both rates must be finite, non-negative numbers. Every supplied token count
 * must be a non-negative safe integer. Invalid inputs and arithmetic overflow
 * throw rather than returning a misleading cost.
 */
export function estimateCostUsd(rates: ModelRates, usage: UsageTokens): number {
  assertRate('inputPerMillion', rates?.inputPerMillion);
  assertRate('outputPerMillion', rates?.outputPerMillion);
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    throw new Error('estimateCostUsd: usage must be an object of token counts');
  }
  // An unrecognized key (a provider's snake_case field, a typo) would
  // otherwise be ignored and its tokens priced at $0.
  for (const key of Object.keys(usage)) {
    if (!USAGE_FIELDS.includes(key as keyof UsageTokens)) {
      throw new Error(
        `estimateCostUsd: usage has unknown field ${JSON.stringify(key)}; ` +
          `expected only ${USAGE_FIELDS.join(', ')}`,
      );
    }
  }

  const inputTokens = tokenCountOrZero(usage, 'inputTokens');
  const outputTokens = tokenCountOrZero(usage, 'outputTokens');
  const cacheReadTokens = tokenCountOrZero(usage, 'cacheReadTokens');
  const cacheCreation5mTokens = tokenCountOrZero(usage, 'cacheCreation5mTokens');
  const cacheCreation1hTokens = tokenCountOrZero(usage, 'cacheCreation1hTokens');

  const unscaledCostUsd =
    inputTokens * rates.inputPerMillion +
    cacheReadTokens * rates.inputPerMillion * CACHE_READ_MULTIPLIER +
    cacheCreation5mTokens * rates.inputPerMillion * CACHE_CREATION_5M_MULTIPLIER +
    cacheCreation1hTokens * rates.inputPerMillion * CACHE_CREATION_1H_MULTIPLIER +
    outputTokens * rates.outputPerMillion;

  if (!Number.isFinite(unscaledCostUsd)) {
    throw new Error('estimateCostUsd: calculated cost must remain finite');
  }

  const costUsd = unscaledCostUsd / 1_000_000;
  if (!Number.isFinite(costUsd)) {
    throw new Error('estimateCostUsd: calculated cost must remain finite');
  }

  return roundToMicroDollar(costUsd);
}

const USAGE_FIELDS: ReadonlyArray<keyof UsageTokens> = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreation5mTokens',
  'cacheCreation1hTokens',
];

function assertRate(field: keyof ModelRates, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`estimateCostUsd: rates.${field} must be a non-negative finite number`);
  }
}

function tokenCountOrZero(usage: UsageTokens, field: keyof UsageTokens): number {
  const value = usage[field];
  if (value === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`estimateCostUsd: usage.${field} must be a non-negative safe integer`);
  }
  return value;
}

/** Round to 6 decimal places (micro-dollar precision) — enough resolution for
 * per-call cost tracking without accumulating floating-point noise across
 * many summed calls. */
function roundToMicroDollar(usd: number): number {
  const roundedUsd = Math.round(usd * 1e6) / 1e6;
  if (!Number.isFinite(roundedUsd)) {
    throw new Error('estimateCostUsd: rounded cost must remain finite');
  }
  return roundedUsd;
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
  // Own keys only: a plain-object table inherits `constructor`, `toString`,
  // `__proto__` and friends, which must never be returned as "rates".
  const rates = Object.hasOwn(table, model) ? table[model] : undefined;
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
