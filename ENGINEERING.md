# Engineering contract

## Scope and invariants

This is a dependency-free runtime library with caller-supplied rates. Keep the five token buckets and cache multipliers distinct, preserve valid arithmetic and exact-ceiling behavior, and reject malformed inputs before returning cost decisions. Public token counts are non-negative safe integers; projection callers must round averages up conservatively and validate their range.

The legacy usage helper is advisory under concurrency. Strict reservation correctness depends on a caller-owned durable atomic adapter; denial, duplicate operations and ambiguous provider outcomes must never cause automatic provider re-execution or blind release. Unit-test ledger doubles do not prove a real adapter. Read README and the affected public contracts before changing behavior.

## Reproducible checks

Use Node 26.3.0 and the committed lockfile on Linux or macOS. No credentials, provider calls or database are required by these checks. Run sequentially from the repository root:

```sh
npm ci --no-audit
npm run audit:dependencies
npm run lint
npm run typecheck
npm test -- --maxWorkers=1 --minWorkers=1
npm run build
npm run verify:package
```

`verify:package` requires the preceding build. It packs the actual exports, installs the tarball into a fresh temporary consumer offline with lifecycle scripts disabled, then checks runtime root/subpath imports, representative denial behavior and strict NodeNext declarations. It prints the evidence directory and successful tarball hash; temporary evidence is retained for inspection. This proves the package boundary with synthetic inputs, not provider billing or live concurrency behavior.

The **Library tests and package** job runs on every PR, main push and manual request using a clean Ubuntu runner. Errors stop the affected step/job; no advisory fallback is allowed. Actions use reviewed commit pins and weekly Actions and npm Dependabot update proposals. Review toolchain compatibility and supported version lines before accepting updates; no update is automatically merged. This does not establish that branch protection or npm security alerts are enabled. Pin updates must preserve the same check name and be verified before integration.

Source lint covers every TypeScript implementation/test file, Node ESM verification script and the lint config, using stable recommended correctness and type-aware rules with zero warnings. The only test-specific rule adjustment permits async functions without await: in-memory ledger doubles deliberately implement promised interfaces, including rejected-promise and scheduling semantics. Promise misuse and floating-promise checks still apply to tests. No source suppression is required. Typecheck remains separate.

The dependency audit includes development tooling and blocks on every reported severity; an unavailable advisory service is a failed check, not a clean security result. A clean audit covers known advisories at the time of the run, not all vulnerabilities. Vitest 3.2.7 and Vite 6.4.3 are exact development pins for the smallest compatible security repair; Vite 6.4 receives security backports. Review these support boundaries during updates. The package still declares no runtime dependencies.

Gate definitions are not pass evidence. Record each actual run against the final revision before claiming these checks are verified.

## Review and release

Record exact revision/dirty-file hashes, environment, commands, results and material limits. Preserve first failures; do not weaken assertions or deadlines to manufacture a pass. Use a separate skeptical review for pricing, quota or durable-data changes. Check affected downstream consumers before integrating a runtime contract change.

Green CI establishes only the checks it actually ran. Main integration, published version/consumer verification, real adapters/providers and production outcomes are separate gates. Apply existing authorization requirements to merges, npm publication, provider calls, deployments and data operations. No workflow step performs those actions.

Before a package release, choose a compatible version and migration plan, verify actual consumers and the final packed version, and record the previous known-working package version plus the consumer rollback procedure. Avoid blindly reverting a safety fix; a consumer rollback must still protect the original boundary. Preserve the separate reservation and numeric repair reviews when integrating their stacked branches.
