/**
 * admission.test.ts: a verdict table for the additions made on 2026-10-10:
 * multi-scope admission (admitBeforeCall, admissionHttpStatus, the in-memory
 * reference store), createCommitOnce, integer micro-dollar reservations,
 * provider usage mappers and dated pricing tables.
 *
 * Every case names the verdict it pins. The "adversarial probes" block at the
 * end lists attempts to get a false ADMIT (a paid call that should have been
 * refused) or a false DENY (a refusal that should not happen), and what the
 * design does about each.
 *
 * The provider fixtures below were written by hand from the providers'
 * documented response shapes. They were NOT captured from live responses.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ADMISSION_TIMEOUT_MS,
  admissionHttpStatus,
  admitBeforeCall,
  assertPricingFresh,
  createCommitOnce,
  createInMemoryAdmissionStore,
  definePricingTable,
  estimateCostMicros,
  estimateCostUsd,
  lookupRatesOrThrow,
  usageFromAnthropic,
  usageFromOpenAI,
  withCapacityReservation,
  type AdmissionDecision,
  type AdmissionRequest,
  type AdmissionStore,
  type AdmitOutcome,
  type CapacityReservation,
  type CapacityReservationLedger,
  type CapacitySettlement,
  type ReserveCapacityRequest,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fixed, movable clock for the in-memory store. */
function clock(iso: string): { now: () => Date; set: (next: string) => void } {
  let current = new Date(iso);
  return { now: () => new Date(current.getTime()), set: (next) => (current = new Date(next)) };
}

/** A store that answers `reply` (or runs it) and counts calls. */
function scripted(reply: (request: AdmissionRequest) => unknown): AdmissionStore & { calls: AdmissionRequest[] } {
  const calls: AdmissionRequest[] = [];
  return {
    calls,
    admit: (request: AdmissionRequest) => {
      calls.push(request);
      return reply(request) as Promise<AdmissionDecision>;
    },
  };
}

const DAY = '2026-10-10';
const admitted = (windowId = DAY): AdmitOutcome => ({ status: 'admitted', windowId });
const global = (limit: number) => ({ key: 'explain:global', limit });
const user = (id: string, limit: number) => ({ key: `explain:user:${id}`, limit });

/** Admit `n` times in sequence; return the statuses. */
async function admitTimes(store: AdmissionStore, n: number, scopes: { key: string; limit: number }[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push((await admitBeforeCall(store, { scopes })).status);
  return out;
}

// ---------------------------------------------------------------------------
// 1. All-or-nothing across scopes
// ---------------------------------------------------------------------------

describe('admission: all-or-nothing across scopes (in-memory reference store)', () => {
  const at = () => createInMemoryAdmissionStore({ now: clock(`${DAY}T12:00:00Z`).now });

  it('ADMIT when every scope has room, and every scope is counted', async () => {
    const store = at();
    expect(await admitBeforeCall(store, { scopes: [global(10), user('a', 2)] })).toEqual(admitted());
    expect(await admitBeforeCall(store, { scopes: [global(10), user('a', 2)] })).toEqual(admitted());
    // user a is now full (2/2); global has 8 left.
    expect(await admitBeforeCall(store, { scopes: [global(10), user('a', 2)] })).toEqual({
      status: 'limited',
      scopeKey: 'explain:user:a',
      windowId: DAY,
    });
  });

  it('DENY on a full global scope changes nothing in the user scope', async () => {
    const store = at();
    expect(await admitTimes(store, 2, [global(2), user('a', 5)])).toEqual(['admitted', 'admitted']);
    expect(await admitBeforeCall(store, { scopes: [global(2), user('b', 5)] })).toEqual({
      status: 'limited',
      scopeKey: 'explain:global',
      windowId: DAY,
    });
    // user b was not incremented by the limited attempt: it still has all 5.
    expect(await admitTimes(store, 6, [user('b', 5)])).toEqual(['admitted', 'admitted', 'admitted', 'admitted', 'admitted', 'limited']);
  });

  it('DENY on a full user scope changes nothing in the global scope', async () => {
    const store = at();
    await admitTimes(store, 1, [global(3), user('a', 1)]);
    expect((await admitBeforeCall(store, { scopes: [global(3), user('a', 1)] })).status).toBe('limited');
    expect((await admitBeforeCall(store, { scopes: [global(3), user('a', 1)] })).status).toBe('limited');
    // Global used only 1 of 3 despite two limited attempts.
    expect(await admitTimes(store, 3, [global(3)])).toEqual(['admitted', 'admitted', 'limited']);
  });

  it('DENY when the middle of three scopes is full increments neither of the others', async () => {
    const store = at();
    await admitTimes(store, 1, [{ key: 'route:explain', limit: 1 }]);
    const scopes = [global(10), { key: 'route:explain', limit: 1 }, user('a', 10)];
    expect(await admitBeforeCall(store, { scopes })).toEqual({ status: 'limited', scopeKey: 'route:explain', windowId: DAY });
    expect(await admitTimes(store, 11, [global(10)])).toEqual([...Array<string>(10).fill('admitted'), 'limited']);
    expect(await admitTimes(store, 11, [user('a', 10)])).toEqual([...Array<string>(10).fill('admitted'), 'limited']);
  });

  it('DENY on limit 0, without counting the other scope', async () => {
    const store = at();
    expect(await admitBeforeCall(store, { scopes: [global(5), user('a', 0)] })).toEqual({
      status: 'limited',
      scopeKey: 'explain:user:a',
      windowId: DAY,
    });
    expect(await admitTimes(store, 6, [global(5)])).toEqual([...Array<string>(5).fill('admitted'), 'limited']);
  });

  it('limited names the full scope, not just the first scope in the request', async () => {
    const store = at();
    await admitTimes(store, 1, [user('a', 1)]);
    for (const scopes of [
      [global(10), user('a', 1)],
      [user('a', 1), global(10)],
    ]) {
      const outcome = await admitBeforeCall(store, { scopes });
      expect(outcome).toEqual({ status: 'limited', scopeKey: 'explain:user:a', windowId: DAY });
    }
  });

  it('a slot is never refunded: an admitted call that then fails still counts', async () => {
    const store = at();
    const outcome = await admitBeforeCall(store, { scopes: [user('a', 1)] });
    expect(outcome.status).toBe('admitted');
    // ...the paid call fails or times out here; there is no refund API to call...
    expect((await admitBeforeCall(store, { scopes: [user('a', 1)] })).status).toBe('limited');
  });

  it('defaults to the utc-day window and passes the store a frozen copy of the scopes', async () => {
    const store = scripted(() => Promise.resolve({ status: 'admitted', windowId: DAY }));
    const scopes = [global(1)];
    await admitBeforeCall(store, { scopes });
    const seen = store.calls[0] as AdmissionRequest;
    expect(seen).toEqual({ scopes: [{ key: 'explain:global', limit: 1 }], window: 'utc-day' });
    expect(seen.scopes).not.toBe(scopes);
    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen.scopes)).toBe(true);
    expect(Object.isFrozen(seen.scopes[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Fail closed: every path that is not a valid decision is 'unavailable'
// ---------------------------------------------------------------------------

describe('admission: fail closed on store failures and malformed replies', () => {
  const ok = { scopes: [global(10), user('a', 5)] };

  const storeCases: [string, () => unknown, AdmitOutcome['status'], string?][] = [
    ['store throws synchronously', () => { throw new Error('boom'); }, 'unavailable', 'store_error'],
    ['store rejects', () => Promise.reject(new Error('db down')), 'unavailable', 'store_error'],
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is the case under test
    ['store rejects with undefined', () => Promise.reject(undefined), 'unavailable', 'store_error'],
    ['reply is undefined', () => Promise.resolve(undefined), 'unavailable', 'malformed_reply'],
    ['reply is null', () => Promise.resolve(null), 'unavailable', 'malformed_reply'],
    ['reply is true (a bare boolean RPC)', () => Promise.resolve(true), 'unavailable', 'malformed_reply'],
    ['reply is the string "admitted"', () => Promise.resolve('admitted'), 'unavailable', 'malformed_reply'],
    ['reply is an array', () => Promise.resolve([{ status: 'admitted', windowId: DAY }]), 'unavailable', 'malformed_reply'],
    ['admitted without windowId', () => Promise.resolve({ status: 'admitted' }), 'unavailable', 'malformed_reply'],
    ['admitted with a blank windowId', () => Promise.resolve({ status: 'admitted', windowId: ' ' }), 'unavailable', 'malformed_reply'],
    ['admitted with a non-canonical windowId', () => Promise.resolve({ status: 'admitted', windowId: '10/10/2026' }), 'unavailable', 'malformed_reply'],
    ['admitted with an impossible date', () => Promise.resolve({ status: 'admitted', windowId: '2026-02-30' }), 'unavailable', 'malformed_reply'],
    ['admitted with an hour id for a day window', () => Promise.resolve({ status: 'admitted', windowId: `${DAY}T05` }), 'unavailable', 'malformed_reply'],
    ['admitted that also names a scopeKey', () => Promise.resolve({ status: 'admitted', windowId: DAY, scopeKey: 'explain:global' }), 'unavailable', 'malformed_reply'],
    ['status "allowed" (another app\'s vocabulary)', () => Promise.resolve({ status: 'allowed', windowId: DAY }), 'unavailable', 'malformed_reply'],
    ['status "ADMITTED" (wrong case)', () => Promise.resolve({ status: 'ADMITTED', windowId: DAY }), 'unavailable', 'malformed_reply'],
    ['limited without scopeKey', () => Promise.resolve({ status: 'limited', windowId: DAY }), 'unavailable', 'malformed_reply'],
    ['limited on a scopeKey that was not requested', () => Promise.resolve({ status: 'limited', windowId: DAY, scopeKey: 'explain:user:b' }), 'unavailable', 'malformed_reply'],
    ['limited on a String object scopeKey', () => Promise.resolve({ status: 'limited', windowId: DAY, scopeKey: Object('explain:global') as unknown }), 'unavailable', 'malformed_reply'],
    ['limited without windowId', () => Promise.resolve({ status: 'limited', scopeKey: 'explain:global' }), 'unavailable', 'malformed_reply'],
    ['a reply whose status getter throws', () => Promise.resolve({ get status() { throw new Error('getter'); }, windowId: DAY }), 'unavailable', 'malformed_reply'],
    ['a thenable that rejects', () => ({ then: (_ok: unknown, fail: (e: unknown) => void) => fail(new Error('thenable')) }), 'unavailable', 'store_error'],
    ['a valid admitted reply (control)', () => Promise.resolve({ status: 'admitted', windowId: DAY }), 'admitted'],
    ['a valid limited reply (control)', () => Promise.resolve({ status: 'limited', windowId: DAY, scopeKey: 'explain:global' }), 'limited'],
  ];

  it.each(storeCases)('%s -> %s', async (_label, reply, status, reason) => {
    const store = scripted(reply);
    const outcome = await admitBeforeCall(store, ok);
    expect(outcome.status).toBe(status);
    if (reason) expect(outcome).toMatchObject({ reason });
    // No retry: exactly one store call on every path.
    expect(store.calls).toHaveLength(1);
  });

  it('a store that throws a non-Error keeps it as cause', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is the case under test
    const outcome = await admitBeforeCall(scripted(() => Promise.reject(undefined)), ok);
    expect(outcome).toEqual({ status: 'unavailable', reason: 'store_error', cause: undefined });
    expect(Object.hasOwn(outcome, 'cause')).toBe(true);
  });

  it('times out a hung store, calls it once, and does not wait longer than timeoutMs', async () => {
    const store = scripted(() => new Promise(() => undefined));
    const started = Date.now();
    const outcome = await admitBeforeCall(store, { ...ok, timeoutMs: 25 });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'timeout' });
    expect(store.calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a store that rejects after the timeout does not raise an unhandled rejection', async () => {
    let fail!: (e: unknown) => void;
    const store = scripted(() => new Promise((_ok, reject) => (fail = reject)));
    const outcome = await admitBeforeCall(store, { ...ok, timeoutMs: 5 });
    expect(outcome).toMatchObject({ reason: 'timeout' });
    fail(new Error('late'));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('the default timeout is 5 seconds', () => {
    expect(DEFAULT_ADMISSION_TIMEOUT_MS).toBe(5_000);
  });
});

describe('admission: malformed requests are invalid_request and never reach the store', () => {
  const requestCases: [string, unknown][] = [
    ['request null', null],
    ['request an array', [global(1)]],
    ['request a Map', new Map([['scopes', [global(1)]]])],
    ['scopes missing', {}],
    ['scopes not an array', { scopes: global(1) }],
    ['scopes empty (would count nothing and allow everything)', { scopes: [] }],
    ['scope null', { scopes: [null] }],
    ['scope a class instance', { scopes: [new (class S { key = 'k'; limit = 1; })()] }],
    ['blank key ""', { scopes: [{ key: '', limit: 1 }] }],
    ['blank key of spaces', { scopes: [{ key: '   ', limit: 1 }] }],
    ['blank key of zero-width characters', { scopes: [{ key: '​⁦', limit: 1 }] }],
    ['key a number', { scopes: [{ key: 7, limit: 1 }] }],
    ['key a String object', { scopes: [{ key: Object('k') as unknown, limit: 1 }] }],
    ['duplicate keys', { scopes: [global(10), global(5)] }],
    ['negative limit', { scopes: [{ key: 'k', limit: -1 }] }],
    ['fractional limit', { scopes: [{ key: 'k', limit: 1.5 }] }],
    ['NaN limit', { scopes: [{ key: 'k', limit: Number.NaN }] }],
    ['Infinity limit', { scopes: [{ key: 'k', limit: Number.POSITIVE_INFINITY }] }],
    ['limit beyond MAX_SAFE_INTEGER', { scopes: [{ key: 'k', limit: 2 ** 53 }] }],
    ['limit as a string', { scopes: [{ key: 'k', limit: '10' }] }],
    ['limit missing', { scopes: [{ key: 'k' }] }],
    ['unknown window', { scopes: [global(1)], window: 'utc-week' }],
    ['window null', { scopes: [global(1)], window: null }],
    ['timeoutMs 0', { scopes: [global(1)], timeoutMs: 0 }],
    ['timeoutMs negative', { scopes: [global(1)], timeoutMs: -5 }],
    ['timeoutMs fractional', { scopes: [global(1)], timeoutMs: 1.5 }],
    ['timeoutMs above setTimeout max', { scopes: [global(1)], timeoutMs: 2 ** 31 }],
    ['timeoutMs a string', { scopes: [global(1)], timeoutMs: '100' }],
  ];

  it.each(requestCases)('%s', async (_label, request) => {
    const store = scripted(() => Promise.resolve({ status: 'admitted', windowId: DAY }));
    const outcome = await admitBeforeCall(store, request as never);
    expect(outcome.status).toBe('unavailable');
    expect(outcome).toMatchObject({ reason: 'invalid_request' });
    const cause = (outcome as { cause?: unknown }).cause;
    expect(cause instanceof TypeError || cause instanceof RangeError).toBe(true);
    expect(store.calls).toHaveLength(0);
  });

  it.each([
    ['store null', null],
    ['store without admit', {}],
    ['admit not a function', { admit: 'yes' }],
  ])('%s', async (_label, store) => {
    const outcome = await admitBeforeCall(store as never, { scopes: [global(1)] });
    expect(outcome).toMatchObject({ status: 'unavailable', reason: 'invalid_request' });
  });

  it('never throws or rejects, even with no arguments at all', async () => {
    await expect((admitBeforeCall as (...args: unknown[]) => Promise<AdmitOutcome>)()).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'invalid_request',
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Concurrency (one process)
// ---------------------------------------------------------------------------

describe('admission: the in-memory store under concurrent admits (one process)', () => {
  it('50 concurrent admits at limit 10 admit exactly 10', async () => {
    const store = createInMemoryAdmissionStore();
    const outcomes = await Promise.all(Array.from({ length: 50 }, () => admitBeforeCall(store, { scopes: [global(10)] })));
    expect(outcomes.filter((o) => o.status === 'admitted')).toHaveLength(10);
    expect(outcomes.filter((o) => o.status === 'limited')).toHaveLength(40);
  });

  it('50 concurrent admits across 10 users (global 12, per user 2) admit exactly 12, no user above 2', async () => {
    const store = createInMemoryAdmissionStore();
    const requests = Array.from({ length: 50 }, (_, i) => `u${i % 10}`);
    const outcomes = await Promise.all(
      requests.map((id) => admitBeforeCall(store, { scopes: [global(12), user(id, 2)] }).then((o) => ({ id, o }))),
    );
    const admittedIds = outcomes.filter(({ o }) => o.status === 'admitted').map(({ id }) => id);
    expect(admittedIds).toHaveLength(12);
    for (const id of new Set(admittedIds)) {
      expect(admittedIds.filter((x) => x === id).length).toBeLessThanOrEqual(2);
    }
  });

  it('control: a non-atomic store (await between check and increment) over-admits, so the test above can see a race', async () => {
    const counts = new Map<string, number>();
    const racy: AdmissionStore = {
      async admit(request) {
        const scope = request.scopes[0] as { key: string; limit: number };
        const used = counts.get(scope.key) ?? 0;
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (used >= scope.limit) return { status: 'limited', scopeKey: scope.key, windowId: DAY };
        counts.set(scope.key, (counts.get(scope.key) ?? 0) + 1);
        return { status: 'admitted', windowId: DAY };
      },
    };
    const outcomes = await Promise.all(Array.from({ length: 50 }, () => admitBeforeCall(racy, { scopes: [global(10)] })));
    expect(outcomes.filter((o) => o.status === 'admitted').length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// 4. Windows and the store's clock
// ---------------------------------------------------------------------------

describe('admission: window rollover with an injected clock', () => {
  it('a full day resets at 00:00:00.000Z, not a millisecond earlier', async () => {
    const c = clock('2026-10-10T23:59:59.000Z');
    const store = createInMemoryAdmissionStore({ now: c.now });
    expect(await admitTimes(store, 3, [global(2)])).toEqual(['admitted', 'admitted', 'limited']);
    c.set('2026-10-10T23:59:59.999Z');
    expect(await admitBeforeCall(store, { scopes: [global(2)] })).toEqual({
      status: 'limited',
      scopeKey: 'explain:global',
      windowId: '2026-10-10',
    });
    c.set('2026-10-11T00:00:00.000Z');
    expect(await admitBeforeCall(store, { scopes: [global(2)] })).toEqual(admitted('2026-10-11'));
  });

  it('utc-hour counts per hour and reports YYYY-MM-DDTHH', async () => {
    const c = clock('2026-10-10T05:59:00Z');
    const store = createInMemoryAdmissionStore({ now: c.now });
    const hourly = { scopes: [global(1)], window: 'utc-hour' as const };
    expect(await admitBeforeCall(store, hourly)).toEqual(admitted('2026-10-10T05'));
    expect((await admitBeforeCall(store, hourly)).status).toBe('limited');
    c.set('2026-10-10T06:00:00Z');
    expect(await admitBeforeCall(store, hourly)).toEqual(admitted('2026-10-10T06'));
  });

  it('utc-day and utc-hour keep separate counters for the same key', async () => {
    const store = createInMemoryAdmissionStore({ now: clock('2026-10-10T05:00:00Z').now });
    expect((await admitBeforeCall(store, { scopes: [global(1)], window: 'utc-hour' })).status).toBe('admitted');
    expect((await admitBeforeCall(store, { scopes: [global(1)], window: 'utc-day' })).status).toBe('admitted');
  });

  it('a window uses UTC, whatever the process time zone', async () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
      expect(new Date('2026-10-10T23:00:00Z').getDate()).toBe(11); // the switch took effect
      const store = createInMemoryAdmissionStore({ now: clock('2026-10-10T23:00:00Z').now });
      expect(await admitBeforeCall(store, { scopes: [global(1)] })).toEqual(admitted('2026-10-10'));
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it('a limit can only go down within a window, and the next window starts fresh', async () => {
    const c = clock(`${DAY}T10:00:00Z`);
    const store = createInMemoryAdmissionStore({ now: c.now });
    expect(await admitTimes(store, 2, [global(5)])).toEqual(['admitted', 'admitted']);
    // An instance with a lower configured limit lowers it for everyone today.
    expect((await admitBeforeCall(store, { scopes: [global(2)] })).status).toBe('limited');
    // An instance with the old, higher limit does not raise it again today.
    expect((await admitBeforeCall(store, { scopes: [global(5)] })).status).toBe('limited');
    c.set('2026-10-11T00:00:00Z');
    expect(await admitTimes(store, 5, [global(5)])).toEqual(Array<string>(5).fill('admitted'));
  });

  it('a now() that is not a valid Date fails closed', async () => {
    for (const bad of [() => new Date(Number.NaN), () => 'today', () => Date.now()]) {
      const store = createInMemoryAdmissionStore({ now: bad as () => Date });
      expect(await admitBeforeCall(store, { scopes: [global(1)] })).toMatchObject({
        status: 'unavailable',
        reason: 'store_error',
      });
    }
  });

  it('createInMemoryAdmissionStore rejects bad options at creation', () => {
    expect(() => createInMemoryAdmissionStore({ now: 'soon' as never })).toThrow(TypeError);
    expect(() => createInMemoryAdmissionStore(null as never)).toThrow(TypeError);
  });

  it('the in-memory store rejects malformed input when called directly', async () => {
    const store = createInMemoryAdmissionStore();
    await expect(store.admit(null as never)).rejects.toThrow(TypeError);
    await expect(store.admit({ scopes: [global(1)], window: 'utc-week' as never })).rejects.toThrow(RangeError);
    await expect(store.admit({ scopes: [], window: 'utc-day' })).rejects.toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 5. HTTP mapping
// ---------------------------------------------------------------------------

describe('admissionHttpStatus', () => {
  const opts = { perUserScopePrefixes: ['explain:user:', 'explain:ip:'] };
  const cases: [string, unknown, typeof opts | undefined, 429 | 503 | null][] = [
    ['admitted -> null', admitted(), opts, null],
    ['limited on a per-user scope -> 429', { status: 'limited', scopeKey: 'explain:user:a', windowId: DAY }, opts, 429],
    ['limited on a per-IP scope -> 429', { status: 'limited', scopeKey: 'explain:ip:abc', windowId: DAY }, opts, 429],
    ['limited on the global scope -> 503', { status: 'limited', scopeKey: 'explain:global', windowId: DAY }, opts, 503],
    ['limited with no prefixes configured -> 503', { status: 'limited', scopeKey: 'explain:user:a', windowId: DAY }, undefined, 503],
    ['unavailable -> 503', { status: 'unavailable', reason: 'timeout' }, opts, 503],
    ['null outcome -> 503', null, opts, 503],
    ['unknown status -> 503', { status: 'allowed' }, opts, 503],
    ['status with trailing space -> 503', { status: 'admitted ' }, opts, 503],
    ['limited without a string scopeKey -> 503', { status: 'limited', scopeKey: 7 }, opts, 503],
    ['an outcome whose getter throws -> 503', { get status() { throw new Error('x'); } }, opts, 503],
  ];
  it.each(cases)('%s', (_label, outcome, options, status) => {
    expect(admissionHttpStatus(outcome as AdmitOutcome, options)).toBe(status);
  });

  it('rejects malformed options even for an admitted outcome', () => {
    expect(() => admissionHttpStatus(admitted(), { perUserScopePrefixes: [''] })).toThrow(RangeError);
    expect(() => admissionHttpStatus(admitted(), { perUserScopePrefixes: ['​'] })).toThrow(RangeError);
    expect(() => admissionHttpStatus(admitted(), { perUserScopePrefixes: 'user:' as never })).toThrow(TypeError);
    expect(() => admissionHttpStatus(admitted(), { perUserScopePrefixes: [7 as never] })).toThrow(TypeError);
    expect(() => admissionHttpStatus(admitted(), null as never)).toThrow(TypeError);
    expect(admissionHttpStatus(admitted(), {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. createCommitOnce
// ---------------------------------------------------------------------------

describe('createCommitOnce', () => {
  it('runs fn once for 100 concurrent calls; every caller gets the same result', async () => {
    let runs = 0;
    const commit = createCommitOnce(async () => {
      runs++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'counted';
    });
    expect(commit.state).toBe('idle');
    const results = await Promise.all(Array.from({ length: 100 }, () => commit()));
    expect(runs).toBe(1);
    expect(new Set(results)).toEqual(new Set(['counted']));
    expect(commit.state).toBe('committed');
    expect(await commit()).toBe('counted');
    expect(runs).toBe(1);
  });

  it('returns the same promise to every caller and is pending while fn runs', () => {
    const commit = createCommitOnce(() => new Promise<void>(() => undefined));
    const a = commit();
    expect(commit.state).toBe('pending');
    expect(commit()).toBe(a);
  });

  it('surfaces a failure to every caller, then and later, and never runs fn again', async () => {
    let runs = 0;
    const failure = new Error('ledger down');
    const commit = createCommitOnce(async () => {
      runs++;
      throw failure;
    });
    const settled = await Promise.allSettled([commit(), commit(), commit()]);
    expect(settled.every((s) => s.status === 'rejected' && s.reason === failure)).toBe(true);
    expect(commit.state).toBe('failed');
    await expect(commit()).rejects.toBe(failure); // no retry through the same instance
    expect(runs).toBe(1);
  });

  it('a synchronous throw becomes a rejection, not a throw from the call', async () => {
    const commit = createCommitOnce(() => {
      throw new TypeError('sync');
    });
    let promise: Promise<unknown> | undefined;
    expect(() => {
      promise = commit();
    }).not.toThrow();
    await expect(promise).rejects.toThrow('sync');
    expect(commit.state).toBe('failed');
  });

  it('a re-entrant call from inside fn joins the first call instead of running fn again', async () => {
    let runs = 0;
    let inner: Promise<number> | undefined;
    const commit: ReturnType<typeof createCommitOnce<number>> = createCommitOnce(() => {
      runs++;
      inner = commit();
      return 1;
    });
    expect(await commit()).toBe(1);
    expect(await inner).toBe(1);
    expect(runs).toBe(1);
  });

  it('rejects a non-function at creation', () => {
    expect(() => createCommitOnce('commit' as never)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// 7. Integer micro-dollars and amount-based reservations
// ---------------------------------------------------------------------------

const rates = { inputPerMillion: 3, outputPerMillion: 15 };

describe('estimateCostMicros', () => {
  it('returns whole micro-dollars and agrees with estimateCostUsd on the README example', () => {
    const usage = { inputTokens: 1_200, outputTokens: 400, cacheReadTokens: 8_000, cacheCreation5mTokens: 2_000 };
    expect(estimateCostUsd(rates, usage)).toBe(0.0195);
    expect(estimateCostMicros(rates, usage)).toBe(19_500); // 8,000 x 3 x 0.1 is 2400.0000000000005 in binary; not rounded up
  });

  it('rounds a fractional micro-dollar UP, so a tiny call is never free', () => {
    expect(estimateCostUsd(rates, { inputTokens: 1 })).toBe(0.000003);
    expect(estimateCostUsd({ inputPerMillion: 0.1, outputPerMillion: 0 }, { inputTokens: 1 })).toBe(0); // the USD path rounds to $0
    expect(estimateCostMicros({ inputPerMillion: 0.1, outputPerMillion: 0 }, { inputTokens: 1 })).toBe(1);
    expect(estimateCostMicros({ inputPerMillion: 0.29, outputPerMillion: 0 }, { inputTokens: 50 })).toBe(15);
  });

  it('a real fraction is rounded up even on a very large call (reviewer finding: the snap tolerance is capped)', () => {
    // A raw 1000000000000.4 micro-dollars used to snap down to 1e12 under a purely relative tolerance.
    expect(estimateCostMicros({ inputPerMillion: 1.0000000000004, outputPerMillion: 0 }, { inputTokens: 1e12 })).toBe(1e12 + 1);
  });

  it('a positive cost below the snap tolerance is 1 micro-dollar, never 0 (review finding)', () => {
    expect(estimateCostMicros({ inputPerMillion: 1e-10, outputPerMillion: 0 }, { inputTokens: 1 })).toBe(1);
    expect(estimateCostMicros({ inputPerMillion: 0, outputPerMillion: 1e-12 }, { outputTokens: 1 })).toBe(1);
  });

  it('zero usage is 0, and every result is a safe integer', () => {
    expect(estimateCostMicros(rates, {})).toBe(0);
    expect(Number.isSafeInteger(estimateCostMicros(rates, { inputTokens: 123_457, outputTokens: 9_999 }))).toBe(true);
  });

  it('validates exactly like estimateCostUsd, with its own message prefix', () => {
    expect(() => estimateCostMicros(rates, { input_tokens: 5 } as never)).toThrow(/^estimateCostMicros: usage has unknown field/);
    expect(() => estimateCostMicros(rates, { inputTokens: -1 })).toThrow(RangeError);
    expect(() => estimateCostMicros({ inputPerMillion: Number.NaN, outputPerMillion: 1 }, {})).toThrow(RangeError);
    expect(() => estimateCostMicros(rates, new Map() as never)).toThrow(TypeError);
    expect(() => estimateCostMicros({ inputPerMillion: Number.MAX_VALUE, outputPerMillion: 0 }, { inputTokens: 10 })).toThrow(/finite/);
    expect(() => estimateCostMicros({ inputPerMillion: 1e300, outputPerMillion: 0 }, { inputTokens: 1 })).toThrow(/safe integer/);
  });
});

describe('withCapacityReservation with an integer amount', () => {
  function amountLedger(log: { requests: ReserveCapacityRequest[]; confirms: unknown[][]; releases: number }): CapacityReservationLedger {
    return {
      reserveCapacity: async (request) => {
        log.requests.push(request);
        return {
          status: 'acquired',
          reservation: { id: 'r-1', key: request.key, operationId: request.operationId, expiresAt: new Date(Date.now() + 60_000).toISOString() },
        };
      },
      // Record every argument, so the tests can see exactly what was passed.
      confirmReservation: async (...args: unknown[]) => {
        log.confirms.push(args);
      },
      releaseReservation: async () => {
        log.releases++;
      },
    };
  }
  const newLog = () => ({ requests: [] as ReserveCapacityRequest[], confirms: [] as unknown[][], releases: 0 });
  const req = { key: 'budget:2026-10-10', limit: 5_000_000, operationId: 'op-1', amount: 12_000 };

  it('passes the amount to the adapter and the reported actual amount to confirm', async () => {
    const log = newLog();
    const result = await withCapacityReservation(amountLedger(log), req, async () => ({
      status: 'succeeded',
      value: 'ok',
      settle: { actualAmount: 9_100 },
    }));
    expect(log.requests).toEqual([{ key: req.key, limit: req.limit, operationId: 'op-1', amount: 12_000 }]);
    const settlement: CapacitySettlement = { usage: 'reported', amount: 9_100, reservedAmount: 12_000 };
    expect(log.confirms).toHaveLength(1);
    expect(log.confirms[0]?.[1]).toEqual(settlement);
    expect(result).toMatchObject({ status: 'confirmed', value: 'ok', settlement });
  });

  it("usage 'unknown' records the full estimate, never zero", async () => {
    const log = newLog();
    await withCapacityReservation(amountLedger(log), req, async () => ({ status: 'succeeded', value: 1, settle: { usage: 'unknown' } }));
    expect(log.confirms[0]?.[1]).toEqual({ usage: 'unknown', amount: 12_000, reservedAmount: 12_000 });
  });

  it('a missing settle is treated as unknown: the full estimate', async () => {
    const log = newLog();
    await withCapacityReservation(amountLedger(log), req, async () => ({ status: 'succeeded', value: 1 }));
    expect(log.confirms[0]?.[1]).toEqual({ usage: 'unknown', amount: 12_000, reservedAmount: 12_000 });
  });

  it('an actual amount above the estimate is recorded as is, not capped at the hold', async () => {
    const log = newLog();
    await withCapacityReservation(amountLedger(log), req, async () => ({ status: 'succeeded', value: 1, settle: { actualAmount: 30_000 } }));
    expect(log.confirms[0]?.[1]).toEqual({ usage: 'reported', amount: 30_000, reservedAmount: 12_000 });
  });

  it.each([
    ['negative actualAmount', { actualAmount: -1 }],
    ['fractional actualAmount', { actualAmount: 1.5 }],
    ['string actualAmount', { actualAmount: '9100' }],
    ['null settle', null],
    ['a number settle', 9_100],
    ['both keys', { actualAmount: 1, usage: 'unknown' }],
    ['usage other than unknown', { usage: 'zero' }],
    ['an empty object', {}],
    ['a Map', new Map([['actualAmount', 1]])],
  ])('a malformed settle (%s) keeps the hold: work_outcome_ambiguous, no confirm, no release', async (_label, settle) => {
    const log = newLog();
    const result = await withCapacityReservation(amountLedger(log), req, async () => ({ status: 'succeeded', value: 1, settle } as never));
    expect(result.status).toBe('work_outcome_ambiguous');
    expect(log.confirms).toEqual([]);
    expect(log.releases).toBe(0);
  });

  it.each([
    ['0', 0, RangeError],
    ['negative', -5, RangeError],
    ['fractional', 1.5, RangeError],
    ['NaN', Number.NaN, RangeError],
    ['a string', '100', TypeError],
  ])('an amount of %s throws before the adapter is called', async (_label, amount, ErrorType) => {
    const log = newLog();
    await expect(withCapacityReservation(amountLedger(log), { ...req, amount: amount as number }, async () => ({ status: 'succeeded', value: 1 }))).rejects.toThrow(ErrorType);
    expect(log.requests).toEqual([]);
  });

  it('without an amount, the adapter sees the old request and confirm gets exactly one argument', async () => {
    const log = newLog();
    const result = await withCapacityReservation(
      amountLedger(log),
      { key: 'k', limit: 1, operationId: 'o' },
      async () => ({ status: 'succeeded', value: 1, settle: { actualAmount: 5 } } as never),
    );
    expect(log.requests).toEqual([{ key: 'k', limit: 1, operationId: 'o' }]);
    expect(Object.hasOwn(log.requests[0] as object, 'amount')).toBe(false);
    expect(log.confirms).toEqual([[expect.objectContaining({ id: 'r-1' }) as CapacityReservation]]);
    expect(result).not.toHaveProperty('settlement');
  });

  it('a failed outcome releases the hold whatever the amount', async () => {
    const log = newLog();
    const result = await withCapacityReservation(amountLedger(log), req, async () => ({ status: 'failed', error: 'no charge' }));
    expect(result.status).toBe('released_after_failure');
    expect(log.releases).toBe(1);
    expect(log.confirms).toEqual([]);
  });

  it('estimateCostMicros feeds an amount directly', async () => {
    const amount = Math.max(1, estimateCostMicros(rates, { inputTokens: 2_000, outputTokens: 500 }));
    expect(amount).toBe(13_500);
    const log = newLog();
    await withCapacityReservation(amountLedger(log), { ...req, amount }, async () => ({ status: 'succeeded', value: 1 }));
    expect(log.requests[0]?.amount).toBe(13_500);
  });
});

// ---------------------------------------------------------------------------
// 8. Provider usage mappers (fixtures written from documented shapes)
// ---------------------------------------------------------------------------

describe('usageFromAnthropic (fixtures written from the documented Messages API usage shape)', () => {
  /** Written by hand from Anthropic's documented `usage` object; not a captured response. */
  const documented = {
    input_tokens: 2_095,
    output_tokens: 503,
    cache_creation_input_tokens: 2_051,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 51, ephemeral_1h_input_tokens: 2_000 },
    server_tool_use: { web_search_requests: 0 },
    service_tier: 'standard',
  };

  it('maps every bucket, keeping 5-minute and 1-hour writes apart', () => {
    expect(usageFromAnthropic(documented)).toEqual({
      inputTokens: 2_095,
      outputTokens: 503,
      cacheReadTokens: 0,
      cacheCreation5mTokens: 51,
      cacheCreation1hTokens: 2_000,
    });
  });

  it('prices cache_creation_input_tokens without the cache_creation split as 5-minute writes (the README bug the hunt found)', () => {
    const usage = usageFromAnthropic({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1_000_000 });
    expect(usage).toMatchObject({ cacheCreation5mTokens: 1_000_000, cacheCreation1hTokens: 0 });
    expect(estimateCostUsd(rates, usage)).toBeGreaterThan(3.75); // 1M x $3 x 1.25 = $3.75, plus input and output
  });

  it('treats documented nullable fields set to null as absent', () => {
    expect(
      usageFromAnthropic({
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        cache_creation: null,
        server_tool_use: null,
        service_tier: null,
      }),
    ).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 });
  });

  it.each([
    ['an unknown top-level key', { ...documented, cache_creation_tokens: 5 }, TypeError],
    ['an unknown key inside cache_creation', { ...documented, cache_creation: { ephemeral_5m_input_tokens: 51, ephemeral_24h_input_tokens: 2_000 } }, TypeError],
    ['an unknown key inside server_tool_use', { ...documented, server_tool_use: { code_runs: 0 } }, TypeError],
    ['a symbol key', { ...documented, [Symbol('x')]: 1 }, TypeError],
    ['missing input_tokens (a bare message_delta usage)', { output_tokens: 503 }, TypeError],
    ['missing output_tokens', { input_tokens: 5 }, TypeError],
    ['a fractional count', { ...documented, output_tokens: 1.5 }, RangeError],
    ['a negative count', { ...documented, input_tokens: -1 }, RangeError],
    ['a string count', { ...documented, input_tokens: '5' }, TypeError],
    ['a total that disagrees with its split (split under-reports)', { ...documented, cache_creation_input_tokens: 9_999 }, RangeError],
    ['an all-zero split next to a nonzero total', { ...documented, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }, RangeError],
    ['nonzero web searches (fees not priced here)', { ...documented, server_tool_use: { web_search_requests: 3 } }, RangeError],
    ['service_tier that is not a string', { ...documented, service_tier: 1 }, TypeError],
    ['null', null, TypeError],
    ['an array', [documented], TypeError],
  ])('throws on %s', (_label, payload, ErrorType) => {
    expect(() => usageFromAnthropic(payload)).toThrow(ErrorType);
  });
});

describe('usageFromOpenAI (fixtures written from the documented usage shapes)', () => {
  /** Written by hand from OpenAI's documented Chat Completions `usage`; not a captured response. */
  const chat = {
    prompt_tokens: 2_006,
    completion_tokens: 300,
    total_tokens: 2_306,
    prompt_tokens_details: { cached_tokens: 1_920, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 128, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
  };
  /** Written by hand from OpenAI's documented Responses API `usage`; not a captured response. */
  const responses = {
    input_tokens: 328,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 52,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 380,
  };

  it('maps Chat Completions usage: cached tokens come out of the prompt total', () => {
    expect(usageFromOpenAI(chat)).toEqual({ inputTokens: 86, outputTokens: 300, cacheReadTokens: 1_920 });
  });

  it('maps Responses API usage', () => {
    expect(usageFromOpenAI(responses)).toEqual({ inputTokens: 328, outputTokens: 52, cacheReadTokens: 0 });
  });

  it('accepts minimal and null-detail shapes', () => {
    expect(usageFromOpenAI({ prompt_tokens: 5, completion_tokens: 1 })).toEqual({ inputTokens: 5, outputTokens: 1, cacheReadTokens: 0 });
    expect(usageFromOpenAI({ input_tokens: 5, output_tokens: 1, input_tokens_details: null, output_tokens_details: null })).toEqual({
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: 0,
    });
    expect(usageFromOpenAI({ ...chat, prompt_tokens_details: { cached_tokens: null, audio_tokens: null } })).toMatchObject({ cacheReadTokens: 0 });
  });

  it.each([
    ['an unknown top-level key', { ...chat, cost: 0.01 }, TypeError],
    ['an unknown detail key', { ...chat, prompt_tokens_details: { cached_tokens: 0, image_tokens: 5 } }, TypeError],
    ['a Chat-only detail in the Responses shape', { ...responses, input_tokens_details: { cached_tokens: 0, audio_tokens: 0 } }, TypeError],
    ['a mixed shape', { ...responses, prompt_tokens: 1 }, TypeError],
    ['cached tokens above the prompt total', { ...chat, prompt_tokens_details: { cached_tokens: 5_000 } }, RangeError],
    ['reasoning tokens above the output', { ...chat, completion_tokens_details: { reasoning_tokens: 301 } }, RangeError],
    ['a total that does not add up', { ...chat, total_tokens: 2_000 }, RangeError],
    ['nonzero input audio tokens', { ...chat, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 10 } }, RangeError],
    ['nonzero output audio tokens', { ...chat, completion_tokens_details: { audio_tokens: 10 } }, RangeError],
    ['missing completion_tokens', { prompt_tokens: 5 }, TypeError],
    ['an empty object', {}, TypeError],
    ['null', null, TypeError],
  ])('throws on %s', (_label, payload, ErrorType) => {
    expect(() => usageFromOpenAI(payload)).toThrow(ErrorType);
  });
});

// ---------------------------------------------------------------------------
// 9. Dated pricing tables
// ---------------------------------------------------------------------------

describe('dated pricing tables', () => {
  // Illustrative numbers only; this kit ships no prices.
  const definition = {
    checkedAt: '2026-10-01',
    source: 'https://example.com/pricing',
    rates: {
      'anthropic:toy-model': { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 },
      'openai:toy-model': { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 1 },
      'bedrock:vendor.toy-model-v1:0': { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1 },
    },
  };

  it('defines a frozen copy and looks up provider:model keys', () => {
    const table = definePricingTable(definition);
    expect(Object.isFrozen(table)).toBe(true);
    expect(Object.isFrozen(table.rates)).toBe(true);
    expect(Object.getPrototypeOf(table.rates)).toBeNull();
    expect(lookupRatesOrThrow(table, 'openai:toy-model')).toEqual({ inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 1 });
    expect(lookupRatesOrThrow(table, 'bedrock:vendor.toy-model-v1:0').inputPerMillion).toBe(1);
    // Editing the input afterward changes nothing.
    definition.rates['openai:toy-model'].inputPerMillion = 999;
    expect(lookupRatesOrThrow(table, 'openai:toy-model').inputPerMillion).toBe(2);
    definition.rates['openai:toy-model'].inputPerMillion = 2;
  });

  it('throws on an unknown model, an inherited name or a different case, with no fallback price', () => {
    const table = definePricingTable(definition);
    for (const key of ['openai:other-model', 'toy-model', 'constructor', '__proto__', 'OpenAI:toy-model']) {
      expect(() => lookupRatesOrThrow(table, key)).toThrow(/no pricing entry/);
    }
    expect(() => lookupRatesOrThrow(table, 7 as never)).toThrow(TypeError);
    expect(() => lookupRatesOrThrow(null as never, 'openai:toy-model')).toThrow(TypeError);
  });

  it.each([
    ['checkedAt without a zone', { ...definition, checkedAt: '2026-10-01T00:00:00' }, RangeError],
    ['an impossible checkedAt', { ...definition, checkedAt: '2026-02-30' }, RangeError],
    ['checkedAt a Date', { ...definition, checkedAt: new Date() }, TypeError],
    ['a blank source', { ...definition, source: ' ' }, RangeError],
    ['no rates', { ...definition, rates: {} }, RangeError],
    ['rates a Map', { ...definition, rates: new Map() }, TypeError],
    ['a key without a provider', { ...definition, rates: { 'toy-model': definition.rates['openai:toy-model'] } }, RangeError],
    ['an uppercase provider', { ...definition, rates: { 'OpenAI:toy': definition.rates['openai:toy-model'] } }, RangeError],
    ['a key with a space', { ...definition, rates: { 'openai:toy model': definition.rates['openai:toy-model'] } }, RangeError],
    ['a key with a control character', { ...definition, rates: { 'openai:toy\u0000': definition.rates['openai:toy-model'] } }, RangeError],
    ['a missing cacheReadPerMillion (no silent 0.1x default)', { ...definition, rates: { 'openai:toy': { inputPerMillion: 1, outputPerMillion: 1 } } }, TypeError],
    ['a typo field', { ...definition, rates: { 'openai:toy': { inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1 } } }, TypeError],
    ['a negative rate', { ...definition, rates: { 'openai:toy': { inputPerMillion: -1, outputPerMillion: 1, cacheReadPerMillion: 0.1 } } }, RangeError],
    ['a NaN rate', { ...definition, rates: { 'openai:toy': { inputPerMillion: Number.NaN, outputPerMillion: 1, cacheReadPerMillion: 0.1 } } }, RangeError],
  ])('definePricingTable rejects %s', (_label, bad, ErrorType) => {
    expect(() => definePricingTable(bad as never)).toThrow(ErrorType);
  });

  it('accepts a zoned date-time checkedAt', () => {
    expect(definePricingTable({ ...definition, checkedAt: '2026-10-01T09:30:00-05:00' }).checkedAt).toBe('2026-10-01T09:30:00-05:00');
  });

  it('assertPricingFresh: fresh passes, exactly at the limit passes, a millisecond past throws', () => {
    const table = definePricingTable(definition); // 2026-10-01T00:00Z
    expect(() => assertPricingFresh(table, new Date('2026-10-10T12:00:00Z'), 30)).not.toThrow();
    expect(() => assertPricingFresh(table, new Date('2026-10-31T00:00:00Z'), 30)).not.toThrow();
    expect(() => assertPricingFresh(table, new Date('2026-10-31T00:00:00.001Z'), 30)).toThrow(/30 days old \(limit 30\)/);
  });

  it('assertPricingFresh: a stale table names its date and source', () => {
    const table = definePricingTable(definition);
    expect(() => assertPricingFresh(table, new Date('2027-01-01T00:00:00Z'), 30)).toThrow(/"2026-10-01".*"https:\/\/example.com\/pricing"/);
  });

  it('assertPricingFresh: up to one day in the future is allowed, more is not', () => {
    const table = definePricingTable(definition);
    expect(() => assertPricingFresh(table, new Date('2026-09-30T00:00:00Z'), 30)).not.toThrow();
    expect(() => assertPricingFresh(table, new Date('2026-09-29T23:59:59Z'), 30)).toThrow(/in the future/);
  });

  it('assertPricingFresh: rejects a bad now, a bad maxAgeDays or a hand-built bad table', () => {
    const table = definePricingTable(definition);
    expect(() => assertPricingFresh(table, new Date(Number.NaN), 30)).toThrow(RangeError);
    expect(() => assertPricingFresh(table, '2026-10-10' as never, 30)).toThrow(TypeError);
    expect(() => assertPricingFresh(table, new Date(), 0)).toThrow(RangeError);
    expect(() => assertPricingFresh(table, new Date(), Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => assertPricingFresh(table, new Date(), '30' as never)).toThrow(TypeError);
    expect(() => assertPricingFresh({ ...table, checkedAt: 'last week' }, new Date(), 30)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 10. Adversarial probes: attempts at a false ADMIT or a false DENY
// ---------------------------------------------------------------------------

describe('adversarial probes', () => {
  it('false ADMIT probe 1: a store that ignores limits and admits past a zero limit is caught', async () => {
    const outcome = await admitBeforeCall(scripted(() => Promise.resolve({ status: 'admitted', windowId: DAY })), {
      scopes: [global(10), user('banned', 0)],
    });
    expect(outcome).toMatchObject({ status: 'unavailable', reason: 'malformed_reply' });
  });

  it('false ADMIT probe 2: a store that counts in the wrong window kind (day id for an hour request) is caught', async () => {
    const outcome = await admitBeforeCall(scripted(() => Promise.resolve({ status: 'admitted', windowId: DAY })), {
      scopes: [global(10)],
      window: 'utc-hour',
    });
    expect(outcome).toMatchObject({ status: 'unavailable', reason: 'malformed_reply' });
  });

  it('false ADMIT probe 3: a store that tries to raise a limit in the request object cannot (frozen), and fails closed', async () => {
    const store = scripted((request) => {
      (request.scopes[0] as { limit: number }).limit = 1_000_000;
      return Promise.resolve({ status: 'admitted', windowId: DAY });
    });
    expect(await admitBeforeCall(store, { scopes: [global(0)] })).toMatchObject({ status: 'unavailable', reason: 'store_error' });
  });

  it('false ADMIT probe 4: a scopes array that changes between reads is copied once', async () => {
    let reads = 0;
    const scopes = [global(1)];
    const shifty = new Proxy(scopes, {
      get(target, prop, receiver) {
        if (prop === '0') reads++;
        if (prop === '0' && reads > 1) return { key: 'explain:global', limit: 1_000_000 };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const store = scripted(() => Promise.resolve({ status: 'limited', scopeKey: 'explain:global', windowId: DAY }));
    await admitBeforeCall(store, { scopes: shifty });
    expect(reads).toBe(1);
    expect(store.calls[0]?.scopes).toEqual([{ key: 'explain:global', limit: 1 }]);
  });

  it('false ADMIT probe 5: a reply whose status getter flips between reads is read once', async () => {
    let reads = 0;
    const reply = {
      get status() {
        reads++;
        return reads === 1 ? 'limited' : 'admitted';
      },
      scopeKey: 'explain:global',
      windowId: DAY,
    };
    const outcome = await admitBeforeCall(scripted(() => Promise.resolve(reply)), { scopes: [global(5)] });
    expect(outcome).toEqual({ status: 'limited', scopeKey: 'explain:global', windowId: DAY });
    expect(reads).toBe(1);
  });

  it('false ADMIT probe 6 (found and fixed): a clock that jumps back a day must not reopen a spent window', async () => {
    // Before the fix, the in-memory store kept only the current window and
    // rebuilt yesterday's counters from zero when the clock stepped back.
    const c = clock('2026-10-11T00:00:01Z');
    const store = createInMemoryAdmissionStore({ now: c.now });
    c.set('2026-10-10T23:59:00Z');
    expect(await admitTimes(store, 2, [global(2)])).toEqual(['admitted', 'admitted']);
    c.set('2026-10-11T00:00:05Z');
    expect(await admitTimes(store, 2, [global(2)])).toEqual(['admitted', 'admitted']);
    c.set('2026-10-10T23:59:30Z'); // NTP steps the clock back
    const back = await admitBeforeCall(store, { scopes: [global(2)] });
    expect(back).toEqual({ status: 'limited', scopeKey: 'explain:global', windowId: '2026-10-11' });
  });

  it('false ADMIT probe 7: a key made only of invisible characters is blank, not a fresh scope', async () => {
    const outcome = await admitBeforeCall(createInMemoryAdmissionStore(), { scopes: [{ key: '⁠﻿', limit: 1 }] });
    expect(outcome).toMatchObject({ reason: 'invalid_request' });
  });

  it('false ADMIT probe 8: a store that admits after the timeout is still refused (and its count stands)', async () => {
    let finish!: (d: AdmissionDecision) => void;
    const store = scripted(() => new Promise<AdmissionDecision>((resolve) => (finish = resolve)));
    const outcome = await admitBeforeCall(store, { scopes: [global(5)], timeoutMs: 5 });
    finish({ status: 'admitted', windowId: DAY });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'timeout' });
  });

  it('false ADMIT probe 9: a forged or near-miss outcome never maps to "proceed"', () => {
    for (const forged of [{ status: 'admitted ' }, { status: 'Admitted' }, {}, 'admitted', undefined, { status: 'admitted', valueOf: () => null }]) {
      // None of these is a well-formed admitted outcome (no windowId), so none may map to null.
      expect(admissionHttpStatus(forged as unknown as AdmitOutcome)).toBe(503);
    }
  });

  it.each([
    ['admitted with no windowId', { status: 'admitted' }],
    ['admitted with a blank windowId', { status: 'admitted', windowId: '' }],
    ['admitted with a non-canonical windowId', { status: 'admitted', windowId: '10/10/2026' }],
    ['admitted with an impossible date', { status: 'admitted', windowId: '2026-02-30' }],
    ['admitted with hour 24', { status: 'admitted', windowId: '2026-10-10T24' }],
    ['admitted with a numeric windowId', { status: 'admitted', windowId: 20261010 }],
    ['admitted that also names a scopeKey', { status: 'admitted', windowId: DAY, scopeKey: 'explain:global' }],
    ['admitted whose windowId getter throws', { status: 'admitted', get windowId() { throw new Error('x'); } }],
  ])('false ADMIT probe 17 (review finding): admissionHttpStatus fails closed on a malformed admitted outcome (%s)', (_label, outcome) => {
    expect(admissionHttpStatus(outcome as unknown as AdmitOutcome)).toBe(503);
  });

  it('control for probe 17: well-formed admitted outcomes, day or hour, still map to null', () => {
    expect(admissionHttpStatus({ status: 'admitted', windowId: DAY })).toBeNull();
    expect(admissionHttpStatus({ status: 'admitted', windowId: `${DAY}T23` })).toBeNull();
    expect(admissionHttpStatus({ status: 'admitted', windowId: DAY, scopeKey: undefined } as AdmitOutcome)).toBeNull();
  });

  it('false ADMIT probe 10: a cache-write split that under-reports its total is refused, not priced low', () => {
    expect(() =>
      usageFromAnthropic({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 10_000, cache_creation: { ephemeral_5m_input_tokens: 0 } }),
    ).toThrow(RangeError);
  });

  it('false ADMIT probe 11: a tiny call reserved in micros is never a zero-size hold', async () => {
    const amount = estimateCostMicros({ inputPerMillion: 0.01, outputPerMillion: 0 }, { inputTokens: 1 });
    expect(amount).toBe(1);
    await expect(
      withCapacityReservation(
        { reserveCapacity: async () => ({ status: 'denied' }), confirmReservation: async () => undefined, releaseReservation: async () => undefined },
        { key: 'k', limit: 10, operationId: 'o', amount: 0 },
        async () => ({ status: 'succeeded', value: 1 }),
      ),
    ).rejects.toThrow(RangeError);
  });

  it('false ADMIT probe 12: a negative actualAmount cannot shrink recorded usage; the hold is kept instead', async () => {
    const confirms: unknown[] = [];
    const result = await withCapacityReservation(
      {
        reserveCapacity: async (r) => ({
          status: 'acquired',
          reservation: { id: 'r', key: r.key, operationId: r.operationId, expiresAt: new Date(Date.now() + 60_000).toISOString() },
        }),
        confirmReservation: async (...args: unknown[]) => void confirms.push(args),
        releaseReservation: async () => undefined,
      },
      { key: 'k', limit: 10, operationId: 'o', amount: 5 },
      async () => ({ status: 'succeeded', value: 1, settle: { actualAmount: -100 } }),
    );
    expect(result.status).toBe('work_outcome_ambiguous');
    expect(confirms).toEqual([]);
  });

  it('false ADMIT probe 13: a sparse scopes array (a hole where a scope should be) is invalid, not skipped', async () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is the case under test
    const outcome = await admitBeforeCall(createInMemoryAdmissionStore(), { scopes: [global(5), , user('a', 1)] as never });
    expect(outcome).toMatchObject({ status: 'unavailable', reason: 'invalid_request' });
  });

  it('false ADMIT probe 14: keys named like Object.prototype members are ordinary scopes in the reference store', async () => {
    const store = createInMemoryAdmissionStore();
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(await admitTimes(store, 2, [{ key, limit: 1 }])).toEqual(['admitted', 'limited']);
    }
  });

  it('false ADMIT probe 15 (review finding): a scopes proxy whose length shrinks between reads cannot drop a scope', async () => {
    const backing = [global(10), user('a', 0)];
    let lengthReads = 0;
    const shrinking = new Proxy(backing, {
      get(target, prop, receiver) {
        if (prop === 'length') {
          lengthReads++;
          return lengthReads === 1 ? 2 : 1;
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const store = scripted(() => Promise.resolve({ status: 'admitted', windowId: DAY }));
    const outcome = await admitBeforeCall(store, { scopes: shrinking });
    // The zero-limit user scope must still be there, so an "admitted" reply is impossible.
    expect(outcome).toMatchObject({ status: 'unavailable', reason: 'malformed_reply' });
    expect(lengthReads).toBe(1);
    expect(store.calls[0]?.scopes).toEqual([
      { key: 'explain:global', limit: 10 },
      { key: 'explain:user:a', limit: 0 },
    ]);
  });

  it('false ADMIT probe 16 (review finding): a store that blocks the event loop past timeoutMs is a timeout, even if it says admitted', async () => {
    const store = scripted(() => {
      const until = performance.now() + 30;
      while (performance.now() < until) {
        // Synchronous work inside admit, before any timer can fire.
      }
      return Promise.resolve({ status: 'admitted', windowId: DAY });
    });
    const outcome = await admitBeforeCall(store, { scopes: [global(5)], timeoutMs: 5 });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'timeout' });
    expect(store.calls).toHaveLength(1);
  });

  it('false DENY probe 1: limits on different scopes do not leak into each other (no shared counter by accident)', async () => {
    const store = createInMemoryAdmissionStore({ now: clock(`${DAY}T01:00:00Z`).now });
    await admitTimes(store, 3, [user('a', 3)]);
    expect((await admitBeforeCall(store, { scopes: [user('b', 3)] })).status).toBe('admitted');
    // A key that is a prefix of another is a different scope.
    expect((await admitBeforeCall(store, { scopes: [{ key: 'explain:user:', limit: 1 }] })).status).toBe('admitted');
  });

  it('false DENY probe 2: a lowered limit is per scope; it does not lower a different key', async () => {
    const store = createInMemoryAdmissionStore({ now: clock(`${DAY}T01:00:00Z`).now });
    expect((await admitBeforeCall(store, { scopes: [user('a', 0)] })).status).toBe('limited');
    expect((await admitBeforeCall(store, { scopes: [user('b', 1)] })).status).toBe('admitted');
  });

  it('false DENY probe 3: a valid reply with scopeKey: undefined on admitted is accepted', async () => {
    const outcome = await admitBeforeCall(scripted(() => Promise.resolve({ status: 'admitted', windowId: DAY, scopeKey: undefined })), {
      scopes: [global(1)],
    });
    expect(outcome).toEqual(admitted());
  });

  it('false DENY probe 4: per-user mapping depends on the prefix you configure (use a delimiter)', () => {
    const limitedGlobal = { status: 'limited', scopeKey: 'users-global', windowId: DAY } as AdmitOutcome;
    expect(admissionHttpStatus(limitedGlobal, { perUserScopePrefixes: ['user'] })).toBe(429); // too-loose prefix
    expect(admissionHttpStatus(limitedGlobal, { perUserScopePrefixes: ['user:'] })).toBe(503);
  });

  it('false DENY probe 5: a leap day is a real window id', async () => {
    const outcome = await admitBeforeCall(scripted(() => Promise.resolve({ status: 'admitted', windowId: '2028-02-29' })), {
      scopes: [global(1)],
    });
    expect(outcome).toEqual(admitted('2028-02-29'));
  });
});
