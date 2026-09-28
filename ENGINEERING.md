# Engineering contract

## Invariants

- Zero runtime dependencies. No I/O, no price table, no default rates.
- Pricing keeps five buckets; cache reads (0.1x by default, or
  `ModelRates.cacheReadPerMillion` when supplied), 5-minute writes (1.25x) and
  1-hour writes (2x) are distinct line items. Results round to the nearest
  micro-dollar with `Math.round`.
- Invalid inputs throw before any cost decision: non-finite or negative rates,
  token counts that are not non-negative safe integers, unknown usage keys.
  Every one of these throws a `TypeError` (wrong type or shape) or a
  `RangeError` (right type, bad value), matching the sibling kits; plain
  `Error` is reserved for the internal "result overflowed to non-finite"
  safety net and for `getRatesOrThrow`'s unconfigured-model lookup, neither
  of which is a malformed-input case.
- `checkPreCallCeiling` allows iff the rounded projected total is `<=` the
  ceiling. It is pure.
- `withReserveConfirm` never commits a call that throws, and fails closed on a
  non-boolean check. Advisory under concurrency; a rejected `commitUsage`
  returns the result with `commitError` set, not discarded.
- `withCapacityReservation` runs work at most once, only after a validated
  `acquired` decision; calls confirm or release at most once, never both;
  never retries; never releases after an ambiguous outcome. The strict limit,
  atomicity, duplicate suppression and durability belong to the caller's
  adapter.

## Set up and verify

Node 20 or later (CI's main job pins Node 26.3.0). From the repository root:

```sh
npm ci
npm run verify          # lint, typecheck, test, build, verify:package
npm run audit:dependencies
```

`verify:package` packs the build, rejects tests/configs/scripts in the
tarball, installs it offline into a temporary project, imports every export,
compares runtime export names with `api-surface.json`, runs
`scripts/consumer-probe.mjs`/`.cjs`, and compiles `scripts/consumer-probe.mts`
with strict NodeNext settings. After an intended export change, run
`node scripts/verify-package.mjs --update-api` and review the diff.

## Packaging

This is an ESM package; `exports`' `default` condition also lets plain
CommonJS `require("cost-governor-kit")` work, on Node 20.19+/22.12+
(`require(esm)` support — see README). No source maps are shipped
(deliberate, not an oversight — see README's "Honest limits").
`build` clears `dist/` before invoking `tsc`, since `tsc` does not delete
outputs it stopped emitting.

CI (`.github/workflows/verify.yml`) runs audit, lint, typecheck, test, build
and `verify:package` on Node 26.3.0, plus build, test and `verify:package` on
Node 20, 22 and 24. Actions are pinned by commit SHA.

`npm run test:postgres` runs `src/referenceImplPostgres.test.ts` against a
real, locally running Postgres 17, pointed at by `COST_GOVERNOR_PG_URL`. It is
skipped (not run) by `npm test`, `npm run verify`, or CI when that variable is
unset, so it needs no CI infrastructure and adds no dependency to the normal
verify path. See README.md ("Reference SQL (advisory only)") for the exact
commands to start a throwaway server and run it. It is the only test that
proves anything about concurrent Postgres sessions.

## Not certified

- No real storage adapter is tested. Unit tests use single-process in-memory
  doubles; they prove the helpers' call sequencing, not atomicity.
- The reference SQL runs against PostgreSQL 18 via PGlite in `npm test` (CI
  covers it), a **single connection**: this proves the grant fix and the
  check/commit/window logic, not concurrent sessions or a live Supabase
  project. `npm run test:postgres` (not run by CI; see above) covers real
  concurrent sessions against a local Postgres 17 and proves
  `usage_ledger_commit_usage`'s row lock caps the recorded count exactly at
  the limit under 50 concurrent commits, and that
  `usage_ledger_check_under_limit` is genuinely advisory under concurrency.
  It still does not prove anything about a live Supabase project (its role
  and default-privilege setup, PgBouncer pooling) or behavior under a network
  partition or Postgres failover.
- No provider billing is checked. Multipliers match Anthropic's pricing page as
  read on 2026-09-24, except models with a non-0.1x cache-read rate and no
  `cacheReadPerMillion` override.
- A clean `npm audit` covers known advisories at the time of the run only.

## Are the types wrong? (attw)

CI runs [`arethetypeswrong`](https://github.com/arethetypeswrong/arethetypeswrong.github.io)
(`npm run attw`, which is `attw --pack . --ignore-rules cjs-resolves-to-esm --profile node16`)
against the packed tarball after the build step. The `cjs-resolves-to-esm` rule is ignored on
purpose: this is an ESM-only package (`"type": "module"`, no `require` entry point), so a
CommonJS consumer must use Node's `require(esm)` support (Node >=20.19 or >=22.12 — see
"Runtime support policy" below) rather than a native `require`. A dual CJS+ESM build was
rejected to avoid the dual-package hazard (two separately-identified copies of the same module,
with broken `instanceof` checks and duplicated module state across the CJS and ESM entry
points).

`attw`'s strict Node 10 resolution check currently fails for this package's `./pricing`, `./preCallCeiling`, and `./reserveConfirm` subpath exports because there is no `typesVersions` fallback for a CommonJS-style (`moduleResolution: node`) resolver. CI runs with `--profile node16` to stay green while that's true. Fixing it needs a `typesVersions` entry in `package.json`, which ships in the npm tarball — out of scope for this repo-hygiene pass; it is planned for the per-kit follow-up pass.

## Release and rollback

`npm run verify` (lint, typecheck, test, build, verify:package) runs automatically before
publish via the `prepublishOnly` script, so a broken build cannot reach the registry by
accident. To release: add a dated entry to `CHANGELOG.md`, bump `version` in
`package.json`, commit, and push a `vX.Y.Z` tag that matches the new version, then let
`.github/workflows/release.yml` install, verify, and publish it. (You can also run
`npm publish` locally; `prepublishOnly` still guards it.)

npm's unpublish policy is deliberately narrow. Within 72 hours of publishing, a version can be
unpublished only if no other published package depends on it. After 72 hours, unpublishing also
requires fewer than 300 downloads in the last week and a single maintainer — most released
versions won't qualify either way. A given `name@version` can never be reused, published or
not, even after an unpublish. Treat unpublish as unavailable: prefer fixing forward with a new
patch version, and use `npm deprecate <name>@"<range>" "<message>"` to warn consumers off a
bad release while it stays installable for anyone already pinned to it.

Before publishing, also check the `npm pack --dry-run` file list and the downstream
`honesty-mcp` build, since that server consumes this package's subpath exports directly.
Rollback for consumers is pinning the previous version or commit; do not roll back past
a validation fix without restoring an equivalent check.

### Runtime support policy

- **Supported (recommended for production):** Node 22 and 24 LTS; Node 26 current.
- **Compatibility-tested:** Node 20. Node 20 is end-of-life — nodejs.org's release page
  (<https://nodejs.org/en/about/previous-releases>) lists it as `EOL`, with its final release
  dated Mar 24, 2026. The `compat` job in `verify.yml` still runs on Node 20 to catch
  regressions, but that runtime gets no security fixes upstream; don't run production traffic
  on it.
- CommonJS `require()` of this package needs Node >=20.19 or >=22.12 (`require(esm)`
  support). ESM `import` works on every version this package tests (20, 22, 24).
- `engines` in `package.json` is unchanged by this policy.

### Publishing with provenance

`.github/workflows/release.yml` publishes using npm trusted publishing: it triggers on
`workflow_dispatch` or a pushed `v*` tag, requests a short-lived OIDC token instead of
reading a stored npm token (`permissions: id-token: write`), and runs a plain `npm publish`
with no token and no `--provenance` flag, because provenance attestation is generated
automatically under trusted publishing. Before publishing, the workflow confirms the tag
matches `package.json`'s `version` and checks whether that version is already on the
registry, so re-running it on a version that's already published is a no-op rather than an
error. Trusted publishing must be configured for this package on npmjs.com (linking it to this
GitHub repository and the `release.yml` workflow) before the first automated release will
work.
