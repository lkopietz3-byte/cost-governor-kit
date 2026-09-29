# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

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
- **Blank ids are rejected.** A `key`, `operationId` or reservation `id` made
  only of whitespace and invisible characters (zero-width space, bidi controls,
  soft hyphen, variation selectors, Hangul fillers) used to pass a `trim()`
  check. It now throws a `RangeError` like an empty string.
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
- Tests: 437 pass and 1 skips without `COST_GOVERNOR_PG_URL` (0.1.0 had 204 and
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
  20.19+/22.12+ (`require(esm)` support) — `exports` adds a `default`
  condition next to `import` for every entry point.
- Every input-validation failure in `pricing.ts`, `preCallCeiling.ts` and
  `reserveConfirm.ts` throws a `TypeError` (wrong type or shape) or a
  `RangeError` (right type, bad value) instead of a plain `Error`, matching
  the sibling kits. Plain `Error` remains only for the internal "result
  overflowed to non-finite" safety net and `getRatesOrThrow`'s
  unconfigured-model lookup — neither is malformed input.
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
