/**
 * capacityLedgerRecipePglite.test.ts: applies the Postgres capacity-ledger
 * recipe from README.md (the SQL between the `capacity-postgres-recipe`
 * markers), unmodified, to a fresh PGlite database, then runs the README's
 * TypeScript adapter over it inside the real `withCapacityReservations`, and
 * runs the README's two route examples (non-streaming and streaming) against
 * it with a mocked provider.
 *
 * What this proves: the recipe applies to a real (WASM) Postgres and its logic
 * matches the CapacityReservationLedger contract on ONE connection: limits
 * count confirmed usage plus unexpired holds, a repeated operation never makes
 * a second hold, confirm and release are idempotent and cannot flip, expired
 * holds stop counting, the window comes from the database clock, bad input is
 * rejected, a limit passed on the next call takes effect, and a role holding
 * only EXECUTE can use the functions but cannot touch the table.
 *
 * What it does NOT prove: PGlite is a single connection, so nothing here shows
 * a cap holds under concurrent sessions. `capacityLedgerPostgres.test.ts` does
 * that against a real server when COST_GOVERNOR_PG_URL is set.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileFunction, runInNewContext } from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Each test may boot a fresh WASM Postgres; that startup alone can pass the
// 5 s default on a loaded machine. Assertions are unchanged.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { createInMemoryAdmissionStore } from './admission.js';
import { admitBeforeCall, admissionHttpStatus } from './admission.js';
import { createInMemoryCapacityLedger } from './capacityLedger.js';
import { estimateCostMicros, priceFor, definePricingTable, usageFromAnthropic, usageFromAnthropicStream } from './pricing.js';
import { createCommitOnce, withCapacityReservation, withCapacityReservations, type CapacityReservationLedger } from './reserveConfirm.js';

const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

function recipeSql(): string {
  const m = /<!-- capacity-postgres-recipe:start -->\s*```sql\n([\s\S]*?)```\s*<!-- capacity-postgres-recipe:end -->/.exec(readme);
  if (!m?.[1]) throw new Error('README.md has no capacity-postgres-recipe SQL block');
  return m[1];
}

function adapterSource(): string {
  const after = readme.slice(readme.indexOf('<!-- capacity-postgres-recipe:end -->'));
  const m = /```ts\n([\s\S]*?)```/.exec(after);
  if (!m?.[1] || !m[1].includes('postgresCapacityLedger')) throw new Error('README.md has no capacity adapter block');
  return m[1];
}

/** The ```js block that follows `anchor` in the README. */
function jsBlock(anchor: string): string {
  const from = readme.indexOf(anchor);
  if (from < 0) throw new Error(`README anchor not found: ${anchor}`);
  const open = '```js\n';
  const start = readme.indexOf(open, from);
  return readme.slice(start + open.length, readme.indexOf('\n```', start + open.length));
}

let db: PGlite;
let ledger: CapacityReservationLedger;

type Query = (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
const query: Query = async (sql, params) => {
  const r = await db.query<Record<string, unknown>>(sql, params);
  return { rows: r.rows };
};

function makeLedger(options?: { window?: 'utc-day' | 'utc-month'; holdSeconds?: number }): CapacityReservationLedger {
  const js = ts.transpileModule(adapterSource().replace(/^import .*$/m, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/^export /m, '');
  const make = compileFunction(`${js}\nreturn postgresCapacityLedger;`, []) as () => (q: Query, o?: unknown) => CapacityReservationLedger;
  return make()(query, options);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(recipeSql());
  ledger = makeLedger();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const req = (key: string, op: string, amount = 4, limit = 10) => ({ key, limit, operationId: op, amount });

describe('README Postgres capacity ledger on PGlite (single connection: logic, not concurrency)', () => {
  it('holds count toward the limit; a refusal changes nothing', async () => {
    expect((await ledger.reserveCapacity(req('t1', 'a'))).status).toBe('acquired');
    expect((await ledger.reserveCapacity(req('t1', 'b'))).status).toBe('acquired');
    expect(await ledger.reserveCapacity(req('t1', 'c'))).toEqual({ status: 'denied', reason: 'limit' });
    const rows = await db.query("select operation_id, state from public.capacity_holds where scope_key = 't1' order by operation_id");
    expect(rows.rows).toEqual([{ operation_id: 'a', state: 'held' }, { operation_id: 'b', state: 'held' }]);
  });

  it('a repeated operation id: in progress while held, terminal once settled, never a second hold', async () => {
    const first = await ledger.reserveCapacity(req('t2', 'a'));
    if (first.status !== 'acquired') throw new Error('expected acquired');
    expect(await ledger.reserveCapacity(req('t2', 'a'))).toMatchObject({ status: 'operation_in_progress', reservation: { id: first.reservation.id } });
    await ledger.confirmReservation(first.reservation, { usage: 'reported', amount: 6, reservedAmount: 4 });
    expect(await ledger.reserveCapacity(req('t2', 'a'))).toMatchObject({ status: 'operation_terminal', operationId: 'a' });
    const count = await db.query("select count(*)::int as n from public.capacity_holds where scope_key = 't2'");
    expect(count.rows).toEqual([{ n: 1 }]);
  });

  it('confirm records the actual amount even above the hold, and it counts toward the next reserve', async () => {
    const a = await ledger.reserveCapacity(req('t3', 'a', 4, 10));
    if (a.status !== 'acquired') throw new Error('expected acquired');
    await ledger.confirmReservation(a.reservation, { usage: 'reported', amount: 9, reservedAmount: 4 });
    expect((await ledger.reserveCapacity(req('t3', 'b', 2, 10))).status).toBe('denied'); // 9 + 2 > 10
    expect((await ledger.reserveCapacity(req('t3', 'c', 1, 10))).status).toBe('acquired'); // 9 + 1 <= 10
  });

  it('confirm without a settlement records the hold; confirm and release are idempotent and cannot flip', async () => {
    const a = await ledger.reserveCapacity(req('t4', 'a'));
    const b = await ledger.reserveCapacity(req('t4', 'b'));
    if (a.status !== 'acquired' || b.status !== 'acquired') throw new Error('expected acquired');
    await ledger.confirmReservation(a.reservation);
    await ledger.confirmReservation(a.reservation);
    await ledger.releaseReservation(b.reservation);
    await ledger.releaseReservation(b.reservation);
    const rows = await db.query("select operation_id, state, recorded::int as recorded from public.capacity_holds where scope_key = 't4' order by operation_id");
    expect(rows.rows).toEqual([{ operation_id: 'a', state: 'confirmed', recorded: 4 }, { operation_id: 'b', state: 'released', recorded: 0 }]);
    await expect(ledger.releaseReservation(a.reservation)).rejects.toThrow(/confirmed/);
    await expect(ledger.confirmReservation(b.reservation)).rejects.toThrow(/released/);
    await expect(ledger.confirmReservation({ ...a.reservation, id: '999999' })).rejects.toThrow(/unknown hold/);
  });

  it('an expired hold stops counting but stays unresolved', async () => {
    const short = makeLedger({ holdSeconds: 1 });
    expect((await short.reserveCapacity(req('t5', 'a', 10, 10))).status).toBe('acquired');
    expect((await short.reserveCapacity(req('t5', 'b', 1, 10))).status).toBe('denied');
    await db.exec("update public.capacity_holds set expires_at = clock_timestamp() - interval '1 second' where scope_key = 't5'");
    expect((await short.reserveCapacity(req('t5', 'b', 1, 10))).status).toBe('acquired');
    expect((await short.reserveCapacity(req('t5', 'a', 10, 10))).status).toBe('operation_in_progress');
  });

  it('a limit passed on the next call takes effect: raised or lowered, nothing is pinned', async () => {
    await ledger.reserveCapacity(req('t6', 'a', 5, 5));
    expect((await ledger.reserveCapacity(req('t6', 'b', 5, 5))).status).toBe('denied');
    expect((await ledger.reserveCapacity(req('t6', 'b', 5, 100))).status).toBe('acquired');
    expect((await ledger.reserveCapacity(req('t6', 'c', 1, 6))).status).toBe('denied');
  });

  it('the window comes from the database clock: day and month ids, and separate counters per window', async () => {
    const day = (await db.query<{ d: string; m: string }>("select to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD') as d, to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM') as m")).rows[0];
    await ledger.reserveCapacity(req('t7', 'a'));
    const monthly = makeLedger({ window: 'utc-month' });
    await monthly.reserveCapacity(req('t7m', 'a'));
    const rows = await db.query("select scope_key, win from public.capacity_holds where scope_key in ('t7', 't7m') order by scope_key");
    expect(rows.rows).toEqual([{ scope_key: 't7', win: day?.d }, { scope_key: 't7m', win: day?.m }]);
    // Yesterday's usage does not count today (the day column is what is summed).
    await db.exec("update public.capacity_holds set win = '2000-01-01' where scope_key = 't7'");
    expect((await ledger.reserveCapacity(req('t7', 'z', 10, 10))).status).toBe('acquired');
  });

  it.each([
    ['a blank key', ['', 10, 'o', 1, 60, 'utc-day']],
    ['a negative limit', ['k', -1, 'o', 1, 60, 'utc-day']],
    ['a zero amount', ['k', 10, 'o', 0, 60, 'utc-day']],
    ['a blank operation id', ['k', 10, ' ', 1, 60, 'utc-day']],
    ['a zero hold time', ['k', 10, 'o', 1, 0, 'utc-day']],
    ['an unknown window', ['k', 10, 'o', 1, 60, 'utc-week']],
    ['a null limit', ['k', null, 'o', 1, 60, 'utc-day']],
  ])('rejects %s', async (_label, args) => {
    await expect(db.query('select * from public.capacity_reserve($1, $2, $3, $4, $5, $6)', args)).rejects.toThrow(/invalid capacity request/);
  });

  it('a limit of 0 refuses everything', async () => {
    expect((await ledger.reserveCapacity(req('t8', 'a', 1, 0))).status).toBe('denied');
  });

  it('a role holding only EXECUTE can use the functions but cannot read or write the table', async () => {
    const grants = [...recipeSql().matchAll(/^-- (grant execute on function [^\n]+) to service_role;$/gm)].map((m) => m[1]);
    expect(grants).toHaveLength(3);
    await db.exec(`create role cap_server_test login nobypassrls nosuperuser;
      ${grants.map((g) => `${g} to cap_server_test;`).join('\n')}`);
    try {
      await db.exec('set role cap_server_test');
      const a = await ledger.reserveCapacity(req('t9', 'a'));
      expect(a.status).toBe('acquired');
      if (a.status === 'acquired') await ledger.confirmReservation(a.reservation, { usage: 'reported', amount: 3, reservedAmount: 4 });
      await expect(db.query('select * from public.capacity_holds')).rejects.toThrow(/permission denied/);
      await expect(db.query("update public.capacity_holds set recorded = 0 where scope_key = 't9'")).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec('reset role');
    }
    const rows = await db.query("select recorded::int as recorded from public.capacity_holds where scope_key = 't9'");
    expect(rows.rows).toEqual([{ recorded: 3 }]);
  });

  it('a role with no grant at all (PUBLIC revoked) cannot call any of the three functions', async () => {
    await db.exec('create role cap_nobody_test login nobypassrls nosuperuser');
    const held = await ledger.reserveCapacity(req('t10', 'a'));
    if (held.status !== 'acquired') throw new Error('expected acquired');
    try {
      await db.exec('set role cap_nobody_test');
      await expect(ledger.reserveCapacity(req('t10', 'b'))).rejects.toThrow(/permission denied/);
      await expect(ledger.confirmReservation(held.reservation)).rejects.toThrow(/permission denied/);
      await expect(ledger.releaseReservation(held.reservation)).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec('reset role');
    }
    // Nothing the stranger tried changed the hold.
    const rows = await db.query("select state from public.capacity_holds where scope_key = 't10'");
    expect(rows.rows).toEqual([{ state: 'held' }]);
  });

  it('inside withCapacityReservations: per-user inside global, refusals name the scope, and settlement is recorded', async () => {
    const scopes = [{ key: 'w1:user', limit: 100 }, { key: 'w1:global', limit: 150 }];
    const run = (op: string, amount: number, actual?: number, who = scopes) =>
      withCapacityReservations(ledger, { scopes: who, operationId: op, amount }, async () => ({
        status: 'succeeded' as const,
        value: op,
        ...(actual === undefined ? {} : { settle: { actualAmount: actual } }),
      }));
    expect(await run('a', 60, 55)).toMatchObject({ status: 'confirmed', settlement: { amount: 55 } });
    expect(await run('b', 60)).toMatchObject({ status: 'refused', scopeKey: 'w1:user' }); // 55 + 60 > 100
    expect(await run('c', 30, 30)).toMatchObject({ status: 'confirmed' }); // user 85
    // A second user fills the global scope: 85 + 55 = 140; a 20 hold needs 160 > 150.
    expect(await run('d', 55, 55, [{ key: 'w1:other', limit: 100 }, { key: 'w1:global', limit: 150 }])).toMatchObject({ status: 'confirmed' });
    expect(await run('e', 20, 20, [{ key: 'w1:other', limit: 100 }, { key: 'w1:global', limit: 150 }])).toMatchObject({ status: 'refused', scopeKey: 'w1:global' });
    // The refusal released its hold on the user scope: no residue.
    const held = await db.query("select count(*)::int as n from public.capacity_holds where scope_key = 'w1:other' and state = 'held'");
    expect(held.rows).toEqual([{ n: 0 }]);
  });
});

describe('README route examples, run with a mocked provider', () => {
  const table = definePricingTable({
    checkedAt: '2026-10-01',
    source: 'illustrative numbers for tests',
    rates: { 'anthropic:test-model': { inputPerMTokMicros: 3_000_000, outputPerMTokMicros: 15_000_000 } },
  });
  const admissionStore = createInMemoryAdmissionStore();

  function context(client: unknown, useLedger: CapacityReservationLedger, logged: unknown[]) {
    return {
      admitBeforeCall,
      admissionHttpStatus,
      store: admissionStore,
      priceFor,
      table,
      estimateCostMicros,
      withCapacityReservations,
      usageFromAnthropic,
      usageFromAnthropicStream,
      createCommitOnce,
      ledger: useLedger,
      client,
      log: (x: unknown) => logged.push(x),
      Response,
      ReadableStream,
      TextEncoder,
      Promise,
    };
  }

  const args = (n: number, extra: Record<string, unknown> = {}) => ({
    userId: 'u1', requestId: `req-${n}`, model: 'test-model', prompt: 'hi', maxTokens: 1_000, estimatedInputTokens: 2_000, ...extra,
  });
  // hold = 2000*3 + 1000*15 = 21,000 micros

  it('non-streaming: the reply, the settled actual cost, and an unknown-model refusal', async () => {
    const logged: unknown[] = [];
    const mem = createInMemoryCapacityLedger();
    const client = { messages: { create: async () => ({ id: 'm', usage: { input_tokens: 1_200, output_tokens: 300 } }) } };
    const handle = runInNewContext(`${jsBlock('### A route: non-streaming')}\nhandle;`, context(client, mem, logged)) as (a: unknown) => Promise<Response>;
    const response = await handle(args(1));
    expect(response.status).toBe(200);
    expect(mem.usage('spend:user:u1')).toEqual({ confirmed: 3_600 + 4_500, held: 0 });
    expect(mem.usage('spend:global')).toEqual({ confirmed: 8_100, held: 0 });
    expect((await handle(args(2, { model: 'mystery' }))).status).toBe(400);
    expect(logged).toEqual([]);
  });

  it('non-streaming: missing usage settles the full hold; a user over their cap gets 429, a full global gets 503', async () => {
    const logged: unknown[] = [];
    const mem = createInMemoryCapacityLedger();
    const client = { messages: { create: async () => ({ id: 'm' }) } };
    const handle = runInNewContext(`${jsBlock('### A route: non-streaming')}\nhandle;`, context(client, mem, logged)) as (a: unknown) => Promise<Response>;
    expect((await handle(args(3))).status).toBe(200);
    expect(mem.usage('spend:user:u1').confirmed).toBe(21_000); // unknown usage: the whole hold, not zero
    // Fill the user's $2.00 cap, then one more request is the user's 429.
    await mem.reserveCapacity({ key: 'spend:user:u1', limit: 2_000_000, operationId: 'filler', amount: 1_979_000 });
    expect((await handle(args(4))).status).toBe(429);
    // A different user, with the global scope filled, is a 503.
    await mem.reserveCapacity({ key: 'spend:global', limit: 100_000_000, operationId: 'filler-g', amount: 99_970_000 });
    expect((await handle(args(5, { userId: 'u2' }))).status).toBe(503);
  });

  it('non-streaming, over the README Postgres ledger: settles the actual cost in the database', async () => {
    const logged: unknown[] = [];
    const client = { messages: { create: async () => ({ id: 'm', usage: { input_tokens: 1_200, output_tokens: 300 } }) } };
    const handle = runInNewContext(`${jsBlock('### A route: non-streaming')}\nhandle;`, context(client, ledger, logged)) as (a: unknown) => Promise<Response>;
    expect((await handle(args(20, { userId: 'pg1' }))).status).toBe(200);
    const rows = await db.query("select scope_key, state, recorded::int as recorded from public.capacity_holds where operation_id = 'req-20' order by scope_key");
    expect(rows.rows).toEqual([
      { scope_key: 'spend:global', state: 'confirmed', recorded: 8_100 },
      { scope_key: 'spend:user:pg1', state: 'confirmed', recorded: 8_100 },
    ]);
    expect(logged).toEqual([]);
  });

  it('non-streaming: a provider call that throws keeps the holds and answers 503', async () => {
    const logged: unknown[] = [];
    const mem = createInMemoryCapacityLedger();
    const client = { messages: { create: async () => { throw new Error('socket hang up'); } } };
    const handle = runInNewContext(`${jsBlock('### A route: non-streaming')}\nhandle;`, context(client, mem, logged)) as (a: unknown) => Promise<Response>;
    expect((await handle(args(6, { userId: 'u3' }))).status).toBe(503);
    expect(mem.usage('spend:user:u3')).toEqual({ confirmed: 0, held: 21_000 });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ status: 'needs_reconciliation' });
  });

  function mockStream(events: unknown[], failAt?: number) {
    return {
      messages: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            for (let i = 0; i < events.length; i++) {
              if (failAt === i) throw new Error('stream broke');
              yield events[i];
            }
          },
        }),
      },
    };
  }
  const streamEvents = [
    { type: 'message_start', message: { usage: { input_tokens: 1_200, output_tokens: 1 } } },
    { type: 'content_block_delta', delta: { text: 'Hello ' } },
    { type: 'content_block_delta', delta: { text: 'world' } },
    { type: 'message_delta', usage: { output_tokens: 300, input_tokens: null } },
  ];

  it('streaming: the Response returns while the stream runs, and settlement follows the final message_delta', async () => {
    const logged: unknown[] = [];
    const mem = createInMemoryCapacityLedger();
    const handle = runInNewContext(`${jsBlock('### A route: streaming')}\nhandleStream;`, context(mockStream(streamEvents), mem, logged)) as (a: unknown) => Promise<Response>;
    const response = await handle(args(10, { userId: 's1' }));
    expect(response.status).toBe(200);
    expect(mem.usage('spend:user:s1')).toEqual({ confirmed: 0, held: 21_000 }); // still held while streaming
    expect(await response.text()).toBe('Hello world');
    await new Promise((r) => setTimeout(r, 20));
    expect(mem.usage('spend:user:s1')).toEqual({ confirmed: 3_600 + 4_500, held: 0 });
    expect(mem.usage('spend:global').confirmed).toBeGreaterThanOrEqual(8_100);
  });

  it('streaming: a stream that dies before message_delta settles the full hold (unknown), never near zero', async () => {
    const logged: unknown[] = [];
    const mem = createInMemoryCapacityLedger();
    const handle = runInNewContext(`${jsBlock('### A route: streaming')}\nhandleStream;`, context(mockStream(streamEvents, 2), mem, logged)) as (a: unknown) => Promise<Response>;
    const response = await handle(args(11, { userId: 's2' }));
    await expect(response.text()).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(mem.usage('spend:user:s2')).toEqual({ confirmed: 21_000, held: 0 });
  });

  it('streaming: a client cancel settles the full hold exactly once', async () => {
    const logged: unknown[] = [];
    const mem = createInMemoryCapacityLedger();
    const handle = runInNewContext(`${jsBlock('### A route: streaming')}\nhandleStream;`, context(mockStream(streamEvents), mem, logged)) as (a: unknown) => Promise<Response>;
    const response = await handle(args(12, { userId: 's3' }));
    await response.body?.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(mem.usage('spend:user:s3')).toEqual({ confirmed: 21_000, held: 0 });
    expect(logged).toEqual([]);
  });

  it('streaming: a user already over their cap is refused before any provider call', async () => {
    const logged: unknown[] = [];
    const mem = createInMemoryCapacityLedger();
    await mem.reserveCapacity({ key: 'spend:user:s4', limit: 2_000_000, operationId: 'filler', amount: 1_990_000 });
    let calls = 0;
    const client = { messages: { create: async () => { calls++; return mockStream(streamEvents).messages.create(); } } };
    const handle = runInNewContext(`${jsBlock('### A route: streaming')}\nhandleStream;`, context(client, mem, logged)) as (a: unknown) => Promise<Response>;
    expect((await handle(args(13, { userId: 's4' }))).status).toBe(429);
    expect(calls).toBe(0);
  });
});

// Keep the single-scope primitive in the import list honest.
void withCapacityReservation;
