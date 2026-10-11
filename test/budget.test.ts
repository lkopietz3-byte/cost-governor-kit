/**
 * budget.test.ts: the in-memory capacity ledger and withCapacityReservations
 * (a per-user cap inside a global cap, in dollars), from the 2026-10-10 field
 * trial finding that every adopter nested two reservations by hand.
 */
import { describe, expect, it } from 'vitest';
import {
  createInMemoryCapacityLedger,
  withCapacityReservations,
  type CapacityReservation,
  type CapacityReservationLedger,
  type CapacityWorkOutcome,
} from '../src/index.js';

const USER = 'budget:user:u1';
const GLOBAL = 'budget:global';
const request = (over: Record<string, unknown> = {}) => ({
  scopes: [{ key: USER, limit: 100 }, { key: GLOBAL, limit: 1_000 }],
  operationId: 'op-1',
  amount: 40,
  ...over,
});

/** Wrap a ledger and record every call (and optionally break one). */
function spy(inner: CapacityReservationLedger, fail: { confirm?: string; release?: string; reserve?: string } = {}) {
  const calls: string[] = [];
  const ledger: CapacityReservationLedger = {
    reserveCapacity: async (r) => {
      calls.push(`reserve:${r.key}`);
      if (fail.reserve === r.key) throw new Error('reserve down');
      return inner.reserveCapacity(r);
    },
    confirmReservation: async (res, s) => {
      calls.push(`confirm:${res.key}${s ? `:${s.amount}` : ''}`);
      if (fail.confirm === res.key) throw new Error('confirm down');
      return inner.confirmReservation(res, s);
    },
    releaseReservation: async (res) => {
      calls.push(`release:${res.key}`);
      if (fail.release === res.key) throw new Error('release down');
      return inner.releaseReservation(res);
    },
  };
  return { ledger, calls };
}

const ok = (settle?: unknown): (() => Promise<CapacityWorkOutcome<string>>) => async () =>
  ({ status: 'succeeded', value: 'reply', ...(settle === undefined ? {} : { settle }) }) as CapacityWorkOutcome<string>;

describe('createInMemoryCapacityLedger', () => {
  const op = (n: number) => ({ key: 'k', limit: 10, operationId: `o${n}`, amount: 4 });

  it('holds count toward the limit, a refusal changes nothing, and the second operation is denied', async () => {
    const ledger = createInMemoryCapacityLedger();
    expect((await ledger.reserveCapacity(op(1))).status).toBe('acquired');
    expect((await ledger.reserveCapacity(op(2))).status).toBe('acquired');
    expect(await ledger.reserveCapacity(op(3))).toEqual({ status: 'denied', reason: 'limit' });
    expect(ledger.usage('k')).toEqual({ confirmed: 0, held: 8 });
  });

  it('repeated operation ids: in progress while held, terminal once settled, never a second hold', async () => {
    const ledger = createInMemoryCapacityLedger();
    const first = await ledger.reserveCapacity(op(1));
    if (first.status !== 'acquired') throw new Error('expected acquired');
    expect((await ledger.reserveCapacity(op(1))).status).toBe('operation_in_progress');
    await ledger.confirmReservation(first.reservation, { usage: 'reported', amount: 6, reservedAmount: 4 });
    expect(await ledger.reserveCapacity(op(1))).toMatchObject({ status: 'operation_terminal', operationId: 'o1' });
    expect(ledger.usage('k')).toEqual({ confirmed: 6, held: 0 }); // the actual, above the hold, is recorded
  });

  it('confirm and release are idempotent; a settled hold cannot flip', async () => {
    const ledger = createInMemoryCapacityLedger();
    const a = await ledger.reserveCapacity(op(1));
    const b = await ledger.reserveCapacity(op(2));
    if (a.status !== 'acquired' || b.status !== 'acquired') throw new Error('expected acquired');
    await ledger.confirmReservation(a.reservation);
    await ledger.confirmReservation(a.reservation);
    await ledger.releaseReservation(b.reservation);
    await ledger.releaseReservation(b.reservation);
    expect(ledger.usage('k')).toEqual({ confirmed: 4, held: 0 });
    await expect(ledger.releaseReservation(a.reservation)).rejects.toThrow(/confirmed/);
    await expect(ledger.confirmReservation(b.reservation)).rejects.toThrow(/released/);
    await expect(ledger.confirmReservation({ ...a.reservation, id: 'forged' })).rejects.toThrow(/unknown/);
  });

  it('an expired hold stops counting but stays unresolved', async () => {
    let offset = 0;
    const ledger = createInMemoryCapacityLedger({ holdMs: 1_000, now: () => Date.now() + offset });
    expect((await ledger.reserveCapacity({ key: 'k', limit: 4, operationId: 'a', amount: 4 })).status).toBe('acquired');
    expect((await ledger.reserveCapacity({ key: 'k', limit: 4, operationId: 'b', amount: 4 })).status).toBe('denied');
    offset = 5_000;
    expect((await ledger.reserveCapacity({ key: 'k', limit: 4, operationId: 'b', amount: 4 })).status).toBe('acquired');
    expect((await ledger.reserveCapacity({ key: 'k', limit: 4, operationId: 'a', amount: 4 })).status).toBe('operation_in_progress');
  });

  it('count-based use: no amount means one unit', async () => {
    const ledger = createInMemoryCapacityLedger();
    for (let i = 0; i < 3; i++) await ledger.reserveCapacity({ key: 'c', limit: 3, operationId: `o${i}` });
    expect((await ledger.reserveCapacity({ key: 'c', limit: 3, operationId: 'o9' })).status).toBe('denied');
  });

  it('rejects bad options and bad requests instead of guessing', async () => {
    expect(() => createInMemoryCapacityLedger({ holdMs: 0 })).toThrow(RangeError);
    expect(() => createInMemoryCapacityLedger({ now: 5 as never })).toThrow(TypeError);
    expect(() => createInMemoryCapacityLedger(null as never)).toThrow(TypeError);
    const ledger = createInMemoryCapacityLedger();
    await expect(ledger.reserveCapacity({ key: ' ', limit: 1, operationId: 'o' })).rejects.toThrow(TypeError);
    await expect(ledger.reserveCapacity({ key: 'k', limit: -1, operationId: 'o' })).rejects.toThrow(RangeError);
    await expect(ledger.reserveCapacity({ key: 'k', limit: 1, operationId: 'o', amount: 0 })).rejects.toThrow(RangeError);
  });
});

describe('withCapacityReservations', () => {
  it('B1 the honest path: both scopes held, the work runs once, both confirm the actual amount', async () => {
    const mem = createInMemoryCapacityLedger();
    const { ledger, calls } = spy(mem);
    let ran = 0;
    const result = await withCapacityReservations(ledger, request(), async (reservations) => {
      ran++;
      expect(reservations.map((r) => r.key)).toEqual([USER, GLOBAL]);
      expect(Object.isFrozen(reservations)).toBe(true);
      expect(mem.usage(USER).held).toBe(40);
      expect(mem.usage(GLOBAL).held).toBe(40);
      return { status: 'succeeded', value: 'reply', settle: { actualAmount: 25 } };
    });
    expect(ran).toBe(1);
    expect(result).toMatchObject({ status: 'confirmed', value: 'reply', settlement: { usage: 'reported', amount: 25, reservedAmount: 40 } });
    expect(result.status === 'confirmed' && result.reservations.map((r) => r.key)).toEqual([USER, GLOBAL]);
    expect(Object.hasOwn(result, 'overrunAmount')).toBe(false);
    expect(mem.usage(USER)).toEqual({ confirmed: 25, held: 0 });
    expect(mem.usage(GLOBAL)).toEqual({ confirmed: 25, held: 0 });
    expect(calls).toEqual([`reserve:${USER}`, `reserve:${GLOBAL}`, `confirm:${GLOBAL}:25`, `confirm:${USER}:25`]);
  });

  it('B2 usage unknown (or a missing settle) records the full estimate on every scope, never zero', async () => {
    for (const settle of [{ usage: 'unknown' }, undefined]) {
      const mem = createInMemoryCapacityLedger();
      const result = await withCapacityReservations(mem, request(), ok(settle));
      expect(result).toMatchObject({ status: 'confirmed', settlement: { usage: 'unknown', amount: 40 } });
      expect(mem.usage(USER).confirmed).toBe(40);
      expect(mem.usage(GLOBAL).confirmed).toBe(40);
    }
  });

  it('B3 an actual above the hold is recorded in full on every scope and reported', async () => {
    const mem = createInMemoryCapacityLedger();
    const result = await withCapacityReservations(mem, request(), ok({ actualAmount: 70 }));
    expect(result).toMatchObject({ status: 'confirmed', overrunAmount: 30 });
    expect(mem.usage(USER).confirmed).toBe(70);
    expect(mem.usage(GLOBAL).confirmed).toBe(70);
  });

  it('B4 the first scope is full: refused naming it, nothing else is touched, the work does not run', async () => {
    const mem = createInMemoryCapacityLedger();
    const { ledger, calls } = spy(mem);
    let ran = 0;
    const result = await withCapacityReservations(ledger, request({ amount: 101 }), async () => {
      ran++;
      return { status: 'succeeded', value: 1 };
    });
    expect(result).toEqual({ status: 'refused', refusal: 'denied', scopeKey: USER, reason: 'limit' });
    expect(ran).toBe(0);
    expect(calls).toEqual([`reserve:${USER}`]);
  });

  it('B5 the second scope is full: the first hold is released, the refusal names the global scope', async () => {
    const mem = createInMemoryCapacityLedger();
    const { ledger, calls } = spy(mem);
    let ran = 0;
    const result = await withCapacityReservations(ledger, request({ scopes: [{ key: USER, limit: 100 }, { key: GLOBAL, limit: 30 }] }), async () => {
      ran++;
      return { status: 'succeeded', value: 1 };
    });
    expect(result).toEqual({ status: 'refused', refusal: 'denied', scopeKey: GLOBAL, reason: 'limit' });
    expect(ran).toBe(0);
    expect(calls).toEqual([`reserve:${USER}`, `reserve:${GLOBAL}`, `release:${USER}`]);
    expect(mem.usage(USER)).toEqual({ confirmed: 0, held: 0 });
  });

  it('B6 work that reports failed releases every hold and records nothing', async () => {
    const mem = createInMemoryCapacityLedger();
    const { ledger, calls } = spy(mem);
    const boom = new Error('provider rejected before any charge');
    const result = await withCapacityReservations(ledger, request(), async () => ({ status: 'failed', error: boom }));
    expect(result).toEqual({ status: 'released_after_failure', error: boom });
    expect(calls).toEqual([`reserve:${USER}`, `reserve:${GLOBAL}`, `release:${GLOBAL}`, `release:${USER}`]);
    expect(mem.usage(USER)).toEqual({ confirmed: 0, held: 0 });
    expect(mem.usage(GLOBAL)).toEqual({ confirmed: 0, held: 0 });
  });

  it('B7 work that throws, or returns a malformed outcome, keeps every hold for reconciliation', async () => {
    for (const work of [
      async () => {
        throw new Error('timeout after the request was written');
      },
      async () => 'not an outcome' as never,
      async () => ({ status: 'succeeded' }) as never,
      async () => ({ status: 'succeeded', value: 1, settle: { actualAmount: -5 } }) as never,
    ]) {
      const mem = createInMemoryCapacityLedger();
      const { ledger, calls } = spy(mem);
      const result = await withCapacityReservations(ledger, request(), work);
      expect(result.status).toBe('needs_reconciliation');
      expect(result.status === 'needs_reconciliation' && result.result.status).toBe('work_outcome_ambiguous');
      expect(calls.filter((c) => c.startsWith('confirm') || c.startsWith('release'))).toEqual([]);
      expect(mem.usage(USER).held).toBe(40);
      expect(mem.usage(GLOBAL).held).toBe(40);
    }
  });

  it('B8 a failed confirm on the global scope keeps the user hold too and says which scope', async () => {
    const mem = createInMemoryCapacityLedger();
    const { ledger, calls } = spy(mem, { confirm: GLOBAL });
    const result = await withCapacityReservations(ledger, request(), ok({ actualAmount: 25 }));
    expect(result).toMatchObject({ status: 'needs_reconciliation', scopeKey: GLOBAL, result: { status: 'confirmation_failed', value: expect.anything() as unknown } });
    expect(calls.filter((c) => c.startsWith('release'))).toEqual([]);
    expect(calls.filter((c) => c.startsWith('confirm'))).toEqual([`confirm:${GLOBAL}:25`]);
    expect(mem.usage(USER).held).toBe(40);
  });

  it('B9 a failed confirm on the user scope after global confirmed is reported, not hidden', async () => {
    const mem = createInMemoryCapacityLedger();
    const { ledger } = spy(mem, { confirm: USER });
    const result = await withCapacityReservations(ledger, request(), ok({ actualAmount: 25 }));
    expect(result).toMatchObject({ status: 'needs_reconciliation', scopeKey: USER, result: { status: 'confirmation_failed' } });
    expect(mem.usage(GLOBAL).confirmed).toBe(25);
  });

  it('B10 a refusal whose release of an earlier hold fails is needs_reconciliation for that earlier scope', async () => {
    const mem = createInMemoryCapacityLedger();
    const { ledger } = spy(mem, { release: USER });
    const result = await withCapacityReservations(ledger, request({ scopes: [{ key: USER, limit: 100 }, { key: GLOBAL, limit: 30 }] }), ok());
    expect(result).toMatchObject({ status: 'needs_reconciliation', scopeKey: USER, result: { status: 'release_failed' } });
    expect(mem.usage(USER).held).toBe(40);
  });

  it('B11 the same operation twice: the second is refused as in progress (then terminal), and the work runs once', async () => {
    const mem = createInMemoryCapacityLedger();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let ran = 0;
    const first = withCapacityReservations(mem, request(), async () => {
      ran++;
      await gate;
      return { status: 'succeeded', value: 1 };
    });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    const second = await withCapacityReservations(mem, request(), ok());
    expect(second).toMatchObject({ status: 'refused', refusal: 'operation_in_progress', scopeKey: USER });
    release();
    expect((await first).status).toBe('confirmed');
    const third = await withCapacityReservations(mem, request(), ok());
    expect(third).toMatchObject({ status: 'refused', refusal: 'operation_terminal', scopeKey: USER });
    expect(ran).toBe(1);
  });

  it('B12 a ledger that rejects on the first scope propagates and runs no work; on a later scope the earlier hold is kept', async () => {
    let ran = 0;
    const work = async (): Promise<CapacityWorkOutcome<number>> => {
      ran++;
      return { status: 'succeeded', value: 1 };
    };
    const first = spy(createInMemoryCapacityLedger(), { reserve: USER });
    await expect(withCapacityReservations(first.ledger, request(), work)).rejects.toThrow('reserve down');
    const mem = createInMemoryCapacityLedger();
    const later = spy(mem, { reserve: GLOBAL });
    const result = await withCapacityReservations(later.ledger, request(), work);
    expect(result).toMatchObject({ status: 'needs_reconciliation', scopeKey: USER, result: { status: 'work_outcome_ambiguous' } });
    expect(mem.usage(USER).held).toBe(40);
    expect(later.calls.filter((c) => c.startsWith('release'))).toEqual([]);
    expect(ran).toBe(0);
  });

  it.each([
    ['no scopes', { scopes: [] }, RangeError],
    ['nine scopes', { scopes: Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, limit: 5 })) }, RangeError],
    ['scopes not an array', { scopes: 'x' }, TypeError],
    ['a scope that is not an object', { scopes: [null] }, TypeError],
    ['duplicate keys', { scopes: [{ key: 'a', limit: 5 }, { key: 'a', limit: 6 }] }, RangeError],
    ['a blank key', { scopes: [{ key: ' ', limit: 5 }] }, RangeError],
    ['a negative limit', { scopes: [{ key: 'a', limit: -1 }] }, RangeError],
    ['a NaN limit', { scopes: [{ key: 'a', limit: Number.NaN }] }, RangeError],
    ['a fractional limit', { scopes: [{ key: 'a', limit: 1.5 }] }, RangeError],
    ['a missing amount', { amount: undefined }, TypeError],
    ['an amount of 0', { amount: 0 }, RangeError],
    ['an amount of -0', { amount: -0 }, RangeError],
    ['an amount of 2^53', { amount: 2 ** 53 }, RangeError],
    ['a BigInt amount', { amount: 5n }, TypeError],
    ['a blank operationId', { operationId: '​' }, RangeError],
    ['a numeric operationId', { operationId: 5 }, TypeError],
  ])('B13 invalid input (%s) throws before the ledger is called', async (_label, over, ErrorType) => {
    const mem = createInMemoryCapacityLedger();
    const { ledger, calls } = spy(mem);
    await expect(withCapacityReservations(ledger, request(over), ok())).rejects.toThrow(ErrorType);
    expect(calls).toEqual([]);
  });

  it('B13b a request that is not an object, a sparse scopes array and a non-function work throw before the ledger', async () => {
    const { ledger, calls } = spy(createInMemoryCapacityLedger());
    await expect(withCapacityReservations(ledger, null as never, ok())).rejects.toThrow(TypeError);
    // eslint-disable-next-line no-sparse-arrays -- the hole is the case under test
    await expect(withCapacityReservations(ledger, request({ scopes: [{ key: 'a', limit: 5 }, , { key: 'b', limit: 5 }] }), ok())).rejects.toThrow(TypeError);
    await expect(withCapacityReservations(ledger, request(), 'work' as never)).rejects.toThrow(TypeError);
    expect(calls).toEqual([]);
  });

  it('B14 hostile request objects are read once: a scopes Proxy length, scope getters and operationId', async () => {
    let lengthReads = 0;
    const scopes = [{ key: USER, limit: 100 }, { key: GLOBAL, limit: 1_000 }];
    const shifty = new Proxy(scopes, {
      get(target, prop, receiver) {
        if (prop === 'length') lengthReads++;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    let keyReads = 0;
    const scope = { limit: 100 };
    Object.defineProperty(scope, 'key', { enumerable: true, get() { keyReads++; return keyReads === 1 ? USER : 'other'; } });
    const mem = createInMemoryCapacityLedger();
    const result = await withCapacityReservations(mem, request({ scopes: shifty }), ok());
    expect(result.status).toBe('confirmed');
    expect(lengthReads).toBe(1);
    const single = await withCapacityReservations(mem, request({ scopes: [scope], operationId: 'op-getter' }), ok());
    expect(single.status).toBe('confirmed');
    expect(keyReads).toBe(1);
    expect(mem.usage(USER).confirmed).toBe(40 + 40);
  });

  it('B15 under 50 concurrent requests exactly as many fit as the tighter cap allows (user cap, then global cap)', async () => {
    const run = async (userLimit: number, globalLimit: number) => {
      const mem = createInMemoryCapacityLedger();
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          withCapacityReservations(
            mem,
            { scopes: [{ key: USER, limit: userLimit }, { key: GLOBAL, limit: globalLimit }], operationId: `op-${i}`, amount: 10 },
            ok({ actualAmount: 10 }),
          ),
        ),
      );
      return { confirmed: results.filter((r) => r.status === 'confirmed').length, mem };
    };
    const byUser = await run(50, 1_000);
    expect(byUser.confirmed).toBe(5);
    expect(byUser.mem.usage(USER)).toEqual({ confirmed: 50, held: 0 });
    expect(byUser.mem.usage(GLOBAL)).toEqual({ confirmed: 50, held: 0 });
    const byGlobal = await run(1_000, 30);
    expect(byGlobal.confirmed).toBe(3);
    expect(byGlobal.mem.usage(GLOBAL)).toEqual({ confirmed: 30, held: 0 });
    // Releases of the user holds from refused requests left no residue.
    expect(byGlobal.mem.usage(USER)).toEqual({ confirmed: 30, held: 0 });
  });

  it('B16 one scope works like withCapacityReservation', async () => {
    const mem = createInMemoryCapacityLedger();
    const result = await withCapacityReservations(mem, request({ scopes: [{ key: GLOBAL, limit: 100 }] }), ok({ actualAmount: 10 }));
    expect(result).toMatchObject({ status: 'confirmed', settlement: { amount: 10 } });
    expect(mem.usage(GLOBAL).confirmed).toBe(10);
  });

  it('B17 a hostile reservation callback input cannot change what is confirmed: the work gets a frozen copy', async () => {
    const mem = createInMemoryCapacityLedger();
    let given: readonly CapacityReservation[] = [];
    await withCapacityReservations(mem, request(), async (reservations) => {
      given = reservations;
      expect(() => ((reservations as CapacityReservation[])[0] = reservations[1] as CapacityReservation)).toThrow();
      return { status: 'succeeded', value: 1 };
    });
    expect(given).toHaveLength(2);
    expect(mem.usage(USER).confirmed).toBe(40);
  });
});
