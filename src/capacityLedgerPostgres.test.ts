/**
 * capacityLedgerPostgres.test.ts: applies the Postgres capacity-ledger recipe
 * from README.md, unmodified, to a REAL locally running Postgres and fires many
 * truly concurrent sessions (separate `pg` connections) at it through the
 * README's TypeScript adapter and the real `withCapacityReservations`.
 *
 * SKIPPED BY DEFAULT: it runs only when `COST_GOVERNOR_PG_URL` is set, so
 * `npm test`, `npm run verify` and CI without a database are unaffected. See
 * README.md ("Reference SQL (advisory only)") for how to start a throwaway
 * Postgres 17, then `npm run test:postgres`.
 *
 * What this proves, against one Postgres 17 server with 50 separate sessions:
 * a scope never holds or confirms more than its limit under concurrent reserve;
 * a user cap inside a global cap admits exactly what the tighter cap allows;
 * a request refused on the global scope leaves no hold on the user scope; and
 * 50 racing requests with the SAME operation id produce one hold.
 *
 * What it does NOT prove: Supabase's role setup, PgBouncer or other pooling,
 * failover or a network partition, or anything beyond these scenarios.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import { Client } from 'pg';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCapacityReservations, type CapacityReservationLedger } from './reserveConfirm.js';

const PG_URL = process.env.COST_GOVERNOR_PG_URL;

if (!PG_URL) {
  describe.skip('README capacity ledger under real Postgres concurrency', () => {
    it('is skipped because COST_GOVERNOR_PG_URL is not set', () => {
      // See README.md for how to run this against a throwaway local Postgres 17.
    });
  });
} else {
  const connectionString = PG_URL;
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  const sql = /<!-- capacity-postgres-recipe:start -->\s*```sql\n([\s\S]*?)```\s*<!-- capacity-postgres-recipe:end -->/.exec(readme)?.[1] ?? '';
  const adapter = /```ts\n([\s\S]*?)```/.exec(readme.slice(readme.indexOf('<!-- capacity-postgres-recipe:end -->')))?.[1] ?? '';
  if (!sql || !adapter.includes('postgresCapacityLedger')) throw new Error('README.md is missing the capacity recipe blocks');

  type Query = (text: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  const WORKERS = 50;
  const REPETITIONS = 3;

  function ledgerOver(client: Client): CapacityReservationLedger {
    const js = ts.transpileModule(adapter.replace(/^import .*$/m, ''), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText.replace(/^export /m, '');
    const make = compileFunction(`${js}\nreturn postgresCapacityLedger;`, []) as () => (q: Query) => CapacityReservationLedger;
    return make()((text, params) => client.query(text, params));
  }

  describe('README capacity ledger under real Postgres concurrency', () => {
    let admin: Client;
    let workers: Client[];
    let ledgers: CapacityReservationLedger[];

    beforeAll(async () => {
      admin = new Client({ connectionString });
      await admin.connect();
      await admin.query('drop table if exists public.capacity_holds cascade');
      await admin.query('drop function if exists public.capacity_reserve(text, bigint, text, bigint, integer, text)');
      await admin.query('drop function if exists public.capacity_confirm(text, text, bigint, bigint)');
      await admin.query('drop function if exists public.capacity_release(text, text, bigint)');
      await admin.query(sql);
      workers = await Promise.all(
        Array.from({ length: WORKERS }, async () => {
          const c = new Client({ connectionString });
          await c.connect();
          return c;
        }),
      );
      ledgers = workers.map(ledgerOver);
    }, 120_000);

    afterAll(async () => {
      await Promise.all((workers ?? []).map((c) => c.end()));
      await admin?.end();
    });

    const count = async (where: string, params: unknown[]): Promise<number> =>
      Number(((await admin.query(`select count(*)::int as n from public.capacity_holds where ${where}`, params)).rows[0] as { n: number }).n);
    const sum = async (key: string, state: string): Promise<number> =>
      Number(((await admin.query(
        `select coalesce(sum(case state when 'confirmed' then recorded else amount end), 0)::int as s from public.capacity_holds where scope_key = $1 and state = $2`,
        [key, state],
      )).rows[0] as { s: number }).s);

    it('50 sessions reserving on one scope: exactly limit/amount holds, never more', async () => {
      for (let round = 0; round < REPETITIONS; round++) {
        const key = `pg:single:${round}`;
        const results = await Promise.all(
          ledgers.map((l, i) => l.reserveCapacity({ key, limit: 100, operationId: `op-${i}`, amount: 10 })),
        );
        expect(results.filter((r) => r.status === 'acquired')).toHaveLength(10);
        expect(results.filter((r) => r.status === 'denied')).toHaveLength(40);
        expect(await sum(key, 'held')).toBe(100);
      }
    });

    it('50 sessions racing with the SAME operation id: one hold, the rest in progress', async () => {
      const results = await Promise.all(ledgers.map((l) => l.reserveCapacity({ key: 'pg:same-op', limit: 1_000, operationId: 'one-op', amount: 10 })));
      expect(results.filter((r) => r.status === 'acquired')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'operation_in_progress')).toHaveLength(49);
      expect(await count("scope_key = 'pg:same-op'", [])).toBe(1);
    });

    it('a user cap inside a global cap, one user: exactly the user cap fits, and the global scope records only those', async () => {
      for (let round = 0; round < REPETITIONS; round++) {
        const user = `pg:u:${round}`;
        const global = `pg:g:${round}`;
        const results = await Promise.all(
          ledgers.map((l, i) =>
            withCapacityReservations(
              l,
              { scopes: [{ key: user, limit: 50 }, { key: global, limit: 1_000 }], operationId: `op-${i}`, amount: 10 },
              async () => ({ status: 'succeeded' as const, value: i, settle: { actualAmount: 10 } }),
            ),
          ),
        );
        expect(results.filter((r) => r.status === 'confirmed')).toHaveLength(5);
        expect(results.filter((r) => r.status === 'refused' && r.scopeKey === user)).toHaveLength(45);
        expect(await sum(user, 'confirmed')).toBe(50);
        expect(await sum(global, 'confirmed')).toBe(50);
        expect(await count('scope_key in ($1, $2) and state = $3', [user, global, 'held'])).toBe(0);
      }
    });

    it('many users inside a tight global cap: exactly the global cap fits, and refused requests leave no hold on their user scope', async () => {
      for (let round = 0; round < REPETITIONS; round++) {
        const global = `pg:tight:${round}`;
        const results = await Promise.all(
          ledgers.map((l, i) =>
            withCapacityReservations(
              l,
              { scopes: [{ key: `pg:tight:${round}:user:${i}`, limit: 1_000 }, { key: global, limit: 120 }], operationId: `op-${i}`, amount: 10 },
              async () => ({ status: 'succeeded' as const, value: i, settle: { actualAmount: 10 } }),
            ),
          ),
        );
        expect(results.filter((r) => r.status === 'confirmed')).toHaveLength(12);
        expect(results.filter((r) => r.status === 'refused' && r.scopeKey === global)).toHaveLength(38);
        expect(await sum(global, 'confirmed')).toBe(120);
        expect(await count("scope_key like $1 and state = 'held'", [`pg:tight:${round}:user:%`])).toBe(0);
        expect(await count("scope_key like $1 and state = 'confirmed'", [`pg:tight:${round}:user:%`])).toBe(12);
      }
    });

    it('settling above the estimate is recorded in full and the next reserve sees it', async () => {
      const key = 'pg:over';
      const r = await withCapacityReservations(
        ledgers[0] as CapacityReservationLedger,
        { scopes: [{ key, limit: 100 }], operationId: 'big', amount: 40 },
        async () => ({ status: 'succeeded' as const, value: 1, settle: { actualAmount: 95 } }),
      );
      expect(r).toMatchObject({ status: 'confirmed', overrunAmount: 55 });
      const next = await (ledgers[1] as CapacityReservationLedger).reserveCapacity({ key, limit: 100, operationId: 'next', amount: 10 });
      expect(next.status).toBe('denied');
    });
  });
}
