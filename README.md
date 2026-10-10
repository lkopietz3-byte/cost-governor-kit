# cost-governor-kit

**[Try it in your browser →](https://lkopietz3-byte.github.io/honesty-kits/#cost-governor-kit)** · Part of [honesty kits](https://github.com/lkopietz3-byte/honesty-kits), a family of small checks for the claims an AI product makes.

A small, zero-dependency TypeScript library for four cost-safety jobs in apps
that call paid AI APIs:

1. **Pricing math** (`estimateCostUsd`): token counts plus rates you supply in,
   dollars out, with cache reads, 5-minute cache writes and 1-hour cache writes
   priced as separate line items.
2. **A pre-call dollar ceiling** (`checkPreCallCeiling`): decide *before* a call
   whether spend so far plus the next call's estimated cost stays within a hard
   cap. Rates are always passed in; the library has no price table.
3. **Usage counting around a paid call** (`withReserveConfirm`,
   `withCapacityReservation`): an advisory check-then-commit helper that never
   counts a call that throws, and a reserve/confirm/release orchestrator for a
   strict limit that is enforced by a storage adapter you write.
4. **Admission control** (`admitBeforeCall`): count one attempt against several
   caps at once (global, per user, per route) before the paid call, all or
   nothing, failing closed and never refunding. The atomic increment lives in a
   store you write; the README has Postgres, D1 and Redis recipes. See
   [Admission control](#admission-control-the-pattern-most-apps-need).

The patterns come from fixes in the author's own apps; the doc comment at the
top of each `src/*.ts` file names the incident.

**Don't use it for:**

- Abuse or DDoS rate limiting. This is about your own spend and your users'
  quotas, not hostile traffic.
- A price source. It ships no prices; you must supply current ones.
- A strict concurrent limit out of the box. `withCapacityReservation` and
  `admitBeforeCall` are only as strict as the adapter or store you implement.
  This kit ships no production store; its in-memory admission store is for
  unit tests and does not hold across instances.
- Exact billing reconciliation. Estimates are rounded to the micro-dollar and
  some model-specific cache rates are not modeled (see [Honest limits](#honest-limits)).

## Install

```bash
npm install cost-governor-kit
```

Or build from source: clone the repository, then run `npm ci` and
`npm run build`. No runtime dependencies. MIT licensed.

It is an ESM package (`"type": "module"`). `import` is the supported way to
load it. `require()` also works where Node can `require(esm)`:

| How you load it | Node 20.19+ | Node 22.12+ | Node 24 and 26 | Older Node 20 or 22 |
| --- | --- | --- | --- | --- |
| `import { estimateCostUsd } from 'cost-governor-kit'` | works | works | works | works |
| `require('cost-governor-kit')` | works | works | works | fails (no `require(esm)`); use `import()` |

ESM package; `require()` works on Node >=20.19 / >=22.12. Recommended runtimes
are Node 22 and 24 (LTS) and Node 26 (current). Node 20 is end-of-life. CI
still runs the tests and the installed-package checks on Node 20.19.0 and
22.12.0 (the `require(esm)` floors) to catch regressions, but that is
compatibility testing, not a recommendation. `engines` in `package.json` is
`>=20`. TypeScript resolves the root and all four subpaths under `node10`,
`node16`/`nodenext` and `bundler` resolution (checked by `attw` in CI).

## Visual example: Threshold

The repository includes a visual example in
[`examples/observatory`](examples/observatory/README.md). Run bounded synthetic
requests through the actual SDK, inspect the cost/capacity decisions, and replay
the recorded journal for a walkthrough. It uses an educational memory adapter;
production enforcement and provider billing are separate concerns.

```sh
node examples/observatory/tools/serve.mjs
# Open http://127.0.0.1:4320
```

Prepared browser modules are pinned to the source manifest. After changing SDK
source, run `node examples/observatory/tools/vendor-sdk.mjs` before verification.
`npm run verify:observatory` runs the example's source-correspondence and
behavioral checks; CI runs it as its own step, and it is not part of the
package release gate (`npm run verify`). The example adds no runtime dependency and is outside the npm files
allowlist. Full local setup and rendered-verification instructions are in its
README.

## Quickstart

```js
import { estimateCostUsd, formatRatesForLog, getRatesOrThrow, checkPreCallCeiling } from 'cost-governor-kit';

// Your own table. These numbers are illustrative; use current published prices.
const pricing = { 'my-model': { inputPerMillion: 3, outputPerMillion: 15 } };
const rates = getRatesOrThrow(pricing, 'my-model');
console.log(`rates: ${formatRatesForLog(rates)} <- VERIFY against current pricing`);

console.log(estimateCostUsd(rates, {
  inputTokens: 1_200,
  outputTokens: 400,
  cacheReadTokens: 8_000,        // 0.1x the input rate
  cacheCreation5mTokens: 2_000,  // 1.25x the input rate
  cacheCreation1hTokens: 0,      // 2x the input rate, kept separate from 5m writes
}));
// 0.0195

const check = checkPreCallCeiling({
  spentSoFarUsd: 24.99,
  ceilingUsd: 25,
  estimatedNextCallUsage: { inputTokens: 2_000, outputTokens: 500 },
  rates,
});
console.log(check.allowed, check.projectedTotalUsd);
// false 25.0035
console.log(check.reason);
// Projected total spend $25.003500 (already spent $24.990000 + projected next call $0.013500)
// would exceed the ceiling of $25.000000. Refusing to make the call.
```

This exact script was run against the installed package; the comments show its
output. The hand calculation for `0.0195`: 1,200 x 3 + 8,000 x 3 x 0.1 +
2,000 x 3 x 1.25 + 400 x 15 = 19,500, divided by 1,000,000.

**Input rules.** Every record you pass must be a plain object or a
null-prototype object: `rates`, `usage`, the `checkPreCallCeiling` argument and
its two nested records, a pricing table, and a `withCapacityReservation`
request. A `Map`, `Set`, `Date`, `RegExp`, array or class instance throws a
`TypeError` instead of being priced as zero usage or read as an empty table. A
record made in another realm (`node:vm`) counts as plain. Each field is read
once and the code validates and computes from that copy, so a getter or proxy
that answers differently the second time cannot change a result. Error text
built from your strings (a model name, an unknown usage key, a decision
status) has control, line-break and bidi characters escaped.

Every export above is also available from its own subpath (`cost-governor-kit/pricing`,
`cost-governor-kit/preCallCeiling`, `cost-governor-kit/reserveConfirm`,
`cost-governor-kit/admission`), importing the same module either way. Use a subpath if you only want one job's code in your
bundle; the root import above is the simplest default and, unlike the
subpaths, resolves under TypeScript's legacy `node10`/`node` module
resolution too.

---

## Admission control (the pattern most apps need)

Most AI features need one guard before every paid call: count this attempt
against a few caps at once (all users today, this user today, maybe this route
this hour) and refuse the call if any cap is full. Getting it right takes four
properties, and missing any one of them leaks money:

- **Atomic and multi-scope.** Every cap is checked and incremented in one step,
  all or nothing. A "count the rows, then insert one" check lets concurrent
  requests all pass the count, and a limited attempt must not use up the
  allowance of the caps that still had room.
- **The store owns the clock.** The UTC day or hour is decided by the database,
  after it takes its lock, never by an app server whose clock may be off.
- **Fail closed.** If the count cannot be confirmed (the database is down,
  slow, or answers something odd), the call does not happen.
- **Never refunded.** The admission counts the attempt. A provider call that
  fails or times out may still be billed, so its slot stays spent, and an
  admission is never retried (a retry after a lost reply could count twice).

`admitBeforeCall` encodes the contract and the fail-closed handling. The atomic
increment itself lives in a store you write; the recipes below are starting
points.

```ts
import { admitBeforeCall, admissionHttpStatus, type AdmissionStore } from 'cost-governor-kit/admission';

declare const store: AdmissionStore; // your database-backed store (recipes below)

// Inside your request handler (the `return`s below belong to it):
const outcome = await admitBeforeCall(store, {
  scopes: [
    { key: 'explain:global', limit: 2_000 },
    { key: `explain:user:${userId}`, limit: 20 },
  ],
  window: 'utc-day', // the default; 'utc-hour' is the other choice
});
const status = admissionHttpStatus(outcome, { perUserScopePrefixes: ['explain:user:'] });
if (status !== null) return new Response('Please try again later.', { status });
// Admitted. Make the paid call ONCE, with the SDK's automatic retries off
// (for example maxRetries: 0), so one admission pays for one provider attempt.
```

**Outcomes.** `admitBeforeCall` never throws and never rejects. It resolves to
one of:

| Outcome | Meaning | `admissionHttpStatus` |
| --- | --- | --- |
| `{ status: 'admitted', windowId }` | every scope had room and was counted | `null` (proceed) only when `windowId` is a real UTC day or hour and there is no `scopeKey`; otherwise `503` |
| `{ status: 'limited', scopeKey, windowId }` on a per-user scope | that caller used their allowance | `429` |
| `{ status: 'limited', scopeKey, windowId }` on any other scope | shared capacity is used up, not the caller's fault | `503` |
| `{ status: 'unavailable', reason, cause? }` | the cap could not be confirmed | `503` |

A scope is per-user when its key starts with one of `perUserScopePrefixes`; end
each prefix with a delimiter (`'explain:user:'`, not `'explain:user'`). Anything
that is not a valid outcome maps to `503`. Malformed options throw, because they
are static configuration.

**What fails closed.** Every one of these is `unavailable`, and only an
`admitted` outcome allows the call:

- `reason: 'invalid_request'`: no scopes, a blank or non-string key (blank
  includes only whitespace or invisible characters), duplicate keys, a limit
  that is not a safe integer >= 0, an unknown window, a bad `timeoutMs`, or a
  store without an `admit` function. `cause` is a `TypeError` or `RangeError`
  naming the problem. These are programmer errors, but they are returned rather
  than thrown, so a route handler's generic `catch` cannot turn one into an
  unguarded paid call. Log `cause` and your tests will find them.
- `reason: 'store_error'`: the store threw or rejected (`cause` is what it threw).
- `reason: 'timeout'`: no answer within `timeoutMs` (default 5,000 ms),
  measured from just before the store is called. A store that blocks the event
  loop and answers late is also a timeout, even if it said `admitted`: the late
  admission is discarded, fail closed. The store may still have counted it;
  admission is never refunded, so that errs toward over-counting.
- `reason: 'malformed_reply'`: anything but `{ status: 'admitted', windowId }`
  or `{ status: 'limited', scopeKey, windowId }`, where `windowId` is a real UTC
  `YYYY-MM-DD` (day) or `YYYY-MM-DDTHH` (hour) matching the requested window,
  `scopeKey` is one of the requested keys, and an `admitted` reply is impossible
  if any requested limit is 0 (a store that admits past a zero limit is not
  enforcing limits).

The request is read once and validated (the scopes array's `length` once, then
each element once by index), and the store gets a frozen copy, so
neither side can change what the reply is checked against. The store is called
exactly once; `admitBeforeCall` never retries. **Admission is not refunded on
failure, by design.**

**The store contract** (`AdmissionStore.admit({ scopes, window })`): atomically,
resolve the current window from the store's own clock after taking the lock; if
`used < limit` for every scope in that window, increment all of them and answer
`admitted`; otherwise change nothing and answer `limited` with the key of a full
scope. The store may apply a lower limit than the request's (a policy row in the
database, or the lowest limit seen this window, so a limit can only go down
within a window), never a higher one. Throw when the outcome is unknown.

**`createInMemoryAdmissionStore({ now? })` is for unit tests only, not for
production.** It is atomic within one JavaScript process (50 concurrent admits
at limit 10 admit exactly 10 in the tests), and it follows the contract above,
including "a limit only goes down within a window" and "a window never moves
backwards when the clock steps back". But its counts live in one process's
memory: **it does not hold a cap across serverless instances, processes or
restarts.** Inject `now` to test window rollover.

### Store recipes (yours to own and test)

These are documentation, not code this package runs or verifies against your
database. Each one is a starting point that your app owns, reviews and tests.
**Proving that a cap holds across instances needs a real multi-instance test
against your real store** (many concurrent clients, separate connections, one
key, and an assertion that exactly `limit` were admitted). This kit does not do
that for you.

**Postgres (Supabase or any Postgres 13+).** One function: take a transaction
advisory lock, then read the clock, then create or lower each scope's row, then
in one block increment each scope only while `used < lim`. If any scope is
full, an exception rolls that block back, so nothing is counted.

<!-- admission-postgres-recipe:start -->
```sql
-- Admission counters. The database owns the clock; no app timestamps.
-- Run this as the role that should OWN the table and the function (on
-- Supabase, the migration role `postgres`). The server role never touches the
-- table directly: it only executes admit_scopes, which runs as the owner.
create table public.admission_usage (
  window_kind text not null check (window_kind in ('utc-day', 'utc-hour')),
  window_id   text not null,
  scope_key   text not null,
  used        integer not null default 0 check (used >= 0),
  lim         integer not null check (lim >= 0),
  primary key (window_kind, window_id, scope_key)
);
-- RLS on with no policies: no non-owner role can read or write rows directly.
-- The owner is exempt (RLS is not FORCEd), which is how the function writes.
alter table public.admission_usage enable row level security;
revoke all on table public.admission_usage from public;

create function public.admit_scopes(p_keys text[], p_limits integer[], p_window text)
returns table (status text, scope_key text, window_id text)
language plpgsql
-- Runs as the owner, so the caller needs EXECUTE only: no table grants, no
-- RLS policies, no BYPASSRLS. The search_path is pinned empty and every table
-- reference is schema-qualified, so a caller cannot redirect it.
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_window text;
  v_key text;
  v_limit integer;
  v_used integer;
  v_limited text;
begin
  if p_window is null or p_window not in ('utc-day', 'utc-hour')
     or p_keys is null or p_limits is null
     or cardinality(p_keys) = 0 or cardinality(p_keys) <> cardinality(p_limits)
     or array_position(p_keys, null) is not null
     or array_position(p_limits, null) is not null
     or exists (select 1 from unnest(p_limits) as l(v) where l.v < 0)
     or (select count(distinct k.v) from unnest(p_keys) as k(v)) <> cardinality(p_keys) then
    raise exception 'invalid admission request' using errcode = '22023';
  end if;

  -- Serialize admissions, THEN read the clock, so a request that waited past
  -- midnight counts in the new day. clock_timestamp(), not now(): now() is
  -- frozen at transaction start, which is before the wait.
  perform pg_advisory_xact_lock(hashtextextended('admission_usage', 0));
  v_window := to_char(clock_timestamp() at time zone 'utc',
                      case p_window when 'utc-day' then 'YYYY-MM-DD' else 'YYYY-MM-DD"T"HH24' end);

  -- Create each row, or lower its limit: a limit only goes down within a
  -- window. This runs outside the rollback block below, so a lowered limit
  -- sticks even when this attempt is limited. It never touches `used`.
  for v_key, v_limit in
    select u.k, u.l from unnest(p_keys, p_limits) as u(k, l) order by u.k
  loop
    insert into public.admission_usage as a (window_kind, window_id, scope_key, used, lim)
      values (p_window, v_window, v_key, 0, v_limit)
      on conflict (window_kind, window_id, scope_key)
      do update set lim = least(a.lim, excluded.lim);
  end loop;

  begin
    for v_key in
      select u.k from unnest(p_keys) as u(k) order by u.k
    loop
      update public.admission_usage as a
        set used = a.used + 1
        where a.window_kind = p_window and a.window_id = v_window
          and a.scope_key = v_key and a.used < a.lim
        returning a.used into v_used;
      if v_used is null then
        v_limited := v_key;
        raise exception 'admission limited' using errcode = 'CGL01';
      end if;
      v_used := null;
    end loop;
  exception when sqlstate 'CGL01' then
    -- Everything this block wrote is rolled back: all or nothing.
    return query select 'limited'::text, v_limited, v_window;
    return;
  end;
  return query select 'admitted'::text, null::text, v_window;
end;
$$;
revoke all on function public.admit_scopes(text[], integer[], text) from public;
-- Supabase's default privileges grant new tables and functions in `public` to
-- anon and authenticated, which `revoke ... from public` does not remove.
do $$
begin
  if exists (select from pg_roles where rolname = 'anon') then
    revoke all on table public.admission_usage from anon;
    revoke all on function public.admit_scopes(text[], integer[], text) from anon;
  end if;
  if exists (select from pg_roles where rolname = 'authenticated') then
    revoke all on table public.admission_usage from authenticated;
    revoke all on function public.admit_scopes(text[], integer[], text) from authenticated;
  end if;
end;
$$;
-- Then grant EXECUTE to the one role your server uses, and nothing else.
-- On Supabase that is service_role:
-- grant execute on function public.admit_scopes(text[], integer[], text) to service_role;
-- A missing grant shows up as store_error, so every call is refused (closed, but an outage).
```
<!-- admission-postgres-recipe:end -->

```ts
// A store over the function above, using a Supabase client created with the
// service-role key on the server. admitBeforeCall validates whatever comes back.
const store: AdmissionStore = {
  async admit({ scopes, window }) {
    const { data, error } = await supabase
      .rpc('admit_scopes', {
        p_keys: scopes.map((s) => s.key),
        p_limits: scopes.map((s) => s.limit),
        p_window: window,
      })
      .abortSignal(AbortSignal.timeout(3_000)); // shorter than admitBeforeCall's timeoutMs
    if (error) throw error; // no retry: the write may have committed
    const row = Array.isArray(data) && data.length === 1 ? data[0] : undefined;
    if (!row) throw new Error('admit_scopes returned no row');
    return row.status === 'limited'
      ? { status: 'limited', scopeKey: row.scope_key, windowId: row.window_id }
      : { status: row.status, windowId: row.window_id };
  },
};
```

**Who owns what.** The migration role owns both the table and the function.
Because the function is `security definer`, it runs with the owner's rights,
so the server role needs only `EXECUTE` on the function: no table privileges,
no RLS policies and no `BYPASSRLS`. Any other role (including Supabase's
`anon` and `authenticated`) can neither call the function nor touch the table.
Keep the function owned by a role that is not a superuser if you can; on
Supabase it is `postgres`, as with any migration.

The advisory lock serializes every admission in the database, which is simple
and fine at the volumes these caps exist for. If you outgrow it, drop the lock
and rely on the row locks the `update ... where used < lim` takes (the keys are
locked in sorted order, so two requests cannot deadlock), at the cost of
resolving the window before a possible wait. `src/admissionRecipePglite.test.ts`
applies this exact SQL, read from this README, to PGlite and runs it through
`admitBeforeCall`: all-or-nothing, the limited scope, limit lowering, input
rejection and the window format are checked. It also creates an ordinary
login role that owns nothing and has no `BYPASSRLS`, applies the documented
`grant execute` line to it, and checks that the role can admit through the
function but cannot read or write the table, and that a role without the
grant cannot call the function. **PGlite is a single connection,
so that test proves the logic, not concurrency.** A one-off run while writing
this recipe (2026-10-10, a local Postgres 17.11, 50 separate connections firing
at once, 5 rounds) admitted exactly 10 of 50 on one key at limit 10, and exactly
12 of 50 with a global limit of 12 plus ten users at 2 each, with no user above
2 and no user counted without the global. That run is not a committed test, and
it says nothing about PgBouncer, Supabase's role setup or failover. Run your own.

**Cloudflare D1.** D1 has no stored procedures, so the all-or-nothing step is a
`db.batch()`. Cloudflare's D1 documentation (read 2026-10-10,
[D1 Database API, `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/))
says batched statements are SQL transactions, and that if a statement in the
sequence fails, it "aborts or rolls back the entire sequence". That rollback
claim is **Reported** (from Cloudflare's docs; not tested here against D1).

The catch: a conditional `UPDATE ... WHERE used < lim` that matches zero rows is
not a failure, so a batch of them would still count the scopes that had room.
Make a full scope *fail* instead, with a `CHECK` constraint, so the batch rolls
back:

```sql
create table admission_usage (
  window_kind text not null,
  window_id   text not null,
  scope_key   text not null,
  used        integer not null,
  lim         integer not null,
  constraint admission_within_limit check (used <= lim),
  primary key (window_kind, window_id, scope_key)
);
```

```ts
// One upsert per scope, in one batch. strftime(..., 'now') is the database's UTC clock.
const ADMIT_SQL = `insert into admission_usage (window_kind, window_id, scope_key, used, lim)
  values (?1, strftime(?2, 'now'), ?3, 1, ?4)
  on conflict (window_kind, window_id, scope_key)
  do update set used = used + 1, lim = min(lim, excluded.lim)
  returning window_id`;

const d1Store = (db: D1Database): AdmissionStore => ({
  async admit({ scopes, window }) {
    const format = window === 'utc-day' ? '%Y-%m-%d' : '%Y-%m-%dT%H';
    const stmt = db.prepare(ADMIT_SQL);
    try {
      const results = await db.batch<{ window_id: string }>(
        scopes.map((s) => stmt.bind(window, format, s.key, s.limit)),
      );
      return { status: 'admitted', windowId: results[0]!.results[0]!.window_id };
    } catch (error) {
      if (!/CHECK constraint failed: admission_within_limit/.test(String(error))) throw error;
      // The batch rolled back. Find a full scope to report (a read, for the
      // message only). Compare against the REQUESTED limit too: a lowered limit
      // fails the CHECK but was rolled back, so the stored lim is still higher.
      const full = await db
        .prepare(`select a.scope_key, a.window_id from admission_usage a
                  join json_each(?3) j on a.scope_key = json_extract(j.value, '$.key')
                  where a.window_kind = ?1 and a.window_id = strftime(?2, 'now')
                    and a.used >= min(a.lim, json_extract(j.value, '$.limit'))
                  order by j.key limit 1`)
        .bind(window, format, JSON.stringify(scopes))
        .first<{ scope_key: string; window_id: string }>();
      const zero = scopes.find((s) => s.limit === 0);
      if (full) return { status: 'limited', scopeKey: full.scope_key, windowId: full.window_id };
      if (zero) {
        const now = await db.prepare(`select strftime(?1, 'now') as w`).bind(format).first<{ w: string }>();
        return { status: 'limited', scopeKey: zero.key, windowId: now!.w };
      }
      throw error; // could not tell which scope; fail closed (unavailable)
    }
  },
});
```

That SQL (table, upsert, `CHECK`, rollback and the limited-scope read) was run against a local SQLite
inside an explicit transaction while writing this recipe; it was **not** run on
D1 or Miniflare, and the exact text of D1's constraint error is **Unknown** (the
adapter matches SQLite's message). In this recipe a lowered limit is saved only
when the batch commits; a limited batch rolls it back, though the request's own
limit is still enforced. Each statement reads `'now'` itself, so a
batch that straddles midnight can count its scopes in two different days; each
scope's limit still holds within its own day.

**Redis or Upstash.** One `EVAL`: Redis runs a script atomically ("Redis
guarantees the script's atomic execution", per the
[Redis scripting docs](https://redis.io/docs/latest/develop/programmability/eval-intro/),
read 2026-10-10; **Reported**). The script below checks every key first and
writes only if all have room, so nothing is half-written. Each scope is a hash
holding its window number and count, and the window comes from Redis's own
`TIME`:

```lua
-- KEYS: one key per scope. ARGV[1]: window length in seconds (86400 or 3600).
-- ARGV[2..]: each key's limit, in the same order. Returns {admitted 1/0, window number, full key index}.
local size = tonumber(ARGV[1])
local w = math.floor(tonumber(redis.call('TIME')[1]) / size)
local stored = {}
for i, key in ipairs(KEYS) do
  local h = redis.call('HMGET', key, 'w', 'used')
  stored[i] = { tonumber(h[1]), tonumber(h[2]) or 0 }
  if stored[i][1] and stored[i][1] > w then w = stored[i][1] end -- never move a window backwards
end
for i = 1, #KEYS do
  local used = 0
  if stored[i][1] == w then used = stored[i][2] end
  if used >= tonumber(ARGV[i + 1]) then return { 0, w, i } end
end
for i, key in ipairs(KEYS) do
  if stored[i][1] == w then
    redis.call('HINCRBY', key, 'used', 1)
  else
    redis.call('HSET', key, 'w', w, 'used', 1)
  end
  redis.call('EXPIRE', key, size * 2)
end
return { 1, w, 0 }
```

The adapter passes the scope keys as `KEYS` (prefixed with the window kind,
because a key shared by `utc-day` and `utc-hour` would mix day and hour window
numbers and lock itself out; and in Redis Cluster
sharing one hash tag such as `{admission}:` so they live in one slot), the
window length and limits as `ARGV`, and turns the window number into an id with
`new Date(w * size * 1000).toISOString().slice(0, window === 'utc-day' ? 10 : 13)`.
That conversion is arithmetic on the number Redis chose, so the clock is still
the store's. `TIME` inside a script needs effects replication, the only mode
since Redis 7 (on Redis 5 and 6, call `redis.replicate_commands()` first).
Whether Upstash allows `TIME` inside `EVAL` is **Unknown**: Upstash documents
both `EVAL` and `TIME`, but not the combination. Test
`EVAL "return redis.call('TIME')" 0` against your database first. This script
was **not run** while writing this recipe.

---

## 1. Pricing (`cost-governor-kit/pricing`)

### `estimateCostUsd(rates, usage): number`

Returns the USD cost of one call, actual or projected:

```
(input x inRate + cacheRead x readRate + write5m x inRate x 1.25
 + write1h x inRate x 2 + output x outRate) / 1,000,000
```

computed in that order in double precision, then rounded to the nearest
micro-dollar ($0.000001). `readRate` is `rates.cacheReadPerMillion` when you
supply it, otherwise `inRate x 0.1`.

> **Warning: an omitted bucket is priced at $0.** Every bucket defaults to 0.
> For a pre-call estimate, always pass `outputTokens`, set to the request's
> `max_tokens` bound (the most the call can bill). Leave it out and the output
> side of the estimate is $0, so `checkPreCallCeiling` allows calls it should
> refuse.
>
> **Warning: a call under half a micro-dollar prices at $0.** Each call is
> rounded on its own, so a tiny call is free and a running total built by adding
> per-call estimates never grows from those calls. Do not feed an accumulator
> from per-call estimates. Instead, reconcile `spentSoFarUsd` from the provider's
> reported usage after each call, or sum the token counts across calls and price
> the sum once with `estimateCostUsd`.

- `rates` (`ModelRates`): `{ inputPerMillion, outputPerMillion }`, USD per
  million tokens, each a finite number >= 0, no default; plus an optional
  `cacheReadPerMillion` (also USD per million, >= 0) that overrides the fixed
  0.1x cache-read ratio — see below.
- `usage` (`UsageTokens`): `inputTokens`, `outputTokens`, `cacheReadTokens`,
  `cacheCreation5mTokens`, `cacheCreation1hTokens`. Each is optional and
  defaults to 0 when omitted or `undefined`; a supplied value must be a
  non-negative safe integer.
- Throws for `rates` or `usage` that is not a plain object (`null`, an array,
  a `Map`, `Set`, `Date`, `RegExp` or class instance), invalid rates, an invalid
  count (`null`, fractional, negative, NaN, Infinity, beyond
  `Number.MAX_SAFE_INTEGER`), **any unknown key**, or a non-finite result.
  Messages name the field but not the rejected value (an unknown key is echoed,
  escaped; a symbol key is reported as "an unknown symbol-keyed field" without
  its description).

Unknown keys throw so that a provider payload passed as-is is not priced at $0.
"Unknown" means any own key that is not one of the five bucket names: string or
symbol, enumerable or not. A known bucket is read and validated whether or not
it is enumerable, so `Object.defineProperty(usage, 'inputTokens', { value: 5,
enumerable: false })` prices 5 input tokens.
Map an Anthropic `usage` block like this (`input_tokens` is the uncached
remainder; `cache_creation_input_tokens` is the total of the two TTL buckets, so
don't add it separately when the split is present):

```js
const u = response.usage;
const writes = u.cache_creation; // the per-TTL split; some responses omit it
const cost = estimateCostUsd(rates, {
  inputTokens: u.input_tokens,
  outputTokens: u.output_tokens,
  cacheReadTokens: u.cache_read_input_tokens ?? 0,
  // With no split, the whole cache_creation_input_tokens total is priced as
  // 5-minute writes (the default TTL). Dropping it would price writes at $0.
  cacheCreation5mTokens: writes ? (writes.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0),
  cacheCreation1hTokens: writes?.ephemeral_1h_input_tokens ?? 0,
});
```

`test/verdict-table.test.ts` runs this exact snippet, read from this file.

**Rounding policy.** `Math.round` to the nearest micro-dollar. A value exactly
halfway in binary rounds up, but a decimal half can round down because the
arithmetic is binary floating point (50 tokens at $0.29/M is exactly 14.5
micro-dollars on paper, and returns `0.000014`). A call cheaper than $0.0000005
returns `0`. The result is always the double nearest a whole number of
micro-dollars, so `estimateCostUsd(...) === 0.0195` style comparisons are exact.

**Why the buckets stay separate.** A cost tracker in the author's own apps once
applied the 5-minute write multiplier (1.25x) to 1-hour writes too. 1-hour
writes cost 2x, so that under-reported them by (2.0 - 1.25) / 2.0 = 37.5%.
`src/pricing.test.ts` computes both numbers.

### Multiplier constants

`CACHE_READ_MULTIPLIER = 0.1`, `CACHE_CREATION_5M_MULTIPLIER = 1.25`,
`CACHE_CREATION_1H_MULTIPLIER = 2`. The write multipliers match Anthropic's
pricing page for all listed models (checked 2026-09-24). The 0.1x read
multiplier is Anthropic's standard rate but **not universal**: the same page
lists 0.025x for Claude Fable 5.1 and Claude Mythos 5.1 and 0.05x for Claude
Opus 5.5. For those models, set `ModelRates.cacheReadPerMillion` to the real
per-million cache-read price and it replaces the 0.1x ratio entirely for that
call, for example `{ inputPerMillion: 10, outputPerMillion: 50, cacheReadPerMillion: 0.25 }`
(illustrative numbers) for a 0.025x-cache-read model at a $10/M input rate. If
you would rather not add the field, the older workaround still works: price
the cache reads in a separate call with the input rate scaled by (model
multiplier / 0.1), for example
`estimateCostUsd({ inputPerMillion: base * 0.25, outputPerMillion: 0 }, { cacheReadTokens })`
for 0.025x, and add it to the cost of the other buckets.

Batch discounts, US-only inference surcharges and fast-mode prices are not
modeled separately. Anthropic applies the cache multipliers on top of those, so
fold them into the two rates you pass.

### `estimateCostMicros(rates, usage): number`

The same validation, buckets and formula as `estimateCostUsd`, returned in whole
micro-dollars (1 = $0.000001) and **rounded up**, for budgets and reservations
that count integers. A call that costs a fraction of a micro-dollar counts as 1,
never 0, so a running total of these values never under-counts. A sum within
floating-point noise of a whole number (relative 1e-12, at most 0.000001 of a
micro-dollar) is taken as that number, so `8,000 x 3 x 0.1` (which is
`2400.0000000000005` in binary) does not add a micro-dollar: the quickstart
call is exactly `19500`. A positive cost never snaps to 0; it is at least 1. Because it rounds up, it
can be one more than `estimateCostUsd(...) * 1e6`.

### Provider usage mappers: `usageFromAnthropic(usage)`, `usageFromOpenAI(usage)`

Pure functions from a provider's `usage` JSON to `UsageTokens`, as strict as
`estimateCostUsd`: **any key they do not know throws**, so a new provider field
is never priced at $0.

- `usageFromAnthropic` requires `input_tokens` and `output_tokens` (merge a
  streaming `message_delta` usage with the `message_start` one first). With the
  `cache_creation` split it fills the 5-minute and 1-hour buckets, and a
  `cache_creation_input_tokens` total that disagrees with the split throws.
  **Without the split, the whole `cache_creation_input_tokens` total is priced
  as 5-minute writes**, never dropped. Documented nullable fields may be `null`.
  `service_tier` is accepted and ignored (fold the tier's price into your
  rates); `server_tool_use` is accepted only when its counts are 0, because
  per-request tool fees are not priced here.
- `usageFromOpenAI` accepts the Chat Completions shape (`prompt_tokens`, ...) or
  the Responses shape (`input_tokens`, ...), not a mix. Cached tokens become
  `cacheReadTokens` and are subtracted from the prompt total. Nonzero audio
  tokens throw (they are billed at other rates); `total_tokens`, when present,
  must add up. **Set `cacheReadPerMillion` for OpenAI models**: their cached-input
  discount is not the 0.1x default for every model.

```js
const cost = estimateCostUsd(rates, usageFromAnthropic(response.usage));
```

The test fixtures for both were written by hand from the providers' documented
shapes, not captured from live responses.

### Dated price tables: `definePricingTable`, `assertPricingFresh`, `lookupRatesOrThrow`

The kit still ships no prices. A dated table records when you checked yours and
where:

```js
const table = definePricingTable({
  checkedAt: '2026-10-01', // or an ISO date-time with a zone
  source: 'https://example.com/pricing', // where you read the prices
  rates: {
    // Illustrative numbers; use current published prices.
    'anthropic:my-model': { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 },
    'openai:my-model': { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 1 },
  },
});
assertPricingFresh(table, new Date(), 30); // throws once the table is more than 30 days old
const rates = lookupRatesOrThrow(table, 'anthropic:my-model'); // throws for an unknown model
```

- Keys are `provider:model` with a lowercase provider; the model part may contain
  `:` (some Bedrock ids do) but no whitespace or control characters.
- Every entry needs exactly `inputPerMillion`, `outputPerMillion` and
  `cacheReadPerMillion`. `cacheReadPerMillion` is required here so a dated table
  never falls back to the 0.1x default; a typo such as `cacheWritePerMillion`
  throws.
- The result is a frozen copy with a null-prototype `rates` record.
  `lookupRatesOrThrow` matches own keys only (`constructor` and `__proto__`
  throw like any unknown model), re-validates the entry and returns a fresh
  copy. **There is no fallback price.**
- `assertPricingFresh` allows a `checkedAt` up to one day in the future (a date
  written in a zone ahead of UTC) and throws past that. A stale table throws an
  `Error` naming its date, age and source.

Long-context surcharges and per-model cache-write prices are not modeled in this
per-million shape (the cache-write multipliers stay fixed at 1.25x and 2x). The
integer-micro shape below models both.

### Integer-micro price tables: `definePricingTable`, `priceFor`, `costMicros`

For budgets that count integers, write prices as whole micro-dollars per million
tokens. `definePricingTable` accepts this shape too (one table uses one shape),
and the cost math is exact BigInt arithmetic with no floating point. The numbers
below are **illustrative, made up for this page and dated 2026-10-01; they are
not any provider's prices.** Check the current published prices before you use
any.

```js
const table = definePricingTable({
  checkedAt: '2026-10-01', // when you last checked the prices
  source: 'https://example.com/pricing', // where you read them
  rates: {
    'anthropic:my-model': {
      inputPerMTokMicros: 3_000_000, // $3.00 per million tokens
      outputPerMTokMicros: 15_000_000,
      cacheWritePerMTokMicros: 3_750_000, // 5-minute writes
      cacheWrite1hPerMTokMicros: 6_000_000, // 1-hour writes
      cacheReadPerMTokMicros: 300_000,
      // Optional: above this prompt size these rates replace the base rates for the whole request.
      longContext: { aboveInputTokens: 200_000, inputPerMTokMicros: 6_000_000, outputPerMTokMicros: 22_500_000, cacheReadPerMTokMicros: 600_000, cacheWritePerMTokMicros: 7_500_000, cacheWrite1hPerMTokMicros: 12_000_000 },
    },
  },
});
assertPricingFresh(table, { now: new Date(), maxAgeDays: 30 }); // throws once the table is older than 30 days
const found = priceFor(table, 'anthropic:my-model'); // { status: 'found', key, price } or { status: 'unknown-model' }
if (found.status === 'unknown-model') throw new Error('no price for this model; refuse the call');
const micros = costMicros({ inputTokens: 2_000, outputTokens: 500 }, found.price);
```

- **`priceFor(table, key)`** returns `{ status: 'found', key, price }` or
  `{ status: 'unknown-model' }`. There is no fallback price, ever: an unknown
  key, a missing key, `constructor` and `__proto__` are all `unknown-model`.
  Decide what to do with that (refuse the call, or fail the deploy); a missing
  price must not become a free call. A malformed table or entry throws.
- **`costMicros(usage, price)`** is exact and **rounds up once**, on the sum of
  all buckets (not per bucket). It is never below the true cost and at most one
  micro-dollar above it; zero usage is 0 and any positive cost is at least 1.
  A bucket with tokens and no configured price throws (a cache read is never
  priced at 0 or by a hidden multiplier). Not to be confused with the older
  `estimateCostMicros(rates, usage)`, which takes per-million USD rates.
- **Long context:** when the prompt (input + cache reads + cache writes) is
  strictly greater than `aboveInputTokens`, the long-context rates apply to
  every bucket. A bucket the long rates do not price throws; it does not fall
  back to the base rates. Output tokens do not count toward the threshold.
- **Cache writes:** `cacheWritePerMTokMicros` prices the 5-minute bucket (and a
  `cache_creation_input_tokens` total the provider did not split);
  `cacheWrite1hPerMTokMicros` prices the 1-hour bucket.
- **Safe integers only.** A price is a safe integer (at most 2^53 - 1). A larger
  value, a fraction, `NaN`, `Infinity`, a negative, a string and a BigInt are
  rejected; `-0` reads as 0. A cost past 2^53 - 1 micro-dollars throws.
- `assertPricingFresh(table, { now, maxAgeDays })` takes `now` from you (the kit
  reads no clock). A table exactly `maxAgeDays` old passes; older throws; a
  `checkedAt` more than a day ahead throws. The original
  `assertPricingFresh(table, now, maxAgeDays)` form still works.
- The result is frozen all the way down, and `priceFor` returns a fresh frozen
  copy, so editing a price after the fact cannot change the table.

### Reading usage, or saying "unknown": `readAnthropicUsage`, `readOpenAIUsage`

`usageFromAnthropic` and `usageFromOpenAI` (above) throw on anything they do not
understand. These two wrap them for the settle step, where paid work has already
happened and a throw would lose the result: they return the same token counts,
or the string `'unknown'`, and never throw.

```js
const reading = readAnthropicUsage(response.usage); // UsageTokens or 'unknown'
const settle = reading === 'unknown' ? { usage: 'unknown' } : { actualAmount: costMicros(reading, found.price) };
```

`'unknown'` means "I cannot tell what this call cost", which is different from
zero. Pass it as `{ usage: 'unknown' }` and the reservation keeps the full
estimate. A response with no `usage`, a string count such as `"123"`, `NaN`,
`Infinity`, a fraction, a BigInt, a count above 2^53 - 1, a field the kit does
not know (it might be a new billed bucket), a cache-write total that disagrees
with its split, nonzero tool fees or audio tokens, and a getter or Proxy that
throws are all `'unknown'`. A cache field that is **absent** counts as 0 (older
API versions omit them when no caching was used); one that is present but
malformed is `'unknown'`. A `cache_creation_input_tokens` total with no
`cache_creation` split is priced as 5-minute writes, never dropped. Each field
is read once. If `costMicros` throws because your price lacks a bucket, fix the
table; treat that as a deploy-time error, not as a reason to record zero.

### `getRatesOrThrow(table, model): ModelRates`

Looks `model` up in your `PricingTable` (`Record<string, ModelRates>`). Throws,
listing the known models, when there is no entry. Only the table's own keys
match: `constructor`, `toString` and `__proto__` throw like any unknown model.
`model` must be a string and `table` a plain object: a `String` object, an
array or an object with a `toString` is a `TypeError`, not a key, and a `Map` is
a `TypeError`, not an empty table. The returned entry is not validated here;
`estimateCostUsd` validates it on use.

### `formatRatesForLog(rates): string`

Returns e.g. `"$3/M in, $15/M out"` for logging on every run, so a stale rate is
visible. It does not validate or round (`NaN` prints as `$NaN/M`). A value that
is not a number prints by kind, and a string prints quoted with control and bidi
characters escaped, so a bad rate cannot forge a log line. `rates` must be a
plain object.

---

## 2. Pre-call ceiling (`cost-governor-kit/preCallCeiling`)

### `checkPreCallCeiling(check): PreCallCeilingResult`

`check` is `{ spentSoFarUsd, ceilingUsd, estimatedNextCallUsage, rates }`. It
prices the estimate with `estimateCostUsd`, adds it to `spentSoFarUsd`, rounds
the total to the micro-dollar, and returns:

- `allowed`: `projectedTotalUsd <= ceilingUsd` (landing exactly on the ceiling is allowed)
- `projectedNextCallCostUsd`, `projectedTotalUsd`, `ceilingUsd` (echoed)
- `reason`: only when denied, a sentence with the amounts. When allowed, the
  `reason` key is absent (not present as `undefined`). A ceiling that is not a
  whole number of micro-dollars is printed with the extra digits needed to read
  below the projected total, so a denial never says "$5.000000 exceeds $5.000000".

> **Pass `outputTokens`.** `estimatedNextCallUsage` must include `outputTokens`,
> set to the call's `max_tokens` bound. If you omit it, output is priced at $0
> and the ceiling check under-counts the call. Sub-half-micro calls also price at
> $0; see the warnings under `estimateCostUsd`.

It is pure: no I/O, no clock, no stored state, and it does not mutate its input.
It throws when the argument, `rates` or the usage estimate is not a plain object
(a `Map` usage estimate throws under a $0 ceiling instead of being allowed as
zero usage), when `rates` is missing or invalid, when `spentSoFarUsd` or
`ceilingUsd` is not a finite number >= 0 (these two messages include the value,
safely rendered), for an invalid usage estimate, or when the total is not
finite. The rates check runs before the ceiling and spend checks.

```js
let spentSoFarUsd = 0;
for (const record of workItems) {
  const check = checkPreCallCeiling({
    spentSoFarUsd,
    ceilingUsd: 25,
    estimatedNextCallUsage: { inputTokens: 2_000, outputTokens: 500 }, // your estimate
    rates,
  });
  if (!check.allowed) {
    console.log(check.reason);
    break; // no call is made after this point
  }
  const response = await callYourLlmApi(record);
  spentSoFarUsd += actualCostFrom(response); // reconcile with real usage, not the estimate
}
```

This comes from a batch script in the author's own projects that takes its
rates as CLI flags, prints them on every run, and checks cumulative spend
against a hard cap before each call. This module adds one step that script does
not take: it also prices the next call before allowing it.

---

## 3. Usage counting (`cost-governor-kit/reserveConfirm`)

### Advisory: `withReserveConfirm(ledger, key, limit, doTheCall)`

```ts
import { withReserveConfirm, type UsageLedger } from 'cost-governor-kit/reserveConfirm';

declare const myLedger: UsageLedger; // your storage

// Inside your request handler (the `return`s below belong to it):
const today = '2026-09-28'; // your window key, for example the UTC date
const result = await withReserveConfirm(myLedger, `${userId}:${today}`, 5, () => callYourLlmApi(prompt));
if (!result.allowed) return send429('Daily limit reached');
// Test for presence, not truthiness: a ledger can reject with undefined, null,
// false, 0 or '', and every one of those is falsy.
if (Object.hasOwn(result, 'commitError')) logForReconciliation(result.commitError); // usage may be under-recorded
return send200(result.result);
```

`UsageLedger` is `checkUnderLimit(key, limit): Promise<boolean>` (read-only) and
`commitUsage(key): Promise<void>`. The helper:

1. Awaits `checkUnderLimit(key, limit)`. `false` returns `{ allowed: false }`
   without calling. A non-boolean result (for example a whole RPC response
   object) throws a `TypeError`, also without calling. `limit` is passed through
   unvalidated.
2. Awaits `doTheCall()`. If it throws, the error propagates unchanged and
   `commitUsage` is never called, so a failed call never burns a slot. That does
   not prove a timed-out provider call was not charged.
3. Awaits `commitUsage(key)`. If it resolves, returns `{ allowed: true, result }`.
   If it rejects, the paid call already happened and its result is **not**
   discarded: this returns `{ allowed: true, result, commitError }` instead of
   rejecting, where `commitError` is whatever `commitUsage` rejected with. The
   presence of `commitError` (check `Object.hasOwn(result, 'commitError')`) is
   your signal that the usage count may be under-recorded for this call — log
   it and reconcile. The value `commitUsage` resolves is ignored, so an adapter
   must reject, not resolve `false`, when it did not record the usage.

It is **advisory under concurrency**: concurrent requests can all pass the
check before any of them commits, so the limit can be exceeded (a test runs 10
concurrent calls at limit 3 and all 10 run). It never retries.

### Strict: `withCapacityReservation(ledger, request, doTheWork)`

```ts
import { withCapacityReservation, type CapacityReservationLedger } from 'cost-governor-kit/reserveConfirm';

declare const ledger: CapacityReservationLedger; // your atomic, durable adapter

// Inside your request handler (the `return`s below belong to it):
const today = '2026-09-28'; // your window key, for example the UTC date
const result = await withCapacityReservation(
  ledger,
  { key: `${userId}:${today}`, limit: 5, operationId: requestId }, // reuse requestId on every retry
  async (reservation) => {
    const response = await callYourLlmApi(prompt, reservation.operationId);
    return { status: 'succeeded', value: response };
  },
);
if (result.status === 'denied') return send429('Daily limit reached');
if (result.status === 'confirmed') return send200(result.value);
// Every other status needs reconciliation. Do not make a second paid call.
return send503('Usage operation needs reconciliation');
```

Your adapter implements `reserveCapacity(request)`, `confirmReservation(r)` and
`releaseReservation(r)`. **It is the safety boundary.** The helper has no
counter of its own and trusts the adapter's decisions. The contract (from the
TSDoc) is: `reserveCapacity` atomically counts confirmed usage plus unexpired
holds for the key and creates a hold only when that total is below `limit`; a
repeated `(key, operationId)` returns `operation_in_progress` while unresolved
or `operation_terminal` once final, and never a second hold; confirm and release
are idempotent. A test shows what happens with a non-atomic adapter: 10
concurrent requests at limit 3 all run.

**What the helper itself guarantees, with any adapter:**

- It reads the request once and validates that copy. A request that is not a
  plain object, a `limit` that is not a safe integer >= 0, or a blank `key` or
  `operationId` throws without calling the adapter. Blank means empty or only
  whitespace and invisible characters (zero-width spaces, bidi controls, the
  soft hyphen and similar). `limit: 0` is passed to the adapter, which should
  deny; the helper does not deny locally. The adapter receives a fresh
  `{ key, limit, operationId }` copy (plus `amount` when you pass one; see
  [Dollar amounts on a strict reservation](#dollar-amounts-on-a-strict-reservation)),
  and every later comparison uses the
  validated values, so neither your changing the request object mid-flight nor
  the adapter editing its argument can change what a reservation is checked
  against.
- It calls `reserveCapacity` once and `doTheWork` at most once, and only for an
  `acquired` decision whose reservation has a non-blank `id`, the request's
  `key` and `operationId`, and an `expiresAt` later than this process's
  `Date.now()` (compared as instants, and read once along with the rest of the
  decision, reservation and outcome). **`expiresAt` must carry a time zone**:
  a strict ISO-8601 date-time ending in `Z` or an offset like `-05:00`, such as
  `new Date(ms).toISOString()` returns. `2026-10-10T16:17:14.411` (no zone),
  `"2099"`, `"Dec 25, 2099"` and impossible dates like February 30 throw a
  `RangeError` instead of being read in the server's local time. Format
  database timestamps with an explicit zone (Postgres: `to_char(... at time
  zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`, or `.toISOString()` on a `Date`). A malformed or unknown decision throws before any work. If the
  adapter did create a hold, the helper leaves it in place (it does not release
  a hold it cannot trust), and with a conforming adapter a retry with the same
  `operationId` then gets `operation_in_progress`.
- `doTheWork` receives a frozen shallow copy of the reservation. It can read
  `id`, `key`, `operationId` and `expiresAt`; assigning to the copy throws in
  strict mode (so, if uncaught, the outcome is `work_outcome_ambiguous`), and
  nothing it does changes which hold is confirmed or released.
- `{ status: 'succeeded', value }` leads to exactly one `confirmReservation`
  call; `{ status: 'failed', error }` to exactly one `releaseReservation` call.
  It never calls both, never calls either twice, and never retries.
- A thrown or rejected `doTheWork` (sync or async), an outcome of the wrong
  shape, or an outcome whose fields throw when read (a hostile getter or
  proxy), returns `work_outcome_ambiguous` and keeps the hold. Return `failed`
  only when the provider definitely did not charge.
- A failed confirm returns `confirmation_failed` with the value and keeps the
  hold. A failed release returns `release_failed` with both errors.
- A rejected `reserveCapacity` propagates and no work runs. A hold may or may
  not exist; retry with the same `operationId` to find out.

Result statuses: `denied`, `confirmed`, and five recovery states:
`operation_in_progress`, `operation_terminal`, `work_outcome_ambiguous`,
`confirmation_failed`, `release_failed`, plus `released_after_failure` (the hold
was released after a known no-charge failure).

**If the process crashes between reserve and confirm.** The helper keeps no
state, sets no timers and has no timeouts, so nothing in this library will ever
confirm or release that hold. It stays in your adapter's storage as unresolved.
While it is unexpired it counts toward the limit, and a retry with the same
`operationId` gets `operation_in_progress` and does not run the provider again.
Your reconciliation job must find out from the provider (or your own records)
whether the work happened and then call `confirmReservation` or
`releaseReservation` directly. Once the hold expires it stops counting under
this contract, so if the crashed operation did paid work, real usage can exceed
the limit by one per such operation until reconciliation confirms it. If you
need the limit to hold across crashes, make your adapter keep counting expired
but unresolved holds until they are reconciled (capacity stays blocked in the
meantime). A retry with a *new* `operationId` is a new operation and can run
the provider again.

### Dollar amounts on a strict reservation

`ReserveCapacityRequest` takes an optional integer `amount` (a safe integer >= 1,
in the same unit as `limit`; typically micro-dollars from `costMicros` or `estimateCostMicros`).
Without it, nothing changes: a hold is one unit and the adapter sees exactly
`{ key, limit, operationId }`. With it:

- The adapter receives `amount` and must create the hold only when confirmed
  usage plus unexpired holds plus `amount` is at most `limit`.
- `doTheWork` may add `settle` to a succeeded outcome: `{ actualAmount }` (for
  example `estimateCostMicros(rates, usageFromAnthropic(response.usage))`) or
  `{ usage: 'unknown' }`. Leaving it out also means unknown.
- `confirmReservation(reservation, settlement)` then gets a second argument,
  `{ usage: 'reported' | 'unknown', amount, reservedAmount }`. Record `amount`.
  **Unknown keeps the full estimate, never zero.** A reported amount above the
  estimate is passed through as is; record it, do not cap it at the hold. The
  result then also carries `overrunAmount` (actual minus reserved), present
  only when the actual amount was higher, so you can alert on a low estimate.
  An actual of exactly the hold, or less, has no `overrunAmount`. A reported
  `-0` is recorded as 0.
- Amounts are safe integers (at most 2^53 - 1). `NaN`, `Infinity`, a fraction,
  a negative, a string, a BigInt and 2^53 + 1 are rejected: a bad reserve
  `amount` throws before the adapter is called, and a bad `actualAmount` is
  `work_outcome_ambiguous`.
- A malformed `settle` (negative, fractional, extra keys, anything else) returns
  `work_outcome_ambiguous` and keeps the hold, like any other unreadable outcome.
  A failed outcome still releases the whole hold.
- The `confirmed` and `confirmation_failed` results carry the same `settlement`
  (and `overrunAmount` when there was one).

```ts
// `found.price` comes from priceFor (see Integer-micro price tables above).
const amount = costMicros({ inputTokens: 2_000, outputTokens: maxTokens }, found.price);
const result = await withCapacityReservation(
  ledger,
  { key: `budget:${today}`, limit: 5_000_000, operationId: requestId, amount: Math.max(1, amount) },
  async () => {
    const response = await callYourLlmApi(prompt);
    const reading = readAnthropicUsage(response.usage);
    return {
      status: 'succeeded',
      value: response,
      settle: reading === 'unknown' ? { usage: 'unknown' } : { actualAmount: costMicros(reading, found.price) },
    };
  },
);
if (result.status === 'confirmed' && result.overrunAmount) {
  // The estimate ran low by this many micro-dollars; the full actual was still recorded.
}
```

### `createCommitOnce(fn)`: count a stream on its first visible output

Returns a function that runs `fn` at most once, however many times and however
concurrently it is called; every caller gets the same promise. Call it from
every chunk handler to record usage exactly once, as soon as the user has seen
output:

```ts
const countOnce = createCommitOnce(() => ledger.commitUsage(`${userId}:${today}`));
for await (const chunk of stream) {
  if (chunk.text) await countOnce();
  write(chunk.text);
}
// countOnce.state === 'idle' here means nothing was shown and nothing was counted.
```

`countOnce.attempt()` is the same single run with a result instead of a
rejection: it never rejects, and it says whether *this* call ran the commit.

```ts
const outcome = await countOnce.attempt();
// { ran: true,  status: 'committed', value }  the call that ran fn
// { ran: false, status: 'committed', value }  every other call, same value
// { ran: true,  status: 'failed', error }     fn threw or rejected; { ran: false, ... } for the rest
if (outcome.status === 'failed') reconcile(outcome.error); // never run again through this instance
```

A failure is surfaced, not swallowed: the shared promise rejects with `fn`'s
error for every caller, then and later, and `state` becomes `failed`. **A failed
commit cannot be retried through the same instance**, because a commit can fail
after its write landed (a lost reply) and a retry could count the call twice.
Reconcile, or create a new instance for a deliberate retry. A synchronous throw
becomes a rejection; a re-entrant call from inside `fn` joins the first call.
`state` is `idle`, `pending`, `committed` or `failed`; it changes from `pending`
when the promise settles (one microtask later, even for a synchronous `fn`), so
read it after awaiting.

### Reference SQL (advisory only)

[`reference-impl/supabase-usage-ledger.sql`](reference-impl/supabase-usage-ledger.sql)
implements the advisory `UsageLedger` as two Postgres functions, with a
TypeScript adapter sketch in a comment. In that sketch, `commitUsage` rejects
when the RPC answers `committed: false` or something malformed, so
`withReserveConfirm` returns the paid result with `commitError` set. It does
**not** implement `CapacityReservationLedger`. Its commit re-checks the limit under a row lock, so
the recorded count never exceeds the limit, but two requests that both passed
the check still both make the paid call; the second is simply not recorded.

`src/referenceImplPglite.test.ts` applies this file, unmodified, to a fresh
[PGlite](https://github.com/electric-sql/pglite) database as part of `npm test`
(so CI runs it on every push) and checks: a role with no explicit grant is
denied on both functions and `service_role` is allowed (the round-1 grant
fix), the Supabase `anon`/`authenticated` revoke branch, fresh-key and
window-rollover behavior, and the limit-reached and limit-0 cases. The same file
extracts the commented adapter, strips its types with the TypeScript compiler
and runs it against these functions through a stub of the Supabase client's
`rpc()` method, inside `withReserveConfirm`: a real `committed: false` (another
request took the last slot during the paid call), a missing or malformed row
and an RPC error each come back as the paid result with `commitError` set, and
the provider callback runs once. `@supabase/supabase-js` itself is not run.
**PGlite is a single connection**, so this test proves nothing about concurrent
sessions — the file's own header comment covers what happens then. It was
not run against a live Supabase project. It ships in the npm tarball as
copy-and-adapt reference material; nothing imports it.

**`src/referenceImplPostgres.test.ts` fills the concurrency gap above.** It is
skipped unless `COST_GOVERNOR_PG_URL` is set, so it does not run as part of
`npm test` or `npm run verify`. CI runs it in its own `postgres` job against a
Postgres 17 service container and fails that job if the suite reports any skipped
test. To run it yourself against a real, local Postgres 17:

```sh
# Start a throwaway Postgres 17 (adjust paths/port as needed; this does not
# touch any existing Postgres install or use brew services). Keep the data
# directory path short: Unix socket paths are limited to about 103 bytes.
# On macOS, the server may refuse to start ("postmaster became multithreaded")
# unless LC_ALL is set, as below.
export LC_ALL=en_US.UTF-8
initdb -D /tmp/cgk-pg -A trust -U postgres
pg_ctl -D /tmp/cgk-pg -o "-p 54329 -k /tmp/cgk-pg -c listen_addresses=''" -l /tmp/cgk-pg.log start
createdb -h /tmp/cgk-pg -p 54329 -U postgres cost_governor_test

COST_GOVERNOR_PG_URL="postgresql://postgres@/cost_governor_test?host=/tmp/cgk-pg&port=54329" \
  npm run test:postgres

pg_ctl -D /tmp/cgk-pg stop
```

It drops and reapplies the SQL to get a fresh schema, then opens 50 separate
`pg` connections (real sessions, not PGlite) and fires `usage_ledger_commit_usage`
at all of them concurrently against one key with `limit: 10`, repeated 5
times including against never-before-seen keys (racing the
`INSERT ... ON CONFLICT` path, not just the update path). **What it proved,
run 2026-09-26 against Postgres 17.11:** exactly 10 of 50 concurrent commits
succeed every time, the successful commits get distinct sequential counts
1&ndash;10 with no gaps or duplicates, and the stored row never exceeds 10. A
second scenario fires 50 concurrent `usage_ledger_check_under_limit` calls
against a fresh key before any commits land: all 50 return `allowed: true`
even though the limit is 10 — proving Phase 1 is genuinely advisory under
real concurrency, exactly as the SQL file's header describes — while the
Phase 2 commits that follow still cap at 10. **What it does not prove:** live
Supabase's own role/default-privilege setup and PgBouncer pooling, or
behavior under a network partition or Postgres failover.

---

## Honest limits

- **The ceiling is only as good as your estimate.** `checkPreCallCeiling`
  prices a guess made before the call. Estimates that run low let more spend
  through. Reconcile `spentSoFarUsd` from each response's actual usage.
  Supply `outputTokens` (the `max_tokens` bound); an omitted bucket is $0.
- **Tiny calls are free, so estimates cannot be summed.** A call under
  $0.0000005 prices at $0. An accumulator fed from per-call estimates never
  grows from such calls. Reconcile from real usage, or price summed token counts
  once.
- **Micro-dollar resolution.** Both the next-call cost and the total are
  rounded, so one check can allow a true total up to about $0.000001 over the
  ceiling, a call under $0.0000005 is priced at $0, and a running total of
  rounded estimates can drift by up to $0.0000005 per call. The ceiling itself
  is compared as given, so pass whole micro-dollars.
- **Cache-write multipliers are fixed.** The 1.25x and 2x cache-creation
  multipliers are not overridable. A model whose cache-read rate is not 0.1x
  is over-estimated unless you set `ModelRates.cacheReadPerMillion` (see
  above). Server-tool fees, such as per-search charges, are not modeled.
- **No price data.** Rates you pass can be stale; the library cannot tell.
- **A count limit is not a dollar budget.** `withCapacityReservation` counts units, and
  `checkPreCallCeiling` compares an estimate against a spend total you supply. Neither
  locks a shared dollar budget or settles the difference between estimated and billed cost.
- **The strict limit lives in your adapter.** This kit ships no
  `CapacityReservationLedger`, and its tests use single-process in-memory
  doubles, which prove the helper's call sequencing, not any real storage.
- **`withReserveConfirm` is advisory**, returns the successful result with a
  `commitError` field (instead of discarding it) if the commit fails, and
  passes `key` and `limit` through unvalidated. It ignores the value
  `commitUsage` resolves, so only a rejection reports an unrecorded commit.
- **Copies are shallow and only for the records this kit reads.** Each field of
  your rates, usage, check and request is read once, but nothing is deep-cloned
  or frozen. The one exception is the reservation your adapter returns: it is
  copied once into a snapshot, `doTheWork` receives a frozen shallow copy, and
  the snapshot is what `confirmReservation` or `releaseReservation` gets and
  what the result returns, so the callback cannot change which hold is
  confirmed.
- **The SQL adapter example is a sketch.** Its tests run it through a stub of
  the Supabase client on a single PGlite connection. It was not run with
  `@supabase/supabase-js`, against a live Supabase project, or under concurrent
  sessions.
- **`expiresAt` needs a zone.** It must be strict ISO-8601 ending in `Z` or an
  offset. A zone-less timestamp is rejected because it would otherwise be read in
  the server's local time.
- **Clock skew.** A newly acquired hold must expire later than this process's
  `Date.now()`. If your app's clock runs ahead of your database's by more than
  the hold's lifetime, every acquire is rejected (and each hold is left for
  reconciliation).
- **No retries, backoff, queueing or timeouts.** Retrying a read-only check is
  safe; retrying paid work is safe only after reconciliation or under the
  provider's own idempotency guarantee.
- **Admission is only as atomic as your store.** `admitBeforeCall` validates and
  fails closed, but the all-or-nothing increment is your store's job. The
  in-memory store is single-process and for tests. The Postgres recipe's logic
  is tested on PGlite (one connection); the D1 and Redis recipes were not run on
  D1, Miniflare, Redis or Upstash. Prove your cap with a multi-instance test.
- **Admissions are never refunded.** A call that fails after admission keeps its
  slot. That is deliberate (the provider may have billed it), and it means a
  provider outage burns allowance.
- **Store clock steps.** The in-memory store never moves a window backwards; the
  recipes trust the database clock and do not guard against it stepping back.
- **Prices go stale.** `assertPricingFresh` checks the date you wrote, not the
  provider's page; it cannot know a price changed. Re-check the source when you
  bump `checkedAt`. The examples in this README are illustrative and dated, not
  current prices.
- **`'unknown'` is not an estimate.** `readAnthropicUsage` and `readOpenAIUsage`
  say `'unknown'` for anything they cannot read, including a field added after
  this version. A reservation then keeps the full estimate, so a persistent
  `'unknown'` means you are budgeting at the estimate; watch for it.
- **Long context is one threshold.** The long-context rates replace the base
  rates for the whole request above one prompt size. Providers with several
  tiers, per-tool fees, batch or regional surcharges need those folded into the
  rates you write.
- **Provider mappers know today's fields.** A field they do not know throws
  instead of being guessed at. Update the kit, or price the field yourself and
  pass a copy without it.
- **Not abuse protection.** Pair it with real rate limiting if you need that.
- **No source maps.** The build emits no `.js.map`/`.d.ts.map`; go-to-definition
  lands on the shipped `.d.ts`/`.js`, not `src/`. The source is small and not
  minified, so this is a deliberate omission, not an oversight.

## Related

[`honesty-mcp`](https://github.com/lkopietz3-byte/honesty-mcp) (a sibling project) depends on this kit and exposes it as a
`scaffold_cost_governor` guidance tool rather than a check tool, because the
ledger contracts need your storage. This kit does not depend on any other kit.

## Development

```bash
npm ci
npm run verify   # lint, typecheck, test, build, then pack + install + probe the tarball
```

See `ENGINEERING.md` for the invariants and release notes and `CHANGELOG.md`
for changes.
