# Review and launch readiness

Prepared September 30, 2026 against GitHub main `dff9be2e447bc05117ff9a73b4abf808eb245866`. This document records a preparation plan, not a production or marketing certification.

## Review cadence

Keep automatic code reviews off during preparation. Request one focused `@codex review` on a meaningful candidate PR after relevant checks; repeat only when material changes invalidate the previous review. Do not add a recurring review schedule.

When this repo enters sustained launch/customer-facing development, enable its repository setting individually with **All PRs / On PR open / Exhaustive Off**. Keep the personal automatic default and credit-funded reviews off. Inspect the first result before expanding cadence. Review guidance lives in the root [AGENTS.md](../AGENTS.md); automated review supplements existing tests and release requirements.

The six repo settings were verified off on September 29, 2026. These preferences are managed in ChatGPT, not activated by committing this file.

## Next preparation task: Demonstrate advisory versus strict reservations

Build a release-facing example using the real API that distinguishes advisory checks from adapter-enforced atomic reservations. Include ambiguous provider results and confirmation rejection.

Finish condition: The example preserves unreconciled holds, documents the adapter's responsibilities and passes the candidate's packed-consumer checks.

## Declared verification commands

Read from the inspected main's `package.json`. This documentation change has not executed these product checks; report any required check that is unavailable rather than treating it as passed. Use focused checks during implementation and existing release gates on the frozen candidate.

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
