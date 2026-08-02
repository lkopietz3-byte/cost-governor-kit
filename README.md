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
3. **Atomic, race-safe usage counting** via a reserve-then-confirm two-phase
   pattern — check a limit before the call, only commit usage after the call
   *actually succeeds* — so a failed upstream call plus a client retry never
   burns two slots for one real usage.

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

## 3. Reserve-then-confirm usage counting (`src/reserveConfirm.ts`)

A database-agnostic contract for atomic usage limits, plus an orchestrator
that wires it around any async call.

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
`commitUsage` is never called** — that's the entire fix, expressed as code
structure rather than a comment you have to trust.

**Where this comes from:** a real production bug. The original code checked
a user's daily limit and incremented it in the *same* step, before calling
the upstream LLM API. When the upstream call failed (a 5xx, a timeout) and
the client did the reasonable thing and retried, the retry burned a *second*
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

**This is the concrete, provable version of the contract** — the interface
above is deliberately abstract so it works for any database; the SQL file is
the specific proof that the pattern is actually implementable correctly,
including the concurrency edge case (two concurrent requests both passing
Phase 1 in the same tick) that the two-phase split alone doesn't solve —
that's what the `FOR UPDATE` row lock in `usage_ledger_commit_usage` is for.

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
- **`reserveConfirm`'s atomicity is only as good as your `UsageLedger`
  implementation.** The interface documents the requirement (commit must be
  atomic against concurrent commits for the same key), but this library
  can't enforce that inside your own database. Use the SQL reference
  implementation's `FOR UPDATE` pattern as the model for correctness if
  you're writing your own.
- **No retries, no backoff, no queueing.** All three modules are
  synchronous decision points, not a full resilience layer. Wrap them with
  your own retry logic if you need it — `withReserveConfirm` is explicitly
  designed to make retries *safe* (a retry after a thrown error just
  re-checks, it never double-commits), but it doesn't perform retries for
  you.

## Files

```
src/
  pricing.ts              Pure pricing math + the cache-multiplier fix
  pricing.test.ts
  preCallCeiling.ts        Pre-call dollar ceiling, live rates required
  preCallCeiling.test.ts
  reserveConfirm.ts        UsageLedger contract + withReserveConfirm orchestrator
  reserveConfirm.test.ts
  index.ts                 Barrel export
reference-impl/
  supabase-usage-ledger.sql  Postgres/Supabase implementation of UsageLedger
```
