/**
 * admission.ts: atomic, multi-scope admission control before a paid call.
 *
 * WHY THIS EXISTS
 * ----------------
 * Almost every AI-calling app needs the same guard: before the paid call,
 * count one admission against several caps at once (for example a global
 * daily cap and a per-user daily cap) and refuse the call if ANY of them is
 * full. The author's apps each hand-rolled it in SQL. The versions that held
 * up shared four properties, and this module encodes them as a contract:
 *
 *   1. Atomic and all-or-nothing. Every scope is checked and incremented in
 *      one step owned by the store. A racy "count, then insert" lets
 *      concurrent requests all pass the count (one app did exactly that, and
 *      its insert was best-effort, so a failed write let calls through
 *      uncounted).
 *   2. The store owns the clock. The window (UTC day or hour) is resolved by
 *      the store, after it has taken its lock, so midnight contention cannot
 *      borrow yesterday's allowance and app servers with skewed clocks agree.
 *   3. Fail closed. A store that throws, hangs or answers something
 *      malformed means "do not make the paid call", never "assume allowed".
 *   4. Never refunded. The admission counts the ATTEMPT. A provider timeout
 *      can still bill, so a failed or uncertain call keeps its slot, and this
 *      module never retries an admission (a retry after a lost reply could
 *      double count, and an "undo" after a lost reply could under count).
 *
 * The kit owns the validation and the fail-closed mapping. The atomic
 * increment lives in YOUR store (Postgres, D1, Redis); README.md has adapter
 * recipes, which the app owns and tests. `createInMemoryAdmissionStore` is a
 * single-process reference for unit tests only.
 */
import { describe, isBlank, isPlainRecord } from './internal.js';
/** Default wait for a store's answer, in milliseconds. */
export const DEFAULT_ADMISSION_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 2_147_483_647; // the largest delay setTimeout honors
const WINDOWS = ['utc-day', 'utc-hour'];
/**
 * Count one admission against every scope BEFORE a paid call. Never throws,
 * never rejects, never retries, never refunds.
 *
 * - Reads `request` once and validates that copy. A request that is not a
 *   plain object, no scopes, a scope that is not a plain object, a blank or
 *   non-string key, duplicate keys, a limit that is not a safe integer >= 0,
 *   an unknown window, a bad `timeoutMs`, or a `store` without an `admit`
 *   function returns `unavailable` with reason `invalid_request` and a
 *   TypeError or RangeError in `cause`, without calling the store. (These are
 *   programmer errors; they are returned instead of thrown so that a route
 *   handler cannot turn them into an unguarded paid call.)
 * - Calls `store.admit` exactly once with a frozen copy of the validated
 *   scopes, so neither the caller nor the store can change what the reply is
 *   checked against.
 * - A throw or rejection is `store_error`; no answer within `timeoutMs` is
 *   `timeout` (the store may still commit; the admission then counts, which is
 *   the safe direction).
 * - The reply is read once. It is `malformed_reply` unless it is exactly
 *   `{ status: 'admitted', windowId }` or
 *   `{ status: 'limited', scopeKey, windowId }` where `windowId` is a real
 *   UTC date (`YYYY-MM-DD`) or hour (`YYYY-MM-DDTHH`) matching the requested
 *   window, `scopeKey` is one of the requested keys, and, for `admitted`,
 *   no requested scope has limit 0 (a store that admits past a zero limit is
 *   not enforcing limits).
 *
 * Admission is not refunded on failure, by design: the paid call that follows
 * may fail or time out after the provider already billed it, so the slot stays
 * spent. Do not "give back" an admission after a failed call, and do not
 * retry `admitBeforeCall` for the same logical attempt after `timeout` or
 * `store_error`.
 *
 * @example
 *   const outcome = await admitBeforeCall(store, {
 *     scopes: [
 *       { key: 'explain:global', limit: 2_000 },
 *       { key: `explain:user:${userId}`, limit: 20 },
 *     ],
 *   });
 *   const status = admissionHttpStatus(outcome, { perUserScopePrefixes: ['explain:user:'] });
 *   if (status !== null) return new Response('Try again later', { status });
 *   // ...only now make the paid call, with provider retries off.
 */
export async function admitBeforeCall(store, request) {
    let validated;
    let admit;
    try {
        validated = readAdmitRequest(request);
        admit = readStore(store);
    }
    catch (cause) {
        return { status: 'unavailable', reason: 'invalid_request', cause };
    }
    const { scopes, window, timeoutMs } = validated;
    let reply;
    let timer;
    try {
        const call = new Promise((resolve, reject) => {
            // A synchronous throw from admit becomes a rejection here.
            Promise.resolve(admit.call(store, Object.freeze({ scopes, window }))).then(resolve, reject);
        });
        const timedOut = new Promise((resolve) => {
            timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        });
        reply = await Promise.race([call, timedOut]);
        if (reply === TIMED_OUT) {
            // Keep a late rejection from surfacing as an unhandled rejection.
            call.catch(() => undefined);
            return { status: 'unavailable', reason: 'timeout' };
        }
    }
    catch (cause) {
        return { status: 'unavailable', reason: 'store_error', cause };
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
    try {
        return readDecision(reply, scopes, window);
    }
    catch (cause) {
        return { status: 'unavailable', reason: 'malformed_reply', cause };
    }
}
const TIMED_OUT = Symbol('admission timeout');
/**
 * Map an {@link AdmitOutcome} to an HTTP status:
 *
 * | outcome | status | why |
 * | --- | --- | --- |
 * | `admitted` | `null` | proceed with the call |
 * | `limited` on a per-user scope | `429` | this caller used their allowance |
 * | `limited` on any other scope | `503` | shared capacity is exhausted; not the caller's fault |
 * | `unavailable` | `503` | the cap could not be confirmed, so the call is refused |
 * | anything else | `503` | not a valid outcome; fail closed |
 *
 * A scope is per-user when its key starts with one of
 * `opts.perUserScopePrefixes`. With no prefixes, every `limited` is 503.
 *
 * @throws TypeError or RangeError when `opts` is malformed (not a plain
 *   object, prefixes not an array of non-blank strings). That is static
 *   configuration, so it fails on the first call rather than mapping silently.
 */
export function admissionHttpStatus(outcome, opts) {
    const prefixes = readPrefixes(opts);
    if (typeof outcome !== 'object' || outcome === null)
        return 503;
    let status;
    let scopeKey;
    try {
        status = outcome.status;
        scopeKey = outcome.scopeKey;
    }
    catch {
        return 503;
    }
    if (status === 'admitted')
        return null;
    if (status === 'limited' && typeof scopeKey === 'string') {
        return prefixes.some((prefix) => scopeKey.startsWith(prefix)) ? 429 : 503;
    }
    return 503;
}
function readPrefixes(opts) {
    if (opts === undefined)
        return [];
    if (!isPlainRecord(opts)) {
        throw new TypeError('admissionHttpStatus: opts must be a plain object');
    }
    const raw = opts.perUserScopePrefixes;
    if (raw === undefined)
        return [];
    if (!Array.isArray(raw)) {
        throw new TypeError('admissionHttpStatus: opts.perUserScopePrefixes must be an array of strings');
    }
    const prefixes = [];
    for (const prefix of raw) {
        if (typeof prefix !== 'string') {
            throw new TypeError('admissionHttpStatus: opts.perUserScopePrefixes must be an array of strings');
        }
        if (isBlank(prefix)) {
            // A blank prefix would match every key.
            throw new RangeError('admissionHttpStatus: opts.perUserScopePrefixes entries must be non-blank');
        }
        prefixes.push(prefix);
    }
    return prefixes;
}
// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function readStore(store) {
    if (typeof store !== 'object' || store === null) {
        throw new TypeError('admitBeforeCall: store must be an object with an admit function');
    }
    const admit = store.admit;
    if (typeof admit !== 'function') {
        throw new TypeError('admitBeforeCall: store.admit must be a function');
    }
    return admit;
}
function readAdmitRequest(request) {
    if (!isPlainRecord(request)) {
        throw new TypeError('admitBeforeCall: request must be a plain object with scopes ' +
            '(not null, an array, a Map or a class instance)');
    }
    const rawScopes = request.scopes;
    const rawWindow = request.window;
    const rawTimeout = request.timeoutMs;
    const scopes = readScopes('admitBeforeCall', rawScopes);
    let window = 'utc-day';
    if (rawWindow !== undefined) {
        if (!WINDOWS.includes(rawWindow)) {
            throw new RangeError(`admitBeforeCall: window must be 'utc-day' or 'utc-hour', got ${describe(rawWindow)}`);
        }
        window = rawWindow;
    }
    let timeoutMs = DEFAULT_ADMISSION_TIMEOUT_MS;
    if (rawTimeout !== undefined) {
        if (typeof rawTimeout !== 'number') {
            throw new TypeError('admitBeforeCall: timeoutMs must be a safe integer from 1 to 2147483647');
        }
        if (!Number.isSafeInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > MAX_TIMEOUT_MS) {
            throw new RangeError('admitBeforeCall: timeoutMs must be a safe integer from 1 to 2147483647');
        }
        timeoutMs = rawTimeout;
    }
    return { scopes, window, timeoutMs };
}
/** Validate a scope list and return a frozen array of frozen `{ key, limit }` copies. Shared with the in-memory store. */
function readScopes(fn, rawScopes) {
    if (!Array.isArray(rawScopes)) {
        throw new TypeError(`${fn}: scopes must be an array of { key, limit }`);
    }
    // Copy first (one read of length and each element), then validate the copy.
    const items = Array.from(rawScopes);
    if (items.length === 0) {
        // Admitting against no scopes would count nothing and allow everything.
        throw new RangeError(`${fn}: scopes must contain at least one scope`);
    }
    const seen = new Set();
    const scopes = [];
    items.forEach((item, index) => {
        if (!isPlainRecord(item)) {
            throw new TypeError(`${fn}: scopes[${index}] must be a plain object with key and limit`);
        }
        const key = item.key;
        const limit = item.limit;
        if (typeof key !== 'string') {
            throw new TypeError(`${fn}: scopes[${index}].key must be a non-blank string`);
        }
        if (isBlank(key)) {
            throw new RangeError(`${fn}: scopes[${index}].key must be a non-blank string`);
        }
        if (typeof limit !== 'number') {
            throw new TypeError(`${fn}: scopes[${index}].limit must be a safe integer >= 0`);
        }
        if (!Number.isSafeInteger(limit) || limit < 0) {
            throw new RangeError(`${fn}: scopes[${index}].limit must be a safe integer >= 0`);
        }
        if (seen.has(key)) {
            throw new RangeError(`${fn}: scopes[${index}].key ${describe(key)} is a duplicate; each scope key must appear once`);
        }
        seen.add(key);
        scopes.push(Object.freeze({ key, limit }));
    });
    return Object.freeze(scopes);
}
const DAY_ID = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOUR_ID = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/;
/** Whether `windowId` is a real UTC day or hour in the canonical format for `window`. */
function isWindowId(windowId, window) {
    const m = (window === 'utc-day' ? DAY_ID : HOUR_ID).exec(windowId);
    if (!m)
        return false;
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const hour = m[4] === undefined ? 0 : Number(m[4]);
    if (month < 1 || month > 12 || day < 1 || hour > 23)
        return false;
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return day <= daysInMonth;
}
function readDecision(reply, scopes, window) {
    if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) {
        throw new TypeError(`admitBeforeCall: store.admit must resolve to a decision object, got ${describe(reply)}`);
    }
    const record = reply;
    // One read of each field; a throwing getter lands in the caller's catch.
    const status = record.status;
    const windowId = record.windowId;
    const scopeKey = record.scopeKey;
    if (typeof windowId !== 'string' || !isWindowId(windowId, window)) {
        throw new RangeError(`admitBeforeCall: store windowId must be ${window === 'utc-day' ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH'} (UTC), got ${describe(windowId)}`);
    }
    if (status === 'admitted') {
        if (scopeKey !== undefined) {
            throw new RangeError('admitBeforeCall: an admitted decision must not name a scopeKey');
        }
        const zero = scopes.find((scope) => scope.limit === 0);
        if (zero) {
            throw new RangeError(`admitBeforeCall: store admitted although scope ${describe(zero.key)} has limit 0; the store is not enforcing limits`);
        }
        return { status: 'admitted', windowId };
    }
    if (status === 'limited') {
        if (typeof scopeKey !== 'string' || !scopes.some((scope) => scope.key === scopeKey)) {
            throw new RangeError(`admitBeforeCall: store limited on scopeKey ${describe(scopeKey)}, which was not requested`);
        }
        return { status: 'limited', scopeKey, windowId };
    }
    throw new RangeError(`admitBeforeCall: store returned unknown decision status ${describe(status)}`);
}
/**
 * A reference {@link AdmissionStore} that keeps counts in this process's
 * memory. **For unit tests only, not for production.** It is atomic within
 * one JavaScript process (each `admit` checks and increments synchronously,
 * with no `await` in between), but its counts are not shared across
 * processes, serverless instances or restarts, so it does NOT hold a cap
 * across instances. Use a database-backed store (see README.md) for that.
 *
 * Behavior, which a production store should match:
 * - Counts per window: `utc-day` and `utc-hour` keep separate counters.
 * - The window is resolved from `now()` once per call, inside the atomic step.
 * - All-or-nothing: if any scope has `used >= limit`, no count changes and the
 *   first full scope (in request order) is reported.
 * - A scope's limit can only go down within a window: the effective limit is
 *   the lowest limit seen for that key in the current window, recorded even
 *   when the request is limited.
 * - Counters of past windows are dropped when the window changes, and the
 *   window never moves backwards: if `now()` steps back into an earlier
 *   window, counting continues in the newest window seen, so a spent window
 *   is never reopened. (A database store whose own clock steps back would
 *   count in the earlier window's row; the README recipes do not guard
 *   against that.)
 *
 * It validates its input like {@link admitBeforeCall} and throws (rejects) on
 * malformed input or a `now()` that is not a valid Date.
 */
export function createInMemoryAdmissionStore(options = {}) {
    if (!isPlainRecord(options)) {
        throw new TypeError('createInMemoryAdmissionStore: options must be a plain object');
    }
    const now = options.now ?? (() => new Date());
    if (typeof now !== 'function') {
        throw new TypeError('createInMemoryAdmissionStore: options.now must be a function returning a Date');
    }
    // window kind -> { id of the current window, key -> { used, limit } }
    const state = new Map();
    return {
        // Errors become rejections, not synchronous throws. Everything inside
        // admitNow is synchronous, which is what makes it atomic within one process.
        admit(request) {
            try {
                return Promise.resolve(admitNow(request));
            }
            catch (error) {
                return Promise.reject(error instanceof Error ? error : new Error(String(error)));
            }
        },
    };
    function admitNow(request) {
        if (!isPlainRecord(request)) {
            throw new TypeError('InMemoryAdmissionStore.admit: request must be a plain object');
        }
        const rawWindow = request.window;
        if (!WINDOWS.includes(rawWindow)) {
            throw new RangeError(`InMemoryAdmissionStore.admit: unknown window ${describe(rawWindow)}`);
        }
        const window = rawWindow;
        const scopes = readScopes('InMemoryAdmissionStore.admit', request.scopes);
        const date = now();
        const ms = date instanceof Date ? date.getTime() : Number.NaN;
        if (!Number.isFinite(ms)) {
            throw new TypeError('InMemoryAdmissionStore: now() must return a valid Date');
        }
        const iso = new Date(ms).toISOString();
        let windowId = window === 'utc-day' ? iso.slice(0, 10) : iso.slice(0, 13);
        let current = state.get(window);
        // Windows never move backwards. If the clock steps back (an NTP
        // correction), keep counting in the newest window seen instead of
        // rebuilding an older window's counters from zero. The canonical ids
        // sort chronologically as strings (for years 0000-9999).
        if (current && windowId < current.windowId)
            windowId = current.windowId;
        if (!current || current.windowId !== windowId) {
            current = { windowId, counters: new Map() };
            state.set(window, current);
        }
        const counters = current.counters;
        // Record each scope's limit first (lowest seen this window wins), so a
        // lowered limit sticks even when this request is limited. Usage is not
        // touched until every scope has been checked.
        const rows = scopes.map((scope) => {
            let counter = counters.get(scope.key);
            if (!counter) {
                counter = { used: 0, limit: scope.limit };
                counters.set(scope.key, counter);
            }
            else if (scope.limit < counter.limit) {
                counter.limit = scope.limit;
            }
            return { key: scope.key, counter };
        });
        const full = rows.find((row) => row.counter.used >= row.counter.limit);
        if (full)
            return { status: 'limited', scopeKey: full.key, windowId };
        for (const row of rows)
            row.counter.used += 1;
        return { status: 'admitted', windowId };
    }
}
