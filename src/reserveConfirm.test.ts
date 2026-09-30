import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  withCapacityReservation,
  withReserveConfirm,
  type CapacityReservation,
  type CapacityReservationLedger,
  type ReserveCapacityRequest,
  type UsageLedger,
} from './reserveConfirm.js';

/**
 * A minimal in-memory UsageLedger, standing in for a real database-backed
 * implementation (see reference-impl/supabase-usage-ledger.sql for the
 * Postgres/Supabase version of this same contract). Records every call so
 * tests can assert on exactly what happened and in what order.
 */
class FakeLedger implements UsageLedger {
  counts = new Map<string, number>();
  checkCalls: string[] = [];
  commitCalls: string[] = [];

  async checkUnderLimit(key: string, limit: number): Promise<boolean> {
    this.checkCalls.push(key);
    return (this.counts.get(key) ?? 0) < limit;
  }

  async commitUsage(key: string): Promise<void> {
    this.commitCalls.push(key);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
}

describe('withReserveConfirm — the core guarantee: a failing call never commits usage', () => {
  it('does not call commitUsage when doTheCall throws', async () => {
    const ledger = new FakeLedger();

    await expect(
      withReserveConfirm(ledger, 'user-1', 5, async () => {
        throw new Error('upstream 500');
      }),
    ).rejects.toThrow('upstream 500');

    expect(ledger.commitCalls).toEqual([]);
    expect(ledger.counts.get('user-1') ?? 0).toBe(0);
  });

  it('does not commit the failed attempt before a separately chosen later call', async () => {
    const ledger = new FakeLedger();

    // First attempt fails.
    await expect(
      withReserveConfirm(ledger, 'user-1', 5, async () => {
        throw new Error('network blip');
      }),
    ).rejects.toThrow();

    // This is a distinct, later call. Whether retrying paid work is safe depends
    // on provider reconciliation and idempotency, outside the legacy helper.
    const retryResult = await withReserveConfirm(ledger, 'user-1', 5, async () => 'ok-on-retry');

    expect(retryResult).toEqual({ allowed: true, result: 'ok-on-retry' });
    // Exactly ONE commit total: the failed attempt itself did not burn a slot.
    expect(ledger.commitCalls).toEqual(['user-1']);
    expect(ledger.counts.get('user-1')).toBe(1);
  });
});

describe('withReserveConfirm — success path', () => {
  it('checks, calls, then commits, and returns the call result', async () => {
    const ledger = new FakeLedger();
    const calls: string[] = [];

    const result = await withReserveConfirm(ledger, 'user-1', 5, async () => {
      calls.push('doTheCall');
      return { answer: 42 };
    });

    expect(result).toEqual({ allowed: true, result: { answer: 42 } });
    expect(ledger.checkCalls).toEqual(['user-1']);
    expect(calls).toEqual(['doTheCall']);
    expect(ledger.commitCalls).toEqual(['user-1']);
  });
});

describe('withReserveConfirm — over-limit path (phase 1 denies)', () => {
  it('denies without ever invoking doTheCall or committing usage', async () => {
    const ledger = new FakeLedger();
    ledger.counts.set('user-1', 5); // already at the limit

    let doTheCallWasInvoked = false;
    const result = await withReserveConfirm(ledger, 'user-1', 5, async () => {
      doTheCallWasInvoked = true;
      return 'should never happen';
    });

    expect(result).toEqual({ allowed: false });
    expect(doTheCallWasInvoked).toBe(false);
    expect(ledger.commitCalls).toEqual([]);
    // The count is unchanged by the denial itself — checking has zero side effects.
    expect(ledger.counts.get('user-1')).toBe(5);
  });
});

describe('withReserveConfirm — a malformed check result fails closed', () => {
  it.each([
    ['a whole RPC response object', { data: [{ allowed: false }], error: null }],
    ['the string "false"', 'false'],
    ['the number 1', 1],
    ['undefined', undefined],
    ['null', null],
    ['the number 0', 0],
  ])('throws without calling or committing when checkUnderLimit resolves %s', async (_label, value) => {
    let paidCalls = 0;
    let commits = 0;
    const ledger = {
      checkUnderLimit: async () => value,
      commitUsage: async () => {
        commits++;
      },
    } as unknown as UsageLedger;

    await expect(
      withReserveConfirm(ledger, 'user-1', 5, async () => {
        paidCalls++;
        return 'paid';
      }),
    ).rejects.toThrow('withReserveConfirm: ledger.checkUnderLimit must resolve to a boolean');
    expect(paidCalls).toBe(0);
    expect(commits).toBe(0);
  });
});

describe('withReserveConfirm — concurrency shape (two keys are independent)', () => {
  it('tracks separate keys independently', async () => {
    const ledger = new FakeLedger();

    await withReserveConfirm(ledger, 'user-a', 1, async () => 'a');
    await withReserveConfirm(ledger, 'user-b', 1, async () => 'b');

    expect(ledger.counts.get('user-a')).toBe(1);
    expect(ledger.counts.get('user-b')).toBe(1);

    // user-a is now at its limit of 1 — a second call for user-a is denied,
    // but user-b (untouched) is irrelevant to that decision.
    const secondForA = await withReserveConfirm(ledger, 'user-a', 1, async () => 'a-again');
    expect(secondForA).toEqual({ allowed: false });
  });
});

class FakeCapacityLedger implements CapacityReservationLedger {
  confirmed = new Map<string, number>();
  active = new Map<string, CapacityReservation>();
  operations = new Map<string, { status: 'active'; reservation: CapacityReservation } | { status: 'terminal'; reason: string }>();
  reserveCalls: ReserveCapacityRequest[] = [];
  confirmCalls: string[] = [];
  releaseCalls: string[] = [];
  failConfirm = false;
  failRelease = false;
  nextId = 1;

  private operationKey(key: string, operationId: string): string {
    return `${key}\u0000${operationId}`;
  }

  async reserveCapacity(request: ReserveCapacityRequest) {
    this.reserveCalls.push(request);
    const operationKey = this.operationKey(request.key, request.operationId);
    const existing = this.operations.get(operationKey);
    if (existing?.status === 'active') {
      return { status: 'operation_in_progress' as const, reservation: existing.reservation };
    }
    if (existing?.status === 'terminal') {
      return { status: 'operation_terminal' as const, operationId: request.operationId, reason: existing.reason };
    }

    const used = (this.confirmed.get(request.key) ?? 0) +
      [...this.active.values()].filter((reservation) => reservation.key === request.key).length;
    if (used >= request.limit) return { status: 'denied' as const, reason: 'capacity exhausted' };

    const reservation: CapacityReservation = {
      id: `r-${this.nextId++}`,
      key: request.key,
      operationId: request.operationId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    this.active.set(reservation.id, reservation);
    this.operations.set(operationKey, { status: 'active', reservation });
    return { status: 'acquired' as const, reservation };
  }

  async confirmReservation(reservation: CapacityReservation): Promise<void> {
    this.confirmCalls.push(reservation.id);
    if (this.failConfirm) throw new Error('ledger unavailable during confirmation');
    if (!this.active.delete(reservation.id)) return;
    this.confirmed.set(reservation.key, (this.confirmed.get(reservation.key) ?? 0) + 1);
    this.operations.set(this.operationKey(reservation.key, reservation.operationId), {
      status: 'terminal',
      reason: 'already confirmed',
    });
  }

  async releaseReservation(reservation: CapacityReservation): Promise<void> {
    this.releaseCalls.push(reservation.id);
    if (this.failRelease) throw new Error('ledger unavailable during release');
    this.active.delete(reservation.id);
    this.operations.set(this.operationKey(reservation.key, reservation.operationId), {
      status: 'terminal',
      reason: 'released after known no-charge failure',
    });
  }
}

describe('withCapacityReservation — strict concurrent capacity lifecycle', () => {
  it('atomically reserves before work, denying a concurrent call without invoking its provider', async () => {
    const ledger = new FakeCapacityLedger();
    let firstProviderCalls = 0;
    let secondProviderCalls = 0;
    let finishFirst: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => { finishFirst = resolve; });

    const first = withCapacityReservation(ledger, { key: 'user-1', limit: 1, operationId: 'op-1' }, async () => {
      firstProviderCalls++;
      await firstCanFinish;
      return { status: 'succeeded', value: 'paid-result' };
    });
    await Promise.resolve();

    const second = await withCapacityReservation(ledger, { key: 'user-1', limit: 1, operationId: 'op-2' }, async () => {
      secondProviderCalls++;
      return { status: 'succeeded', value: 'must-not-run' };
    });

    expect(second).toEqual({ status: 'denied', reason: 'capacity exhausted' });
    expect(secondProviderCalls).toBe(0);
    expect(firstProviderCalls).toBe(1);

    finishFirst?.();
    await expect(first).resolves.toMatchObject({ status: 'confirmed', value: 'paid-result' });
    expect(ledger.confirmed.get('user-1')).toBe(1);
  });

  it('does not re-execute a concurrent duplicate operation under the same active reservation', async () => {
    const ledger = new FakeCapacityLedger();
    let firstProviderCalls = 0;
    let duplicateProviderCalls = 0;
    let finishFirst: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => { finishFirst = resolve; });

    const first = withCapacityReservation(ledger, { key: 'user-1', limit: 1, operationId: 'op-1' }, async () => {
      firstProviderCalls++;
      await firstCanFinish;
      return { status: 'succeeded', value: 'first result' };
    });
    await Promise.resolve();

    const duplicate = await withCapacityReservation(ledger, { key: 'user-1', limit: 1, operationId: 'op-1' }, async () => {
      duplicateProviderCalls++;
      return { status: 'succeeded', value: 'must-not-run' };
    });

    expect(duplicate.status).toBe('operation_in_progress');
    expect(firstProviderCalls).toBe(1);
    expect(duplicateProviderCalls).toBe(0);

    finishFirst?.();
    await expect(first).resolves.toMatchObject({ status: 'confirmed', value: 'first result' });
  });

  it('returns an expired unresolved hold as recovery metadata and never executes provider work', async () => {
    const reservation: CapacityReservation = {
      id: 'r-expired',
      key: 'user-1',
      operationId: 'op-1',
      expiresAt: new Date(Date.now() - 1).toISOString(),
    };
    const ledger: CapacityReservationLedger = {
      reserveCapacity: async () => ({ status: 'operation_in_progress', reservation }),
      confirmReservation: async () => undefined,
      releaseReservation: async () => undefined,
    };
    let providerCalls = 0;

    const result = await withCapacityReservation(
      ledger,
      { key: 'user-1', limit: 1, operationId: 'op-1' },
      async () => {
        providerCalls++;
        return { status: 'succeeded', value: 'must-not-run' };
      },
    );

    expect(result).toMatchObject({ status: 'operation_in_progress', reservation });
    expect(providerCalls).toBe(0);
  });

  it('releases a reservation after a known failed provider outcome, freeing capacity', async () => {
    const ledger = new FakeCapacityLedger();
    const failed = await withCapacityReservation(ledger, { key: 'user-1', limit: 1, operationId: 'op-1' }, async () => (
      { status: 'failed', error: new Error('provider rejected before charging') }
    ));

    expect(failed.status).toBe('released_after_failure');
    expect(ledger.releaseCalls).toEqual(['r-1']);
    expect(ledger.active.size).toBe(0);

    const retry = await withCapacityReservation(ledger, { key: 'user-1', limit: 1, operationId: 'op-2' }, async () => (
      { status: 'succeeded', value: 'ok' }
    ));
    expect(retry).toMatchObject({ status: 'confirmed', value: 'ok' });
  });

  it('keeps the reservation and result when confirmation fails; it never releases or retries paid work', async () => {
    const ledger = new FakeCapacityLedger();
    ledger.failConfirm = true;
    let providerCalls = 0;

    const result = await withCapacityReservation(ledger, { key: 'user-1', limit: 1, operationId: 'op-1' }, async () => {
      providerCalls++;
      return { status: 'succeeded', value: { receipt: 'provider-success' } };
    });

    expect(result).toMatchObject({
      status: 'confirmation_failed',
      value: { receipt: 'provider-success' },
    });
    expect(providerCalls).toBe(1);
    expect(ledger.releaseCalls).toEqual([]);
    expect(ledger.active.size).toBe(1);
  });

  it('treats a rejected provider promise as ambiguous and keeps the reservation for reconciliation', async () => {
    const ledger = new FakeCapacityLedger();

    const result = await withCapacityReservation(ledger, { key: 'user-1', limit: 1, operationId: 'op-1' }, async () => {
      throw new Error('timeout after request write');
    });

    expect(result.status).toBe('work_outcome_ambiguous');
    expect(ledger.releaseCalls).toEqual([]);
    expect(ledger.confirmCalls).toEqual([]);
    expect(ledger.active.size).toBe(1);

    let replayProviderCalls = 0;
    const replay = await withCapacityReservation(ledger, { key: 'user-1', limit: 1, operationId: 'op-1' }, async () => {
      replayProviderCalls++;
      return { status: 'succeeded', value: 'must-not-run' };
    });
    expect(replay.status).toBe('operation_in_progress');
    expect(replayProviderCalls).toBe(0);
  });

  it('does not restart work after a confirmation failure or a terminal confirmation', async () => {
    const ledger = new FakeCapacityLedger();
    ledger.failConfirm = true;
    const confirmationFailure = await withCapacityReservation(
      ledger,
      { key: 'user-1', limit: 1, operationId: 'op-1' },
      async () => ({ status: 'succeeded', value: 'paid result' }),
    );
    expect(confirmationFailure.status).toBe('confirmation_failed');

    let retryAfterFailureCalls = 0;
    const retryAfterFailure = await withCapacityReservation(
      ledger,
      { key: 'user-1', limit: 1, operationId: 'op-1' },
      async () => {
        retryAfterFailureCalls++;
        return { status: 'succeeded', value: 'must-not-run' };
      },
    );
    expect(retryAfterFailure.status).toBe('operation_in_progress');
    expect(retryAfterFailureCalls).toBe(0);

    ledger.failConfirm = false;
    const activeReservation = [...ledger.active.values()][0]!;
    await ledger.confirmReservation(activeReservation);

    let replayAfterTerminalCalls = 0;
    const replayAfterTerminal = await withCapacityReservation(
      ledger,
      { key: 'user-1', limit: 1, operationId: 'op-1' },
      async () => {
        replayAfterTerminalCalls++;
        return { status: 'succeeded', value: 'must-not-run' };
      },
    );
    expect(replayAfterTerminal).toMatchObject({ status: 'operation_terminal', operationId: 'op-1' });
    expect(replayAfterTerminalCalls).toBe(0);
  });

  it('surfaces a release failure instead of claiming capacity was freed', async () => {
    const ledger = new FakeCapacityLedger();
    ledger.failRelease = true;

    const result = await withCapacityReservation(ledger, { key: 'user-1', limit: 1, operationId: 'op-1' }, async () => (
      { status: 'failed', error: new Error('known provider failure') }
    ));

    expect(result.status).toBe('release_failed');
    expect(ledger.active.size).toBe(1);
  });

  it('fails closed before calling the adapter or provider for invalid capacity requests', async () => {
    const ledger = new FakeCapacityLedger();
    let providerCalls = 0;
    const work = async () => {
      providerCalls++;
      return { status: 'succeeded' as const, value: 'must-not-run' };
    };

    await expect(withCapacityReservation(ledger, { key: 'user-1', limit: Number.NaN, operationId: 'op-1' }, work)).rejects.toThrow('non-negative safe integer');
    await expect(withCapacityReservation(ledger, { key: 'user-1', limit: Number.NaN, operationId: 'op-1' }, work)).rejects.toThrow(RangeError);
    await expect(withCapacityReservation(ledger, { key: 'user-1', limit: -1, operationId: 'op-2' }, work)).rejects.toThrow('non-negative safe integer');
    await expect(withCapacityReservation(ledger, { key: 'user-1', limit: -1, operationId: 'op-2' }, work)).rejects.toThrow(RangeError);
    await expect(withCapacityReservation(ledger, { key: 'user-1', limit: 1.5, operationId: 'op-3' }, work)).rejects.toThrow('non-negative safe integer');
    await expect(withCapacityReservation(ledger, { key: 'user-1', limit: 1.5, operationId: 'op-3' }, work)).rejects.toThrow(RangeError);
    await expect(withCapacityReservation(ledger, { key: 'user-1', limit: '1' as never, operationId: 'op-3b' }, work)).rejects.toThrow(TypeError);
    await expect(withCapacityReservation(ledger, { key: 'user-1', limit: 1, operationId: '   ' }, work)).rejects.toThrow('operationId must be a non-empty string');
    await expect(withCapacityReservation(ledger, { key: 'user-1', limit: 1, operationId: '   ' }, work)).rejects.toThrow(RangeError);
    await expect(withCapacityReservation(ledger, { key: 42 as never, limit: 1, operationId: 'op-4' }, work)).rejects.toThrow('key must be a non-empty string');
    await expect(withCapacityReservation(ledger, { key: 42 as never, limit: 1, operationId: 'op-4' }, work)).rejects.toThrow(TypeError);
    await expect(withCapacityReservation(ledger, { key: 'user-1', limit: 1, operationId: false as never }, work)).rejects.toThrow('operationId must be a non-empty string');
    await expect(withCapacityReservation(ledger, { key: 'user-1', limit: 1, operationId: false as never }, work)).rejects.toThrow(TypeError);

    expect(ledger.reserveCalls).toEqual([]);
    expect(providerCalls).toBe(0);
  });

  it('fails closed when an adapter returns an unknown decision before provider work', async () => {
    const ledger: CapacityReservationLedger = {
      reserveCapacity: async () => ({ status: 'surprise' } as never),
      confirmReservation: async () => undefined,
      releaseReservation: async () => undefined,
    };
    let providerCalls = 0;

    await expect(withCapacityReservation(
      ledger,
      { key: 'user-1', limit: 1, operationId: 'op-1' },
      async () => {
        providerCalls++;
        return { status: 'succeeded', value: 'must-not-run' };
      },
    )).rejects.toThrow('unknown reservation decision status');
    await expect(withCapacityReservation(
      ledger,
      { key: 'user-1', limit: 1, operationId: 'op-1' },
      async () => {
        providerCalls++;
        return { status: 'succeeded', value: 'must-not-run' };
      },
    )).rejects.toThrow(RangeError);
    expect(providerCalls).toBe(0);
  });

  it('validates newly acquired reservation identity and expiry before provider work', async () => {
    const base: CapacityReservation = {
      id: 'r-1',
      key: 'user-1',
      operationId: 'op-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const cases: Array<[CapacityReservation, string]> = [
      [{ ...base, id: '' }, 'reservation id must be a non-empty string'],
      [{ ...base, key: 'other-user' }, 'reservation key does not match request'],
      [{ ...base, operationId: 'other-operation' }, 'reservation operationId does not match request'],
      [{ ...base, expiresAt: 'not-a-date' }, 'reservation expiresAt must be a valid ISO-8601 timestamp'],
      [{ ...base, expiresAt: new Date(Date.now() - 1).toISOString() }, 'adapter returned an expired reservation'],
    ];

    for (const [reservation, message] of cases) {
      const ledger: CapacityReservationLedger = {
        reserveCapacity: async () => ({ status: 'acquired', reservation }),
        confirmReservation: async () => undefined,
        releaseReservation: async () => undefined,
      };
      let providerCalls = 0;
      const attempt = () =>
        withCapacityReservation(
          ledger,
          { key: 'user-1', limit: 1, operationId: 'op-1' },
          async () => {
            providerCalls++;
            return { status: 'succeeded', value: 'must-not-run' };
          },
        );
      // All five identity/expiry checks reject a validly-shaped but wrong
      // value (a mismatched id/key/operationId/expiry), so all are RangeError.
      await expect(attempt()).rejects.toThrow(message);
      await expect(attempt()).rejects.toThrow(RangeError);
      expect(providerCalls).toBe(0);
    }
  });

  it('holds capacity when a callback omits its discriminated payload', async () => {
    const ledger = new FakeCapacityLedger();
    const result = await withCapacityReservation(
      ledger,
      { key: 'user-1', limit: 1, operationId: 'op-1' },
      async () => ({ status: 'succeeded' } as never),
    );

    expect(result.status).toBe('work_outcome_ambiguous');
    expect(ledger.releaseCalls).toEqual([]);
    expect(ledger.active.size).toBe(1);

    const failedLedger = new FakeCapacityLedger();
    const failedResult = await withCapacityReservation(
      failedLedger,
      { key: 'user-1', limit: 1, operationId: 'op-2' },
      async () => ({ status: 'failed' } as never),
    );
    expect(failedResult.status).toBe('work_outcome_ambiguous');
    expect(failedLedger.releaseCalls).toEqual([]);
    expect(failedLedger.active.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Adversarial interleavings. These pin down what the HELPERS guarantee.
// Where a test uses an in-memory double, it illustrates the adapter contract;
// it does not prove any real storage adapter.
// ---------------------------------------------------------------------------

// Yield to other pending promise callbacks (no timers: the test lib has no DOM/Node types).
const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const futureIso = (ms = 60_000) => new Date(Date.now() + ms).toISOString();

/** A double that counts only unexpired holds, with its own injectable clock. */
class ExpiringCapacityLedger extends FakeCapacityLedger {
  nowMs = Date.now();
  constructor(private readonly nonAtomic = false) {
    super();
  }

  override async reserveCapacity(request: ReserveCapacityRequest) {
    this.reserveCalls.push(request);
    const operationKey = `${request.key}\u0000${request.operationId}`;
    const existing = this.operations.get(operationKey);
    if (existing?.status === 'active') return { status: 'operation_in_progress' as const, reservation: existing.reservation };
    if (existing?.status === 'terminal') {
      return { status: 'operation_terminal' as const, operationId: request.operationId, reason: existing.reason };
    }
    const unexpiredHolds = [...this.active.values()].filter(
      (r) => r.key === request.key && Date.parse(r.expiresAt) > this.nowMs,
    ).length;
    const used = (this.confirmed.get(request.key) ?? 0) + unexpiredHolds;
    if (this.nonAtomic) await tick(); // read, yield, then write: a check-then-act race
    if (used >= request.limit) return { status: 'denied' as const, reason: 'capacity exhausted' };
    const reservation: CapacityReservation = {
      id: `r-${this.nextId++}`,
      key: request.key,
      operationId: request.operationId,
      expiresAt: new Date(Math.max(this.nowMs, Date.now()) + 60_000).toISOString(),
    };
    this.active.set(reservation.id, reservation);
    this.operations.set(operationKey, { status: 'active', reservation });
    return { status: 'acquired' as const, reservation };
  }
}

function countingWork(counter: { calls: number }, value = 'paid') {
  return async () => {
    counter.calls++;
    await tick();
    return { status: 'succeeded' as const, value };
  };
}

describe('withCapacityReservation — concurrency is the adapter\'s job', () => {
  it('with an atomic adapter, 10 concurrent requests at limit 3 run the provider exactly 3 times', async () => {
    const ledger = new ExpiringCapacityLedger();
    const provider = { calls: 0 };
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        withCapacityReservation(ledger, { key: 'user-1', limit: 3, operationId: `op-${i}` }, countingWork(provider)),
      ),
    );
    expect(provider.calls).toBe(3);
    expect(results.filter((r) => r.status === 'confirmed')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'denied')).toHaveLength(7);
    expect(ledger.confirmed.get('user-1')).toBe(3);
  });

  it('with a NON-atomic adapter the helper cannot prevent overselling: all 10 run', async () => {
    // The helper has no counter of its own; it trusts the adapter's decision.
    const ledger = new ExpiringCapacityLedger(true);
    const provider = { calls: 0 };
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        withCapacityReservation(ledger, { key: 'user-1', limit: 3, operationId: `op-${i}` }, countingWork(provider)),
      ),
    );
    expect(provider.calls).toBe(10);
  });

  it('five concurrent calls with the same operationId run the provider once', async () => {
    const ledger = new ExpiringCapacityLedger();
    const provider = { calls: 0 };
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        withCapacityReservation(ledger, { key: 'user-1', limit: 3, operationId: 'same-op' }, countingWork(provider)),
      ),
    );
    expect(provider.calls).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual([
      'confirmed',
      'operation_in_progress',
      'operation_in_progress',
      'operation_in_progress',
      'operation_in_progress',
    ]);
  });

  it('passes limit 0 to the adapter and does not enforce it locally', async () => {
    const provider = { calls: 0 };
    const conforming = new ExpiringCapacityLedger();
    const denied = await withCapacityReservation(conforming, { key: 'u', limit: 0, operationId: 'a' }, countingWork(provider));
    expect(denied.status).toBe('denied');
    expect(conforming.reserveCalls[0]?.limit).toBe(0);

    const ignoresLimit: CapacityReservationLedger = {
      reserveCapacity: async (request) => ({
        status: 'acquired',
        reservation: { id: 'x', key: request.key, operationId: request.operationId, expiresAt: futureIso() },
      }),
      confirmReservation: async () => undefined,
      releaseReservation: async () => undefined,
    };
    const ran = await withCapacityReservation(ignoresLimit, { key: 'u', limit: 0, operationId: 'a' }, countingWork(provider));
    expect(ran.status).toBe('confirmed');
    expect(provider.calls).toBe(1);
  });
});

describe('withCapacityReservation — each ledger method is called at most once, never both', () => {
  function spyLedger(): CapacityReservationLedger & { log: string[] } {
    const log: string[] = [];
    return {
      log,
      reserveCapacity: async (request) => {
        log.push('reserve');
        return {
          status: 'acquired',
          reservation: { id: 'r-1', key: request.key, operationId: request.operationId, expiresAt: futureIso() },
        };
      },
      confirmReservation: async () => {
        log.push('confirm');
      },
      releaseReservation: async () => {
        log.push('release');
      },
    };
  }
  const request = { key: 'user-1', limit: 1, operationId: 'op-1' };

  it('success: reserve, work, confirm', async () => {
    const ledger = spyLedger();
    await withCapacityReservation(ledger, request, async () => {
      ledger.log.push('work');
      return { status: 'succeeded', value: 1 };
    });
    expect(ledger.log).toEqual(['reserve', 'work', 'confirm']);
  });

  it('known failure: reserve, work, release', async () => {
    const ledger = spyLedger();
    const result = await withCapacityReservation(ledger, request, async () => {
      ledger.log.push('work');
      return { status: 'failed', error: new Error('rejected before charging') };
    });
    expect(ledger.log).toEqual(['reserve', 'work', 'release']);
    expect(result).toMatchObject({ status: 'released_after_failure', error: new Error('rejected before charging') });
  });

  it('a synchronous throw from doTheWork is ambiguous: no confirm, no release', async () => {
    const ledger = spyLedger();
    const result = await withCapacityReservation(ledger, request, () => {
      ledger.log.push('work');
      throw new Error('sync failure');
    });
    expect(ledger.log).toEqual(['reserve', 'work']);
    expect(result).toMatchObject({ status: 'work_outcome_ambiguous', error: new Error('sync failure') });
  });

  it('a non-object outcome is ambiguous: no confirm, no release', async () => {
    const ledger = spyLedger();
    const result = await withCapacityReservation(ledger, request, async () => 'done' as never);
    expect(ledger.log).toEqual(['reserve']);
    expect(result.status).toBe('work_outcome_ambiguous');
  });

  it('confirmation failure: confirm is attempted once and never followed by release', async () => {
    const ledger = spyLedger();
    ledger.confirmReservation = async () => {
      ledger.log.push('confirm');
      throw new Error('ledger down');
    };
    const result = await withCapacityReservation(ledger, request, async () => ({ status: 'succeeded', value: 'v' }));
    expect(ledger.log).toEqual(['reserve', 'confirm']);
    expect(result).toMatchObject({ status: 'confirmation_failed', value: 'v', error: new Error('ledger down') });
  });

  it('release failure reports both errors and does not retry', async () => {
    const ledger = spyLedger();
    ledger.releaseReservation = async () => {
      ledger.log.push('release');
      throw new Error('release down');
    };
    const result = await withCapacityReservation(ledger, request, async () => ({ status: 'failed', error: 'no charge' }));
    expect(ledger.log).toEqual(['reserve', 'release']);
    expect(result).toMatchObject({ status: 'release_failed', workError: 'no charge', releaseError: new Error('release down') });
  });
});

describe('withCapacityReservation — adapter errors and malformed decisions', () => {
  const request = { key: 'user-1', limit: 1, operationId: 'op-1' };
  const neverRun = { calls: 0 };

  it('propagates a rejected reserveCapacity and runs no work', async () => {
    const ledger: CapacityReservationLedger = {
      reserveCapacity: async () => {
        throw new Error('db timeout');
      },
      confirmReservation: async () => undefined,
      releaseReservation: async () => undefined,
    };
    await expect(withCapacityReservation(ledger, request, countingWork(neverRun))).rejects.toThrow('db timeout');
    expect(neverRun.calls).toBe(0);
  });

  it.each([
    ['null', null],
    ['a string', 'acquired'],
    ['an object without status', { reservation: {} }],
  ])('throws a TypeError for a %s decision', async (_label, decision) => {
    const ledger: CapacityReservationLedger = {
      reserveCapacity: async () => decision as never,
      confirmReservation: async () => undefined,
      releaseReservation: async () => undefined,
    };
    await expect(withCapacityReservation(ledger, request, countingWork(neverRun))).rejects.toThrow(
      'adapter returned an invalid reservation decision',
    );
    await expect(withCapacityReservation(ledger, request, countingWork(neverRun))).rejects.toThrow(TypeError);
    expect(neverRun.calls).toBe(0);
  });

  it('passes a denial reason through, and allows a denial without one', async () => {
    const withReason: CapacityReservationLedger = {
      reserveCapacity: async () => ({ status: 'denied', reason: 'daily cap' }),
      confirmReservation: async () => undefined,
      releaseReservation: async () => undefined,
    };
    await expect(withCapacityReservation(withReason, request, countingWork(neverRun))).resolves.toEqual({
      status: 'denied',
      reason: 'daily cap',
    });
    const noReason: CapacityReservationLedger = { ...withReason, reserveCapacity: async () => ({ status: 'denied' }) };
    await expect(withCapacityReservation(noReason, request, countingWork(neverRun))).resolves.toMatchObject({ status: 'denied' });
    expect(neverRun.calls).toBe(0);
  });

  it.each([
    ['key', { key: 'other-user' }, 'reservation key does not match request'],
    ['operationId', { operationId: 'other-op' }, 'reservation operationId does not match request'],
    ['expiresAt', { expiresAt: 'soon' }, 'reservation expiresAt must be a valid ISO-8601 timestamp'],
  ])('throws a RangeError for an in-progress hold with a mismatched %s', async (_label, patch, message) => {
    const ledger: CapacityReservationLedger = {
      reserveCapacity: async () => ({
        status: 'operation_in_progress',
        reservation: { id: 'r-1', key: 'user-1', operationId: 'op-1', expiresAt: futureIso(), ...patch },
      }),
      confirmReservation: async () => undefined,
      releaseReservation: async () => undefined,
    };
    await expect(withCapacityReservation(ledger, request, countingWork(neverRun))).rejects.toThrow(message);
    await expect(withCapacityReservation(ledger, request, countingWork(neverRun))).rejects.toThrow(RangeError);
  });

  it('throws a RangeError for a terminal decision about a different operation', async () => {
    const ledger: CapacityReservationLedger = {
      reserveCapacity: async () => ({ status: 'operation_terminal', operationId: 'op-2' }),
      confirmReservation: async () => undefined,
      releaseReservation: async () => undefined,
    };
    await expect(withCapacityReservation(ledger, request, countingWork(neverRun))).rejects.toThrow(
      'adapter terminal decision operationId does not match request',
    );
    await expect(withCapacityReservation(ledger, request, countingWork(neverRun))).rejects.toThrow(RangeError);
  });

  it('an acquired-but-malformed hold throws a RangeError before work and is NOT released by the helper', async () => {
    const ledger = new ExpiringCapacityLedger();
    const original = ledger.reserveCapacity.bind(ledger);
    ledger.reserveCapacity = async (req) => {
      const decision = await original(req);
      if (decision.status === 'acquired') decision.reservation.expiresAt = new Date(Date.now() - 1).toISOString();
      return decision;
    };
    // A single call: this ledger is stateful (the reservation it just
    // created is now "in progress"), so a second call would return
    // operation_in_progress instead of throwing again.
    const error: unknown = await withCapacityReservation(ledger, request, countingWork(neverRun)).then(
      () => {
        throw new Error('expected withCapacityReservation to reject');
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toMatch(/adapter returned an expired reservation/);
    expect(neverRun.calls).toBe(0);
    expect(ledger.releaseCalls).toEqual([]);
    expect(ledger.active.size).toBe(1); // the hold stays until your reconciliation handles it
    const retry = await withCapacityReservation(ledger, request, countingWork(neverRun));
    expect(retry.status).toBe('operation_in_progress');
  });
});

describe('withCapacityReservation — request validation', () => {
  const ledger = new FakeCapacityLedger();
  const work = async () => ({ status: 'succeeded' as const, value: 'must-not-run' });

  it.each([
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['MAX_SAFE_INTEGER + 1', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a %s limit with a RangeError before calling the adapter', async (_label, limit) => {
    await expect(withCapacityReservation(ledger, { key: 'u', limit, operationId: 'a' }, work)).rejects.toThrow(
      'limit must be a non-negative safe integer',
    );
    await expect(withCapacityReservation(ledger, { key: 'u', limit, operationId: 'a' }, work)).rejects.toThrow(
      RangeError,
    );
  });

  it.each([
    ['a numeric string', '3' as unknown as number],
    ['null', null as unknown as number],
  ])('rejects a %s limit with a TypeError before calling the adapter', async (_label, limit) => {
    await expect(withCapacityReservation(ledger, { key: 'u', limit, operationId: 'a' }, work)).rejects.toThrow(
      'limit must be a non-negative safe integer',
    );
    await expect(withCapacityReservation(ledger, { key: 'u', limit, operationId: 'a' }, work)).rejects.toThrow(
      TypeError,
    );
  });

  it('accepts limit 0 and MAX_SAFE_INTEGER', async () => {
    await expect(withCapacityReservation(ledger, { key: 'u0', limit: 0, operationId: 'a' }, work)).resolves.toMatchObject({
      status: 'denied',
    });
    await expect(
      withCapacityReservation(ledger, { key: 'umax', limit: Number.MAX_SAFE_INTEGER, operationId: 'a' }, work),
    ).resolves.toMatchObject({ status: 'confirmed' });
  });

  it.each(['', '   '])('rejects the key %j with a RangeError', async (key) => {
    await expect(withCapacityReservation(ledger, { key, limit: 1, operationId: 'a' }, work)).rejects.toThrow(
      'key must be a non-empty string',
    );
    await expect(withCapacityReservation(ledger, { key, limit: 1, operationId: 'a' }, work)).rejects.toThrow(
      RangeError,
    );
  });

  it('never calls the adapter for a rejected request', () => {
    expect(ledger.reserveCalls.map((r) => r.key)).toEqual(['u0', 'umax']);
  });
});

describe('withCapacityReservation — crash between reserve and confirm (contract illustration)', () => {
  it('a restarted process retrying the same operationId gets operation_in_progress and never re-runs work', async () => {
    const ledger = new ExpiringCapacityLedger();
    const request = { key: 'user-1', limit: 1, operationId: 'op-1' };

    // Process A reserved, then died before confirming. Only the adapter's
    // durable state survives; the helper keeps none.
    const beforeCrash = await ledger.reserveCapacity(request);
    expect(beforeCrash.status).toBe('acquired');

    // Process B retries the same logical operation.
    const provider = { calls: 0 };
    const retry = await withCapacityReservation(ledger, request, countingWork(provider));
    expect(retry.status).toBe('operation_in_progress');
    expect(provider.calls).toBe(0);

    // While unexpired, the orphaned hold still counts toward the limit.
    const other = await withCapacityReservation(ledger, { ...request, operationId: 'op-2' }, countingWork(provider));
    expect(other.status).toBe('denied');
    expect(provider.calls).toBe(0);
  });

  it('after the orphaned hold expires it stops counting, so unreconciled paid work can exceed the limit', async () => {
    const ledger = new ExpiringCapacityLedger();
    const request = { key: 'user-1', limit: 1, operationId: 'op-1' };
    await ledger.reserveCapacity(request); // process A: reserved, did paid work, crashed before confirm

    ledger.nowMs += 61_000; // the adapter's clock passes the hold's expiry
    const provider = { calls: 0 };
    const next = await withCapacityReservation(ledger, { ...request, operationId: 'op-2' }, countingWork(provider));
    expect(next.status).toBe('confirmed');
    expect(provider.calls).toBe(1);
    // op-1 is still unresolved: only reconciliation can confirm or release it.
    const replay = await withCapacityReservation(ledger, request, countingWork(provider));
    expect(replay.status).toBe('operation_in_progress');
    expect(provider.calls).toBe(1);
  });
});

describe('withReserveConfirm — advisory behavior, pinned', () => {
  it('concurrent callers can all pass the read-only check: 10 at limit 3 all run', async () => {
    const counts = new Map<string, number>();
    const ledger: UsageLedger = {
      checkUnderLimit: async (key, limit) => (counts.get(key) ?? 0) < limit,
      commitUsage: async (key) => {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      },
    };
    let paid = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withReserveConfirm(ledger, 'user-1', 3, async () => {
          paid++;
          await tick();
          return 'ok';
        }),
      ),
    );
    expect(paid).toBe(10);
    expect(counts.get('user-1')).toBe(10);
  });

  it('if commitUsage rejects, returns the paid result with commitError instead of discarding it', async () => {
    let paid = 0;
    const commitFailure = new Error('commit failed');
    const ledger: UsageLedger = {
      checkUnderLimit: async () => true,
      commitUsage: async () => {
        throw commitFailure;
      },
    };
    const result = await withReserveConfirm(ledger, 'user-1', 5, async () => {
      paid++;
      return 'PAID RESULT';
    });
    expect(result).toEqual({ allowed: true, result: 'PAID RESULT', commitError: commitFailure });
    expect(paid).toBe(1);
  });

  it('does not attach commitError when commitUsage succeeds', async () => {
    const result = await withReserveConfirm(new FakeLedger(), 'user-1', 5, async () => 'ok');
    expect(result).toEqual({ allowed: true, result: 'ok' });
    expect('commitError' in result).toBe(false);
  });

  it('propagates a non-Error rejection from commitUsage as commitError unchanged', async () => {
    const ledger: UsageLedger = {
      checkUnderLimit: async () => true,
      commitUsage: async () => {
        throw 'a plain string rejection'; // eslint-disable-line @typescript-eslint/only-throw-error -- proving the helper does not assume Error
      },
    };
    const result = await withReserveConfirm(ledger, 'user-1', 5, async () => 'paid');
    expect(result).toEqual({ allowed: true, result: 'paid', commitError: 'a plain string rejection' });
  });

  it('propagates a rejected checkUnderLimit without calling', async () => {
    let paid = 0;
    const ledger: UsageLedger = {
      checkUnderLimit: async () => {
        throw new Error('db down');
      },
      commitUsage: async () => undefined,
    };
    await expect(
      withReserveConfirm(ledger, 'user-1', 5, async () => {
        paid++;
        return 'x';
      }),
    ).rejects.toThrow('db down');
    expect(paid).toBe(0);
  });

  it('passes key and limit to the ledger unchanged, without validating the limit', async () => {
    const seen: Array<[string, number]> = [];
    const ledger: UsageLedger = {
      checkUnderLimit: async (key, limit) => {
        seen.push([key, limit]);
        return false;
      },
      commitUsage: async () => undefined,
    };
    await withReserveConfirm(ledger, 'k', 0, async () => 'x');
    await withReserveConfirm(ledger, 'k', Number.NaN, async () => 'x');
    expect(seen).toEqual([
      ['k', 0],
      ['k', Number.NaN],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Audit fix pass: caller input is read once, records must be plain, blank
// means "shows nothing", adapter-returned shapes are guarded, and error text
// built from adapter strings is escaped.
// ---------------------------------------------------------------------------

// Every character below is either whitespace or Default_Ignorable_Code_Point,
// so a string made only of them shows nothing on screen or in a log.
const visiblyBlank: ReadonlyArray<readonly [string, string]> = [
  ['a zero-width space', '\u200B'],
  ['a zero-width joiner', '\u200D'],
  ['a word joiner', '\u2060'],
  ['a byte order mark', '\uFEFF'],
  ['a soft hyphen', '\u00AD'],
  ['an Arabic letter mark', '\u061C'],
  ['bidi isolates', '\u2066\u2069'],
  ['a bidi override pair', '\u202A\u202C'],
  ['a variation selector', '\uFE0F'],
  ['a Hangul filler', '\u3164'],
  ['whitespace mixed with invisibles', ' \t\u200B\u2066 \n'],
];

const hostileText = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const okWork = async () => ({ status: 'succeeded' as const, value: 'paid' });

function acquiringLedger(
  build: (request: ReserveCapacityRequest) => CapacityReservation,
  log: string[] = [],
): CapacityReservationLedger {
  return {
    reserveCapacity: async (request) => {
      log.push('reserve');
      return { status: 'acquired', reservation: build(request) };
    },
    confirmReservation: async () => {
      log.push('confirm');
    },
    releaseReservation: async () => {
      log.push('release');
    },
  };
}

describe('withCapacityReservation — the request is read once and validated as a snapshot', () => {
  it('still compares the reservation with the values the adapter was asked for when the caller mutates the request mid-flight', async () => {
    const request = { key: 'user-1', limit: 1, operationId: 'op-1' };
    const ledger: CapacityReservationLedger = {
      reserveCapacity: async (received) => {
        // The caller (or another task) changes its own object while the adapter is awaiting.
        request.key = 'someone-else';
        request.operationId = 'another-op';
        await Promise.resolve();
        return {
          status: 'acquired',
          reservation: { id: 'r-1', key: received.key, operationId: received.operationId, expiresAt: futureIso() },
        };
      },
      confirmReservation: async () => undefined,
      releaseReservation: async () => undefined,
    };
    const result = await withCapacityReservation(ledger, request, okWork);
    expect(result.status).toBe('confirmed');
    if (result.status === 'confirmed') {
      expect(result.reservation.key).toBe('user-1');
      expect(result.reservation.operationId).toBe('op-1');
    }
  });

  it('does not let a key that changes between reads smuggle in a reservation for a different key', async () => {
    let keyReads = 0;
    const request = {
      get key(): string {
        keyReads++;
        return keyReads === 1 ? 'user-1' : 'user-2';
      },
      limit: 1,
      operationId: 'op-1',
    };
    const ledger = acquiringLedger((received) => ({
      id: 'r-1',
      key: 'user-2',
      operationId: received.operationId,
      expiresAt: futureIso(),
    }));
    const work = { calls: 0 };
    await expect(withCapacityReservation(ledger, request, countingWork(work))).rejects.toThrow(
      'reservation key does not match request',
    );
    expect(work.calls).toBe(0);
    expect(keyReads).toBe(1);
  });

  it('hands the adapter a copy, so an adapter that edits its argument cannot change what the helper compares against', async () => {
    const ledger: CapacityReservationLedger = {
      reserveCapacity: async (received) => {
        const reservation = { id: 'r-1', key: received.key, operationId: received.operationId, expiresAt: futureIso() };
        received.key = 'edited-by-adapter';
        received.operationId = 'edited-by-adapter';
        return { status: 'acquired', reservation };
      },
      confirmReservation: async () => undefined,
      releaseReservation: async () => undefined,
    };
    const original = { key: 'user-1', limit: 1, operationId: 'op-1' };
    await expect(withCapacityReservation(ledger, original, okWork)).resolves.toMatchObject({ status: 'confirmed' });
    expect(original).toEqual({ key: 'user-1', limit: 1, operationId: 'op-1' });
  });

  it('reads limit, key and operationId once each', async () => {
    const reads = { limit: 0, key: 0, operationId: 0 };
    const request: ReserveCapacityRequest = {
      get limit(): number {
        reads.limit++;
        return 1;
      },
      get key(): string {
        reads.key++;
        return 'user-1';
      },
      get operationId(): string {
        reads.operationId++;
        return 'op-1';
      },
    };
    const ledger = acquiringLedger((received) => ({
      id: 'r-1',
      key: received.key,
      operationId: received.operationId,
      expiresAt: futureIso(),
    }));
    await withCapacityReservation(ledger, request, okWork);
    expect(reads).toEqual({ limit: 1, key: 1, operationId: 1 });
  });

  it('passes the adapter exactly { key, limit, operationId }', async () => {
    const seen: unknown[] = [];
    const ledger = acquiringLedger((received) => {
      seen.push(received);
      return { id: 'r-1', key: received.key, operationId: received.operationId, expiresAt: futureIso() };
    });
    await withCapacityReservation(ledger, { key: 'k', limit: 2, operationId: 'o' }, okWork);
    expect(seen).toEqual([{ key: 'k', limit: 2, operationId: 'o' }]);
  });
});

describe('withCapacityReservation — the request must be a plain record', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a Map', new Map([['key', 'k']])],
    ['an array', ['k', 1, 'o']],
    ['a Date', new Date(0)],
    ['a class instance', new (class Req { key = 'k'; limit = 1; operationId = 'o'; })()],
  ])('rejects %s with a TypeError before calling the adapter', async (_label, request) => {
    const ledger = new FakeCapacityLedger();
    await expect(withCapacityReservation(ledger, request as never, okWork)).rejects.toThrow(TypeError);
    await expect(withCapacityReservation(ledger, request as never, okWork)).rejects.toThrow(/request must be an object/);
    expect(ledger.reserveCalls).toEqual([]);
  });

  it('accepts a null-prototype request', async () => {
    const ledger = new FakeCapacityLedger();
    const request = Object.assign(Object.create(null) as ReserveCapacityRequest, {
      key: 'k',
      limit: 1,
      operationId: 'o',
    });
    await expect(withCapacityReservation(ledger, request, okWork)).resolves.toMatchObject({ status: 'confirmed' });
  });
});

describe('withCapacityReservation — the work callback cannot change which hold is confirmed', () => {
  const request = { key: 'user-1', limit: 1, operationId: 'op-1' };
  const issue = (): CapacityReservation => ({ id: 'r-1', key: 'user-1', operationId: 'op-1', expiresAt: futureIso() });
  const recording = (issued: CapacityReservation) => {
    const confirmed: CapacityReservation[] = [];
    const released: CapacityReservation[] = [];
    const ledger: CapacityReservationLedger = {
      reserveCapacity: async () => ({ status: 'acquired', reservation: issued }),
      confirmReservation: async (held) => {
        confirmed.push({ ...held });
      },
      releaseReservation: async (held) => {
        released.push({ ...held });
      },
    };
    return { ledger, confirmed, released };
  };

  it('hands the callback a frozen copy, not the object that is later confirmed', async () => {
    const { ledger, confirmed } = recording(issue());
    let received: CapacityReservation | undefined;
    const result = await withCapacityReservation(ledger, request, async (reservation) => {
      received = reservation;
      return { status: 'succeeded', value: 'paid' };
    });
    expect(received).toMatchObject({ id: 'r-1', key: 'user-1', operationId: 'op-1' });
    expect(Object.isFrozen(received)).toBe(true);
    expect(result.status).toBe('confirmed');
    if (result.status === 'confirmed') expect(result.reservation).not.toBe(received);
    expect(confirmed.map((held) => held.id)).toEqual(['r-1']);
  });

  it('confirms the original id when the callback tries to change the reservation it was given', async () => {
    const { ledger, confirmed } = recording(issue());
    const result = await withCapacityReservation(ledger, request, async (reservation) => {
      try {
        (reservation as { id: string }).id = 'someone-elses-hold';
      } catch {
        // A frozen object throws in strict mode; the hold is what matters here.
      }
      return { status: 'succeeded', value: 'paid' };
    });
    expect(result.status).toBe('confirmed');
    expect(confirmed.map((held) => held.id)).toEqual(['r-1']);
  });

  it('treats a callback that throws on its frozen copy as an ambiguous outcome and confirms nothing', async () => {
    const { ledger, confirmed, released } = recording(issue());
    const result = await withCapacityReservation(ledger, request, async (reservation) => {
      (reservation as { id: string }).id = 'someone-elses-hold';
      return { status: 'succeeded', value: 'paid' };
    });
    expect(result.status).toBe('work_outcome_ambiguous');
    expect(confirmed).toEqual([]);
    expect(released).toEqual([]);
  });

  it('confirms and releases the snapshot taken at acquire time, not later edits to the adapter\'s own object', async () => {
    for (const outcome of ['succeeded', 'failed'] as const) {
      const issued = issue();
      const { ledger, confirmed, released } = recording(issued);
      await withCapacityReservation(ledger, request, async () => {
        issued.id = 'edited-after-acquire';
        return outcome === 'succeeded'
          ? { status: 'succeeded', value: 'paid' }
          : { status: 'failed', error: new Error('no') };
      });
      expect((outcome === 'succeeded' ? confirmed : released).map((held) => held.id)).toEqual(['r-1']);
    }
  });

  it('still reads required fields that are inherited or non-enumerable, once each', async () => {
    let idReads = 0;
    class Held {
      readonly key = 'user-1';
      get id(): string {
        idReads += 1;
        return 'r-1';
      }
      get expiresAt(): string {
        return futureIso();
      }
    }
    const held = new Held();
    Object.defineProperty(held, 'operationId', { value: 'op-1', enumerable: false });
    const { ledger, confirmed } = recording(held as unknown as CapacityReservation);
    let received: CapacityReservation | undefined;
    const result = await withCapacityReservation(ledger, request, async (reservation) => {
      received = reservation;
      return { status: 'succeeded', value: 'paid' };
    });
    expect(result.status).toBe('confirmed');
    expect(idReads).toBe(1);
    expect(received).toMatchObject({ id: 'r-1', key: 'user-1', operationId: 'op-1' });
    expect(confirmed[0]).toMatchObject({ id: 'r-1', operationId: 'op-1' });
  });

  it('keeps the adapter\'s extra fields on the snapshot it passes back', async () => {
    const issued = { ...issue(), fencingToken: 42 } as CapacityReservation;
    const { ledger, confirmed } = recording(issued);
    await withCapacityReservation(ledger, request, okWork);
    expect(confirmed[0]).toMatchObject({ id: 'r-1', fencingToken: 42 });
  });
});

describe('withCapacityReservation — the adapter decision and reservation are read once', () => {
  it('reads decision.status, decision.reservation and each reservation field once', async () => {
    const reads: Record<string, number> = {};
    const count = (name: string) => {
      reads[name] = (reads[name] ?? 0) + 1;
    };
    const expiresAt = futureIso();
    const reservation = {
      get id(): string {
        count('id');
        return 'r-1';
      },
      get key(): string {
        count('key');
        return 'user-1';
      },
      get operationId(): string {
        count('operationId');
        return 'op-1';
      },
      get expiresAt(): string {
        count('expiresAt');
        return expiresAt;
      },
    };
    const decision = {
      get status(): 'acquired' {
        count('status');
        return 'acquired';
      },
      get reservation(): CapacityReservation {
        count('reservation');
        return reservation;
      },
    };
    const ledger: CapacityReservationLedger = {
      reserveCapacity: async () => decision,
      confirmReservation: async () => undefined,
      releaseReservation: async () => undefined,
    };
    const result = await withCapacityReservation(ledger, { key: 'user-1', limit: 1, operationId: 'op-1' }, okWork);
    expect(result.status).toBe('confirmed');
    expect(reads).toEqual({ status: 1, reservation: 1, id: 1, key: 1, operationId: 1, expiresAt: 1 });
  });

  it('reads the outcome status, value and error once', async () => {
    const reads: Record<string, number> = {};
    const count = (name: string) => {
      reads[name] = (reads[name] ?? 0) + 1;
    };
    const succeeded = {
      get status(): 'succeeded' {
        count('status');
        return 'succeeded';
      },
      get value(): string {
        count('value');
        return 'paid';
      },
    };
    const ledger = acquiringLedger((r) => ({ id: 'r-1', key: r.key, operationId: r.operationId, expiresAt: futureIso() }));
    const ok = await withCapacityReservation(ledger, { key: 'k', limit: 1, operationId: 'o' }, async () => succeeded);
    expect(ok).toMatchObject({ status: 'confirmed', value: 'paid' });
    expect(reads).toEqual({ status: 1, value: 1 });

    const failedReads: Record<string, number> = {};
    const failed = {
      get status(): 'failed' {
        failedReads.status = (failedReads.status ?? 0) + 1;
        return 'failed';
      },
      get error(): string {
        failedReads.error = (failedReads.error ?? 0) + 1;
        return 'nope';
      },
    };
    const released = await withCapacityReservation(ledger, { key: 'k', limit: 1, operationId: 'o' }, async () => failed);
    expect(released).toMatchObject({ status: 'released_after_failure', error: 'nope' });
    expect(failedReads).toEqual({ status: 1, error: 1 });
  });
});

describe('withCapacityReservation — a key, operationId or reservation id that shows nothing is blank', () => {
  it.each(visiblyBlank)('rejects %s as the key with a RangeError before calling the adapter', async (_label, key) => {
    const ledger = new FakeCapacityLedger();
    await expect(withCapacityReservation(ledger, { key, limit: 1, operationId: 'op' }, okWork)).rejects.toThrow(RangeError);
    await expect(withCapacityReservation(ledger, { key, limit: 1, operationId: 'op' }, okWork)).rejects.toThrow(
      'key must be a non-empty string',
    );
    expect(ledger.reserveCalls).toEqual([]);
  });

  it.each(visiblyBlank)('rejects %s as the operationId with a RangeError before calling the adapter', async (_label, operationId) => {
    const ledger = new FakeCapacityLedger();
    await expect(withCapacityReservation(ledger, { key: 'k', limit: 1, operationId }, okWork)).rejects.toThrow(RangeError);
    await expect(withCapacityReservation(ledger, { key: 'k', limit: 1, operationId }, okWork)).rejects.toThrow(
      'operationId must be a non-empty string',
    );
    expect(ledger.reserveCalls).toEqual([]);
  });

  it.each(visiblyBlank)('rejects %s as a reservation id before any work runs', async (_label, id) => {
    const ledger = acquiringLedger((r) => ({ id, key: r.key, operationId: r.operationId, expiresAt: futureIso() }));
    const work = { calls: 0 };
    await expect(withCapacityReservation(ledger, { key: 'k', limit: 1, operationId: 'o' }, countingWork(work))).rejects.toThrow(
      'reservation id must be a non-empty string',
    );
    expect(work.calls).toBe(0);
  });

  it('rejects a blank reservation id on an in-progress hold too', async () => {
    const ledger: CapacityReservationLedger = {
      reserveCapacity: async (r) => ({
        status: 'operation_in_progress',
        reservation: { id: '\u200B', key: r.key, operationId: r.operationId, expiresAt: futureIso() },
      }),
      confirmReservation: async () => undefined,
      releaseReservation: async () => undefined,
    };
    await expect(withCapacityReservation(ledger, { key: 'k', limit: 1, operationId: 'o' }, okWork)).rejects.toThrow(RangeError);
  });

  it('accepts a key that has visible text next to invisible characters', async () => {
    const ledger = new FakeCapacityLedger();
    const key = '\u200Buser\u2066-1\u200B';
    await expect(withCapacityReservation(ledger, { key, limit: 1, operationId: '\u00ADop' }, okWork)).resolves.toMatchObject({
      status: 'confirmed',
    });
    expect(ledger.reserveCalls[0]?.key).toBe(key);
  });
});

describe('withCapacityReservation — adapter-returned shapes are guarded', () => {
  const request = { key: 'user-1', limit: 1, operationId: 'op-1' };
  const base = (): CapacityReservation => ({ id: 'r-1', key: 'user-1', operationId: 'op-1', expiresAt: futureIso() });

  function returning(decision: unknown, log: string[] = []): CapacityReservationLedger {
    return {
      reserveCapacity: async () => decision as never,
      confirmReservation: async () => {
        log.push('confirm');
      },
      releaseReservation: async () => {
        log.push('release');
      },
    };
  }

  it.each([
    ['null', null],
    ['a string', 'r-1'],
    ['a number', 7],
    ['undefined', undefined],
  ])('rejects %s as an acquired reservation with a TypeError and runs no work', async (_label, reservation) => {
    const work = { calls: 0 };
    const log: string[] = [];
    const ledger = returning({ status: 'acquired', reservation }, log);
    await expect(withCapacityReservation(ledger, request, countingWork(work))).rejects.toThrow(TypeError);
    await expect(withCapacityReservation(ledger, request, countingWork(work))).rejects.toThrow(
      'adapter returned an invalid reservation',
    );
    expect(work.calls).toBe(0);
    expect(log).toEqual([]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s as an in-progress reservation with a TypeError', async (_label, reservation) => {
    const ledger = returning({ status: 'operation_in_progress', reservation });
    await expect(withCapacityReservation(ledger, request, okWork)).rejects.toThrow(TypeError);
    await expect(withCapacityReservation(ledger, request, okWork)).rejects.toThrow('adapter returned an invalid reservation');
  });

  it.each([
    ['a number', 7],
    ['undefined', undefined],
    ['null', null],
  ])('rejects %s as a reservation id with a TypeError', async (_label, id) => {
    const ledger = returning({ status: 'acquired', reservation: { ...base(), id } });
    await expect(withCapacityReservation(ledger, request, okWork)).rejects.toThrow(TypeError);
    await expect(withCapacityReservation(ledger, request, okWork)).rejects.toThrow('reservation id must be a non-empty string');
  });

  it.each([
    ['a number', 0],
    ['a Date', new Date(Date.now() + 60_000)],
    ['undefined', undefined],
    ['null', null],
  ])('rejects %s as expiresAt with a TypeError', async (_label, expiresAt) => {
    const ledger = returning({ status: 'acquired', reservation: { ...base(), expiresAt } });
    await expect(withCapacityReservation(ledger, request, okWork)).rejects.toThrow(TypeError);
    await expect(withCapacityReservation(ledger, request, okWork)).rejects.toThrow(
      'reservation expiresAt must be a valid ISO-8601 timestamp',
    );
  });

  it('never treats a missing or non-string identity as a match (undefined does not equal undefined)', async () => {
    const ledger = returning({ status: 'acquired', reservation: { id: 'r-1', expiresAt: futureIso() } });
    await expect(withCapacityReservation(ledger, request, okWork)).rejects.toThrow(RangeError);
    const terminal = returning({ status: 'operation_terminal' });
    await expect(withCapacityReservation(terminal, request, okWork)).rejects.toThrow(
      'adapter terminal decision operationId does not match request',
    );
  });

  it('compares expiry as an instant: a later offset spelling of an already-past instant is still expired', async () => {
    const past = Date.now() - 1_000;
    const asOffset = new Date(past).toISOString().replace('Z', '+00:00');
    const ledger = returning({ status: 'acquired', reservation: { ...base(), expiresAt: asOffset } });
    await expect(withCapacityReservation(ledger, request, okWork)).rejects.toThrow('adapter returned an expired reservation');
  });

  it.each([
    ['null', null],
    ['a string', 'succeeded'],
    ['an array', ['succeeded']],
    ['an unknown status', { status: 'maybe', value: 1 }],
    ['a missing status', { value: 1 }],
    ['a truthy non-status', { status: true, value: 1 }],
    ['a failed outcome without error', { status: 'failed' }],
    ['a succeeded outcome without value', { status: 'succeeded' }],
  ])('treats %s as an ambiguous outcome and keeps the hold', async (_label, outcome) => {
    const log: string[] = [];
    const ledger = acquiringLedger((r) => ({ id: 'r-1', key: r.key, operationId: r.operationId, expiresAt: futureIso() }), log);
    const result = await withCapacityReservation(ledger, request, async () => outcome as never);
    expect(result.status).toBe('work_outcome_ambiguous');
    expect(log).toEqual(['reserve']);
  });

  it('accepts an outcome whose payload is present but undefined (own property)', async () => {
    const ledger = acquiringLedger((r) => ({ id: 'r-1', key: r.key, operationId: r.operationId, expiresAt: futureIso() }));
    await expect(
      withCapacityReservation(ledger, request, async () => ({ status: 'succeeded', value: undefined })),
    ).resolves.toMatchObject({ status: 'confirmed', value: undefined });
    await expect(
      withCapacityReservation(ledger, request, async () => ({ status: 'failed', error: undefined })),
    ).resolves.toMatchObject({ status: 'released_after_failure', error: undefined });
  });
});

describe('withCapacityReservation — error text built from adapter strings is safe', () => {
  const request = { key: 'user-1', limit: 1, operationId: 'op-1' };

  function statusError(status: unknown): Promise<Error> {
    const ledger: CapacityReservationLedger = {
      reserveCapacity: async () => ({ status } as never),
      confirmReservation: async () => undefined,
      releaseReservation: async () => undefined,
    };
    return withCapacityReservation(ledger, request, okWork).then(
      () => {
        throw new Error('expected a rejection');
      },
      (caught: unknown) => caught as Error,
    );
  }

  it('escapes control, line-break and bidi characters in an unknown status', async () => {
    const error = await statusError('evil\n\u001b[31m\u202e\u2066');
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toMatch(/unknown reservation decision status/);
    expect(error.message).not.toMatch(hostileText);
  });

  it.each([
    ['a symbol', Symbol('x')],
    ['a bigint', 5n],
    ['a null-prototype object', Object.create(null) as object],
    [
      'an object with a throwing toString',
      {
        toString(): string {
          throw new TypeError('boom');
        },
      },
    ],
  ])('still raises the documented RangeError for %s as the status', async (_label, status) => {
    const error = await statusError(status);
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toMatch(/unknown reservation decision status/);
  });
});

describe('withReserveConfirm — a rejected commit is detected by presence, not truthiness (CGK-003)', () => {
  const falsyRejections: ReadonlyArray<readonly [string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['false', false],
    ['zero', 0],
    ['an empty string', ''],
  ];

  it.each(falsyRejections)('keeps the paid result and an own commitError when commitUsage rejects with %s', async (_label, rejection) => {
    let paidCalls = 0;
    const ledger: UsageLedger = {
      checkUnderLimit: async () => true,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a falsy rejection is the case under test
      commitUsage: () => Promise.reject(rejection),
    };
    const result = await withReserveConfirm(ledger, 'user', 5, async () => {
      paidCalls++;
      return 'paid-result';
    });
    expect(paidCalls).toBe(1);
    expect(result).toMatchObject({ allowed: true, result: 'paid-result' });
    expect(Object.hasOwn(result, 'commitError')).toBe(true);
    expect((result as { commitError?: unknown }).commitError).toBe(rejection);
    // Why the docs test presence: a truthiness test misses every one of these.
    expect(Boolean((result as { commitError?: unknown }).commitError)).toBe(false);
  });

  it('has no own commitError after a clean commit', async () => {
    const ledger = new FakeLedger();
    const result = await withReserveConfirm(ledger, 'user', 5, async () => 'paid-result');
    expect(result).toEqual({ allowed: true, result: 'paid-result' });
    expect(Object.hasOwn(result, 'commitError')).toBe(false);
  });

  it('treats a commitUsage that resolves a value as recorded (only a rejection signals failure)', async () => {
    const ledger: UsageLedger = {
      checkUnderLimit: async () => true,
      commitUsage: (() => Promise.resolve({ committed: false })) as unknown as UsageLedger['commitUsage'],
    };
    const result = await withReserveConfirm(ledger, 'user', 5, async () => 'paid-result');
    expect(Object.hasOwn(result, 'commitError')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mutation-driven additions: exact expiry boundary, outcome shape edge cases
// and exact messages.
// ---------------------------------------------------------------------------

describe('withCapacityReservation — expiry is judged at the millisecond', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const request = { key: 'k', limit: 1, operationId: 'o' };
  const at = (ms: number): CapacityReservationLedger =>
    acquiringLedger((r) => ({ id: 'r-1', key: r.key, operationId: r.operationId, expiresAt: new Date(ms).toISOString() }));

  it('rejects a hold that expires exactly now and accepts one that expires a millisecond later', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'));
    const now = Date.now();
    await expect(withCapacityReservation(at(now), request, okWork)).rejects.toThrow('adapter returned an expired reservation');
    await expect(withCapacityReservation(at(now - 1), request, okWork)).rejects.toThrow('adapter returned an expired reservation');
    await expect(withCapacityReservation(at(now + 1), request, okWork)).resolves.toMatchObject({ status: 'confirmed' });
  });

  it('does not require an in-progress hold to be unexpired (it is recovery metadata)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'));
    const expired: CapacityReservationLedger = {
      reserveCapacity: async (r) => ({
        status: 'operation_in_progress',
        reservation: { id: 'r-1', key: r.key, operationId: r.operationId, expiresAt: new Date(Date.now() - 60_000).toISOString() },
      }),
      confirmReservation: async () => undefined,
      releaseReservation: async () => undefined,
    };
    await expect(withCapacityReservation(expired, request, okWork)).resolves.toMatchObject({ status: 'operation_in_progress' });
  });
});

describe('withCapacityReservation — outcome shape edge cases and messages', () => {
  const request = { key: 'k', limit: 1, operationId: 'o' };
  const ledger = () =>
    acquiringLedger((r) => ({ id: 'r-1', key: r.key, operationId: r.operationId, expiresAt: futureIso() }));

  it('does not accept a function that carries status and value properties', async () => {
    const outcome = Object.assign(() => 1, { status: 'succeeded', value: 'x' });
    const result = await withCapacityReservation(ledger(), request, async () => outcome as never);
    expect(result.status).toBe('work_outcome_ambiguous');
  });

  it('does not treat an unknown status that happens to carry an error as a known failure', async () => {
    const log: string[] = [];
    const result = await withCapacityReservation(
      acquiringLedger((r) => ({ id: 'r-1', key: r.key, operationId: r.operationId, expiresAt: futureIso() }), log),
      request,
      async () => ({ status: 'maybe', error: 'e', value: 'v' }) as never,
    );
    expect(result.status).toBe('work_outcome_ambiguous');
    expect(log).toEqual(['reserve']);
  });

  it('says why an invalid outcome is ambiguous', async () => {
    const result = await withCapacityReservation(ledger(), request, async () => 'nope' as never);
    expect(result).toMatchObject({ status: 'work_outcome_ambiguous' });
    expect((result as { error: Error }).error.message).toBe('withCapacityReservation: doTheWork returned an invalid outcome');
  });

  it('names the plain-object rule for a request that is not a plain object', async () => {
    await expect(withCapacityReservation(ledger(), new Map() as never, okWork)).rejects.toThrowError(
      'withCapacityReservation: request must be an object with key, limit and operationId ' +
        '(a plain object; not null, an array, a Map, a Date or a class instance)',
    );
  });
});
