# Engineering contract

## Invariants

- Zero runtime dependencies. No I/O, no price table, no default rates.
- Pricing keeps five buckets; cache reads (0.1x by default, or
  `ModelRates.cacheReadPerMillion` when supplied), 5-minute writes (1.25x) and
  1-hour writes (2x) are distinct line items. Results round to the nearest
  micro-dollar with `Math.round`.
- Invalid inputs throw before any cost decision: non-finite or negative rates,
  token counts that are not non-negative safe integers, unknown usage keys, and
  any record that is not a plain or null-prototype object (a `Map`, `Set`,
  `Date`, `RegExp`, array or class instance is never priced as zero usage or
  read as an empty table).
  Every one of these throws a `TypeError` (wrong type or shape) or a
  `RangeError` (right type, bad value), matching the sibling kits; plain
  `Error` is reserved for the internal "result overflowed to non-finite"
  safety net and for `getRatesOrThrow`'s unconfigured-model lookup, neither
  of which is a malformed-input case.
- `checkPreCallCeiling` allows iff the rounded projected total is `<=` the
  ceiling. It is pure.
- Caller input is read once. Each field of rates, usage, the ceiling check and
  the capacity request is read a single time, and the code validates and
  computes from that copy. The same goes for the adapter's decision,
  reservation and work outcome.
- A key, operationId or reservation id that shows nothing (only whitespace and
  Default_Ignorable_Code_Point characters) is blank and rejected. A model name
  is only looked up if it is a string.
- Text built from caller or adapter strings (error messages, `formatRatesForLog`)
  escapes control, line-break and bidi characters. Structured results stay raw.
- `withReserveConfirm` never commits a call that throws, and fails closed on a
  non-boolean check. Advisory under concurrency; a rejected `commitUsage`
  returns the result with `commitError` set, not discarded. Detect it with
  `Object.hasOwn(result, 'commitError')`, never truthiness. The value
  `commitUsage` resolves is ignored, so only a rejection reports a failure.
- `withCapacityReservation` runs work at most once, only after a validated
  `acquired` decision; calls confirm or release at most once, never both;
  never retries; never releases after an ambiguous outcome. The strict limit,
  atomicity, duplicate suppression and durability belong to the caller's
  adapter.

## Set up and verify

Node 20 or later (CI's main job pins Node 26.3.0; 22 and 24 LTS are the
recommended runtimes). From the repository root:

```sh
npm ci
npm run verify          # lint, typecheck, test, build, verify:package
npm run audit:dependencies
```

Mutation testing is run by hand, not in CI: `npm i -D --no-save
@stryker-mutator/core @stryker-mutator/vitest-runner` and a local
`stryker.config.json` (not committed) with the vitest runner and
`mutate: ["src/**/*.ts", "!src/**/*.test.ts"]`. Before the 0.2.0 fix pass it
scored 87.03% (369 of 424 mutants killed; the 0.1.0 tests left the
adapter-returned shape guards and the `rates` null case untested). At 0.2.0 it
scores 100% (537 killed, none survived), and v8 coverage is 100% of lines and
branches (it was 95.2% and 94.7%). The v8 provider is
`@vitest/coverage-v8@4.1.11`, also installed with `--no-save`.

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

CI (`.github/workflows/verify.yml`) runs audit, lint, typecheck, test, build,
`attw` and `verify:package` on Node 26.3.0, plus build, test and
`verify:package` (which includes the CommonJS consumer probe) on Node 20, 20.19.0,
22, 22.12.0 and 24. 20.19.0 and 22.12.0 are the exact `require(esm)` floors;
the unpinned 20 and 22 track the latest release of each line. Actions are
pinned by commit SHA.

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
  project. The same test extracts the commented TypeScript adapter from the SQL
  file and runs it through a stub of the Supabase client's `rpc()`; it does not
  run `@supabase/supabase-js`. `npm run test:postgres` (not run by CI; see above) covers real
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
(`npm run attw`, which is `attw --pack . --ignore-rules cjs-resolves-to-esm`) against the
packed tarball after the build step, and the release workflow runs it too. All four entry points
(`.`, `./pricing`, `./preCallCeiling`, `./reserveConfirm`) resolve under `node10`, `node16`
(from CJS and from ESM) and `bundler`. `package.json` carries a `typesVersions` map for the
three subpaths because `node10` resolution ignores `exports`; it must be kept in step with
`exports` when a subpath is added.

The `cjs-resolves-to-esm` rule is ignored on purpose: this is an ESM-only package
(`"type": "module"`, no `require` entry point), so a CommonJS consumer must use Node's
`require(esm)` support (Node >=20.19 or >=22.12 — see "Runtime support policy" below) rather
than a native `require`. A dual CJS+ESM build was rejected to avoid the dual-package hazard
(two separately-identified copies of the same module, with broken `instanceof` checks and
duplicated module state across the CJS and ESM entry points).

## Release and rollback

`npm run verify` (lint, typecheck, test, build, verify:package) runs automatically before
publish via the `prepublishOnly` script, so a broken build cannot reach the registry by
accident. To release: add a dated entry to `CHANGELOG.md`, bump `version` in
`package.json`, commit, and push a `vX.Y.Z` tag that matches the new version, then let
`.github/workflows/release.yml` audit, verify, check types, and publish it. (You can also run
`npm publish` locally; `prepublishOnly` still guards it.)

npm's unpublish policy is narrow, and npm can change it: read
<https://docs.npmjs.com/policies/unpublish> before relying on it. As read on 2026-09-28, a
version published within 72 hours can be unpublished if no other public package depends on it;
after 72 hours it also needs fewer than 300 downloads in the past week and a single owner or
maintainer. A given `name@version` can never be reused, even after an unpublish. Fixing forward
is the normal recovery: publish a new patch version, and use
`npm deprecate <name>@"<range>" "<message>"` to warn consumers off a bad release while it stays
installable for anyone already pinned to it. Do not plan on unpublish.

Before publishing, also check the `npm pack --dry-run` file list and the downstream
`honesty-mcp` build, since that server consumes this package's subpath exports directly. A
0.x minor bump is outside a `^0.1.0` range, so a consumer on that range does not pick up
0.2.0 until it changes the range; 0.2.0 changed input validation (plain records, blank ids,
model-name type) and error text, and `honesty-mcp` must mirror it.
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
  support). ESM `import` works on every version this package tests (20, 22, 24). The
  `compat` job also runs Node 20.19.0 and 22.12.0 pinned, the exact `require(esm)` floors, and
  runs `scripts/verify-package.mjs`, which includes a CommonJS consumer probe.
- `engines` in `package.json` is unchanged by this policy.

### Publishing with provenance

`.github/workflows/release.yml` publishes using npm trusted publishing: it triggers on
`workflow_dispatch` or a pushed `v*` tag, requests a short-lived OIDC token instead of
reading a stored npm token (`permissions: id-token: write`), and runs a plain `npm publish`
with no token and no `--provenance` flag, because provenance attestation is generated
automatically under trusted publishing. Both triggers must run on a `v*` tag whose version
matches `package.json` (a manual run from a branch fails). The workflow then runs the
dependency audit, `npm run verify` and `npm run attw`. Finally it checks the registry: only a
confirmed `E404` means "not published yet", an existing version is a no-op rather than an
error, and any other registry error fails the job instead of guessing. Trusted publishing must
be configured for this package on npmjs.com (linking it to this GitHub repository and the
`release.yml` workflow) before an automated release will work.
