# Cost Governor Kit

A small TypeScript library for estimating AI-call costs, checking a caller-defined spending ceiling before a call, and tracking successful usage through a reserve-then-confirm interface.

The examples below use hypothetical application data and do not report a particular organization or measured application fleet. This library is a set of utilities; it does not provide compliance certification, a complete billing system, or a guarantee that your estimated spend matches the provider's final charge.

## Start here

```sh
npm install
npm test
npm run typecheck
```

The package is ESM and has no runtime dependencies. The test suite uses Vitest. It is MIT licensed.

## 1. Estimate a call's cost

Pass the rates you have verified for your provider and model. The library does not ship a model-price table.

```ts
import { estimateCostUsd, type ModelRates } from "cost-governor-kit/pricing";

const rates: ModelRates = {
  inputPerMillion: 3,
  outputPerMillion: 15,
};

const estimatedUsd = estimateCostUsd(rates, {
  inputTokens: 1_200,
  outputTokens: 400,
  cacheReadTokens: 8_000,
  cacheCreation5mTokens: 2_000,
  cacheCreation1hTokens: 0,
});
```

The usage object keeps cache reads and the two cache-creation time-to-live buckets separate. Provider prices and multipliers can change, so check current provider documentation and the constants in `src/pricing.ts` before using the result for a budget decision. Reconcile estimates against actual usage returned by the provider.

### Hypothetical example

Suppose a caller's current provider price card assigns different rates to cache reads, five-minute cache writes, and one-hour cache writes. The caller passes those verified rates and token counts separately; `estimateCostUsd` can then account for each bucket. Combining the two write buckets under one rate would misstate the estimate for whichever bucket has a different price. This is an illustrative pricing scenario only.

## 2. Check a pre-call ceiling

`checkPreCallCeiling` estimates the cost of the next call and reports whether the projected total is within the ceiling. Call it before making the provider request.

```ts
import { checkPreCallCeiling } from "cost-governor-kit/preCallCeiling";

const rates = { inputPerMillion: 3, outputPerMillion: 15 };

const check = checkPreCallCeiling({
  spentSoFarUsd: 4.25,
  ceilingUsd: 25,
  estimatedNextCallUsage: {
    inputTokens: 2_000,
    outputTokens: 500,
  },
  rates,
});

if (!check.allowed) {
  throw new Error(check.reason);
}

const response = await callYourProvider();
// Reconcile using the actual usage in `response` before the next estimate.
```

This decision is only as accurate as `estimatedNextCallUsage` and the rates supplied by the caller. A low estimate can allow more spend than intended. The function does not see the provider response and cannot enforce a provider-side cap.

## 3. Count successful usage

`withReserveConfirm` checks a caller-provided ledger before invoking a call, then records usage after the call succeeds. If the call throws, the error propagates and usage is not committed.

```ts
import {
  withReserveConfirm,
  type UsageLedger,
} from "cost-governor-kit/reserveConfirm";

declare const ledger: UsageLedger;

const result = await withReserveConfirm(
  ledger,
  `account:${accountId}:day:${day}`,
  5,
  () => callYourProvider(prompt),
);

if (!result.allowed) {
  return send429("Usage limit reached");
}

return send200(result.result);
```

The storage adapter implements:

```ts
interface UsageLedger {
  checkUnderLimit(key: string, limit: number): Promise<boolean>;
  commitUsage(key: string): Promise<void>;
}
```

The adapter is responsible for safe behavior under concurrent requests. Two calls can pass the initial check at nearly the same time, so `commitUsage` must enforce the intended limit atomically for a key. `reference-impl/supabase-usage-ledger.sql` demonstrates a Postgres/Supabase adapter using a row lock; review and adapt it for your schema before use.

## Modules

- `src/pricing.ts` — pure cost calculations and pricing constants
- `src/preCallCeiling.ts` — projected pre-call ceiling check
- `src/reserveConfirm.ts` — ledger interface and reserve-then-confirm orchestration
- `reference-impl/supabase-usage-ledger.sql` — example Postgres/Supabase ledger

## Limits

- This is not abuse prevention, DDoS protection, or request-rate limiting. Use an appropriate rate-limit or WAF layer for that.
- A pre-call estimate is a prediction. Reconcile with actual provider usage and charges.
- The library cannot make a caller's custom `UsageLedger` atomic. Its correctness depends on the storage adapter.
- It does not retry calls, schedule jobs, store credentials, or contact a provider.
- It does not establish financial, regulatory, or contractual compliance.
