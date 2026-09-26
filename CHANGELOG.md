# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First release. Not yet published to npm.

### Added

- `estimateCostUsd`, `getRatesOrThrow`, `formatRatesForLog` and the
  `CACHE_READ_MULTIPLIER` (0.1), `CACHE_CREATION_5M_MULTIPLIER` (1.25) and
  `CACHE_CREATION_1H_MULTIPLIER` (2) constants: pricing math with
  caller-supplied rates, cache reads and both cache-write TTLs priced as
  separate line items, results rounded to the nearest micro-dollar.
- `checkPreCallCeiling`: allows the next call only when spend so far plus the
  call's estimated cost, rounded to the micro-dollar, is at or below a hard
  ceiling.
- `withReserveConfirm` and `UsageLedger`: advisory check-then-commit that never
  counts a call that throws. Not a limit under concurrency.
- `withCapacityReservation` and `CapacityReservationLedger`: reserve, run one
  classified operation, then confirm or release, with explicit recovery
  statuses. The limit is enforced by the caller's adapter; none is included.
- Subpath entry points `./pricing`, `./preCallCeiling` and `./reserveConfirm`.
- `reference-impl/supabase-usage-ledger.sql`: a Postgres sketch of the advisory
  `UsageLedger`, shipped as reference material.

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
  `SECURITY DEFINER` functions and enables row level security on its table.
