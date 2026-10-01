# Threshold verification and limits

## Verified source

The prepared SDK manifest identifies cost-governor-kit 0.2.0 at source revision
`e8601b90950938d7d8a6dab31b8860dc557ac1e9`. This branch does not change the SDK
source, public API or runtime dependencies. The example uses synthetic requests,
illustrative rates and a sequential memory ledger; the canvas replays the captured
journal. Source-correspondence and behavioral checks run with `npm run verify:observatory`,
which CI runs as its own step; they are not part of the package release gate.

## Current verification

Verification results for the reviewed candidate are recorded in the observatory
PR body. Reproduce them with the commands in [README.md](README.md). A local pass
applies to the checked source and runtime, not a deployed service or user outcome.
The real-Postgres test is skipped when its connection variable is unset.

## Reported historical evidence

Earlier local work reported 22 example checks, 21 browser checks, four reference
viewports plus a held-out viewport, a 39/50 visual critique and a silent WebM
showcase. The cited `evidence/critic/current` and `demo/critic/current` directories
are absent from this repository. Those reports are historical and unavailable
here; they are not current verification of this checkout. The separate measurer
baseline used during development is also not included.

## Unknown and bounded claims

The capture and browser harnesses record selected local source hashes but do not
compare all served files with those hashes or establish post-capture freshness.
`measure-render.mjs` has a separate served-source comparison; its receipt must
still be read for the exact file inventory and states checked. Captures are page
playback, not measured SDK latency or a frame-rate guarantee.

Desktop browser emulation does not establish physical-phone or cross-browser
behavior. Complete contrast, assistive-technology and performance audits, user
acceptance and creative/business outcomes are Unknown unless separately tested.
Live tool/MCP adapters, actual provider billing, production concurrency, durable
ledgers, account sync, demand and revenue remain Unknown. The presentation hook
moves through the existing journal; it does not execute work or settle uncertainty.
