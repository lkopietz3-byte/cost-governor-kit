# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

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
