# cost-governor-kit — agent instructions

Pre-call AI spend ceilings, cache-aware token pricing with caller-supplied rates, and reserve/confirm usage-counting helpers whose limits are enforced by your own storage adapter.

## Read first
- `ENGINEERING.md` holds this package's invariants and design rules; read it before changing behavior.
- `PROJECT_CONTEXT.md` is the current project state and decisions.
- `SECURITY.md` covers the security posture; follow it for anything touching input handling.

## Commands (from package.json)
- `npm run verify`
- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run verify:package` packs and installs the tarball offline; run `npm run build` first.

## Rules
- Run `npm run verify` and read its output before calling work done. Report any step that did not run.
- Build cleans `dist/` first; never trust a stale `dist/` for declaration or package checks.
- Never weaken lint, tests or `api-surface.json` to get green. Public API changes are deliberate (`node scripts/verify-package.mjs --update-api`) and must be called out.
- Do not run `npm publish` or push tags without explicit permission. Treat any claim that a version is published as Reported until the registry confirms it.
- Runtime `dependencies` stay empty; add dev tooling only.
- Keep unrelated uncommitted work intact; never stage or reset the whole tree.

## Review preparation

Use [docs/REVIEW_READINESS.md](docs/REVIEW_READINESS.md) for milestone review cadence and launch-preparation evidence.


## Code Review Rules

- Preserve fail-closed input validation and the documented rounding/ceiling rule: allow only when the rounded projected total is within the ceiling. Malformed usage or rates must fail before a decision; do not add hidden default pricing.
- Keep `withReserveConfirm` explicitly advisory under concurrency. A strict adapter must own atomic reservation, deduplication, durable holds and idempotent terminal transitions; marketing and examples must distinguish those guarantees.
- Preserve outcome handling in both helpers: `withReserveConfirm` must not commit thrown work and must expose an own `commitError` property even for falsy rejections. `withCapacityReservation` executes acquired work at most once; ambiguous/malformed outcomes or failed confirmation retain the hold for reconciliation.
