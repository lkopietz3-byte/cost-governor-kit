# cost-governor-kit

A small, zero-dependency TypeScript library for three cost-safety jobs in apps
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

The patterns come from fixes in the author's own apps; the doc comment at the
top of each `src/*.ts` file names the incident.

**Don't use it for:**

- Abuse or DDoS rate limiting. This is about your own spend and your users'
  quotas, not hostile traffic.
- A price source. It ships no prices; you must supply current ones.
- A strict concurrent limit out of the box. `withCapacityReservation` is only as
  strict as the adapter you implement, and this kit ships none for it.
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
`>=20`. TypeScript resolves the root and all three subpaths under `node10`,
`node16`/`nodenext` and `bundler` resolution (checked by `attw` in CI).

## Visual example: Threshold

The repository includes a PlanrLabs visual instrument in
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
`npm run verify` includes the example's source-correspondence and behavioral
checks. The example adds no runtime dependency and is outside the npm files
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

Every export above is also available from its own subpath — `cost-governor-kit/pricing`,
`cost-governor-kit/preCallCeiling`, `cost-governor-kit/reserveConfirm` — importing the
same module either way. Use a subpath if you only want one job's code in your
bundle; the root import above is the simplest default and, unlike the
subpaths, resolves under TypeScript's legacy `node10`/`node` module
resolution too.

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
don't add it separately):

```js
const u = response.usage;
const cost = estimateCostUsd(rates, {
  inputTokens: u.input_tokens,
  outputTokens: u.output_tokens,
  cacheReadTokens: u.cache_read_input_tokens ?? 0,
  cacheCreation5mTokens: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
  cacheCreation1hTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
});
```

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
- `reason`: only when denied, a sentence with the amounts

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
  `{ key, limit, operationId }` copy, and every later comparison uses the
  validated values, so neither your changing the request object mid-flight nor
  the adapter editing its argument can change what a reservation is checked
  against.
- It calls `reserveCapacity` once and `doTheWork` at most once, and only for an
  `acquired` decision whose reservation has a non-blank `id`, the request's
  `key` and `operationId`, and an `expiresAt` later than this process's
  `Date.now()` (compared as instants, and read once along with the rest of the
  decision, reservation and outcome). A malformed or unknown decision throws before any work. If the
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
- A thrown or rejected `doTheWork` (sync or async), or an outcome of the wrong
  shape, returns `work_outcome_ambiguous` and keeps the hold. Return `failed`
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
`npm test`, `npm run verify`, or CI. Run it yourself against a real, local
Postgres 17:

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
- **Clock skew.** A newly acquired hold must expire later than this process's
  `Date.now()`. If your app's clock runs ahead of your database's by more than
  the hold's lifetime, every acquire is rejected (and each hold is left for
  reconciliation).
- **No retries, backoff, queueing or timeouts.** Retrying a read-only check is
  safe; retrying paid work is safe only after reconciliation or under the
  provider's own idempotency guarantee.
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
