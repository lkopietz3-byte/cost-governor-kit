import { describe, isPlainRecord } from './internal.js';
const RATE_FIELDS = [
    'inputPerMTokMicros',
    'outputPerMTokMicros',
    'cacheWritePerMTokMicros',
    'cacheWrite1hPerMTokMicros',
    'cacheReadPerMTokMicros',
];
const REQUIRED_RATE_FIELDS = ['inputPerMTokMicros', 'outputPerMTokMicros'];
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
function readRate(fn, where, field, value, required) {
    if (value === undefined) {
        if (required)
            throw new TypeError(`${fn}: ${where}.${field} is required: a safe integer number of micro-dollars per million tokens`);
        return undefined;
    }
    if (typeof value !== 'number') {
        throw new TypeError(`${fn}: ${where}.${field} must be a safe integer number of micro-dollars per million tokens (BigInt is not accepted)`);
    }
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${fn}: ${where}.${field} must be a non-negative safe integer (micro-dollars per million tokens)`);
    }
    return value + 0; // -0 reads as 0
}
function readRateSet(fn, where, value, extra) {
    if (!isPlainRecord(value)) {
        throw new TypeError(`${fn}: ${where} must be a plain object with ${REQUIRED_RATE_FIELDS.join(' and ')}`);
    }
    const allowed = [...RATE_FIELDS, ...extra];
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol' || !allowed.includes(key)) {
            throw new TypeError(`${fn}: ${where} has unknown field ${typeof key === 'symbol' ? '(a symbol)' : describe(key)}; expected only ${allowed.join(', ')}`);
        }
    }
    const out = {};
    for (const field of RATE_FIELDS) {
        // Own fields only, each read once.
        const raw = Object.hasOwn(value, field) ? value[field] : undefined;
        const rate = readRate(fn, where, field, raw, REQUIRED_RATE_FIELDS.includes(field));
        if (rate !== undefined)
            out[field] = rate;
    }
    return out;
}
/**
 * Validate one integer-micro price and return a fresh, deeply frozen copy.
 * Each field is read once. Throws TypeError for a wrong type or shape and
 * RangeError for a value that is not a non-negative safe integer.
 */
export function readMicrosPrice(fn, where, value) {
    const rates = readRateSet(fn, where, value, ['longContext']);
    const record = value;
    const rawLong = Object.hasOwn(record, 'longContext') ? record.longContext : undefined;
    if (rawLong === undefined)
        return Object.freeze(rates);
    const longWhere = `${where}.longContext`;
    const longRates = readRateSet(fn, longWhere, rawLong, ['aboveInputTokens']);
    const rawThreshold = Object.hasOwn(rawLong, 'aboveInputTokens')
        ? rawLong.aboveInputTokens
        : undefined;
    if (typeof rawThreshold !== 'number') {
        throw new TypeError(`${fn}: ${longWhere}.aboveInputTokens must be a safe integer >= 1`);
    }
    if (!Number.isSafeInteger(rawThreshold) || rawThreshold < 1) {
        throw new RangeError(`${fn}: ${longWhere}.aboveInputTokens must be a safe integer >= 1`);
    }
    return Object.freeze({ ...rates, longContext: Object.freeze({ ...longRates, aboveInputTokens: rawThreshold }) });
}
/** Build the frozen rates record for a table whose entries have all been classified as integer-micro. */
export function buildMicrosRates(fn, entries) {
    const rates = Object.create(null);
    for (const [key, entry] of entries) {
        rates[key] = readMicrosPrice(fn, `rates[${describe(key)}]`, entry);
    }
    return Object.freeze(rates);
}
/**
 * Look up `provider:model` in an integer-micro table.
 *
 * @throws TypeError when `table` or its `rates` is not a plain object, or the
 *   entry is not an integer-micro price; RangeError for an invalid rate.
 */
export function priceFor(table, key) {
    const fn = 'priceFor';
    if (!isPlainRecord(table)) {
        throw new TypeError(`${fn}: table must come from definePricingTable`);
    }
    const rates = table.rates;
    if (!isPlainRecord(rates)) {
        throw new TypeError(`${fn}: table.rates must be a plain object keyed by provider:model`);
    }
    if (typeof key !== 'string')
        return { status: 'unknown-model' };
    if (!Object.hasOwn(rates, key))
        return { status: 'unknown-model', key };
    const price = readMicrosPrice(fn, `rates[${describe(key)}]`, rates[key]);
    return { status: 'found', key, price };
}
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreation5mTokens', 'cacheCreation1hTokens'];
function readTokens(fn, usage) {
    if (!isPlainRecord(usage)) {
        throw new TypeError(`${fn}: usage must be an object of token counts (a plain object; not 'unknown', null, an array, a Map or a class instance)`);
    }
    for (const key of Reflect.ownKeys(usage)) {
        if (typeof key === 'symbol' || !USAGE_FIELDS.includes(key)) {
            throw new TypeError(`${fn}: usage has unknown field ${typeof key === 'symbol' ? '(a symbol)' : describe(key)}; expected only ${USAGE_FIELDS.join(', ')}`);
        }
    }
    const out = {};
    for (const field of USAGE_FIELDS) {
        const raw = Object.hasOwn(usage, field) ? usage[field] : undefined;
        if (raw === undefined) {
            out[field] = 0n;
            continue;
        }
        if (typeof raw !== 'number') {
            throw new TypeError(`${fn}: usage.${field} must be a non-negative safe integer`);
        }
        if (!Number.isSafeInteger(raw) || raw < 0) {
            throw new RangeError(`${fn}: usage.${field} must be a non-negative safe integer`);
        }
        out[field] = BigInt(raw);
    }
    return out;
}
/**
 * The cost of one call in whole micro-dollars, exact and rounded UP.
 *
 * Arithmetic is BigInt: each bucket's tokens times its price per million
 * tokens, summed, divided by 1,000,000 and rounded up ONCE on the sum. A cost
 * is therefore never below the true cost and at most one micro-dollar above
 * it; zero usage is 0, and any positive cost is at least 1. There is no
 * floating point anywhere in the path.
 *
 * Buckets: `inputTokens` at `inputPerMTokMicros`, `outputTokens` at
 * `outputPerMTokMicros`, `cacheReadTokens` at `cacheReadPerMTokMicros`,
 * `cacheCreation5mTokens` at `cacheWritePerMTokMicros`, `cacheCreation1hTokens`
 * at `cacheWrite1hPerMTokMicros`. A bucket with tokens and no configured price
 * throws; it is never priced at 0 and never borrowed from another bucket.
 *
 * Long context: when `price.longContext` exists and the prompt (input + cache
 * reads + cache writes) is strictly greater than `aboveInputTokens`, the long
 * rates replace the base rates for every bucket. A bucket the long rates do
 * not price throws; it does not fall back to the base tier.
 *
 * Each field of `usage` and `price` is read once. Usage must be known token
 * counts: pass the `usage` of a `usageFromAnthropic` or `usageFromOpenAI` reading
 * only after checking its `status` is `'known'`.
 *
 * @throws TypeError for a usage or price of the wrong type or shape (including
 *   the string `'unknown'` or a whole reading object, an unknown field, a BigInt or a string count);
 *   RangeError for a count or rate that is not a non-negative safe integer, a
 *   bucket with tokens and no price, or a cost beyond the safe-integer range.
 */
export function estimateCostMicros(usage, price) {
    const fn = 'estimateCostMicros';
    const tokens = readTokens(fn, usage);
    const p = readMicrosPrice(fn, 'price', price);
    const prompt = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheCreation5mTokens + tokens.cacheCreation1hTokens;
    // Own properties only: a field on a polluted Object.prototype is never a price.
    const long = Object.hasOwn(p, 'longContext') ? p.longContext : undefined;
    const useLong = long !== undefined && prompt > BigInt(long.aboveInputTokens);
    const rates = useLong ? long : p;
    const tier = useLong ? 'long-context ' : '';
    let total = 0n;
    const add = (count, field, label) => {
        if (count === 0n)
            return;
        const rate = Object.hasOwn(rates, field) ? rates[field] : undefined;
        if (rate === undefined) {
            throw new RangeError(`${fn}: usage has ${label} but the ${tier}price has no ${field}; add that price rather than letting it default`);
        }
        total += count * BigInt(rate);
    };
    add(tokens.inputTokens, 'inputPerMTokMicros', 'inputTokens');
    add(tokens.outputTokens, 'outputPerMTokMicros', 'outputTokens');
    add(tokens.cacheReadTokens, 'cacheReadPerMTokMicros', 'cacheReadTokens');
    add(tokens.cacheCreation5mTokens, 'cacheWritePerMTokMicros', 'cacheCreation5mTokens');
    add(tokens.cacheCreation1hTokens, 'cacheWrite1hPerMTokMicros', 'cacheCreation1hTokens');
    const micros = (total + 999999n) / 1000000n;
    if (micros > MAX_SAFE) {
        throw new RangeError(`${fn}: the cost does not fit in a safe integer number of micro-dollars`);
    }
    return Number(micros);
}
