/**
 * verdict-table.test.ts: a named table of verdicts that must hold.
 *
 * Two kinds of case:
 *   - REGRESSION cases assert the correct behavior for defects found in the
 *     2026-10-10 hunt (a wrong ALLOW, a wrong DENY, a paid result lost, a
 *     self-contradicting message, a wrong README snippet).
 *   - GUARD cases pin behavior that was already right, so the fixes cannot
 *     move it: exact pricing, ceiling equality, strict input validation, the
 *     commit-failure results and the README quickstart output.
 *
 * Time-zone cases run under several TZ values by assigning `process.env.TZ`
 * (Node re-reads it on assignment) and check first that the switch took effect.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseIsoInstant } from '../src/internal.js';
import {
  checkPreCallCeiling,
  estimateCostUsd,
  formatRatesForLog,
  getRatesOrThrow,
  withCapacityReservation,
  withReserveConfirm,
  type CapacityReservation,
  type CapacityReservationLedger,
  type CapacityWorkOutcome,
  type ModelRates,
  type ReserveCapacityResult,
} from '../src/index.js';

const rates: ModelRates = { inputPerMillion: 3, outputPerMillion: 15 };
const request = { key: 'user-1:2026-10-10', limit: 5, operationId: 'op-1' };

const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Log {
  work: number;
  confirm: CapacityReservation[];
  release: CapacityReservation[];
}

/** A ledger that always acquires, with the given `expiresAt`, and records every call. */
function acquiring(expiresAt: string, log: Log): CapacityReservationLedger {
  return {
    reserveCapacity: async (r): Promise<ReserveCapacityResult> => ({
      status: 'acquired',
      reservation: { id: 'r-1', key: r.key, operationId: r.operationId, expiresAt },
    }),
    confirmReservation: async (res) => {
      log.confirm.push(res);
    },
    releaseReservation: async (res) => {
      log.release.push(res);
    },
  };
}

const newLog = (): Log => ({ work: 0, confirm: [], release: [] });

function work(log: Log, outcome: unknown): (r: CapacityReservation) => Promise<CapacityWorkOutcome<string>> {
  return async () => {
    log.work += 1;
    return outcome as CapacityWorkOutcome<string>;
  };
}

/** A well-formed future instant, shifted by `ms` from now, as an offset-bearing ISO string. */
const future = (ms = 30 * 60_000): Date => new Date(Date.now() + ms);

/** The same wall-clock reading as `d` in UTC, but with the zone designator removed. */
const withoutZone = (d: Date, precision: 'ms' | 's' | 'min' = 'ms'): string => {
  const iso = d.toISOString().replace('Z', '');
  if (precision === 'ms') return iso;
  if (precision === 's') return iso.slice(0, 19);
  return iso.slice(0, 16);
};

/** Pull the first fenced block of `lang` that follows `anchor` in the README. */
function readmeBlock(anchor: string, lang = 'js'): string {
  const from = readme.indexOf(anchor);
  expect(from, `README anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0);
  const open = '```' + lang + '\n';
  const start = readme.indexOf(open, from);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = readme.indexOf('\n```', start + open.length);
  return readme.slice(start + open.length, end);
}

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
  vi.useRealTimers();
});

const ZONES = ['America/Chicago', 'Asia/Tokyo', 'UTC', 'Pacific/Kiritimati'] as const;

// ---------------------------------------------------------------------------
// REGRESSION 1: expiresAt must carry a zone and be strict ISO-8601
// ---------------------------------------------------------------------------

describe('verdict table: expiresAt is strict ISO-8601 with a zone', () => {
  it('precondition: assigning process.env.TZ really changes how a zone-less string parses', () => {
    process.env.TZ = 'America/Chicago';
    const chicago = Date.parse('2026-10-10T12:00:00');
    process.env.TZ = 'Asia/Tokyo';
    const tokyo = Date.parse('2026-10-10T12:00:00');
    expect(chicago - tokyo).toBe(14 * 3_600_000); // CDT is UTC-5, JST is UTC+9
  });

  describe.each(ZONES)('under TZ=%s', (zone) => {
    it.each([
      ['milliseconds, no zone', 'ms'],
      ['seconds, no zone', 's'],
      ['minutes, no zone', 'min'],
    ] as const)('rejects a zone-less timestamp (%s) with a RangeError naming the zone, and runs no work', async (_l, precision) => {
      process.env.TZ = zone;
      const log = newLog();
      const stamp = withoutZone(future(), precision);
      const ledger = acquiring(stamp, log);
      const attempt = withCapacityReservation(ledger, request, work(log, { status: 'succeeded', value: 'x' }));
      await expect(attempt).rejects.toThrow(RangeError);
      await expect(withCapacityReservation(ledger, request, work(log, { status: 'succeeded', value: 'x' }))).rejects.toThrow(
        /time zone/,
      );
      expect(log.work).toBe(0);
    });

    it('accepts the same instant when it is spelled with Z, +00:00 or a real offset, whatever the machine TZ', async () => {
      process.env.TZ = zone;
      const target = future();
      const asOffset = (hours: number): string => {
        const shifted = new Date(target.getTime() + hours * 3_600_000).toISOString().replace('Z', '');
        const sign = hours < 0 ? '-' : '+';
        const hh = String(Math.abs(hours)).padStart(2, '0');
        return `${shifted}${sign}${hh}:00`;
      };
      for (const stamp of [target.toISOString(), asOffset(0), asOffset(-5), asOffset(9)]) {
        const log = newLog();
        const result = await withCapacityReservation(acquiring(stamp, log), request, work(log, { status: 'succeeded', value: 'ok' }));
        expect(result.status, stamp).toBe('confirmed');
        expect(log.work).toBe(1);
      }
    });
  });

  it.each([
    ['a bare year', '2099'],
    ['a long-form date', 'Dec 25, 2099'],
    ['a US date', '12/25/2099'],
    ['a date with no time', '2099-12-25'],
    ['a space instead of T', '2099-12-25 10:00:00Z'],
    ['a lowercase t and z', '2099-12-25t10:00:00z'],
    ['an offset without a colon', '2099-12-25T10:00:00+0000'],
    ['a short offset', '2099-12-25T10:00:00+00'],
    ['epoch milliseconds as text', '4102444800000'],
    ['a day that does not exist (Feb 30)', '2099-02-30T10:00:00Z'],
    ['a month 13', '2099-13-01T10:00:00Z'],
    ['hour 24', '2099-12-25T24:00:00Z'],
    ['hour 25', '2099-12-25T25:00:00Z'],
    ['minute 60', '2099-12-25T10:60:00Z'],
    ['an offset beyond 23:59', '2099-12-25T10:00:00+25:00'],
    ['trailing text', '2099-12-25T10:00:00Z later'],
    ['leading space', ' 2099-12-25T10:00:00Z'],
    ['an empty string', ''],
    ['a trailing newline', '2099-12-25T10:00:00Z\n'],
    ['full-width digits', '\uFF12\uFF10\uFF19\uFF19-12-25T10:00:00Z'],
    ['a fraction marker with no digits', '2099-12-25T10:00:00.Z'],
    ['more than nine fractional digits (documented limit)', '2099-12-25T10:00:00.1234567890Z'],
    ['raw Postgres text with a space and a short offset (documented: format it as ISO first)', '2099-12-25 10:00:00.411+00'],
    ['Feb 29 in a non-leap century year', '2100-02-29T10:00:00Z'],
    ['Feb 29 in a non-leap year', '2099-02-29T10:00:00Z'],
  ])('rejects %s as expiresAt, so it is never read as a live hold', async (_label, expiresAt) => {
    const log = newLog();
    await expect(
      withCapacityReservation(acquiring(expiresAt, log), request, work(log, { status: 'succeeded', value: 'x' })),
    ).rejects.toThrow(/reservation expiresAt must be a valid ISO-8601 timestamp/);
    expect(log.work).toBe(0);
  });

  it('also rejects a zone-less expiresAt on an in-progress decision (no silent local-time read)', async () => {
    const ledger: CapacityReservationLedger = {
      reserveCapacity: async (r) => ({
        status: 'operation_in_progress',
        reservation: { id: 'r-1', key: r.key, operationId: r.operationId, expiresAt: withoutZone(future()) },
      }),
      confirmReservation: async () => undefined,
      releaseReservation: async () => undefined,
    };
    await expect(withCapacityReservation(ledger, request, async () => ({ status: 'succeeded', value: 1 }))).rejects.toThrow(/time zone/);
  });

  it.each([
    ['a leap day in a leap year', '2096-02-29T10:00:00Z'],
    ['a leap day in a 400-year leap year', '2400-02-29T10:00:00Z'],
    ['no seconds', '2099-12-25T10:00Z'],
    ['a half-hour offset without seconds', '2099-12-25T10:00+05:30'],
    ['the widest offsets', '2099-12-25T10:00:00-23:59'],
    ['nine fractional digits', '2099-12-25T10:00:00.123456789+23:59'],
  ])('accepts %s as expiresAt', async (_label, expiresAt) => {
    const log = newLog();
    const result = await withCapacityReservation(acquiring(expiresAt, log), request, work(log, { status: 'succeeded', value: 'ok' }));
    expect(result.status).toBe('confirmed');
  });

  it('reads an offset as an instant: now+60s written as +14:00 is live, now-60s written as -12:00 is expired', async () => {
    const spell = (ms: number, hours: number, sign: 1 | -1): string => {
      const shifted = new Date(Date.now() + ms + sign * hours * 3_600_000).toISOString().replace('Z', '');
      return `${shifted}${sign > 0 ? '+' : '-'}${String(hours).padStart(2, '0')}:00`;
    };
    const live = newLog();
    expect((await withCapacityReservation(acquiring(spell(60_000, 14, 1), live), request, work(live, { status: 'succeeded', value: 1 }))).status).toBe(
      'confirmed',
    );
    const dead = newLog();
    await expect(
      withCapacityReservation(acquiring(spell(-60_000, 12, -1), dead), request, work(dead, { status: 'succeeded', value: 1 })),
    ).rejects.toThrow('adapter returned an expired reservation');
  });

  it('a year before 0100 is read as that year (expired), not mapped to 19xx or reported as malformed', async () => {
    const log = newLog();
    await expect(withCapacityReservation(acquiring('0050-06-01T00:00:00Z', log), request, work(log, { status: 'succeeded', value: 1 }))).rejects.toThrow(
      'adapter returned an expired reservation',
    );
  });

  it('truncates fractional seconds past milliseconds instead of rounding up', () => {
    expect(parseIsoInstant('2099-12-25T10:00:00.9999999Z')).toBe(Date.UTC(2099, 11, 25, 10, 0, 0, 999));
    expect(parseIsoInstant('2099-12-25T10:00:00.5Z')).toBe(Date.UTC(2099, 11, 25, 10, 0, 0, 500));
  });

  it('GUARD: an already-expired timestamp with a zone is still reported as expired, not as malformed', async () => {
    const log = newLog();
    const past = new Date(Date.now() - 1_000).toISOString();
    await expect(withCapacityReservation(acquiring(past, log), request, work(log, { status: 'succeeded', value: 'x' }))).rejects.toThrow(
      'adapter returned an expired reservation',
    );
  });

  it('GUARD: Postgres-style microsecond fractions with a +00:00 offset are accepted', async () => {
    const log = newLog();
    const stamp = future().toISOString().replace('Z', '123+00:00'); // .mmm123 microseconds
    const result = await withCapacityReservation(acquiring(stamp, log), request, work(log, { status: 'succeeded', value: 'ok' }));
    expect(result.status).toBe('confirmed');
  });
});

// ---------------------------------------------------------------------------
// REGRESSION 2: `reason` is absent (not present-and-undefined) when allowed
// ---------------------------------------------------------------------------

describe('verdict table: reason key', () => {
  const allowed = checkPreCallCeiling({ spentSoFarUsd: 1, ceilingUsd: 25, estimatedNextCallUsage: { inputTokens: 1_000 }, rates });
  const denied = checkPreCallCeiling({ spentSoFarUsd: 25, ceilingUsd: 25, estimatedNextCallUsage: { inputTokens: 1_000 }, rates });

  it('omits the reason key entirely when allowed', () => {
    expect(allowed.allowed).toBe(true);
    expect(Object.hasOwn(allowed, 'reason')).toBe(false);
    expect('reason' in allowed).toBe(false);
    expect(Object.keys(allowed).sort()).toEqual(['allowed', 'ceilingUsd', 'projectedNextCallCostUsd', 'projectedTotalUsd']);
    expect(JSON.parse(JSON.stringify(allowed))).toStrictEqual({ ...allowed });
  });

  it('GUARD: a denial still carries a string reason', () => {
    expect(denied.allowed).toBe(false);
    expect(typeof denied.reason).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// REGRESSION 3: a throwing outcome getter is an ambiguous outcome, not an escape
// ---------------------------------------------------------------------------

describe('verdict table: a hostile or throwing work outcome after paid work', () => {
  const boom = new Error('getter exploded');
  const cases: [string, () => unknown][] = [
    ['a throwing status getter', () => ({ get status(): string { throw boom; } })],
    ['a throwing value getter on a succeeded outcome', () => ({ status: 'succeeded', get value(): string { throw boom; } })],
    ['a throwing error getter on a failed outcome', () => ({ status: 'failed', get error(): string { throw boom; } })],
    [
      'a proxy whose has/getOwnPropertyDescriptor trap throws',
      () =>
        new Proxy({ status: 'succeeded', value: 1 }, {
          getOwnPropertyDescriptor() {
            throw boom;
          },
        }),
    ],
    ['a revoked proxy', () => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; }],
    ['a thenable whose then getter throws', () => ({ get then(): string { throw boom; } })],
  ];

  it.each(cases)('%s gives work_outcome_ambiguous with the hold kept and the reservation returned', async (_label, make) => {
    const log = newLog();
    const result = await withCapacityReservation(acquiring(future().toISOString(), log), request, work(log, make()));
    expect(result.status).toBe('work_outcome_ambiguous');
    if (result.status !== 'work_outcome_ambiguous') return;
    expect(result.error).toBeInstanceOf(Error);
    expect(result.reservation).toMatchObject({ id: 'r-1', key: request.key, operationId: request.operationId });
    expect(log.work).toBe(1);
    expect(log.confirm).toEqual([]);
    expect(log.release).toEqual([]);
  });

  it('GUARD: a malformed (not throwing) outcome is still work_outcome_ambiguous', async () => {
    const log = newLog();
    const result = await withCapacityReservation(acquiring(future().toISOString(), log), request, work(log, { status: 'maybe' }));
    expect(result.status).toBe('work_outcome_ambiguous');
    expect(log.confirm).toEqual([]);
    expect(log.release).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// REGRESSION 4: the README usage-mapping snippet
// ---------------------------------------------------------------------------

describe('verdict table: README usage-mapping snippet', () => {
  const snippet = readmeBlock('Map an Anthropic `usage` block like this');
  const run = (usage: Record<string, unknown>): number =>
    vm.runInNewContext(`${snippet}\ncost;`, { estimateCostUsd, rates, response: { usage } }) as number;

  it('prices cache_creation_input_tokens as 5-minute writes when the TTL split is absent', () => {
    // 2,000 x $3/M x 1.25 = $0.0075
    expect(run({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 2_000 })).toBe(0.0075);
  });

  it('uses the TTL split when it is present and does not add the total on top', () => {
    const cost = run({
      input_tokens: 1_000,
      output_tokens: 100,
      cache_read_input_tokens: 4_000,
      cache_creation_input_tokens: 3_000,
      cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 1_000 },
    });
    // 1,000x3 + 4,000x0.3 + 2,000x3.75 + 1,000x6 + 100x15 = 3000+1200+7500+6000+1500 = 19,200
    expect(cost).toBe(0.0192);
  });

  it('prices a payload with no cache fields at all as plain input and output', () => {
    expect(run({ input_tokens: 1_000, output_tokens: 100 })).toBe(0.0045);
  });

  it('GUARD: matches estimateCostUsd called with the same buckets by hand', () => {
    expect(run({ input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 11 })).toBe(
      estimateCostUsd(rates, { inputTokens: 7, outputTokens: 9, cacheReadTokens: 11 }),
    );
  });
});

// ---------------------------------------------------------------------------
// REGRESSION 5: the ceiling message never contradicts itself
// ---------------------------------------------------------------------------

describe('verdict table: ceiling denial message', () => {
  /** Pull the dollar amounts out of a reason, in order: total, spent, next, ceiling. */
  const amounts = (reason: string): string[] => [...reason.matchAll(/\$(\d+\.\d+)/g)].map((m) => m[1] as string);

  it('shows a non-micro ceiling with enough precision to explain the denial', () => {
    // spent == ceiling == $4.9999996: the total rounds up to $5.000000, which is above the ceiling.
    const r = checkPreCallCeiling({ spentSoFarUsd: 4.9999996, ceilingUsd: 4.9999996, estimatedNextCallUsage: {}, rates });
    expect(r.allowed).toBe(false);
    const [total, , , ceiling] = amounts(r.reason as string);
    expect(total).toBe('5.000000');
    expect(ceiling).toBe('4.9999996');
    expect(Number(total)).toBeGreaterThan(Number(ceiling)); // reads as "above"
  });

  it('GUARD: whole-micro-dollar denials keep the exact, existing wording', () => {
    const r = checkPreCallCeiling({ spentSoFarUsd: 24.99, ceilingUsd: 25, estimatedNextCallUsage: { inputTokens: 2_000, outputTokens: 500 }, rates });
    expect(r.reason).toBe(
      'Projected total spend $25.003500 (already spent $24.990000 + projected next call $0.013500) ' +
        'would exceed the ceiling of $25.000000. Refusing to make the call.',
    );
  });

  it.each([0.1234567, 1e-7, 4.99999951, 12.3456789012, 0.30000000000000004 - 1e-9])(
    'a denied non-micro ceiling of %s is printed below the printed total',
    (ceilingUsd) => {
      const r = checkPreCallCeiling({ spentSoFarUsd: ceilingUsd, ceilingUsd, estimatedNextCallUsage: { inputTokens: 1_000 }, rates });
      expect(r.allowed).toBe(false);
      const [total, , , ceiling] = amounts(r.reason as string);
      expect(Number(ceiling)).toBeLessThan(Number(total));
    },
  );
});

// ---------------------------------------------------------------------------
// GUARDS: behavior that was already right
// ---------------------------------------------------------------------------

describe('guard: exact pricing', () => {
  it.each([
    [{ inputTokens: 1_200, outputTokens: 400, cacheReadTokens: 8_000, cacheCreation5mTokens: 2_000, cacheCreation1hTokens: 0 }, 0.0195],
    [{ cacheCreation1hTokens: 1_000_000 }, 6],
    [{ cacheCreation5mTokens: 1_000_000 }, 3.75],
    [{ cacheReadTokens: 1_000_000 }, 0.3],
    [{ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 18],
    [{}, 0],
  ])('prices %j at %s', (usage, expected) => {
    expect(estimateCostUsd(rates, usage)).toBe(expected);
  });

  it('rounds to the nearest micro-dollar: 50 tokens at $0.29/M is 14 micro-dollars, not 15', () => {
    expect(estimateCostUsd({ inputPerMillion: 0.29, outputPerMillion: 0 }, { inputTokens: 50 })).toBe(0.000014);
  });

  it('documented limit: one input token at $0.4/M is under half a micro-dollar and prices at $0', () => {
    expect(estimateCostUsd({ inputPerMillion: 0.4, outputPerMillion: 0 }, { inputTokens: 1 })).toBe(0);
  });

  it('cacheReadPerMillion replaces the 0.1x ratio', () => {
    expect(estimateCostUsd({ ...rates, cacheReadPerMillion: 0.25 }, { cacheReadTokens: 1_000_000 })).toBe(0.25);
  });

  it('getRatesOrThrow only matches own keys', () => {
    expect(() => getRatesOrThrow({ m: rates }, 'constructor')).toThrow();
    expect(getRatesOrThrow({ m: rates }, 'm')).toBe(rates);
  });
});

describe('guard: ceiling equality and rounding', () => {
  const check = (spentSoFarUsd: number, ceilingUsd: number, usage = { inputTokens: 1_000 }) =>
    checkPreCallCeiling({ spentSoFarUsd, ceilingUsd, estimatedNextCallUsage: usage, rates });

  it('allows landing exactly on the ceiling', () => {
    expect(check(24.997, 25)).toMatchObject({ allowed: true, projectedTotalUsd: 25 });
  });
  it('denies one micro-dollar over', () => {
    expect(check(24.997001, 25)).toMatchObject({ allowed: false, projectedTotalUsd: 25.000001 });
  });
  it('absorbs float noise: 0.1 + 0.2 fits a 0.3 ceiling', () => {
    const cheap = { inputPerMillion: 1, outputPerMillion: 0 }; // 200,000 tokens = $0.20
    const r = checkPreCallCeiling({ spentSoFarUsd: 0.1, ceilingUsd: 0.3, estimatedNextCallUsage: { inputTokens: 200_000 }, rates: cheap });
    expect(r).toMatchObject({ allowed: true, projectedTotalUsd: 0.3 });
  });
  it('a $0 ceiling allows only $0 calls', () => {
    expect(check(0, 0, { inputTokens: 0 }).allowed).toBe(true);
    expect(check(0, 0).allowed).toBe(false);
  });
});

describe('guard: strict input validation', () => {
  const base = { spentSoFarUsd: 0, ceilingUsd: 1, estimatedNextCallUsage: { inputTokens: 1 }, rates };
  it.each([
    ['a negative token count', () => estimateCostUsd(rates, { inputTokens: -1 }), RangeError],
    ['a fractional token count', () => estimateCostUsd(rates, { inputTokens: 1.5 }), RangeError],
    ['NaN tokens', () => estimateCostUsd(rates, { inputTokens: Number.NaN }), RangeError],
    ['a string token count', () => estimateCostUsd(rates, { inputTokens: '5' as unknown as number }), TypeError],
    ['an unknown usage key', () => estimateCostUsd(rates, { input_tokens: 5 } as never), Error],
    ['a Map as usage', () => estimateCostUsd(rates, new Map() as never), TypeError],
    ['a negative rate', () => estimateCostUsd({ inputPerMillion: -1, outputPerMillion: 1 }, {}), RangeError],
    ['an infinite rate', () => estimateCostUsd({ inputPerMillion: Infinity, outputPerMillion: 1 }, {}), RangeError],
    ['a negative spend', () => checkPreCallCeiling({ ...base, spentSoFarUsd: -1 }), RangeError],
    ['a NaN ceiling', () => checkPreCallCeiling({ ...base, ceilingUsd: Number.NaN }), RangeError],
    ['a string ceiling', () => checkPreCallCeiling({ ...base, ceilingUsd: '1' as unknown as number }), TypeError],
    ['missing rates', () => checkPreCallCeiling({ ...base, rates: undefined as never }), TypeError],
    ['a null check', () => checkPreCallCeiling(null as never), TypeError],
  ] as const)('throws on %s', (_label, run, errorType) => {
    expect(run).toThrow(errorType);
  });

  it.each([
    ['limit -1', { limit: -1 }, RangeError],
    ['limit 1.5', { limit: 1.5 }, RangeError],
    ['limit as a string', { limit: '5' as unknown as number }, TypeError],
    ['a blank key', { key: '​  ' }, RangeError],
    ['a blank operationId', { operationId: '' }, RangeError],
    ['a numeric key', { key: 7 as unknown as string }, TypeError],
  ] as const)('withCapacityReservation throws on %s before the adapter is called', async (_label, patch, errorType) => {
    const reserveCapacity = vi.fn();
    const ledger = { reserveCapacity, confirmReservation: vi.fn(), releaseReservation: vi.fn() };
    await expect(
      withCapacityReservation(ledger as unknown as CapacityReservationLedger, { ...request, ...patch }, async () => ({ status: 'succeeded', value: 1 })),
    ).rejects.toThrow(errorType);
    expect(reserveCapacity).not.toHaveBeenCalled();
  });
});

describe('guard: commit-failure behavior', () => {
  it.each([undefined, null, false, 0, ''])('withReserveConfirm returns the paid result with an own commitError for a %p rejection', async (rejection) => {
    // The point of the case: a ledger may reject with a falsy non-Error value.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const ledger = { checkUnderLimit: async () => true, commitUsage: () => Promise.reject(rejection) };
    const result = await withReserveConfirm(ledger, 'k', 5, async () => 'paid');
    expect(result).toMatchObject({ allowed: true, result: 'paid' });
    expect(Object.hasOwn(result, 'commitError')).toBe(true);
  });

  it('withReserveConfirm never commits a call that throws', async () => {
    const commitUsage = vi.fn();
    const ledger = { checkUnderLimit: async () => true, commitUsage };
    await expect(
      withReserveConfirm(ledger, 'k', 5, () => Promise.reject(new Error('provider 500'))),
    ).rejects.toThrow('provider 500');
    expect(commitUsage).not.toHaveBeenCalled();
  });

  it('withReserveConfirm fails closed on a non-boolean check and never calls the provider', async () => {
    const call = vi.fn();
    const ledger = { checkUnderLimit: async () => ({ allowed: true }) as unknown as boolean, commitUsage: async () => undefined };
    await expect(withReserveConfirm(ledger, 'k', 5, call)).rejects.toThrow(TypeError);
    expect(call).not.toHaveBeenCalled();
  });

  it('a failed confirm returns confirmation_failed with the value and keeps the hold', async () => {
    const log = newLog();
    const ledger = acquiring(future().toISOString(), log);
    ledger.confirmReservation = async () => {
      throw new Error('db down');
    };
    const result = await withCapacityReservation(ledger, request, work(log, { status: 'succeeded', value: 'paid' }));
    expect(result).toMatchObject({ status: 'confirmation_failed', value: 'paid' });
    expect(log.release).toEqual([]);
  });

  it('a failed release returns release_failed with both errors', async () => {
    const log = newLog();
    const ledger = acquiring(future().toISOString(), log);
    ledger.releaseReservation = async () => {
      throw new Error('release down');
    };
    const result = await withCapacityReservation(ledger, request, work(log, { status: 'failed', error: new Error('no charge') }));
    expect(result.status).toBe('release_failed');
    expect(log.confirm).toEqual([]);
  });

  it('a thrown doTheWork is work_outcome_ambiguous with the hold kept', async () => {
    const log = newLog();
    const result = await withCapacityReservation(acquiring(future().toISOString(), log), request, async () => {
      throw new Error('timeout');
    });
    expect(result.status).toBe('work_outcome_ambiguous');
    expect(log.confirm).toEqual([]);
    expect(log.release).toEqual([]);
  });
});

describe('guard: README quickstart outputs', () => {
  const lines: string[] = [];
  const quickstart = readmeBlock('## Quickstart').replace(/^import .*$/m, '');
  vm.runInNewContext(quickstart, {
    estimateCostUsd,
    formatRatesForLog,
    getRatesOrThrow,
    checkPreCallCeiling,
    console: { log: (...args: unknown[]) => lines.push(args.map(String).join(' ')) },
  });

  it('prints the documented rates, cost, verdict and reason', () => {
    expect(lines[0]).toBe('rates: $3/M in, $15/M out <- VERIFY against current pricing');
    expect(lines[1]).toBe('0.0195');
    expect(lines[2]).toBe('false 25.0035');
    expect(lines[3]).toBe(
      'Projected total spend $25.003500 (already spent $24.990000 + projected next call $0.013500) ' +
        'would exceed the ceiling of $25.000000. Refusing to make the call.',
    );
  });
});
