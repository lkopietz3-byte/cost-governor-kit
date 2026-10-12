# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - unreleased

Minor release. The exports are all additive: every 0.2.1 export is still there
with the same name and signature. A few inputs that were accepted now throw, and
three results changed, so read the list below before upgrading.

### Breaking changes

- **`expiresAt` must carry a time zone.** `withCapacityReservation` used to read
  a zone-less `expiresAt` as the server's local time; it now throws a
  `RangeError` for anything that is not a strict ISO-8601 date-time ending in
  `Z` or `+hh:mm` / `-hh:mm`. Also rejected: non-ISO text (`"2099"`,
  `"Dec 25, 2099"`), impossible dates (`02-30`, `T24:00`), a space instead of
  `T`, lowercase `t` or `z`, an offset without a colon (`+0000`) or with hours
  only (`+00`), and more than nine fractional digits. Migration: format the
  value in the adapter before returning it, for example
  `new Date(row.expires_at).toISOString()`; raw Postgres text such as
  `2026-10-10 16:17:14.411+00` must be converted. Fractional seconds past
  milliseconds are truncated.
- **`request.amount` is now read.** A `withCapacityReservation` request that
  carries an `amount` which is not a safe integer >= 1 (for example `null` or a
  string) now throws before the adapter is called; before, the field was
  ignored. Migration: remove the field, or rename it, if it was unrelated to
  micro-dollar holds.
- **`checkPreCallCeiling` omits `reason` when allowed.** The key used to be
  present with the value `undefined`. This changes `Object.hasOwn`,
  `Object.keys` and strict-equality checks on the result. Migration: branch on
  `allowed`, and read `reason` only when it is false.
- **A throwing work-outcome getter no longer throws.** If the outcome that
  `doTheWork` returned has a getter or Proxy trap that throws, the result is
  now `work_outcome_ambiguous` with the hold kept, where the error used to
  escape after the paid work ran. Migration: handle that result status (you
  already needed to for other unreadable outcomes); a surrounding `catch` no
  longer sees this case.

### Added

- **Multi-scope admission control** (new subpath `cost-governor-kit/admission`,
  also on the root): `admitBeforeCall(store, { scopes, window?, timeoutMs? })`
  counts one attempt against every scope before a paid call, all or nothing,
  through an `AdmissionStore` you write. It never throws, never retries and
  never refunds: a store throw, a timeout (default 5,000 ms), a malformed reply
  (wrong status, a missing or non-canonical `windowId`, a `scopeKey` that was
  not requested, an admit past a zero limit) and a malformed request (blank or
  duplicate keys, bad limits, no scopes) all resolve to
  `{ status: 'unavailable', reason }`. `admissionHttpStatus(outcome, opts?)`
  maps a well-formed admitted outcome (a canonical `windowId`, no `scopeKey`)
  to `null` and anything malformed to 503, limited on a per-user scope to 429, and limited on a
  global scope or unavailable to 503. A reply that arrives after the
  deadline (measured before the store is called, so event-loop blocking counts)
  is a timeout even if it says admitted; the scopes array's `length` is read
  once. `createInMemoryAdmissionStore({ now? })`
  is a single-process reference store for unit tests only; it does not hold a
  cap across instances. Also exports `DEFAULT_ADMISSION_TIMEOUT_MS` and the
  `AdmissionScope`, `AdmissionWindow`, `AdmissionRequest`, `AdmissionDecision`,
  `AdmissionStore`, `AdmitOutcome`, `AdmissionUnavailableReason`,
  `AdmitBeforeCallRequest`, `AdmissionHttpStatusOptions` and
  `InMemoryAdmissionStoreOptions` types.
- README: "Admission control (the pattern most apps need)", with store recipes
  for Postgres (a `security definer` function owned by the migration role, so
  the server role needs only `EXECUTE`; tested on PGlite by
  `src/admissionRecipePglite.test.ts`, one connection, including an ordinary
  non-owner role without `BYPASSRLS`), Cloudflare D1 (`db.batch()` with a `CHECK` constraint; batch
  rollback is Reported from Cloudflare's docs) and Redis/Upstash (one Lua
  `EVAL`; not run). Each is a recipe the app owns and tests.
- **Integer micro-dollar reservations:** an optional `amount` on
  `ReserveCapacityRequest`; a succeeded work outcome may carry
  `settle: { actualAmount } | { usage: 'unknown' }`, and `confirmReservation`
  then receives a `CapacitySettlement` (`usage`, `amount`, `reservedAmount`).
  Unknown usage keeps the full estimate; a reported `-0` is recorded as `0`.
  Without `amount`, behavior is unchanged. New types `CapacitySettlement`, `CapacitySettle`.
- `createCommitOnce(fn)`: runs a commit at most once under concurrent and
  repeated calls, for counting a stream on its first visible output. A failure
  is surfaced to every caller and is final for that instance. New types
  `CommitOnce`, `CommitOnceState`.
- The observatory example vendors the new `admission` module too.
- **Dated integer-micro price tables.** `definePricingTable({ checkedAt, source,
  rates })` takes entries `{ inputPerMTokMicros, outputPerMTokMicros,
  cacheWritePerMTokMicros?, cacheWrite1hPerMTokMicros?, cacheReadPerMTokMicros?,
  longContext? }` keyed `provider:model` (safe integers; the kit ships no
  prices) and returns a deeply frozen table. `priceFor(table, key)` returns
  `{ status: 'found', key, price }` or `{ status: 'unknown-model', key? }`, with no
  fallback price. `assertPricingFresh(table, { now, maxAgeDays })` takes `now`
  from the caller. New types `DatedPricingTable`, `PricingTableDefinition`,
  `MicrosPrice`, `MicrosRates`, `LongContextRates`, `PriceLookup`,
  `PricingFreshnessOptions`.
- `estimateCostMicros(usage, price)`: exact BigInt arithmetic in whole
  micro-dollars, rounded up once on the sum, with cache-read, 5-minute and
  1-hour write prices and long-context prices; a bucket with tokens and no
  price throws, and any positive cost is at least 1.
- `usageFromAnthropic(usage)` and `usageFromOpenAI(usage)`: provider usage JSON
  to `{ status: 'known', usage }` (token counts) or `{ status: 'unknown', reason }`.
  They never throw. Missing usage, a string or non-finite count, a field the kit
  does not know, a hostile getter or Proxy and similar all read as unknown, which
  settles as `{ usage: 'unknown' }` and keeps the reserved estimate (never zero).
  A cache field that is absent counts as 0; one that is present and malformed is
  unknown. Fields the official SDK declares as informational or null/default
  (`output_tokens_details`, `inference_geo` of null or `'global'`, OpenAI
  `cache_write_tokens` of 0, `text_tokens`) do not make a reading unknown.
  `usageFromAnthropic` prices `cache_creation_input_tokens` as 5-minute writes
  when the `cache_creation` split is absent. New type `UsageReading`.
- `overrunAmount` on the `confirmed` and `confirmation_failed` results of an
  amount reservation, present only when the reported actual exceeded the hold.
  The actual amount is still recorded in full.
- `createCommitOnce(fn).attempt()`: shares the single run, never rejects and
  returns `{ ran, status: 'committed', value }` or `{ ran, status: 'failed',
  error }`. New type `CommitOnceResult`.
- `withCapacityReservations(ledger, { scopes, operationId, amount }, doTheWork)`:
  reserve the same amount on 1 to 8 scopes (a per-user dollar cap inside a global
  one), run paid work once, and settle every scope. Resolves to `confirmed`
  (with `overrunAmount` when the actual passed the hold), `refused` (naming the
  scope; earlier holds released), `released_after_failure`, or
  `needs_reconciliation` (naming the scope; holds kept). New types
  `ReservationScope`, `ReserveScopesRequest`, `CapacityReservationsResult`.
- `createInMemoryCapacityLedger({ holdMs?, now? })`: a single-process
  `CapacityReservationLedger` for unit tests, with `usage(key)`.
- README: a worked path for daily dollar caps per user and global (call caps,
  `priceFor`, `estimateCostMicros`, `withCapacityReservations`, streaming with
  `createCommitOnce`), and a Postgres capacity-ledger recipe with a `utc-day` or
  `utc-month` window the database resolves. `src/capacityLedgerRecipePglite.test.ts`
  runs the README's SQL, adapter and both route examples; the opt-in
  `src/capacityLedgerPostgres.test.ts` (`npm run test:postgres`) fires 50
  concurrent connections at a real Postgres.
- `usageFromAnthropicStream(start, delta)`: merges a stream's `message_start`
  and final `message_delta` usage; unknown when no `message_delta` arrived.
  `usageFromOpenAIEmbeddings(usage)`: an input-only reading for embeddings.
  `usageFromAnthropic(usage, { allowInferenceGeo })` option and the type
  `AnthropicUsageOptions`.
- `checkPreCallCeiling({ ..., requireOutputTokens: true })` throws when
  `outputTokens` is missing instead of pricing it at $0. Off by default.
- README opening rewritten around the one job (fail-closed admission and spend
  caps on a database you already run), with a start-here map and a list of what
  the kit cannot see (keys built from unset ids, month windows, tiers, weights,
  store clocks).
- README: dated price tables, `estimateCostMicros` and the usage readers, with
  illustrative, dated example prices.

### Fixed

- **`expiresAt` is no longer read as local time.** The old `Date.parse` read a
  zone-less `2026-10-10T16:17:14.411` in the server's time zone, so an expired
  hold could be accepted or a live one rejected, and it rolled impossible dates
  forward (`02-30` became `03-02`). See Breaking changes.
- **A throwing work-outcome getter no longer loses the reservation.** Reading
  the outcome ran outside the protective `try`. See Breaking changes.
- **`checkPreCallCeiling` omits `reason` when allowed** (see Breaking changes).
- **The ceiling denial message no longer contradicts itself.** A ceiling that is
  not a whole number of micro-dollars is printed with the extra digits needed to
  read below the projected total (`$4.9999996`, not `$5.000000`). Whole
  micro-dollar ceilings print exactly as before.
- **README usage-mapping snippet** priced `cache_creation_input_tokens` at $0
  when the `cache_creation` TTL split was absent. It now prices the total as
  5-minute writes in that case. The README snippet is run by a test.

### Changed

- `npm run test:postgres` now runs both Postgres suites, one file at a time.
- CI runs `npm run test:postgres` in a new `postgres` job against a
  `postgres:17` service container and fails if that suite reports any skipped
  test.
- Tests: `test/verdict-table.test.ts` is a named table of verdicts, and
  `tsconfig.json` now type-checks `test/`. The build still emits only `src/`.
- The observatory example's vendored SDK copy is regenerated for the new source.

### Documented

- Always pass `outputTokens`, set to the request's `max_tokens` bound, in a
  ceiling check. An omitted bucket is priced at $0.
- A call under half a micro-dollar prices at $0, so a running total built from
  per-call estimates never grows from such calls. Reconcile from the provider's
  reported usage, or sum token counts and price the sum once.
- `expiresAt` must carry a time zone.

## [0.2.1] - 2026-10-07

No change to the library's behavior or API.

### Changed

- The README links to the [in-browser playground](https://lkopietz3-byte.github.io/honesty-kits/#cost-governor-kit) and the honesty kits family, and the npm homepage now points to the playground.
- Added the `honesty-kits` npm keyword so the family shows up together in search.

### Security

- Development lockfile: `source-map-js` 1.2.2 (GHSA-68fv-2mgg-jv7q). Development tooling only; the published package has no runtime dependencies.

## [0.2.0] - 2026-09-28

Minor release: inputs that used to be accepted now throw, and some error text
changed. The pricing arithmetic and rounding, the ceiling rule, the reservation
lifecycle, the result shapes and the export names are unchanged. Every exact
rounding regression value (for example `0.0195`, `103641.217812`,
`55999.511541`) is the same.

### Changed (breaking)

- **Records must be plain (CGK-001).** `rates`, `usage`, the
  `checkPreCallCeiling` argument (and its nested `rates` and
  `estimatedNextCallUsage`), a pricing table and a `withCapacityReservation`
  request must be plain or null-prototype objects (a record from another realm
  counts as plain). A `Map`, `Set`, `Date`, `RegExp`, array or class instance
  now throws a `TypeError`. Before, `estimateCostUsd` priced a `Map` usage as
  `0`, so `checkPreCallCeiling` allowed it under a `$0` ceiling, and
  `getRatesOrThrow` treated a `Map` table as empty.
- **`getRatesOrThrow` needs a string model.** A `String` object, an array, or an
  object with a `toString` used to be coerced into a key (`['a']` matched `a`).
  It is now a `TypeError`.
- **`withCapacityReservation` rejects blank ids.** A `key`, `operationId` or
  reservation `id` made only of whitespace and invisible characters
  (zero-width space, bidi controls, soft hyphen, variation selectors, Hangul
  fillers) used to pass a `trim()` check. It now throws a `RangeError` like an
  empty string. `withReserveConfirm` does not validate `key` or `limit`: it
  passes both to your ledger as given, so a blank key is for your ledger to
  reject.
- **`withCapacityReservation` confirms and releases its own snapshot.** The
  reservation your adapter returns is copied once. `doTheWork` receives a
  frozen shallow copy, and the snapshot is what `confirmReservation` or
  `releaseReservation` gets and what the result's `reservation` holds. Before,
  the callback received the very object that was confirmed later, so it could
  change the `id` being confirmed (or your adapter could edit its own object
  while the work ran). Assigning to the frozen copy throws in strict mode, so an
  uncaught assignment makes the outcome `work_outcome_ambiguous` and nothing is
  confirmed. Extra fields your adapter puts on the reservation are kept on the
  snapshot, and `id`, `key`, `operationId` and `expiresAt` are still read once
  even when they are inherited or non-enumerable.
- **`withCapacityReservation` reads its input once.** It validates a copy of the
  request and hands the adapter a fresh `{ key, limit, operationId }` object,
  not your object, so an adapter or a caller that changes the request while the
  call is in flight cannot change what the reservation is compared against.
  The decision, reservation and work outcome are read once too. Before, the
  request was re-read after the `await`.
- **One read of rates, usage and the check.** `estimateCostUsd` and
  `checkPreCallCeiling` read each field once and price from that copy. A getter
  or proxy that answered differently on a second read could pass validation
  and then be priced from a negative or changed value.
- **Text built from your strings is escaped.** Control, line-break and bidi
  characters in an unknown usage key, a model name, the known-model list and an
  adapter's unknown decision status print as `\n` or `\u{HEX}`, and the status is
  now quoted (`unknown reservation decision status "surprise"`). Values in
  `checkPreCallCeiling`'s type errors and `formatRatesForLog` are rendered
  without calling their `toString`, so a hostile value can no longer change the
  error type or forge a log line. `formatRatesForLog` prints a non-number rate
  by kind (a string is quoted) instead of interpolating it.
- **Messages:** a `null` or `undefined` `rates` now says `rates must be an
  object ...` (it used to name `rates.inputPerMillion`), and a non-object
  `checkPreCallCeiling` argument gets a clear `TypeError` instead of the
  engine's own.

### Fixed

- **Unknown usage fields cannot hide.** `estimateCostUsd`, and
  `checkPreCallCeiling` through it, inspects every own key of `usage`
  (`Reflect.ownKeys`). Before, only enumerable string keys were checked, so a
  non-enumerable `input_tokens` or a symbol-keyed field was skipped and its
  tokens priced at $0, and the README's "any unknown key throws" was false.
  Now an unknown string key throws `unknown field "..."`, and an unknown
  symbol key throws `unknown symbol-keyed field` (without echoing the symbol).
  A known bucket that is not enumerable is still read and validated; that is
  the documented choice, and it is tested.
- **CGK-002:** the commented `supabaseUsageLedger` example in
  `reference-impl/supabase-usage-ledger.sql` logged a warning and resolved when
  the RPC returned `committed: false`, so `withReserveConfirm` reported the call
  as recorded. It now rejects on `committed: false` and on a missing or
  malformed RPC response (the error text leaves the key out).
  `withReserveConfirm` then returns the paid result with `commitError` set and
  never repeats the paid call. Only comment lines of the SQL file changed.
- **CGK-003:** the README example detected an unrecorded commit with
  `if (result.commitError)`, which misses a rejection with `undefined`, `null`,
  `false`, `0` or `''`. It now uses `Object.hasOwn(result, 'commitError')`, and
  the TSDoc says so. Library behavior is unchanged (`commitError` was already an
  own property in all five cases).

### Added

- `typesVersions` in `package.json`, so TypeScript's `node10` resolution finds
  `cost-governor-kit/pricing`, `/preCallCeiling` and `/reserveConfirm`. The
  `attw` script no longer needs `--profile node16`.
- CI compatibility jobs on Node 20.19.0 and 22.12.0 (the `require(esm)` floors)
  that run the tests and `scripts/verify-package.mjs`, which includes the
  CommonJS consumer probe. The release workflow now fails unless it runs on a
  `v*` tag that matches `package.json` (for both triggers), runs the dependency
  audit, `npm run verify` and `npm run attw`, and treats only a confirmed
  registry `E404` as "not published".
- Tests: 446 pass and 1 skips without `COST_GOVERNOR_PG_URL` (0.1.0 had 204 and
  1). They now cover the adapter-returned reservation and outcome shapes, a
  `null` `rates`, the exact-millisecond expiry boundary, the extracted SQL
  adapter running through `withReserveConfirm` on PGlite, and the five falsy
  rejections. Mutation testing (Stryker, run locally, not committed): 87.03%
  before, 100% after (537 killed, none survived). v8 line and branch coverage:
  95.2% and 94.7% before, 100% and 100% after.
- README: a load-and-Node-version compatibility table, the input rules, and
  honest limits for the copies and the SQL adapter sketch. `PROJECT_CONTEXT.md`'s
  purpose line no longer says counting is safe under concurrent requests.
  `ENGINEERING.md` no longer says unpublishing is unavailable after 72 hours; it
  points to npm's policy page.

## [0.1.0] - 2026-09-27

First release.

### Added

- `estimateCostUsd`, `getRatesOrThrow`, `formatRatesForLog` and the
  `CACHE_READ_MULTIPLIER` (0.1), `CACHE_CREATION_5M_MULTIPLIER` (1.25) and
  `CACHE_CREATION_1H_MULTIPLIER` (2) constants: pricing math with
  caller-supplied rates, cache reads and both cache-write TTLs priced as
  separate line items, results rounded to the nearest micro-dollar.
- `ModelRates.cacheReadPerMillion` (optional): a per-model cache-read price
  that replaces the fixed 0.1x ratio for a model whose real cache-read rate is
  different (for example 0.025x or 0.05x on some current Anthropic models).
- `checkPreCallCeiling`: allows the next call only when spend so far plus the
  call's estimated cost, rounded to the micro-dollar, is at or below a hard
  ceiling.
- `withReserveConfirm` and `UsageLedger`: advisory check-then-commit that never
  counts a call that throws. Not a limit under concurrency. If `commitUsage`
  rejects after a successful call, the result is returned with `commitError`
  set instead of being discarded.
- `withCapacityReservation` and `CapacityReservationLedger`: reserve, run one
  classified operation, then confirm or release, with explicit recovery
  statuses. The limit is enforced by the caller's adapter; none is included.
- Subpath entry points `./pricing`, `./preCallCeiling` and `./reserveConfirm`.
- `reference-impl/supabase-usage-ledger.sql`: a Postgres sketch of the advisory
  `UsageLedger`, shipped as reference material. `npm test` applies it to a
  fresh PGlite database and exercises the check/commit RPCs and the grant fix
  (see Behavior worth knowing); PGlite is a single connection and does not
  test concurrent sessions. A separate, opt-in `npm run test:postgres`
  (`src/referenceImplPostgres.test.ts`, skipped unless `COST_GOVERNOR_PG_URL`
  is set, not run by `npm test`/CI) exercises 50 real concurrent Postgres
  sessions against `usage_ledger_commit_usage` and proves the row lock caps
  the recorded count at the limit, while `usage_ledger_check_under_limit` is
  genuinely advisory under that same concurrency.

### Behavior worth knowing

- Inputs are validated before any cost decision. Rates must be finite and
  non-negative; token counts must be non-negative safe integers; unknown usage
  keys (such as a provider's `input_tokens`) and arrays throw instead of being
  priced at $0.
- `getRatesOrThrow` matches only a table's own keys, so names such as
  `constructor` throw like any unknown model.
- `withReserveConfirm` throws a `TypeError` unless the ledger's check resolves
  a real boolean.
- The reference SQL revokes the default `PUBLIC` execute grant on its
  `SECURITY DEFINER` functions and enables row level security on its table;
  a PGlite test proves a role with no grant is denied and `service_role` is
  allowed.
- CommonJS `require("cost-governor-kit")` works alongside `import`, on Node
  20.19+/22.12+ (`require(esm)` support); `exports` adds a `default`
  condition next to `import` for every entry point.
- Every input-validation failure in `pricing.ts`, `preCallCeiling.ts` and
  `reserveConfirm.ts` throws a `TypeError` (wrong type or shape) or a
  `RangeError` (right type, bad value) instead of a plain `Error`, matching
  the sibling kits. Plain `Error` remains only for the internal "result
  overflowed to non-finite" safety net and `getRatesOrThrow`'s
  unconfigured-model lookup, neither of which is malformed input.
- README's Quickstart now imports from the package root
  (`from 'cost-governor-kit'`) as the primary example; the per-module
  subpaths (`/pricing`, `/preCallCeiling`, `/reserveConfirm`) remain
  available and are documented as an option. The root import also resolves
  under TypeScript's legacy `node10` resolution, which the subpaths do not.
- `build` clears `dist/` before invoking `tsc`, and `verify:package` checks
  every shipped source map's `sources` resolve, so a stale build can no
  longer ship a dangling map. This kit still emits no source maps by
  design (see README's "Honest limits"); the check is a no-op guard against
  a future regression, not a behavior change today.
