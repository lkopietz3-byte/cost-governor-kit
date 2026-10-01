/**
 * pricing.ts — pure, zero-dependency pricing math for LLM API cost estimation.
 *
 * Extracted from the pricing/cache-multiplier pattern in the author's own
 * Anthropic-calling apps (cruise-almanac's and first's
 * `api/_cost-monitoring.js`). No I/O, no SDK dependency, no product-specific
 * field names: token counts in, dollars out.
 *
 * THE BUG THIS FIXES
 * -------------------
 * Anthropic's usage payload reports input in separate buckets:
 *   - input_tokens                  (uncached remainder, base input rate)
 *   - cache_read_input_tokens       (served from cache; 0.1x the input rate
 *                                    on most models, see CACHE_READ_MULTIPLIER)
 *   - cache_creation_input_tokens   (written to cache; the total of
 *                                    cache_creation.ephemeral_5m_input_tokens
 *                                    at 1.25x and
 *                                    cache_creation.ephemeral_1h_input_tokens
 *                                    at 2x the input rate)
 *   - output_tokens                 (output rate)
 *
 * A real bug in that lineage (AUDIT-2026-05-01-v2, finding A3-CC-E-1)
 * collapsed both cache-creation TTLs into a single flat 1.25x multiplier.
 * That is correct for 5-minute writes but wrong for 1-hour writes, which cost
 * 2x. Applying 1.25x to a 1-hour write under-reports its cost by
 * (2.0 - 1.25) / 2.0 = 37.5%. This module keeps cache reads, 5-minute writes
 * and 1-hour writes as three distinct line items, each with its own
 * multiplier. `pricing.test.ts` shows the collapsed calculation gives a
 * different number.
 */
import { describe, escapeText, isPlainRecord } from './internal.js';
/**
 * Cache reads (`cache_read_input_tokens`) are priced at 0.1x the base input
 * rate by default. This matches Anthropic's standard multiplier, but not
 * every model: Anthropic's pricing page (checked 2026-09-24) lists 0.025x for
 * Claude Fable 5.1 and Claude Mythos 5.1 and 0.05x for Claude Opus 5.5. For
 * those models this default over-estimates cache-read cost (4x and 2x). Set
 * {@link ModelRates.cacheReadPerMillion} to price such a model exactly
 * (preferred), or price its cache reads in a separate call with
 * `inputPerMillion` scaled by (model multiplier / 0.1).
 */
export const CACHE_READ_MULTIPLIER = 0.1;
/** 5-minute-TTL cache writes (`cache_creation.ephemeral_5m_input_tokens`) are priced at 1.25x the base input rate. */
export const CACHE_CREATION_5M_MULTIPLIER = 1.25;
/**
 * 1-hour-TTL cache writes (`cache_creation.ephemeral_1h_input_tokens`) are
 * priced at 2x the base input rate. Deliberately different from
 * {@link CACHE_CREATION_5M_MULTIPLIER}; never collapse the two.
 */
export const CACHE_CREATION_1H_MULTIPLIER = 2.0;
/**
 * Compute the USD cost of one call, actual or projected.
 *
 * Formula, in this order, in IEEE-754 double precision:
 * `(input x inRate + cacheRead x readRate + write5m x inRate x 1.25 +
 * write1h x inRate x 2 + output x outRate) / 1,000,000`, then rounded to the
 * nearest micro-dollar ($0.000001) with `Math.round`, where `readRate` is
 * `rates.cacheReadPerMillion` when supplied, otherwise `inRate x 0.1`
 * ({@link CACHE_READ_MULTIPLIER}).
 *
 * Rounding policy: a value exactly halfway between two micro-dollars in binary
 * rounds up, but a cost that is a decimal half (for example 50 tokens at
 * $0.29/M = 14.5 micro-dollars) can round down because the intermediate
 * arithmetic is binary. A call cheaper than $0.0000005 returns 0. The result
 * is always the double nearest a whole number of micro-dollars, so it compares
 * equal to a decimal literal such as `0.0195`.
 *
 * Each field of `rates` and `usage` is read exactly once, before anything is
 * priced, and the cost is computed from those values, so a getter or proxy
 * that answers differently the second time cannot change the result.
 *
 * @param rates - Caller-supplied rates; there is no default. Both must be finite and >= 0.
 * @param usage - Token counts; see {@link UsageTokens}.
 * @returns Cost in USD, rounded to the nearest micro-dollar.
 * @throws TypeError if `rates` or `usage` is not a plain or null-prototype
 *   object (`null`, `undefined`, a primitive, an array, a `Map`, `Set`,
 *   `Date`, `RegExp` or class instance), a rate is not a number, an unknown
 *   usage key is present (any own key that is not one of the five bucket names:
 *   string or symbol, enumerable or not), or a token count is not a number.
 *   A known bucket is read and validated whether or not it is enumerable.
 * @throws RangeError if a rate or token count is negative, non-finite (`NaN`
 *   or `Infinity`), or not a safe integer (token counts only). Error messages
 *   name the field but never echo the rejected value; an unknown usage key is
 *   echoed escaped.
 * @throws Error (not TypeError/RangeError) only for the internal "result
 *   must remain finite" safety net below: that guards the computed cost,
 *   not a single bad input field.
 */
export function estimateCostUsd(rates, usage) {
    if (!isPlainRecord(rates)) {
        throw new TypeError('estimateCostUsd: rates must be an object with inputPerMillion and outputPerMillion ' +
            '(a plain object; not null, an array, a Map, a Date or a class instance)');
    }
    const inputPerMillion = rates.inputPerMillion;
    assertRate('inputPerMillion', inputPerMillion);
    const outputPerMillion = rates.outputPerMillion;
    assertRate('outputPerMillion', outputPerMillion);
    const cacheReadPerMillion = rates.cacheReadPerMillion;
    if (cacheReadPerMillion !== undefined) {
        assertRate('cacheReadPerMillion', cacheReadPerMillion);
    }
    if (!isPlainRecord(usage)) {
        throw new TypeError('estimateCostUsd: usage must be an object of token counts ' +
            '(a plain object; not null, an array, a Map, a Date or a class instance)');
    }
    // An unrecognized key (a provider's snake_case field, a typo) would
    // otherwise be ignored and its tokens priced at $0. Every own key counts,
    // enumerable or not and string or symbol, so a field cannot hide from this
    // check. A known field that is not enumerable is still read below.
    for (const key of Reflect.ownKeys(usage)) {
        if (typeof key === 'symbol') {
            throw new TypeError('estimateCostUsd: usage has an unknown symbol-keyed field; ' +
                `expected only ${USAGE_FIELDS.join(', ')}`);
        }
        if (!USAGE_FIELDS.includes(key)) {
            throw new TypeError(`estimateCostUsd: usage has unknown field ${describe(key)}; ` +
                `expected only ${USAGE_FIELDS.join(', ')}`);
        }
    }
    const inputTokens = tokenCountOrZero('inputTokens', usage.inputTokens);
    const outputTokens = tokenCountOrZero('outputTokens', usage.outputTokens);
    const cacheReadTokens = tokenCountOrZero('cacheReadTokens', usage.cacheReadTokens);
    const cacheCreation5mTokens = tokenCountOrZero('cacheCreation5mTokens', usage.cacheCreation5mTokens);
    const cacheCreation1hTokens = tokenCountOrZero('cacheCreation1hTokens', usage.cacheCreation1hTokens);
    // Preserve the original multiply-sum-divide order for the default path
    // (no override) exactly, so existing rounding results do not shift by a
    // floating-point ULP: only substitute a different expression when
    // cacheReadPerMillion is actually present.
    const cacheReadCostUsd = cacheReadPerMillion !== undefined
        ? cacheReadTokens * cacheReadPerMillion
        : cacheReadTokens * inputPerMillion * CACHE_READ_MULTIPLIER;
    const unscaledCostUsd = inputTokens * inputPerMillion +
        cacheReadCostUsd +
        cacheCreation5mTokens * inputPerMillion * CACHE_CREATION_5M_MULTIPLIER +
        cacheCreation1hTokens * inputPerMillion * CACHE_CREATION_1H_MULTIPLIER +
        outputTokens * outputPerMillion;
    // An overflowed sum is Infinity, and Infinity / 1e6 is still Infinity, so
    // this one check also covers the sum.
    const costUsd = unscaledCostUsd / 1_000_000;
    if (!Number.isFinite(costUsd)) {
        throw new Error('estimateCostUsd: calculated cost must remain finite');
    }
    return roundToMicroDollar(costUsd);
}
const USAGE_FIELDS = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreation5mTokens',
    'cacheCreation1hTokens',
];
function assertRate(field, value) {
    if (typeof value !== 'number') {
        throw new TypeError(`estimateCostUsd: rates.${field} must be a non-negative finite number`);
    }
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`estimateCostUsd: rates.${field} must be a non-negative finite number`);
    }
}
function tokenCountOrZero(field, value) {
    if (value === undefined) {
        return 0;
    }
    if (typeof value !== 'number') {
        throw new TypeError(`estimateCostUsd: usage.${field} must be a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`estimateCostUsd: usage.${field} must be a non-negative safe integer`);
    }
    return value;
}
/** Round to 6 decimal places (micro-dollar precision) — enough resolution for
 * per-call cost tracking without accumulating floating-point noise across
 * many summed calls. */
function roundToMicroDollar(usd) {
    const roundedUsd = Math.round(usd * 1e6) / 1e6;
    if (!Number.isFinite(roundedUsd)) {
        throw new Error('estimateCostUsd: rounded cost must remain finite');
    }
    return roundedUsd;
}
/**
 * Format a rate pair for logging, e.g. `"$3/M in, $15/M out"`. Log it on
 * every run so a stale or wrong rate is visible.
 *
 * Numbers are printed with JavaScript's default formatting and are not
 * validated or rounded: `NaN` prints as `$NaN/M`. A value that is not a number
 * is printed by kind (a string is quoted, with control, line-break and bidi
 * characters escaped), never through its own `toString`, so a bad rate cannot
 * forge a log line or send a terminal escape. Each rate is read once.
 *
 * @throws TypeError if `rates` is not a plain or null-prototype object
 *   (`null`, `undefined`, an array, a `Map`, `Date`, class instance, ...).
 */
export function formatRatesForLog(rates) {
    if (!isPlainRecord(rates)) {
        throw new TypeError('formatRatesForLog: rates must be an object with inputPerMillion and outputPerMillion ' +
            '(a plain object; not null, an array, a Map, a Date or a class instance)');
    }
    const inputPerMillion = rates.inputPerMillion;
    const outputPerMillion = rates.outputPerMillion;
    // describe() prints a number exactly as String() does and anything else by kind.
    return `$${describe(inputPerMillion)}/M in, $${describe(outputPerMillion)}/M out`;
}
/**
 * Look up a model's rates in a pricing table, throwing instead of falling back
 * to a guessed default.
 *
 * Only the table's own keys match: inherited names such as `constructor`,
 * `toString` or `__proto__` throw like any unknown model. The returned
 * entry is the table's own object, not a copy, and is not validated here;
 * {@link estimateCostUsd} validates rates when it uses them. The model name
 * and the known-model list in the error message are escaped, so a model name
 * cannot forge a log line.
 *
 * @throws TypeError if `table` is not a plain or null-prototype object (a
 *   `Map` is rejected, not read as an empty table) or `model` is not a string
 *   (a `String` object, an array or an object with a `toString` is never
 *   coerced into a key).
 * @throws Error naming the model and listing the table's known models. Plain
 *   `Error`, not `TypeError`/`RangeError`: `model` isn't malformed input,
 *   it's a validly-shaped key that has no configured entry — the same
 *   "unconfigured lookup key" case trust-core's `identified.signalWeight`
 *   also leaves as a plain `Error`.
 */
export function getRatesOrThrow(table, model) {
    if (!isPlainRecord(table)) {
        throw new TypeError('getRatesOrThrow: table must be an object keyed by model id ' +
            '(a plain object; not null, an array, a Map, a Date or a class instance)');
    }
    if (typeof model !== 'string') {
        throw new TypeError('getRatesOrThrow: model must be a string');
    }
    // Own keys only: a plain-object table inherits `constructor`, `toString`,
    // `__proto__` and friends, which must never be returned as "rates".
    const rates = Object.hasOwn(table, model) ? table[model] : undefined;
    if (!rates) {
        const known = Object.keys(table).map(escapeText).join(', ') || '(empty table)';
        throw new Error(`cost-governor-kit: no pricing entry for model "${escapeText(model)}". Known models: ${known}. ` +
            `Add it to your pricing table rather than falling back to a default — a wrong default price ` +
            `defeats the point of a cost ceiling.`);
    }
    return rates;
}
