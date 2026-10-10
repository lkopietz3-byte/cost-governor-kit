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

/** One cap to count against. */
export interface AdmissionScope {
  /**
   * What is limited, for example `explain:global` or `explain:user:<id>`.
   * Must be a non-blank string (not empty, not only whitespace or invisible
   * characters). Compared exactly: not trimmed, not Unicode-normalized.
   */
  key: string;
  /**
   * Maximum admissions in the window, a safe integer >= 0. `0` always limits.
   * The store may apply a LOWER limit (a policy row in the database, or the
   * lowest limit seen this window), never a higher one.
   */
  limit: number;
}

/** The counting window, always in UTC and always resolved by the store's clock. */
export type AdmissionWindow = 'utc-day' | 'utc-hour';

/** What the store receives: a validated, frozen copy of the caller's scopes. */
export interface AdmissionRequest {
  scopes: readonly AdmissionScope[];
  window: AdmissionWindow;
}

/** What a store must answer. */
export type AdmissionDecision =
  | { status: 'admitted'; windowId: string }
  | { status: 'limited'; scopeKey: string; windowId: string };

/**
 * Storage contract for {@link admitBeforeCall}. This is the safety boundary;
 * the kit has no counter of its own.
 *
 * `admit` MUST, atomically: resolve the current window from the store's own
 * clock AFTER taking its lock; if `used < limit` for EVERY scope in that
 * window, increment every scope by one and answer `admitted`; otherwise change
 * nothing and answer `limited` with the key of a scope that was full. It must
 * never decrement or refund.
 *
 * `windowId` is the window the store counted in, formatted `YYYY-MM-DD` for
 * `utc-day` and `YYYY-MM-DDTHH` (24-hour) for `utc-hour`, in UTC. Anything
 * else is treated as a malformed reply.
 *
 * Throw or reject when the outcome is unknown (a lost reply, a database
 * error). Do not retry inside the store after a write may have committed.
 */
export interface AdmissionStore {
  admit(request: AdmissionRequest): Promise<AdmissionDecision>;
}

/** Why an admission could not be confirmed. Every one of these means: do not make the call. */
export type AdmissionUnavailableReason =
  /** The request (or the store argument) was malformed: a programmer error. `cause` is a TypeError or RangeError naming the problem. */
  | 'invalid_request'
  /** The store threw or rejected. `cause` is what it threw. */
  | 'store_error'
  /** The store did not answer within `timeoutMs`. It may still commit the admission later. */
  | 'timeout'
  /** The store answered something that is not a valid decision for this request. */
  | 'malformed_reply';

/** Result of {@link admitBeforeCall}. Only `admitted` allows the paid call. */
export type AdmitOutcome =
  | { status: 'admitted'; windowId: string }
  | { status: 'limited'; scopeKey: string; windowId: string }
  | { status: 'unavailable'; reason: AdmissionUnavailableReason; cause?: unknown };

/** Input to {@link admitBeforeCall}. */
export interface AdmitBeforeCallRequest {
  /** One or more scopes, with distinct keys. All must have room for the call to be admitted. */
  scopes: readonly AdmissionScope[];
  /** Defaults to `'utc-day'`. */
  window?: AdmissionWindow;
  /**
   * How long to wait for the store, in milliseconds: a safe integer from 1 to
   * 2,147,483,647. Defaults to {@link DEFAULT_ADMISSION_TIMEOUT_MS}. Give the
   * store's own transport a shorter timeout than this.
   */
  timeoutMs?: number;
}

/** Default wait for a store's answer, in milliseconds. */
export const DEFAULT_ADMISSION_TIMEOUT_MS = 5_000;

const MAX_TIMEOUT_MS = 2_147_483_647; // the largest delay setTimeout honors
const WINDOWS: readonly AdmissionWindow[] = ['utc-day', 'utc-hour'];

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
 *   `timeout`. The deadline is measured from just before the store is called
 *   (`performance.now()`), so a store that blocks the event loop and then
 *   answers late is also `timeout`, even if it said `admitted`. That late
 *   admission is discarded, fail closed, and the store may have counted it:
 *   admission is never refunded.
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
export async function admitBeforeCall(
  store: AdmissionStore,
  request: AdmitBeforeCallRequest,
): Promise<AdmitOutcome> {
  let validated: { scopes: readonly AdmissionScope[]; window: AdmissionWindow; timeoutMs: number };
  let admit: (request: AdmissionRequest) => Promise<AdmissionDecision>;
  try {
    validated = readAdmitRequest(request);
    admit = readStore(store);
  } catch (cause) {
    return { status: 'unavailable', reason: 'invalid_request', cause };
  }
  const { scopes, window, timeoutMs } = validated;

  let reply: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Taken before the store runs: synchronous work inside admit blocks the
  // event loop, so the timer below cannot fire until it is done. The deadline
  // check after the race catches a reply that arrived late anyway.
  const deadline = performance.now() + timeoutMs;
  try {
    const call = new Promise<unknown>((resolve, reject) => {
      // A synchronous throw from admit becomes a rejection here.
      Promise.resolve(admit.call(store, Object.freeze({ scopes, window }))).then(resolve, reject);
    });
    const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    reply = await Promise.race([call, timedOut]);
    if (reply === TIMED_OUT || performance.now() > deadline) {
      // Keep a late rejection from surfacing as an unhandled rejection.
      call.catch(() => undefined);
      return { status: 'unavailable', reason: 'timeout' };
    }
  } catch (cause) {
    return { status: 'unavailable', reason: 'store_error', cause };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  try {
    return readDecision(reply, scopes, window);
  } catch (cause) {
    return { status: 'unavailable', reason: 'malformed_reply', cause };
  }
}

const TIMED_OUT: unique symbol = Symbol('admission timeout');

/** Options for {@link admissionHttpStatus}. */
export interface AdmissionHttpStatusOptions {
  /**
   * Key prefixes that mark a scope as belonging to one user or client, for
   * example `['explain:user:', 'explain:ip:']`. A `limited` outcome on such a
   * scope maps to 429; on any other scope (a global or route cap) to 503.
   * Each prefix must be a non-blank string.
   */
  perUserScopePrefixes?: readonly string[];
}

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
export function admissionHttpStatus(
  outcome: AdmitOutcome,
  opts?: AdmissionHttpStatusOptions,
): 429 | 503 | null {
  const prefixes = readPrefixes(opts);
  if (typeof outcome !== 'object' || outcome === null) return 503;
  let status: unknown;
  let scopeKey: unknown;
  try {
    status = outcome.status;
    scopeKey = (outcome as { scopeKey?: unknown }).scopeKey;
  } catch {
    return 503;
  }
  if (status === 'admitted') return null;
  if (status === 'limited' && typeof scopeKey === 'string') {
    return prefixes.some((prefix) => scopeKey.startsWith(prefix)) ? 429 : 503;
  }
  return 503;
}

function readPrefixes(opts: AdmissionHttpStatusOptions | undefined): readonly string[] {
  if (opts === undefined) return [];
  if (!isPlainRecord(opts)) {
    throw new TypeError('admissionHttpStatus: opts must be a plain object');
  }
  const raw: unknown = opts.perUserScopePrefixes;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new TypeError('admissionHttpStatus: opts.perUserScopePrefixes must be an array of strings');
  }
  const prefixes: string[] = [];
  for (const prefix of raw as unknown[]) {
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

function readStore(store: AdmissionStore): (request: AdmissionRequest) => Promise<AdmissionDecision> {
  if (typeof store !== 'object' || store === null) {
    throw new TypeError('admitBeforeCall: store must be an object with an admit function');
  }
  const admit: unknown = (store as unknown as Record<string, unknown>).admit;
  if (typeof admit !== 'function') {
    throw new TypeError('admitBeforeCall: store.admit must be a function');
  }
  return admit as (request: AdmissionRequest) => Promise<AdmissionDecision>;
}

function readAdmitRequest(request: AdmitBeforeCallRequest): {
  scopes: readonly AdmissionScope[];
  window: AdmissionWindow;
  timeoutMs: number;
} {
  if (!isPlainRecord(request)) {
    throw new TypeError(
      'admitBeforeCall: request must be a plain object with scopes ' +
        '(not null, an array, a Map or a class instance)',
    );
  }
  const rawScopes: unknown = request.scopes;
  const rawWindow: unknown = request.window;
  const rawTimeout: unknown = request.timeoutMs;
  const scopes = readScopes('admitBeforeCall', rawScopes);

  let window: AdmissionWindow = 'utc-day';
  if (rawWindow !== undefined) {
    if (!WINDOWS.includes(rawWindow as AdmissionWindow)) {
      throw new RangeError(`admitBeforeCall: window must be 'utc-day' or 'utc-hour', got ${describe(rawWindow)}`);
    }
    window = rawWindow as AdmissionWindow;
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
function readScopes(fn: string, rawScopes: unknown): readonly AdmissionScope[] {
  if (!Array.isArray(rawScopes)) {
    throw new TypeError(`${fn}: scopes must be an array of { key, limit }`);
  }
  // Copy first, then validate the copy. Read `length` exactly once and each
  // element once by index: Array.from would iterate, re-reading `length` on
  // every step, so a proxy could shrink the array and drop a scope.
  const source = rawScopes as unknown[];
  const length: unknown = source.length;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    throw new TypeError(`${fn}: scopes must be an array of { key, limit }`);
  }
  const items: unknown[] = [];
  for (let index = 0; index < length; index++) items.push(source[index]);
  if (items.length === 0) {
    // Admitting against no scopes would count nothing and allow everything.
    throw new RangeError(`${fn}: scopes must contain at least one scope`);
  }
  const seen = new Set<string>();
  const scopes: AdmissionScope[] = [];
  items.forEach((item, index) => {
    if (!isPlainRecord(item)) {
      throw new TypeError(`${fn}: scopes[${index}] must be a plain object with key and limit`);
    }
    const key: unknown = item.key;
    const limit: unknown = item.limit;
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
function isWindowId(windowId: string, window: AdmissionWindow): boolean {
  const m = (window === 'utc-day' ? DAY_ID : HOUR_ID).exec(windowId);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  if (month < 1 || month > 12 || day < 1 || hour > 23) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
  return day <= daysInMonth;
}

function readDecision(reply: unknown, scopes: readonly AdmissionScope[], window: AdmissionWindow): AdmitOutcome {
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) {
    throw new TypeError(`admitBeforeCall: store.admit must resolve to a decision object, got ${describe(reply)}`);
  }
  const record = reply as Record<string, unknown>;
  // One read of each field; a throwing getter lands in the caller's catch.
  const status: unknown = record.status;
  const windowId: unknown = record.windowId;
  const scopeKey: unknown = record.scopeKey;
  if (typeof windowId !== 'string' || !isWindowId(windowId, window)) {
    throw new RangeError(
      `admitBeforeCall: store windowId must be ${window === 'utc-day' ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH'} (UTC), got ${describe(windowId)}`,
    );
  }
  if (status === 'admitted') {
    if (scopeKey !== undefined) {
      throw new RangeError('admitBeforeCall: an admitted decision must not name a scopeKey');
    }
    const zero = scopes.find((scope) => scope.limit === 0);
    if (zero) {
      throw new RangeError(
        `admitBeforeCall: store admitted although scope ${describe(zero.key)} has limit 0; the store is not enforcing limits`,
      );
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

// ---------------------------------------------------------------------------
// In-memory reference store (unit tests only)
// ---------------------------------------------------------------------------

/** Options for {@link createInMemoryAdmissionStore}. */
export interface InMemoryAdmissionStoreOptions {
  /** The store's clock. Defaults to `() => new Date()`. Inject one to test window rollover. */
  now?: () => Date;
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
export function createInMemoryAdmissionStore(options: InMemoryAdmissionStoreOptions = {}): AdmissionStore {
  if (!isPlainRecord(options)) {
    throw new TypeError('createInMemoryAdmissionStore: options must be a plain object');
  }
  const now: unknown = options.now ?? (() => new Date());
  if (typeof now !== 'function') {
    throw new TypeError('createInMemoryAdmissionStore: options.now must be a function returning a Date');
  }
  // window kind -> { id of the current window, key -> { used, limit } }
  const state = new Map<AdmissionWindow, { windowId: string; counters: Map<string, { used: number; limit: number }> }>();

  return {
    // Errors become rejections, not synchronous throws. Everything inside
    // admitNow is synchronous, which is what makes it atomic within one process.
    admit(request: AdmissionRequest): Promise<AdmissionDecision> {
      try {
        return Promise.resolve(admitNow(request));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };

  function admitNow(request: AdmissionRequest): AdmissionDecision {
    if (!isPlainRecord(request)) {
      throw new TypeError('InMemoryAdmissionStore.admit: request must be a plain object');
    }
    const rawWindow: unknown = request.window;
    if (!WINDOWS.includes(rawWindow as AdmissionWindow)) {
      throw new RangeError(`InMemoryAdmissionStore.admit: unknown window ${describe(rawWindow)}`);
    }
    const window = rawWindow as AdmissionWindow;
    const scopes = readScopes('InMemoryAdmissionStore.admit', request.scopes);

    const date: unknown = (now as () => unknown)();
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
    if (current && windowId < current.windowId) windowId = current.windowId;
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
      } else if (scope.limit < counter.limit) {
        counter.limit = scope.limit;
      }
      return { key: scope.key, counter };
    });
    const full = rows.find((row) => row.counter.used >= row.counter.limit);
    if (full) return { status: 'limited', scopeKey: full.key, windowId };
    for (const row of rows) row.counter.used += 1;
    return { status: 'admitted', windowId };
  }
}
