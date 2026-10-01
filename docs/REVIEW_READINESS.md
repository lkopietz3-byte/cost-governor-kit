# Review and launch readiness

Prepared September 30, 2026 against GitHub main `e8601b90950938d7d8a6dab31b8860dc557ac1e9`. This document records a preparation plan, not a production or marketing certification.

## Review cadence

Keep automatic code reviews off during preparation. Request one focused `@codex review` on a meaningful candidate PR after relevant checks; repeat only when material changes invalidate the previous review. Do not add a recurring review schedule.

When this repo enters sustained launch/customer-facing development, enable its repository setting individually with **All PRs / On PR open / Exhaustive Off**. Keep the personal automatic default and credit-funded reviews off. Inspect the first result before expanding cadence. Review guidance lives in the root [AGENTS.md](../AGENTS.md); automated review supplements existing tests and release requirements.

The September 29 settings observation is historical, not a current settings receipt. These preferences are managed in ChatGPT; this PR changes no settings.

## Verified release state

npm lists cost-governor-kit 0.2.0. The published tarball has 15 files and excludes
repository examples. honesty-mcp 0.2.0 now consumes ^0.2.0 of this kit. The earlier
brace-expansion audit failure was addressed on main by PR #15; the candidate's
current audit result is recorded in this PR rather than carried forward from an
older run. API and installed-package checks remain requirements for future changes.

## Ongoing review checks for reservation examples

`withReserveConfirm` is advisory check-then-commit, not a concurrency-safe limit.
`withCapacityReservation` only orchestrates a caller-supplied ledger; atomicity,
durability, strict limits and duplicate suppression depend on that adapter.
Preserve holds after ambiguous work or confirmation rejection, and keep known
estimated spend separate from unknown usage and provider billing. Pricing defaults
to a fixed 0.1x cache-read ratio unless `cacheReadPerMillion` overrides it.

The separate [observatory draft PR #16](https://github.com/lkopietz3-byte/cost-governor-kit/pull/16)
demonstrates synthetic sequential capacity decisions. It is under review, absent
from current main and excluded from this documentation PR. It does not establish
production concurrency, provider billing or a strict dollar budget. Lucas owns
its public branding decision.

## Declared verification commands

Read from the inspected main's `package.json`. The updated documentation branch passes `npm run verify`. Exact candidate and hosted results are recorded in the PR body; report any unavailable check rather than treating it as passed. Use focused checks during implementation and existing release gates on the frozen candidate.

- `npm run verify`: `npm run lint && npm run typecheck && npm test && npm run build && npm run verify:package`
- `npm run lint`: `eslint . --max-warnings=0`
- `npm run typecheck`: `tsc --noEmit`
- `npm run test`: `vitest run`
- `npm run build`: `node -e "require('fs').rmSync('dist',{recursive:true,force:true})" && tsc -p tsconfig.build.json`
- `npm run attw`: `attw --pack . --ignore-rules cjs-resolves-to-esm`
- `npm run test:postgres`: `vitest run src/referenceImplPostgres.test.ts`

Local tests, hosted authorization, published package resolution, deployed behavior and demand are separate evidence. Dated receipts apply to their recorded revision.

## Source basis

- [ENGINEERING.md](../ENGINEERING.md)
- [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md)
- [src/reserveConfirm.ts](../src/reserveConfirm.ts)

Public marketing claims must be supported by current candidate evidence. Private-data transfers, commercial commitments, database promotion and deployment retain their existing authorization boundaries.
