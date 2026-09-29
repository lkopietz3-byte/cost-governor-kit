/**
 * referenceImplPglite.test.ts — applies reference-impl/supabase-usage-ledger.sql
 * verbatim to a fresh PGlite (single-session, WASM Postgres) database and
 * exercises the two RPCs it defines: `usage_ledger_check_under_limit` (Phase
 * 1, read-only) and `usage_ledger_commit_usage` (Phase 2, locked increment).
 *
 * The SQL file implements only the advisory `UsageLedger` contract from
 * reserveConfirm.ts. It has no `reserveCapacity` / `confirmReservation` /
 * `releaseReservation` functions — this kit ships no SQL for the strict
 * `CapacityReservationLedger` contract, so there is nothing "reserve/confirm/
 * release"-shaped to test here.
 *
 * What this proves: the file applies cleanly to a real (WASM) Postgres, the
 * round-1 grant fix holds (a role with no explicit grant cannot execute
 * either function; `service_role` can), and the check/commit/limit/window
 * logic behaves as documented.
 *
 * What this does NOT prove: PGlite is a single connection with no real
 * concurrent sessions, so this cannot exercise or disprove the "two
 * concurrent requests both pass Phase 1" behavior described in the SQL
 * file's own header — that requires a real multi-connection Postgres. It
 * also does not touch a live Supabase project's default role/privilege setup.
 *
 * The last describe block extracts the commented-out TypeScript adapter at the
 * end of the SQL file, strips its types with the TypeScript compiler, and runs
 * that code against these same RPCs through a stub of the Supabase client's
 * `rpc` method, inside the real `withReserveConfirm` (CGK-002). It does not
 * run `@supabase/supabase-js`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withReserveConfirm, type UsageLedger } from './reserveConfirm.js';

const referenceSqlPath = fileURLToPath(
  new URL('../reference-impl/supabase-usage-ledger.sql', import.meta.url),
);
const referenceSql = readFileSync(referenceSqlPath, 'utf8');

interface CheckRow {
  allowed: boolean | null;
  current_count: number;
}
interface CommitRow {
  committed: boolean;
  new_count: number;
}

// One PGlite instance for the whole file: spinning up the WASM Postgres is
// the slow part (~1s), and every test below uses its own key, so a shared,
// already-migrated database keeps this fast without weakening what's proven.
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  // Supabase provides these roles out of the box; the reference SQL assumes
  // they exist (it grants to service_role, and its DO block revokes from
  // anon/authenticated when present). Create them first so that branch runs.
  await db.exec('create role service_role; create role anon; create role authenticated;');
  await db.exec(referenceSql);
});

afterAll(async () => {
  await db.close();
});

async function checkUnderLimit(key: string, limit: number, windowKey: string): Promise<CheckRow> {
  const result = await db.query<CheckRow>(
    'select * from usage_ledger_check_under_limit($1, $2, $3)',
    [key, limit, windowKey],
  );
  const row = result.rows[0];
  if (!row) throw new Error('usage_ledger_check_under_limit returned no row');
  return row;
}

async function commitUsage(key: string, limit: number, windowKey: string): Promise<CommitRow> {
  const result = await db.query<CommitRow>(
    'select * from usage_ledger_commit_usage($1, $2, $3)',
    [key, limit, windowKey],
  );
  const row = result.rows[0];
  if (!row) throw new Error('usage_ledger_commit_usage returned no row');
  return row;
}

describe('reference-impl/supabase-usage-ledger.sql on PGlite — round-1 grant fix', () => {
  it('denies a role with no explicit grant on both functions', async () => {
    await db.exec('set role anon;');
    await expect(checkUnderLimit('k', 3, 'w')).rejects.toThrow(/permission denied/i);
    await expect(commitUsage('k', 3, 'w')).rejects.toThrow(/permission denied/i);
    await db.exec('reset role;');
  });

  it('denies the Supabase authenticated role too', async () => {
    await db.exec('set role authenticated;');
    await expect(commitUsage('k', 3, 'w')).rejects.toThrow(/permission denied/i);
    await db.exec('reset role;');
  });

  it('allows service_role to execute both functions', async () => {
    await db.exec('set role service_role;');
    await expect(checkUnderLimit('user-x', 3, 'w1')).resolves.toEqual({ allowed: true, current_count: 0 });
    await expect(commitUsage('user-x', 3, 'w1')).resolves.toEqual({ committed: true, new_count: 1 });
    await db.exec('reset role;');
  });

  it('reproduces the pre-fix bug when the PUBLIC revoke is missing (regression check)', async () => {
    // Prove this test would have caught the round-1 bug: re-running with only
    // the file's ORIGINAL grant (no "revoke ... from public") lets a
    // no-grants role commit usage for any key, exactly what the round-1 fix
    // report describes ("an anon role committed usage for another key").
    const preFixDb = new PGlite();
    try {
      await preFixDb.exec('create role service_role;');
      await preFixDb.exec(`
        create table usage_ledger (
          key text primary key, count integer not null default 0,
          window_key text not null, updated_at timestamptz not null default now()
        );
        create or replace function usage_ledger_commit_usage(p_key text, p_limit integer, p_window text)
        returns table (committed boolean, new_count integer)
        language plpgsql security definer set search_path = public as $$
        declare v_row usage_ledger%rowtype;
        begin
          insert into usage_ledger (key, count, window_key) values (p_key, 0, p_window) on conflict (key) do nothing;
          select * into v_row from usage_ledger where key = p_key for update;
          update usage_ledger set count = count + 1, updated_at = now() where key = p_key returning * into v_row;
          return query select true, v_row.count;
        end; $$;
        -- The pre-fix file granted service_role but never revoked PUBLIC's
        -- default EXECUTE grant on a new function, so PUBLIC (and any role,
        -- including one with zero explicit grants) could still call it.
        grant execute on function usage_ledger_commit_usage(text, integer, text) to service_role;
      `);
      await preFixDb.exec('create role no_grants_at_all;');
      await preFixDb.exec('set role no_grants_at_all;');
      const result = await preFixDb.query<CommitRow>(
        'select * from usage_ledger_commit_usage($1, $2, $3)',
        ['victim', 5, 'd1'],
      );
      expect(result.rows[0]).toEqual({ committed: true, new_count: 1 });
    } finally {
      await preFixDb.close();
    }
  });
});

describe('reference-impl/supabase-usage-ledger.sql on PGlite — check/commit/limit/window logic', () => {
  beforeAll(async () => {
    // Session-level: stays in effect for the rest of this shared connection.
    await db.exec('set role service_role;');
  });

  it('treats a never-seen key as count 0, allowed under any positive limit', async () => {
    await expect(checkUnderLimit('fresh', 1, 'w1')).resolves.toEqual({ allowed: true, current_count: 0 });
  });

  it('denies a fresh key at limit 0 and records nothing on commit', async () => {
    await expect(checkUnderLimit('z', 0, 'w1')).resolves.toEqual({ allowed: false, current_count: 0 });
    await expect(commitUsage('z', 0, 'w1')).resolves.toEqual({ committed: false, new_count: 0 });
  });

  it('increments on each successful commit and denies once the limit is reached', async () => {
    await expect(commitUsage('u', 2, 'w1')).resolves.toEqual({ committed: true, new_count: 1 });
    await expect(checkUnderLimit('u', 2, 'w1')).resolves.toEqual({ allowed: true, current_count: 1 });
    await expect(commitUsage('u', 2, 'w1')).resolves.toEqual({ committed: true, new_count: 2 });

    // At the limit: Phase 1 denies, and a Phase-2 commit anyway (the call
    // already happened) records nothing rather than exceeding the limit.
    await expect(checkUnderLimit('u', 2, 'w1')).resolves.toEqual({ allowed: false, current_count: 2 });
    await expect(commitUsage('u', 2, 'w1')).resolves.toEqual({ committed: false, new_count: 2 });
  });

  it('rolls the window over on both check and commit, resetting the count', async () => {
    await expect(commitUsage('rolling-key', 1, 'day-1')).resolves.toEqual({ committed: true, new_count: 1 });
    // Same window, at the limit: denied.
    await expect(checkUnderLimit('rolling-key', 1, 'day-1')).resolves.toEqual({ allowed: false, current_count: 1 });
    // New window: Phase 1 treats it as count 0 again.
    await expect(checkUnderLimit('rolling-key', 1, 'day-2')).resolves.toEqual({ allowed: true, current_count: 0 });
    // Phase 2 persists the rollover.
    await expect(commitUsage('rolling-key', 1, 'day-2')).resolves.toEqual({ committed: true, new_count: 1 });
    await expect(checkUnderLimit('rolling-key', 1, 'day-2')).resolves.toEqual({ allowed: false, current_count: 1 });
  });

  it('a window rollover at limit 0 records nothing (the round-1 fix)', async () => {
    await commitUsage('rollover-zero', 1, 'day-1'); // count = 1 in day-1
    // New window, but limit is now 0: must not record usage past limit 0.
    await expect(commitUsage('rollover-zero', 0, 'day-2')).resolves.toEqual({ committed: false, new_count: 0 });
  });

  it('keeps independent keys independent', async () => {
    await commitUsage('key-a', 5, 'w1');
    await expect(checkUnderLimit('key-b', 5, 'w1')).resolves.toEqual({ allowed: true, current_count: 0 });
  });
});

// ---------------------------------------------------------------------------
// CGK-002: the example adapter at the end of the SQL file. Its commitUsage
// must REJECT when usage was not recorded (committed: false, a missing or
// malformed row, an RPC error) so that withReserveConfirm returns the paid
// result WITH commitError set, instead of the caller seeing a recorded call.
// ---------------------------------------------------------------------------

type SupabaseAdapterFactory = (windowKey: string, limit: number) => UsageLedger;
interface RpcResponse {
  data: unknown;
  error: unknown;
}
interface RpcClient {
  rpc(fn: string, args: { p_key: string; p_limit: number; p_window: string }): Promise<RpcResponse>;
}

/** Pull the adapter out of the SQL file's comment block and turn it into a callable factory. */
function loadCommentedAdapter(client: RpcClient): SupabaseAdapterFactory {
  const lines = referenceSql.split('\n');
  const start = lines.findIndex((line) => /^--\s+export function supabaseUsageLedger\b/.test(line));
  expect(start).toBeGreaterThan(-1);
  const body: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = (lines[i] as string).replace(/^-- ?/, '');
    body.push(line);
    if (/^ {2}\}$/.test(line)) break; // the closing brace of the exported function
  }
  const source = body.join('\n').replace(/^\s*export /, '');
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: false,
  }).outputText;
  return new Function('supabase', `${js}\nreturn supabaseUsageLedger;`)(client) as SupabaseAdapterFactory;
}

/** A stub of the Supabase client's rpc(), answered by the real SQL functions on PGlite. */
function pgliteRpc(database: PGlite): RpcClient {
  return {
    async rpc(fn, args) {
      if (fn !== 'usage_ledger_check_under_limit' && fn !== 'usage_ledger_commit_usage') {
        return { data: null, error: new Error(`unexpected rpc ${fn}`) };
      }
      try {
        const result = await database.query(`select * from ${fn}($1, $2, $3)`, [args.p_key, args.p_limit, args.p_window]);
        return { data: result.rows, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
}

/** A stub whose commit RPC answers exactly what the test says; check RPCs are answered as "allowed". */
function scriptedCommit(response: RpcResponse): RpcClient {
  return {
    async rpc(fn) {
      if (fn === 'usage_ledger_check_under_limit') return { data: [{ allowed: true, current_count: 0 }], error: null };
      return response;
    },
  };
}

describe('supabaseUsageLedger example adapter (extracted from the SQL comment) — CGK-002', () => {
  it('finds and loads the commented adapter', () => {
    const adapter = loadCommentedAdapter(pgliteRpc(db))('w', 1);
    expect(typeof adapter.checkUnderLimit).toBe('function');
    expect(typeof adapter.commitUsage).toBe('function');
  });

  it('records usage on a real committed:true and returns the result with no commitError', async () => {
    const ledger = loadCommentedAdapter(pgliteRpc(db))('adapter-w1', 2);
    let paidCalls = 0;
    const result = await withReserveConfirm(ledger, 'adapter-ok', 2, async () => {
      paidCalls++;
      return 'paid-result';
    });
    expect(result).toEqual({ allowed: true, result: 'paid-result' });
    expect(Object.hasOwn(result, 'commitError')).toBe(false);
    expect(paidCalls).toBe(1);
    await expect(checkUnderLimit('adapter-ok', 2, 'adapter-w1')).resolves.toEqual({ allowed: true, current_count: 1 });
  });

  it('denies without calling the provider once the limit is reached', async () => {
    const ledger = loadCommentedAdapter(pgliteRpc(db))('adapter-w2', 1);
    await commitUsage('adapter-full', 1, 'adapter-w2');
    let paidCalls = 0;
    const result = await withReserveConfirm(ledger, 'adapter-full', 1, async () => {
      paidCalls++;
      return 'never';
    });
    expect(result).toEqual({ allowed: false });
    expect(paidCalls).toBe(0);
  });

  it('rejects on a real committed:false, so the paid result comes back with commitError (no paid retry)', async () => {
    const ledger = loadCommentedAdapter(pgliteRpc(db))('adapter-w3', 1);
    let paidCalls = 0;
    const result = await withReserveConfirm(ledger, 'adapter-raced', 1, async () => {
      paidCalls++;
      // Another request takes the last slot while this paid call is in flight.
      await commitUsage('adapter-raced', 1, 'adapter-w3');
      return 'paid-result';
    });
    expect(paidCalls).toBe(1);
    expect(result).toMatchObject({ allowed: true, result: 'paid-result' });
    expect(Object.hasOwn(result, 'commitError')).toBe(true);
    const commitError = (result as { commitError?: unknown }).commitError;
    expect(commitError).toBeInstanceOf(Error);
    expect((commitError as Error).message).toMatch(/usage not recorded.*limit reached/);
    expect((commitError as Error).message).not.toContain('adapter-raced'); // no key in the error text
    // The other request's slot is the only one recorded: this call really was not counted.
    await expect(checkUnderLimit('adapter-raced', 1, 'adapter-w3')).resolves.toEqual({ allowed: false, current_count: 1 });
  });

  it.each<[string, RpcResponse]>([
    ['committed:false', { data: [{ committed: false, new_count: 3 }], error: null }],
    ['a null data field', { data: null, error: null }],
    ['an undefined data field', { data: undefined, error: null }],
    ['an empty row list', { data: [], error: null }],
    ['a row without committed', { data: [{ new_count: 1 }], error: null }],
    ['a truthy non-boolean committed', { data: [{ committed: 'true' }], error: null }],
    ['a numeric committed', { data: [{ committed: 1 }], error: null }],
    ['a null row', { data: [null], error: null }],
    ['an object instead of a row list', { data: { committed: true }, error: null }],
  ])('rejects on %s and the paid result is still returned once', async (_label, response) => {
    const ledger = loadCommentedAdapter(scriptedCommit(response))('w', 5);
    let paidCalls = 0;
    const result = await withReserveConfirm(ledger, 'user', 5, async () => {
      paidCalls++;
      return 'paid-result';
    });
    expect(paidCalls).toBe(1);
    expect(result).toMatchObject({ allowed: true, result: 'paid-result' });
    expect(Object.hasOwn(result, 'commitError')).toBe(true);
    expect((result as { commitError?: unknown }).commitError).toBeInstanceOf(Error);
  });

  it('rethrows an RPC error unchanged, so commitError is the very error the client returned', async () => {
    const rpcError = new Error('rpc unavailable');
    const ledger = loadCommentedAdapter(scriptedCommit({ data: null, error: rpcError }))('w', 5);
    const result = await withReserveConfirm(ledger, 'user', 5, async () => 'paid-result');
    expect(result).toMatchObject({ allowed: true, result: 'paid-result' });
    expect((result as { commitError?: unknown }).commitError).toBe(rpcError);
  });

  it('checkUnderLimit fails closed on a malformed response and propagates an RPC error', async () => {
    const malformed = loadCommentedAdapter({ rpc: async () => ({ data: null, error: null }) })('w', 5);
    await expect(malformed.checkUnderLimit('user', 5)).resolves.toBe(false);
    const truthy = loadCommentedAdapter({ rpc: async () => ({ data: [{ allowed: 'yes' }], error: null }) })('w', 5);
    await expect(truthy.checkUnderLimit('user', 5)).resolves.toBe(false);
    const rpcError = new Error('down');
    const failing = loadCommentedAdapter({ rpc: async () => ({ data: null, error: rpcError }) })('w', 5);
    await expect(failing.checkUnderLimit('user', 5)).rejects.toBe(rpcError);
  });
});
