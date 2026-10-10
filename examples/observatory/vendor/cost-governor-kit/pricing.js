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
import { describe, escapeText, isBlank, isPlainRecord, parseIsoInstant } from './internal.js';
import { buildMicrosRates, estimateCostMicros, priceFor, } from './micros.js';
// Integer-micro prices, tables and exact cost math live in micros.ts.
export { estimateCostMicros, priceFor };
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
    const unscaledCostUsd = sumUnscaledMicros('estimateCostUsd', rates, usage);
    // An overflowed sum is Infinity, and Infinity / 1e6 is still Infinity, so
    // this one check also covers the sum.
    const costUsd = unscaledCostUsd / 1_000_000;
    if (!Number.isFinite(costUsd)) {
        throw new Error('estimateCostUsd: calculated cost must remain finite');
    }
    return roundToMicroDollar(costUsd);
}
/**
 * Validate `rates` and `usage` exactly as {@link estimateCostUsd} documents
 * and return the unscaled sum `input x inRate + ... + output x outRate`,
 * which is the cost in micro-dollars before rounding. `fn` prefixes error
 * messages.
 */
function sumUnscaledMicros(fn, rates, usage) {
    if (!isPlainRecord(rates)) {
        throw new TypeError(`${fn}: rates must be an object with inputPerMillion and outputPerMillion ` +
            '(a plain object; not null, an array, a Map, a Date or a class instance)');
    }
    const inputPerMillion = rates.inputPerMillion;
    assertRate('inputPerMillion', inputPerMillion, fn);
    const outputPerMillion = rates.outputPerMillion;
    assertRate('outputPerMillion', outputPerMillion, fn);
    const cacheReadPerMillion = rates.cacheReadPerMillion;
    if (cacheReadPerMillion !== undefined) {
        assertRate('cacheReadPerMillion', cacheReadPerMillion, fn);
    }
    if (!isPlainRecord(usage)) {
        throw new TypeError(`${fn}: usage must be an object of token counts ` +
            '(a plain object; not null, an array, a Map, a Date or a class instance)');
    }
    // An unrecognized key (a provider's snake_case field, a typo) would
    // otherwise be ignored and its tokens priced at $0. Every own key counts,
    // enumerable or not and string or symbol, so a field cannot hide from this
    // check. A known field that is not enumerable is still read below.
    for (const key of Reflect.ownKeys(usage)) {
        if (typeof key === 'symbol') {
            throw new TypeError(`${fn}: usage has an unknown symbol-keyed field; ` +
                `expected only ${USAGE_FIELDS.join(', ')}`);
        }
        if (!USAGE_FIELDS.includes(key)) {
            throw new TypeError(`${fn}: usage has unknown field ${describe(key)}; ` +
                `expected only ${USAGE_FIELDS.join(', ')}`);
        }
    }
    const inputTokens = tokenCountOrZero('inputTokens', usage.inputTokens, fn);
    const outputTokens = tokenCountOrZero('outputTokens', usage.outputTokens, fn);
    const cacheReadTokens = tokenCountOrZero('cacheReadTokens', usage.cacheReadTokens, fn);
    const cacheCreation5mTokens = tokenCountOrZero('cacheCreation5mTokens', usage.cacheCreation5mTokens, fn);
    const cacheCreation1hTokens = tokenCountOrZero('cacheCreation1hTokens', usage.cacheCreation1hTokens, fn);
    // Preserve the original multiply-sum-divide order for the default path
    // (no override) exactly, so existing rounding results do not shift by a
    // floating-point ULP: only substitute a different expression when
    // cacheReadPerMillion is actually present.
    const cacheReadCostUsd = cacheReadPerMillion !== undefined
        ? cacheReadTokens * cacheReadPerMillion
        : cacheReadTokens * inputPerMillion * CACHE_READ_MULTIPLIER;
    return (inputTokens * inputPerMillion +
        cacheReadCostUsd +
        cacheCreation5mTokens * inputPerMillion * CACHE_CREATION_5M_MULTIPLIER +
        cacheCreation1hTokens * inputPerMillion * CACHE_CREATION_1H_MULTIPLIER +
        outputTokens * outputPerMillion);
}
const USAGE_FIELDS = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreation5mTokens',
    'cacheCreation1hTokens',
];
function assertRate(field, value, fn = 'estimateCostUsd') {
    if (typeof value !== 'number') {
        throw new TypeError(`${fn}: rates.${field} must be a non-negative finite number`);
    }
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${fn}: rates.${field} must be a non-negative finite number`);
    }
}
function tokenCountOrZero(field, value, fn = 'estimateCostUsd') {
    if (value === undefined) {
        return 0;
    }
    if (typeof value !== 'number') {
        throw new TypeError(`${fn}: usage.${field} must be a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${fn}: usage.${field} must be a non-negative safe integer`);
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
// ---------------------------------------------------------------------------
// Provider usage mappers
// ---------------------------------------------------------------------------
/**
 * The strict parser behind {@link usageFromAnthropic}: it maps an Anthropic
 * Messages API `usage` block to {@link UsageTokens} and THROWS wherever the
 * public function reports `unknown`.
 *
 * - `input_tokens` and `output_tokens` are required non-negative safe
 *   integers. (A streaming `message_delta` usage alone is incomplete; merge it
 *   with the `message_start` usage first.)
 * - `cache_read_input_tokens` maps to `cacheReadTokens`.
 * - Cache writes: when the `cache_creation` split is present, its
 *   `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` map to the 5m
 *   and 1h buckets, and `cache_creation_input_tokens`, if also present, must
 *   equal their sum. When the split is absent, the whole
 *   `cache_creation_input_tokens` total is priced as 5-minute writes (the
 *   default TTL), never dropped.
 * - `service_tier` (a string) is accepted and ignored: fold the tier's price
 *   into the prices you pass. `server_tool_use` is accepted only when every
 *   count in it is 0, because per-request tool fees are not priced by this
 *   kit; price them separately and pass a copy without that field.
 * - Nullable fields (`cache_*`, `cache_creation`, `server_tool_use`,
 *   `service_tier`) may be `null`, which counts as absent.
 * - Any other key, at the top level or inside `cache_creation` or
 *   `server_tool_use`, throws a TypeError, so a field this version does not
 *   know about is never priced at $0.
 *
 * @throws TypeError for a non-object, an unknown key or a wrong type;
 *   RangeError for an invalid count, a cache-write total that disagrees with
 *   its split, or a nonzero server-tool count.
 */
function parseAnthropicUsage(usage) {
    const fn = 'usageFromAnthropic';
    const record = readProviderRecord(fn, 'usage', usage, [
        'input_tokens',
        'output_tokens',
        'cache_creation_input_tokens',
        'cache_read_input_tokens',
        'cache_creation',
        'server_tool_use',
        'service_tier',
    ]);
    const inputTokens = readProviderCount(fn, 'input_tokens', record.input_tokens, false);
    const outputTokens = readProviderCount(fn, 'output_tokens', record.output_tokens, false);
    const cacheReadTokens = readProviderCount(fn, 'cache_read_input_tokens', record.cache_read_input_tokens, true);
    const creationTotal = record.cache_creation_input_tokens;
    const split = record.cache_creation;
    const serverToolUse = record.server_tool_use;
    const serviceTier = record.service_tier;
    let cacheCreation5mTokens;
    let cacheCreation1hTokens;
    if (split === undefined || split === null) {
        cacheCreation5mTokens = readProviderCount(fn, 'cache_creation_input_tokens', creationTotal, true);
        cacheCreation1hTokens = 0;
    }
    else {
        const splitRecord = readProviderRecord(fn, 'cache_creation', split, [
            'ephemeral_5m_input_tokens',
            'ephemeral_1h_input_tokens',
        ]);
        cacheCreation5mTokens = readProviderCount(fn, 'cache_creation.ephemeral_5m_input_tokens', splitRecord.ephemeral_5m_input_tokens, true);
        cacheCreation1hTokens = readProviderCount(fn, 'cache_creation.ephemeral_1h_input_tokens', splitRecord.ephemeral_1h_input_tokens, true);
        if (creationTotal !== undefined && creationTotal !== null) {
            const total = readProviderCount(fn, 'cache_creation_input_tokens', creationTotal, true);
            if (total !== cacheCreation5mTokens + cacheCreation1hTokens) {
                throw new RangeError(`${fn}: cache_creation_input_tokens (${total}) does not equal the cache_creation split ` +
                    `(${cacheCreation5mTokens} + ${cacheCreation1hTokens}); refusing to guess which is right`);
            }
        }
    }
    if (serverToolUse !== undefined && serverToolUse !== null) {
        const tools = readProviderRecord(fn, 'server_tool_use', serverToolUse, ['web_search_requests', 'web_fetch_requests']);
        for (const name of ['web_search_requests', 'web_fetch_requests']) {
            const count = readProviderCount(fn, `server_tool_use.${name}`, tools[name], true);
            if (count !== 0) {
                throw new RangeError(`${fn}: server_tool_use.${name} is ${count}; per-request tool fees are not priced by this kit. ` +
                    'Price them separately and pass a copy of usage without server_tool_use.');
            }
        }
    }
    if (serviceTier !== undefined && serviceTier !== null && typeof serviceTier !== 'string') {
        throw new TypeError(`${fn}: service_tier must be a string or null`);
    }
    return { inputTokens, outputTokens, cacheReadTokens, cacheCreation5mTokens, cacheCreation1hTokens };
}
/**
 * The strict parser behind {@link usageFromOpenAI}: it maps an OpenAI `usage`
 * object to {@link UsageTokens} and THROWS wherever the public function
 * reports `unknown`. Accepts either the
 * Chat Completions shape (`prompt_tokens`, `completion_tokens`,
 * `prompt_tokens_details`, `completion_tokens_details`) or the Responses API
 * shape (`input_tokens`, `output_tokens`, `input_tokens_details`,
 * `output_tokens_details`), never a mix.
 *
 * - Cached prompt tokens (`*_details.cached_tokens`) map to `cacheReadTokens`
 *   and are subtracted from the prompt total to get uncached `inputTokens`.
 *   **Set `cacheReadPerMTokMicros` in your price**: OpenAI's cached-input
 *   discount differs by model, and `estimateCostMicros` throws for cache reads
 *   with no cache-read price.
 * - Output maps to `outputTokens`; reasoning and prediction tokens are already
 *   included in it and are only checked (`reasoning_tokens` must not exceed it).
 * - `total_tokens`, when present, must equal prompt + completion.
 * - Audio tokens are billed at different rates, so a nonzero audio count
 *   throws instead of being priced as text.
 * - The `*_details` objects, and counts inside them, may be `null` (absent).
 * - Any other key throws a TypeError.
 *
 * @throws TypeError for a non-object, an unknown key, a mixed shape or a wrong
 *   type; RangeError for an invalid count, cached tokens above the prompt
 *   total, reasoning tokens above the output, a total that does not add up,
 *   or nonzero audio tokens.
 */
function parseOpenAIUsage(usage) {
    const fn = 'usageFromOpenAI';
    const chatKeys = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details'];
    const responsesKeys = ['input_tokens', 'output_tokens', 'total_tokens', 'input_tokens_details', 'output_tokens_details'];
    const record = readProviderRecord(fn, 'usage', usage, [...new Set([...chatKeys, ...responsesKeys])]);
    const hasChat = Object.hasOwn(record, 'prompt_tokens') || Object.hasOwn(record, 'completion_tokens') ||
        Object.hasOwn(record, 'prompt_tokens_details') || Object.hasOwn(record, 'completion_tokens_details');
    const hasResponses = Object.hasOwn(record, 'input_tokens') || Object.hasOwn(record, 'output_tokens') ||
        Object.hasOwn(record, 'input_tokens_details') || Object.hasOwn(record, 'output_tokens_details');
    if (hasChat && hasResponses) {
        throw new TypeError(`${fn}: usage mixes Chat Completions fields (prompt_/completion_) with Responses fields (input_/output_)`);
    }
    const chat = !hasResponses;
    const promptKey = chat ? 'prompt_tokens' : 'input_tokens';
    const outputKey = chat ? 'completion_tokens' : 'output_tokens';
    const promptDetailsKey = chat ? 'prompt_tokens_details' : 'input_tokens_details';
    const outputDetailsKey = chat ? 'completion_tokens_details' : 'output_tokens_details';
    const promptTokens = readProviderCount(fn, promptKey, record[promptKey], false);
    const outputTokens = readProviderCount(fn, outputKey, record[outputKey], false);
    const totalRaw = record.total_tokens;
    const promptDetailsRaw = record[promptDetailsKey];
    const outputDetailsRaw = record[outputDetailsKey];
    let cachedTokens = 0;
    if (promptDetailsRaw !== undefined && promptDetailsRaw !== null) {
        const allowed = chat ? ['cached_tokens', 'audio_tokens'] : ['cached_tokens'];
        const details = readProviderRecord(fn, promptDetailsKey, promptDetailsRaw, allowed);
        cachedTokens = readProviderCount(fn, `${promptDetailsKey}.cached_tokens`, details.cached_tokens, true);
        if (chat)
            assertNoAudio(fn, `${promptDetailsKey}.audio_tokens`, details.audio_tokens);
    }
    if (outputDetailsRaw !== undefined && outputDetailsRaw !== null) {
        const allowed = chat
            ? ['reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']
            : ['reasoning_tokens'];
        const details = readProviderRecord(fn, outputDetailsKey, outputDetailsRaw, allowed);
        const reasoning = readProviderCount(fn, `${outputDetailsKey}.reasoning_tokens`, details.reasoning_tokens, true);
        if (reasoning > outputTokens) {
            throw new RangeError(`${fn}: ${outputDetailsKey}.reasoning_tokens (${reasoning}) exceeds ${outputKey} (${outputTokens})`);
        }
        if (chat) {
            assertNoAudio(fn, `${outputDetailsKey}.audio_tokens`, details.audio_tokens);
            readProviderCount(fn, `${outputDetailsKey}.accepted_prediction_tokens`, details.accepted_prediction_tokens, true);
            readProviderCount(fn, `${outputDetailsKey}.rejected_prediction_tokens`, details.rejected_prediction_tokens, true);
        }
    }
    if (cachedTokens > promptTokens) {
        throw new RangeError(`${fn}: cached_tokens (${cachedTokens}) exceeds ${promptKey} (${promptTokens})`);
    }
    if (totalRaw !== undefined) {
        const total = readProviderCount(fn, 'total_tokens', totalRaw, false);
        if (total !== promptTokens + outputTokens) {
            throw new RangeError(`${fn}: total_tokens (${total}) does not equal ${promptKey} + ${outputKey} (${promptTokens + outputTokens})`);
        }
    }
    return { inputTokens: promptTokens - cachedTokens, outputTokens, cacheReadTokens: cachedTokens };
}
function assertNoAudio(fn, path, value) {
    const count = readProviderCount(fn, path, value, true);
    if (count !== 0) {
        throw new RangeError(`${fn}: ${path} is ${count}; audio tokens are billed at different rates and are not priced by this kit`);
    }
}
/** A plain or null-prototype object whose own keys are all in `allowed`. */
function readProviderRecord(fn, path, value, allowed) {
    if (!isPlainRecord(value)) {
        throw new TypeError(`${fn}: ${path} must be a plain object`);
    }
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') {
            throw new TypeError(`${fn}: ${path} has an unknown symbol-keyed field`);
        }
        if (!allowed.includes(key)) {
            throw new TypeError(`${fn}: ${path} has unknown field ${describe(key)}; expected only ${allowed.join(', ')}`);
        }
    }
    return value;
}
/** A non-negative safe integer. `undefined`, and `null` when `optional`, read as 0. */
function readProviderCount(fn, path, value, optional) {
    if (optional && (value === undefined || value === null))
        return 0;
    if (typeof value !== 'number') {
        throw new TypeError(`${fn}: ${path} must be a non-negative safe integer${optional ? ' or null' : ''}`);
    }
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${fn}: ${path} must be a non-negative safe integer`);
    }
    return value;
}
/** Make every count a plain non-negative number: `-0` reads as `0`. */
function plainCounts(usage) {
    const out = {};
    for (const key of Object.keys(usage)) {
        const count = usage[key];
        if (count !== undefined)
            out[key] = count + 0;
    }
    return out;
}
/** A short, escaped reason from whatever was thrown; never throws itself. */
function reasonOf(error) {
    try {
        if (error instanceof Error && typeof error.message === 'string') {
            return escapeText(error.message.length > 200 ? `${error.message.slice(0, 200)}…` : error.message);
        }
    }
    catch {
        // a hostile error object: fall through to the generic reason
    }
    return 'usage could not be read';
}
function readUsage(parse, usage) {
    try {
        return { status: 'known', usage: plainCounts(parse(usage)) };
    }
    catch (error) {
        return { status: 'unknown', reason: reasonOf(error) };
    }
}
/**
 * Read an Anthropic Messages API `usage` block: `{ status: 'known', usage }`
 * with the token counts, or `{ status: 'unknown', reason }`. Never throws.
 *
 * - `input_tokens` and `output_tokens` are required non-negative safe
 *   integers. (A streaming `message_delta` usage alone is incomplete; merge it
 *   with the `message_start` usage first.)
 * - `cache_read_input_tokens` maps to `cacheReadTokens`.
 * - Cache writes: when the `cache_creation` split is present, its
 *   `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` map to the 5m
 *   and 1h buckets, and `cache_creation_input_tokens`, if also present, must
 *   equal their sum. When the split is absent, the whole
 *   `cache_creation_input_tokens` total is priced as 5-minute writes (the
 *   default TTL), never dropped.
 * - A cache field that is **absent** (or `null`) counts as 0: older API
 *   versions omit them when no caching was used. One that is present but
 *   malformed makes the reading unknown.
 * - `service_tier` (a string) is accepted and ignored: fold the tier's price
 *   into the prices you pass. `server_tool_use` is accepted only when every
 *   count in it is 0, because per-request tool fees are not priced by this kit.
 *
 * The reading is `unknown` when `usage` is missing, `null` or not a plain
 * object; `input_tokens` or `output_tokens` is missing; any count is not a
 * non-negative safe integer (a string such as `"123"`, `NaN`, `Infinity`, a
 * fraction, a BigInt, or above 2^53 - 1); a field this version does not know is
 * present (it might be a new billed bucket); a cache-write total disagrees
 * with its split; tool fees are nonzero; or a getter or Proxy trap throws.
 * `reason` is a short escaped sentence for logs. Each field is read once, and
 * `-0` reads as `0`.
 */
export function usageFromAnthropic(usage) {
    return readUsage(parseAnthropicUsage, usage);
}
/**
 * Read an OpenAI `usage` object (Chat Completions or Responses shape):
 * `{ status: 'known', usage }` or `{ status: 'unknown', reason }`. Never
 * throws. Cached prompt tokens become `cacheReadTokens` and are subtracted
 * from `inputTokens`; a Chat Completions shape and a Responses shape mixed
 * together, cached tokens above the prompt total, a `total_tokens` that does
 * not add up, nonzero audio tokens and every other case that
 * {@link usageFromAnthropic} lists are `unknown`. A response with no `usage`
 * at all is `unknown`, never zero.
 */
export function usageFromOpenAI(usage) {
    return readUsage(parseOpenAIUsage, usage);
}
// ---------------------------------------------------------------------------
// Dated pricing tables
// ---------------------------------------------------------------------------
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
// provider: lowercase letters, digits, '-' or '_'; model: no whitespace (it may contain ':', as some Bedrock ids do).
const PRICING_KEY = /^[a-z0-9][a-z0-9_-]*:\S+$/;
const DAY_MS = 86_400_000;
/**
 * Validate and freeze a dated pricing table. This kit ships no prices: you
 * supply them, with the date you checked them and where you read them.
 *
 * Each entry is `{ inputPerMTokMicros, outputPerMTokMicros,
 * cacheWritePerMTokMicros?, cacheWrite1hPerMTokMicros?, cacheReadPerMTokMicros?,
 * longContext? }`: every price a non-negative safe integer of micro-dollars per
 * million tokens (a value above 2^53 - 1 is rejected and a BigInt is not
 * accepted). Look prices up with {@link priceFor} and cost usage with
 * {@link estimateCostMicros}.
 *
 * Any other key in an entry (a typo like `cacheWritePerMillion`) throws. Keys
 * must look like `provider:model` with a lowercase provider. The result is
 * frozen all the way down, with a null-prototype `rates` record, so editing
 * your input afterward changes nothing. A `-0` price reads as 0. Each entry is
 * read once. Pure: no clock is read here; check age with
 * {@link assertPricingFresh}.
 *
 * @throws TypeError for a wrong type or shape, RangeError for a bad date,
 *   blank source, empty table, malformed key or invalid price.
 */
export function definePricingTable(definition) {
    const fn = 'definePricingTable';
    if (!isPlainRecord(definition)) {
        throw new TypeError(`${fn}: definition must be a plain object with checkedAt, source and rates`);
    }
    const checkedAt = definition.checkedAt;
    const source = definition.source;
    const rawRates = definition.rates;
    readCheckedAt(fn, checkedAt);
    if (typeof source !== 'string') {
        throw new TypeError(`${fn}: source must be a non-blank string`);
    }
    if (isBlank(source)) {
        throw new RangeError(`${fn}: source must be a non-blank string`);
    }
    if (!isPlainRecord(rawRates)) {
        throw new TypeError(`${fn}: rates must be a plain object keyed by provider:model`);
    }
    const keys = Reflect.ownKeys(rawRates);
    if (keys.length === 0) {
        throw new RangeError(`${fn}: rates must have at least one entry`);
    }
    // Validate every key, then read every entry exactly once.
    const entries = [];
    for (const key of keys) {
        if (typeof key === 'symbol') {
            throw new TypeError(`${fn}: rates has a symbol key; keys must be provider:model strings`);
        }
        if (!PRICING_KEY.test(key) || escapeText(key) !== key) {
            throw new RangeError(`${fn}: rates key ${describe(key)} must look like provider:model (lowercase provider, no spaces)`);
        }
        entries.push([key, rawRates[key]]);
    }
    return Object.freeze({ checkedAt: checkedAt, source, rates: buildMicrosRates(fn, entries) });
}
/**
 * Throw unless `table` was checked within the last `maxAgeDays` days of
 * `now`. Call it at startup or per request, with a `now` from your clock.
 * The options object's two fields are each read once, and any other key is
 * rejected.
 *
 * A table that is exactly `maxAgeDays` old passes; one millisecond older
 * fails. A `checkedAt` up to one day in the future is allowed (a date written
 * in a time zone ahead of UTC); further in the future throws.
 *
 * @throws TypeError or RangeError for a malformed table or options, an invalid
 *   `now`, or a `maxAgeDays` that is not a finite number > 0; RangeError for a
 *   `checkedAt` more than a day in the future; Error when the table is older
 *   than `maxAgeDays` (the message names its date, age and source).
 */
export function assertPricingFresh(table, options) {
    const fn = 'assertPricingFresh';
    if (!isPlainRecord(table)) {
        throw new TypeError(`${fn}: table must come from definePricingTable`);
    }
    const checkedAt = table.checkedAt;
    const source = table.source;
    const checkedMs = readCheckedAt(fn, checkedAt);
    if (!isPlainRecord(options)) {
        throw new TypeError(`${fn}: options must be { now, maxAgeDays }`);
    }
    for (const key of Reflect.ownKeys(options)) {
        if (key !== 'now' && key !== 'maxAgeDays') {
            throw new TypeError(`${fn}: options must have only now and maxAgeDays`);
        }
    }
    const now = Object.hasOwn(options, 'now') ? options.now : undefined;
    const maxAgeDays = Object.hasOwn(options, 'maxAgeDays') ? options.maxAgeDays : undefined;
    let nowMs;
    try {
        nowMs = Date.prototype.getTime.call(now);
    }
    catch {
        throw new TypeError(`${fn}: now must be a Date`);
    }
    if (!Number.isFinite(nowMs)) {
        throw new RangeError(`${fn}: now must be a valid Date`);
    }
    if (typeof maxAgeDays !== 'number') {
        throw new TypeError(`${fn}: maxAgeDays must be a finite number > 0`);
    }
    if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
        throw new RangeError(`${fn}: maxAgeDays must be a finite number > 0`);
    }
    const ageMs = nowMs - checkedMs;
    if (ageMs < -DAY_MS) {
        throw new RangeError(`${fn}: checkedAt ${describe(checkedAt)} is in the future; fix the date`);
    }
    if (ageMs > maxAgeDays * DAY_MS) {
        const ageDays = Math.floor(ageMs / DAY_MS);
        throw new Error(`cost-governor-kit: pricing table checked ${describe(checkedAt)} is ${ageDays} days old ` +
            `(limit ${maxAgeDays}); re-check the prices at ${typeof source === 'string' ? describe(source) : 'their source'} ` +
            'and update checkedAt.');
    }
}
/** Parse a `checkedAt` (date-only or zoned instant) to epoch ms, or throw. */
function readCheckedAt(fn, checkedAt) {
    if (typeof checkedAt !== 'string') {
        throw new TypeError(`${fn}: checkedAt must be a YYYY-MM-DD date or an ISO-8601 date-time with a zone`);
    }
    const dateOnly = DATE_ONLY.exec(checkedAt);
    const ms = dateOnly ? parseIsoInstant(`${checkedAt}T00:00:00Z`) : parseIsoInstant(checkedAt);
    if (ms === undefined) {
        throw new RangeError(`${fn}: checkedAt ${describe(checkedAt)} must be a real YYYY-MM-DD date or an ISO-8601 date-time with a zone`);
    }
    return ms;
}
