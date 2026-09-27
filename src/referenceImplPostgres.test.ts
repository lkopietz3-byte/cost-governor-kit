/**
 * referenceImplPostgres.test.ts — applies reference-impl/supabase-usage-ledger.sql
 * to a fresh database on a REAL, locally running Postgres 17 and fires many
 * truly concurrent sessions (separate `pg` connections, not one PGlite
 * process) at `usage_ledger_commit_usage` for the same key.
 *
 * `src/referenceImplPglite.test.ts` proves the grant fix and the
 * check/commit/window logic, but PGlite is a single connection and cannot
 * exercise real concurrent sessions. This file is the only place that does.
 *
 * SKIPPED BY DEFAULT. It only runs when `COST_GOVERNOR_PG_URL` is set, so
 * `npm test`, `npm run verify` and CI are unaffected. See README.md
 * ("Reference SQL (advisory only)") and ENGINEERING.md for how to start a
 * throwaway Postgres and run this file with `npm run test:postgres`.
 *
 * What this proves: against a real multi-connection Postgres 17, with 50
 * separate sessions committing concurrently against one key and a limit of
 * 10, `usage_ledger_commit_usage`'s row lock (`SELECT ... FOR UPDATE` inside
 * the function's own implicit transaction) caps the recorded count at
 * exactly the limit — never over — including when the key has never been
 * committed before (racing the `INSERT ... ON CONFLICT DO NOTHING` path).
 * It also proves `usage_ledger_check_under_limit` (Phase 1) is genuinely
 * advisory: with no commits yet recorded, many concurrent checks against a
 * fresh key can all return `allowed: true` even though far fewer than that
 * many slots exist, matching the SQL file's own documented guarantee that
 * only the commit (Phase 2), not the check (Phase 1), caps the count.
 *
 * What this does NOT prove: behavior on live Supabase (its actual role and
 * default-privilege setup, network latency, connection pooling via
 * PgBouncer), behavior under a network partition or Postgres failover, or
 * anything beyond what these specific scenarios exercise.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PG_URL = process.env.COST_GOVERNOR_PG_URL;

if (!PG_URL) {
  describe.skip('reference-impl/supabase-usage-ledger.sql under real Postgres concurrency', () => {
    it('is skipped because COST_GOVERNOR_PG_URL is not set', () => {
      // See README.md / ENGINEERING.md for how to run this against a
      // throwaway local Postgres 17.
    });
  });
} else {
  const connectionString = PG_URL;
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

  const WORKERS = 50;
  const LIMIT = 10;
  const REPETITIONS = 5;

  async function connect(): Promise<Client> {
    const client = new Client({ connectionString });
    await client.connect();
    return client;
  }

  async function checkUnderLimit(client: Client, key: string, limit: number, windowKey: string) {
    const result = await client.query<CheckRow>(
      'select * from usage_ledger_check_under_limit($1, $2, $3)',
      [key, limit, windowKey],
    );
    const row = result.rows[0];
    if (!row) throw new Error('usage_ledger_check_under_limit returned no row');
    return row;
  }

  async function commitUsage(client: Client, key: string, limit: number, windowKey: string) {
    const result = await client.query<CommitRow>(
      'select * from usage_ledger_commit_usage($1, $2, $3)',
      [key, limit, windowKey],
    );
    const row = result.rows[0];
    if (!row) throw new Error('usage_ledger_commit_usage returned no row');
    return row;
  }

  describe('reference-impl/supabase-usage-ledger.sql under real Postgres concurrency', () => {
    let admin: Client;
    let workers: Client[];

    beforeAll(async () => {
      // Apply the SQL to a FRESH schema: drop anything a previous run left
      // behind (table, functions, the roles the file grants to), then
      // recreate the Supabase roles the SQL assumes exist (as the PGlite
      // test does) and apply the file verbatim.
      admin = await connect();
      await admin.query('drop table if exists usage_ledger cascade;');
      await admin.query(
        'drop function if exists usage_ledger_check_under_limit(text, integer, text);',
      );
      await admin.query('drop function if exists usage_ledger_commit_usage(text, integer, text);');
      await admin.query('drop role if exists service_role;');
      await admin.query('drop role if exists anon;');
      await admin.query('drop role if exists authenticated;');
      await admin.query('create role service_role; create role anon; create role authenticated;');
      // A single simple-query message with multiple ;-separated statements
      // runs as one implicit transaction (node-postgres sends the whole
      // string as one simple query when called with no parameters).
      await admin.query(referenceSql);

      // 50 SEPARATE connections (separate TCP/socket sessions), each set to
      // the role the SQL grants EXECUTE to, matching real usage.
      workers = await Promise.all(
        Array.from({ length: WORKERS }, async () => {
          const client = await connect();
          await client.query('set role service_role;');
          return client;
        }),
      );
    });

    afterAll(async () => {
      await Promise.all(workers.map((client) => client.end()));
      await admin.end();
    });

    it(`caps concurrent commits at the limit across ${REPETITIONS} repetitions`, async () => {
      for (let rep = 0; rep < REPETITIONS; rep++) {
        // A never-committed key each repetition: this also races the
        // INSERT ... ON CONFLICT DO NOTHING path, not just the update path.
        const key = `concurrent-commit-${rep}`;
        const windowKey = 'w1';

        // Fire all WORKERS commits truly concurrently: every client sends
        // its query before any of them awaits a response.
        const results = await Promise.all(
          workers.map((client) => commitUsage(client, key, LIMIT, windowKey)),
        );

        const committed = results.filter((row) => row.committed === true);
        const notCommitted = results.filter((row) => row.committed === false);

        expect(committed).toHaveLength(LIMIT);
        expect(notCommitted).toHaveLength(WORKERS - LIMIT);

        // Every successful commit got a distinct sequential count: the row
        // lock serializes the increments rather than several sessions
        // reading-then-writing the same stale count.
        const committedCounts = committed.map((row) => row.new_count).sort((a, b) => a - b);
        expect(committedCounts).toEqual(Array.from({ length: LIMIT }, (_, i) => i + 1));

        // Nobody ever saw a count above the limit, and nothing was silently
        // recorded past it in the table itself.
        expect(Math.max(...results.map((row) => row.new_count))).toBe(LIMIT);
        const stored = await admin.query<{ count: number }>(
          'select count from usage_ledger where key = $1',
          [key],
        );
        expect(stored.rows[0]?.count).toBe(LIMIT);
      }
    });

    it(`Phase 1 (check) is advisory: many concurrent checks can all pass, while Phase 2 (commit) still caps — across ${REPETITIONS} repetitions`, async () => {
      for (let rep = 0; rep < REPETITIONS; rep++) {
        const key = `advisory-interleave-${rep}`;
        const windowKey = 'w1';

        // All WORKERS callers "arrive" at once and run Phase 1 concurrently,
        // before any of them has committed. Phase 1 only reads, so with a
        // fresh key every single one sees count 0 and passes, even though
        // the limit is far smaller than WORKERS. That is the race the SQL
        // file's header describes: a denial has no side effects, but an
        // allow is not a promise.
        const checks = await Promise.all(
          workers.map((client) => checkUnderLimit(client, key, LIMIT, windowKey)),
        );
        const allowedChecks = checks.filter((row) => row.allowed === true);
        expect(allowedChecks.length).toBe(WORKERS);
        expect(allowedChecks.length).toBeGreaterThan(LIMIT);
        for (const row of checks) {
          expect(row.current_count).toBe(0);
        }

        // Every one of those callers now behaves as if its Phase-1 "allowed"
        // was a guarantee and proceeds to make the (simulated) paid call,
        // then calls Phase 2. Phase 2's row lock is what actually caps the
        // recorded count, independent of how many Phase-1 checks passed.
        const commits = await Promise.all(
          workers.map((client) => commitUsage(client, key, LIMIT, windowKey)),
        );
        const committed = commits.filter((row) => row.committed === true);
        expect(committed).toHaveLength(LIMIT);
        expect(Math.max(...commits.map((row) => row.new_count))).toBe(LIMIT);

        const stored = await admin.query<{ count: number }>(
          'select count from usage_ledger where key = $1',
          [key],
        );
        expect(stored.rows[0]?.count).toBe(LIMIT);
      }
    });
  });
}
