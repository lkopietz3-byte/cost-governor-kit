/**
 * admissionRecipePglite.test.ts: applies the Postgres admission recipe from
 * README.md (the SQL between the `admission-postgres-recipe` markers),
 * unmodified, to a fresh PGlite database, and runs the README's TypeScript
 * store over it through a stub of the Supabase client's `rpc()`, inside the
 * real `admitBeforeCall`.
 *
 * What this proves: the recipe applies to a real (WASM) Postgres, and its
 * logic matches the AdmissionStore contract on one connection: all or nothing
 * across scopes, the limited scope is named, a limit only goes down within a
 * window, malformed input is rejected, the window id comes from the
 * database clock in the canonical format, and an ordinary non-owner role
 * (no BYPASSRLS) given only the documented EXECUTE grant can admit through the
 * SECURITY DEFINER function but cannot read or write the table.
 *
 * What it does NOT prove: PGlite is a single connection, so nothing here
 * shows the cap holds under concurrent sessions or across instances. That
 * needs a real multi-connection test against your own database. It does not
 * run `@supabase/supabase-js` or touch a live Supabase project.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Each test may boot a fresh WASM Postgres; that startup alone can pass the
// 5 s default on a loaded machine. Assertions are unchanged.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { admitBeforeCall, type AdmissionStore } from './admission.js';

const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

function recipeSql(): string {
  const m = /<!-- admission-postgres-recipe:start -->\s*```sql\n([\s\S]*?)```\s*<!-- admission-postgres-recipe:end -->/.exec(readme);
  if (!m?.[1]) throw new Error('README.md has no admission-postgres-recipe SQL block');
  return m[1];
}

/** The ```ts block right after the recipe's end marker: the Supabase store. */
function recipeStoreSource(): string {
  const after = readme.slice(readme.indexOf('<!-- admission-postgres-recipe:end -->'));
  const m = /```ts\n([\s\S]*?)```/.exec(after);
  if (!m?.[1] || !m[1].includes('const store: AdmissionStore')) throw new Error('README.md has no recipe store block');
  return m[1];
}

interface Row {
  status: string;
  scope_key: string | null;
  window_id: string;
}

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(recipeSql());
}, 120_000);

afterAll(async () => {
  await db?.close();
});

async function admitSql(keys: string[], limits: number[], window = 'utc-day'): Promise<Row> {
  const result = await db.query<Row>('select * from public.admit_scopes($1::text[], $2::integer[], $3)', [keys, limits, window]);
  expect(result.rows).toHaveLength(1);
  return result.rows[0] as Row;
}

async function dbDay(): Promise<{ day: string; hour: string }> {
  const r = await db.query<{ day: string; hour: string }>(
    `select to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD') as day,
            to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24') as hour`,
  );
  return r.rows[0] as { day: string; hour: string };
}

describe('README Postgres admission recipe on PGlite (single connection: logic, not concurrency)', () => {
  it('admits while every scope has room, then names the full scope', async () => {
    const { day } = await dbDay();
    expect(await admitSql(['t1:global', 't1:user:a'], [10, 2])).toEqual({ status: 'admitted', scope_key: null, window_id: day });
    expect(await admitSql(['t1:global', 't1:user:a'], [10, 2])).toMatchObject({ status: 'admitted' });
    expect(await admitSql(['t1:global', 't1:user:a'], [10, 2])).toEqual({ status: 'limited', scope_key: 't1:user:a', window_id: day });
  });

  it('a limited attempt counts nothing in the scopes that had room (all or nothing)', async () => {
    await admitSql(['t2:route'], [1]);
    expect(await admitSql(['t2:a', 't2:route', 't2:z'], [5, 1, 5])).toMatchObject({ status: 'limited', scope_key: 't2:route' });
    const used = await db.query<{ scope_key: string; used: number }>(
      "select scope_key, used from public.admission_usage where scope_key like 't2:%' order by scope_key",
    );
    // The rows for t2:a and t2:z exist (the limits are recorded) but nothing was counted in them.
    expect(used.rows).toEqual([
      { scope_key: 't2:a', used: 0 },
      { scope_key: 't2:route', used: 1 },
      { scope_key: 't2:z', used: 0 },
    ]);
  });

  it('limit 0 limits immediately', async () => {
    expect(await admitSql(['t3:global', 't3:banned'], [5, 0])).toMatchObject({ status: 'limited', scope_key: 't3:banned' });
  });

  it('a limit only goes down within a window', async () => {
    expect(await admitTimes(['t4:g'], [5], 2)).toEqual(['admitted', 'admitted']);
    expect((await admitSql(['t4:g'], [2])).status).toBe('limited');
    expect((await admitSql(['t4:g'], [5])).status).toBe('limited');
  });

  it('utc-hour uses YYYY-MM-DDTHH from the database clock, with its own counters', async () => {
    const { hour } = await dbDay();
    const row = await admitSql(['t4:g'], [5], 'utc-hour');
    expect(row).toEqual({ status: 'admitted', scope_key: null, window_id: hour });
  });

  it.each([
    ['no keys', [], []],
    ['mismatched lengths', ['a', 'b'], [1]],
    ['a null key', [null], [1]],
    ['a null limit', ['a'], [null]],
    ['a negative limit', ['a'], [-1]],
    ['duplicate keys', ['a', 'a'], [1, 1]],
  ])('rejects %s', async (_label, keys, limits) => {
    await expect(db.query('select * from public.admit_scopes($1::text[], $2::integer[], $3)', [keys, limits, 'utc-day'])).rejects.toThrow(
      /invalid admission request/,
    );
  });

  it('rejects an unknown window', async () => {
    await expect(db.query("select * from public.admit_scopes(array['a'], array[1], 'utc-week')")).rejects.toThrow(/invalid admission request/);
  });

  it('an ordinary non-owner server role, given only the documented grant, can admit but cannot touch the table', async () => {
    // The documented grant line, with service_role swapped for a test role.
    const grantLine = /^-- (grant execute on function public\.admit_scopes\(text\[\], integer\[\], text\) to) service_role;$/m.exec(recipeSql());
    expect(grantLine).not.toBeNull();
    await db.exec(`
      create role app_server_test login nobypassrls nosuperuser;
      create role app_other_test login nobypassrls nosuperuser;
      ${(grantLine as RegExpExecArray)[1]} app_server_test;
    `);
    const roles = await db.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      "select rolbypassrls, rolsuper from pg_roles where rolname = 'app_server_test'",
    );
    expect(roles.rows).toEqual([{ rolbypassrls: false, rolsuper: false }]);
    try {
      await db.exec('set role app_server_test');
      const { day } = await dbDay();
      expect(await admitSql(['t6:global', 't6:user:a'], [5, 1])).toEqual({ status: 'admitted', scope_key: null, window_id: day });
      expect(await admitSql(['t6:global', 't6:user:a'], [5, 1])).toMatchObject({ status: 'limited', scope_key: 't6:user:a' });
      await expect(db.query('select * from public.admission_usage')).rejects.toThrow(/permission denied/);
      await expect(db.query("insert into public.admission_usage values ('utc-day', 'x', 'k', 0, 99)")).rejects.toThrow(/permission denied/);
      await expect(db.query("update public.admission_usage set used = 0 where scope_key = 't6:user:a'")).rejects.toThrow(/permission denied/);
      await db.exec('reset role');
      await db.exec('set role app_other_test');
      await expect(admitSql(['t6:global'], [5])).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec('reset role');
    }
    // The non-owner's admissions were really counted (by the definer, as the owner).
    const used = await db.query<{ scope_key: string; used: number }>(
      "select scope_key, used from public.admission_usage where scope_key like 't6:%' order by scope_key",
    );
    expect(used.rows).toEqual([
      { scope_key: 't6:global', used: 1 },
      { scope_key: 't6:user:a', used: 1 },
    ]);
  });

  it("the README's TypeScript store, run inside admitBeforeCall, gives the documented outcomes", async () => {
    const js = ts.transpileModule(recipeStoreSource(), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    // A stub of supabase.rpc(name, args).abortSignal(signal) backed by PGlite.
    const supabase = {
      rpc(name: string, args: { p_keys: string[]; p_limits: number[]; p_window: string }) {
        expect(name).toBe('admit_scopes');
        return {
          abortSignal: async () => {
            try {
              const r = await db.query<Row>('select * from public.admit_scopes($1::text[], $2::integer[], $3)', [
                args.p_keys,
                args.p_limits,
                args.p_window,
              ]);
              return { data: r.rows, error: null };
            } catch (error) {
              return { data: null, error };
            }
          },
        };
      },
    };
    const make = compileFunction(`${js}\nreturn store;`, ['supabase']) as (s: typeof supabase) => AdmissionStore;
    const store = make(supabase);
    const { day } = await dbDay();
    const scopes = [
      { key: 't5:global', limit: 3 },
      { key: 't5:user:a', limit: 1 },
    ];
    expect(await admitBeforeCall(store, { scopes })).toEqual({ status: 'admitted', windowId: day });
    expect(await admitBeforeCall(store, { scopes })).toEqual({ status: 'limited', scopeKey: 't5:user:a', windowId: day });
    expect(await admitBeforeCall(store, { scopes: [{ key: 't5:global', limit: 3 }, { key: 't5:user:b', limit: 1 }] })).toEqual({
      status: 'admitted',
      windowId: day,
    });
    expect(await admitBeforeCall(store, { scopes: [{ key: 't5:global', limit: 3 }], window: 'utc-hour' })).toMatchObject({
      status: 'admitted',
    });
    // global day count is now 2 of 3; one more user fits, then global is full.
    expect((await admitBeforeCall(store, { scopes: [{ key: 't5:global', limit: 3 }, { key: 't5:user:c', limit: 1 }] })).status).toBe('admitted');
    expect(await admitBeforeCall(store, { scopes: [{ key: 't5:global', limit: 3 }, { key: 't5:user:d', limit: 1 }] })).toEqual({
      status: 'limited',
      scopeKey: 't5:global',
      windowId: day,
    });
  });
});

async function admitTimes(keys: string[], limits: number[], n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push((await admitSql(keys, limits)).status);
  return out;
}
