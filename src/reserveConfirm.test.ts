import { describe, expect, it } from 'vitest';
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
    await expect(withCapacityReservation(ledger, { key: 'user-1', limit: -1, operationId: 'op-2' }, work)).rejects.toThrow('non-negative safe integer');
    await expect(withCapacityReservation(ledger, { key: 'user-1', limit: 1.5, operationId: 'op-3' }, work)).rejects.toThrow('non-negative safe integer');
    await expect(withCapacityReservation(ledger, { key: 'user-1', limit: 1, operationId: '   ' }, work)).rejects.toThrow('operationId must be a non-empty string');
    await expect(withCapacityReservation(ledger, { key: 42 as never, limit: 1, operationId: 'op-4' }, work)).rejects.toThrow('key must be a non-empty string');
    await expect(withCapacityReservation(ledger, { key: 'user-1', limit: 1, operationId: false as never }, work)).rejects.toThrow('operationId must be a non-empty string');

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
      await expect(withCapacityReservation(
        ledger,
        { key: 'user-1', limit: 1, operationId: 'op-1' },
        async () => {
          providerCalls++;
          return { status: 'succeeded', value: 'must-not-run' };
        },
      )).rejects.toThrow(message);
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
