import { describe, expect, it } from 'vitest';
import { withReserveConfirm, type UsageLedger } from './reserveConfirm.js';

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

  it('a client retry after a thrown error only re-checks — it never double-commits', async () => {
    const ledger = new FakeLedger();

    // First attempt fails.
    await expect(
      withReserveConfirm(ledger, 'user-1', 5, async () => {
        throw new Error('network blip');
      }),
    ).rejects.toThrow();

    // Client retries — this is a fresh call, phase 1 runs again (safe, read-only).
    const retryResult = await withReserveConfirm(ledger, 'user-1', 5, async () => 'ok-on-retry');

    expect(retryResult).toEqual({ allowed: true, result: 'ok-on-retry' });
    // Exactly ONE commit total for one real success — the failed attempt + its
    // retry did not burn two slots.
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
