# cost-governor-kit

A tiny, zero-dependency library that gives any AI-calling app three cost-safety
properties at once — properties that, across an audited portfolio of ~26
AI-calling apps, no single app had all three of together:

1. **A pre-call dollar ceiling**, checked *before* the API call happens, not
   monitored after — using rates the caller supplies at call time, never a
   hardcoded price baked into the library.
2. **Correct pricing math**, including a real bug fix: Anthropic's cache
   writes split into two different multipliers (5-minute vs. 1-hour TTL), and
   collapsing them into one flat multiplier silently under-reports 1-hour
   cache turns by about 37.5%.
3. **Two usage-counting choices:** a source-compatible advisory
   check-then-commit helper that avoids charging known failures, and a strict
   atomic-reservation contract for concurrent capacity limits.

Every piece here was extracted from a real bug fix or a real gap found in
production code, not designed in the abstract. See the doc comments in each
`src/*.ts` file for the specific incident each pattern fixes.

## Install

```bash
npm install
npm test        # vitest
npm run typecheck  # tsc --noEmit
```

Zero runtime dependencies. ESM only (`"type": "module"`). MIT licensed.

---

## 1. Pricing (`src/pricing.ts`)

Pure, zero-I/O cost math. You supply a model's list-price rates and a token
usage breakdown; it returns a dollar cost.

```ts
import { estimateCostUsd, type ModelRates } from 'cost-governor-kit/pricing';

const rates: ModelRates = { inputPerMillion: 3, outputPerMillion: 15 }; // e.g. claude-sonnet-5

const cost = estimateCostUsd(rates, {
  inputTokens: 1_200,
  outputTokens: 400,
  cacheReadTokens: 8_000,        // billed at 0.1x the input rate
  cacheCreation5mTokens: 2_000,  // billed at 1.25x the input rate
  cacheCreation1hTokens: 0,      // billed at 2.0x the input rate — kept SEPARATE from the 5m bucket
});

console.log(cost); // => a USD number
```

**The bug this fixes:** a real cost-tracking system in production collapsed
both cache-creation TTLs (5-minute and 1-hour) into a single 1.25x
multiplier. That's correct for 5-minute writes but wrong for 1-hour writes,
which actually cost 2.0x. Applying 1.25x where 2.0x was owed under-reports
the true cost of every 1-hour-cache turn by `(2.0 - 1.25) / 2.0 = 37.5%` — a
cost dashboard quietly telling you a whole class of calls is over a third
cheaper than it really is. This library keeps `cacheReadTokens`,
`cacheCreation5mTokens`, and `cacheCreation1hTokens` as three permanently
distinct fields, each with its own multiplier constant
(`CACHE_READ_MULTIPLIER`, `CACHE_CREATION_5M_MULTIPLIER`,
`CACHE_CREATION_1H_MULTIPLIER`), so they can never be silently collapsed back
into one. `src/pricing.test.ts` has a test that computes both the correct
and the buggy-collapsed cost for the same usage and asserts they differ by
~37.5% — proving the fix is real, not just documented.

You bring your own pricing table — this library ships no hardcoded model
prices (see the ceiling section below for why).

---

## 2. Pre-call dollar ceiling (`src/preCallCeiling.ts`)

Decides whether the *next* call is allowed to happen — before you make it.

```ts
import { checkPreCallCeiling } from 'cost-governor-kit/preCallCeiling';

let spentSoFarUsd = 0;
const ceilingUsd = 25;
const rates = { inputPerMillion: 3, outputPerMillion: 15 }; // from a CLI flag / config — never hardcoded

for (const record of workItems) {
  const check = checkPreCallCeiling({
    spentSoFarUsd,
    ceilingUsd,
    estimatedNextCallUsage: { inputTokens: 2_000, outputTokens: 500 }, // your best estimate
    rates,
  });

  if (!check.allowed) {
    console.log(check.reason);
    break; // stop cleanly — nothing after this point makes another call
  }

  const response = await callYourLlmApi(record);
  spentSoFarUsd = check.projectedTotalUsd; // or reconcile with the response's real usage block
}
```

**Where this comes from:** a portfolio audit of AI-calling apps found plenty
of *post-hoc spend monitoring* (dashboards, alerts, anomaly detection on
yesterday's spend) but only one script with a genuine *pre-call* ceiling —
one that computes the projected cost of the next call and refuses to make it
at all if that would exceed a hard cap, rather than firing an alert after the
money's already spent. That script also enforced a discipline worth copying
directly: rates come in as explicit CLI arguments and are printed on every
run, specifically so a stale hardcoded price can't silently corrupt the spend
cap. This module mirrors both: `checkPreCallCeiling` runs before your call
(never after), and `rates` is a **required** parameter with no default
anywhere in this file — pass it explicitly, and log it with
`formatRatesForLog()` from the pricing module so a wrong number is visible,
not hidden.

```ts
import { formatRatesForLog } from 'cost-governor-kit/pricing';
console.log(`rates: ${formatRatesForLog(rates)} <- VERIFY against current pricing`);
```

---

## 3. Usage counting (`src/reserveConfirm.ts`)

### Legacy advisory check-then-commit

A database-agnostic, source-compatible helper that checks before work and
commits only after a successful call.

```ts
import { withReserveConfirm, type UsageLedger } from 'cost-governor-kit/reserveConfirm';

// Implement this against whatever storage you already use — Postgres,
// Redis, DynamoDB, an in-memory map for tests. See reference-impl/ for a
// ready-to-copy Postgres/Supabase implementation of this exact interface.
declare const myLedger: UsageLedger;

const result = await withReserveConfirm(
  myLedger,
  `${userId}:${today}`, // any string key your app wants to rate-limit by
  5,                     // e.g. 5 free calls/day
  () => callYourLlmApi(prompt),
);

if (!result.allowed) {
  return send429('Daily limit reached');
}
return send200(result.result);
```

`UsageLedger` is two methods:

```ts
interface UsageLedger {
  checkUnderLimit(key: string, limit: number): Promise<boolean>; // read-only
  commitUsage(key: string): Promise<void>;                        // mutates
}
```

`withReserveConfirm` calls `checkUnderLimit` first; if it returns `false`, it
denies immediately without ever invoking your call. Otherwise it invokes
`doTheCall()`. **If `doTheCall()` throws, the error propagates unchanged and
`commitUsage` is never called.** That only means the helper did not count the
attempt; it does not prove a timeout failed before a paid provider accepted
work. Re-running the read-only check is safe. Retrying paid work requires the
caller's own provider reconciliation or idempotency mechanism.

**Where this comes from:** a real production bug. The original code checked
a user's daily limit and incremented it in the *same* step, before calling
the upstream LLM API. When the upstream call was known to fail before a
successful response, a later safely-reconciled attempt burned a *second*
slot for a request that had never actually succeeded even once — a single
flaky call plus its retry could burn a user's whole daily quota with zero
real usage to show for it. The fix split the gate into two phases: check
without incrementing (before the call), increment only after a confirmed
success (after the call). That two-phase split is exactly what
`withReserveConfirm` encodes.

### Reference implementation: Postgres/Supabase

[`reference-impl/supabase-usage-ledger.sql`](reference-impl/supabase-usage-ledger.sql)
is a ready-to-copy migration implementing `UsageLedger` as two RPCs —
`usage_ledger_check_under_limit` (Phase 1, read-only) and
`usage_ledger_commit_usage` (Phase 2, atomic increment via
`SELECT ... FOR UPDATE`, called only after your upstream call succeeds). It's
generic (a `usage_ledger` table with a `key`/`window_key`/`count` shape, no
product-specific columns) so it drops into any Postgres/Supabase project. The
SQL file includes a short example TypeScript adapter wiring it up to
`UsageLedger` via `supabase.rpc(...)`.

### What the legacy helper guarantees

`withReserveConfirm` is **advisory under concurrency**, not a strict capacity
reservation. Its `checkUnderLimit(key, limit)` call is read-only and its later
`commitUsage(key)` has neither a limit nor a reservation token. Two concurrent
requests can both pass the check before either commits. It still provides a
valuable narrower guarantee: a call that throws before reporting success never
commits usage, so a known failed call does not burn a slot. Keep using it where
that behavior is sufficient and source compatibility matters.

### Strict concurrent capacity: atomic reservation

Use `withCapacityReservation` when the limit must hold across concurrent
requests. The adapter reserves capacity **before** the provider is invoked;
committed usage plus active reservations must never exceed the supplied limit.

```ts
import {
  withCapacityReservation,
  type CapacityReservationLedger,
} from 'cost-governor-kit/reserveConfirm';

declare const ledger: CapacityReservationLedger;

const result = await withCapacityReservation(
  ledger,
  { key: `${userId}:${today}`, limit: 5, operationId: requestId },
  async (reservation) => {
    const response = await callYourLlmApi(prompt, { idempotencyKey: reservation.operationId });
    return { status: 'succeeded', value: response };
  },
);

if (result.status === 'denied') return send429('Daily limit reached');
if (result.status === 'confirmed') return send200(result.value);
// `operation_in_progress`, `operation_terminal`, `confirmation_failed`,
// `work_outcome_ambiguous`, and `release_failed` are recovery states.
// Do not make a second paid provider call.
return send503('Usage operation needs reconciliation');
```

`CapacityReservationLedger` has three methods: `reserveCapacity`,
`confirmReservation`, and `releaseReservation`. Its implementation is the
safety boundary. `reserveCapacity` must atomically count confirmed usage and
unexpired active reservations before making a hold. It returns `acquired` only
to the invocation that newly owns execution. A duplicate `(key, operationId)`
must return `operation_in_progress` while its hold is active, or
`operation_terminal` after finalization; neither state may invoke the provider
again or take another slot. The adapter must make confirmation and release
idempotent. Persist operation IDs with provider idempotency keys where the
provider supports them.

Before invoking the provider, `withCapacityReservation` validates that the
adapter decision is exactly `acquired` and that its reservation has a nonempty
ID, the requested key and operation ID, and a valid unexpired timestamp.
Unknown decisions or malformed holds fail closed before work runs.
For `operation_in_progress`, identity and timestamp syntax are still checked,
but an expired unresolved hold is returned as recovery metadata and never runs
work; expiry is not permission to release or restart it.

The helper releases only an explicit `{ status: 'failed' }` outcome. Return
that only when the provider definitely performed no charge and no relevant
side effect; an unsuccessful user experience alone is not enough. A thrown
provider operation becomes `work_outcome_ambiguous`, because a timeout can
occur after paid work was accepted; the hold remains in place. Likewise,
`confirmation_failed` retains the hold and the successful provider value. The
helper never retries paid work or blindly releases either state. Reconcile with
the provider and the ledger using the same `operationId` before retrying.

Reservation expiry is not a substitute for reconciliation. Choose an expiry
longer than the expected provider operation, use durable operation state and
fencing/reconciliation for expirations, and retain enough evidence to
investigate ambiguity. Expiry never makes possibly executing work safe to
release merely to make capacity look available.

---

## Honest limits

- **This is not abuse/DDoS rate limiting.** Everything here is about
  *dollar* and *count* ceilings on your own spend and your own users' quotas
  — not about detecting or blocking malicious traffic, credential stuffing,
  or bot floods. Pair it with a real rate-limiting/WAF layer if you need
  that; this library doesn't attempt it.
- **The pre-call ceiling is only as accurate as the estimate you pass it.**
  `checkPreCallCeiling` prices `estimatedNextCallUsage`, which by definition
  is a guess made before the call happens — a fixed per-request heuristic, a
  tokenizer count, a running average of recent calls, whatever you have. It
  is *not* the actual usage the call will report. If your estimates run
  systematically low, the ceiling will let more spend through than you
  intended, even though every individual check was enforced correctly. If
  you need exact accounting (not just "don't blow the ceiling"), pair this
  with **post-call reconciliation**: after each call, compute the real cost
  from the response's actual usage block with `estimateCostUsd` and use that
  — not the pre-call estimate — as your running total for the *next*
  check's `spentSoFarUsd`.
- **`withReserveConfirm` is advisory, not strict under concurrency.** It
  avoids committing known failed work but cannot reserve capacity. For a hard
  concurrent cap, implement `CapacityReservationLedger` and use
  `withCapacityReservation`; its adapter is responsible for an atomic
  committed-plus-active-reservations check.
- **No retries, no backoff, no queueing.** All three modules are synchronous
  decision points, not a full resilience layer. The library never retries.
  Retrying a read-only quota check is safe; retrying paid work after an error
  is safe only after provider reconciliation or under that provider's durable
  idempotency guarantee.

## Files

```
src/
  pricing.ts              Pure pricing math + the cache-multiplier fix
  pricing.test.ts
  preCallCeiling.ts        Pre-call dollar ceiling, live rates required
  preCallCeiling.test.ts
  reserveConfirm.ts        Advisory helper + strict reservation contracts
  reserveConfirm.test.ts
  index.ts                 Barrel export
reference-impl/
  supabase-usage-ledger.sql  Postgres/Supabase implementation of UsageLedger
```
