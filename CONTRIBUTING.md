# Contributing

## Setup

```bash
npm ci
```

## Before you open a PR

```bash
npm run verify
```

`verify` runs lint, typecheck, tests, the build, and the packaging checks
in one command. It must pass locally before you push.

## Fixing a bug

A behavior fix needs a regression test that fails on the old code first.
Write the test, confirm it fails against the current source, then make
your fix and confirm the test passes. Commit the test and the fix
together, with a message that says what was wrong.

## Pull requests

PRs must pass CI (the same `verify` pipeline, run on every push and pull
request) before they can be merged. Keep changes focused and describe the
"why," not just the "what," in the PR description.
