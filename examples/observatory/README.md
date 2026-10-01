# Threshold / PlanrLabs

Watch a request find its way. Threshold makes Lucas's Cost Governor SDK visible through a clean decision canvas: packets travel along the recorded path, visited stages illuminate, capacity fills, and outcomes branch into confirmed, stopped, released or unresolved work.

## Open the canvas

Use Node 22 or 24. From this folder:

```sh
node tools/serve.mjs
```

Open <http://127.0.0.1:4320>. This loopback server needs no installation, account or external service for the prepared example.

1. Choose an experiment and set its ceiling and capacity. On phones, tap the question above the canvas to open conditions. **Run & watch** executes the actual SDK with bounded synthetic requests, captures its immutable journal, then automatically plays that journal.
2. Pause, use **+1**, scrub the recorded steps, or choose **Finish**. Select a node or **Inspect** to open its explanation, visible state, token estimate, source identity and recorded attempts. Details follow the cursor; a stage that has not been reached says so.
3. At the complete result, open **Result**, then **Pin baseline** and change one condition, or use a suggested variation. A variation loads a draft; press Run to create the second result. The **Compare** view shows actual changed paths, confirmed places, work callbacks and known estimated spend. Watching A never replaces B. **Unpin** returns to B if A was being watched.
4. **Saved setups** keeps up to 12 named condition recipes in this browser. Opening a recipe loads controls without running work or replacing the captured result. Backup downloads the exact stored notebook.
5. The ↗ button in the header opens **presentation view**. It keeps the journal timing, known state and synthetic/local source labels visible in a larger composition. The same control exits it.
6. **Export run** downloads the entire completed journal, including when the canvas displays an earlier step. **Export both runs** preserves A, B, their comparison and SDK identity. **Copy summary** is available at the complete result.

Playback speed controls presentation timing. It does not measure execution latency. Reduced motion disables timed playback; manual steps and a static complete result remain available. Escape or hiding the page pauses playback. Invalid conditions preserve the previous run. Changed draft conditions are labeled. Refresh clears in-memory journals and the baseline; setup recipes remain at this browser origin. Export journals you want to retain.

## A comparison worth watching

Run the full circuit at $0.12 and four slots. Four operations confirm, the oversized estimate is refused, a definite local failure releases its place, and an extra small operation is refused for capacity. Select **Try 5 capacity slots**, then Run again. Five places confirm, that extra operation changes from refusal to confirmation, and callbacks change from five to six. Known estimated spend changes from $0.0180 to $0.0225 at illustrative rates. This is extra work with an extra estimate, not provider savings or revenue.

Comparisons require the same scenario, rates and planned requests. Other plans explain why they cannot be compared. Unknown usage prevents a numeric total-spend delta; the known part remains labeled.

## What actually runs

The prepared modules come from the owning `cost-governor-kit/src` at the revision in `vendor/cost-governor-kit/source.json`. The browser checks six prepared file hashes against that local manifest before enabling Run. The manifest establishes correspondence, not external signing authority. `dist` is not a source cache.

The example calls the real `estimateCostUsd`, `checkPreCallCeiling` and `withCapacityReservation`. A bounded sequential memory ledger and synthetic callbacks supply six experiments: mixed success/refusal/release, cost boundaries, known failure, unresolved work/confirmation, repeated IDs and cache pricing. A run has at most seven attempts. Each journal event records a sequence, attempt ID, operation ID, stage, result and frozen state snapshot.

Only newly acquired holds invoke work. Definite no-work failures release a hold. Ambiguous work or failed confirmation retains it. Known successful usage remains in estimated spend even if confirmation fails; ambiguous usage stays explicitly unknown. Duplicate active and terminal IDs do not start a second callback. The drawer separates input, output, cache reads and both cache-write buckets using the example's illustrative rates (the SDK supplies no price table; cache reads default to a fixed 0.1x input-rate ratio unless `cacheReadPerMillion` overrides it).

The canvas replays a completed local journal. Jev and MCP execution streams are not connected. Production atomicity, durable storage, actual provider prices/billing, expiry/fencing and reconciliation need their actual adapters and checks. Threshold does not establish a strict production limit.

## Reuse the motion layer

`lib/flow-map.mjs` has no external runtime dependency. `createFlowMap(host, { onSelect })` returns `render` and `destroy`. Its render input is `{session, cursor, playing, selectedStage, reducedMotion, animate}`. It uses only events through the cursor, highlights the current attempt's visited stages, reads occupancy from that snapshot, and moves a comet along the same SVG paths that illuminate. Paused or reduced-motion views are static. Refusal follows the observed bypass; it never fabricates a visit to Work.

`app.mjs` owns controls, playback, tabs, comparison, native conditions/result/details dialogs and notebook. `viewport.css` defines the single-screen layout and an upper-left key with consistent contact shadows. Long evidence and saved lists scroll inside named panels; the root page stays within the four reference viewports. Short or enlarged-text viewports keep normal reflow instead of clipping. `lib/session.mjs` owns the bounded actual SDK experiment. `lib/insights.mjs` owns complete-run explanations and compatible comparisons. `lib/notebook.mjs` owns stored conditions. This separation lets a future tool adapter supply actual events while keeping execution and presentation distinct. Do not create a synthetic trace and label it live Jev/MCP.

## Notebook recovery

The existing key remains `planrlabs.threshold.notebook.v1`. Its schema stores only validated conditions, a bounded name, ID and save time; no run journal, credential or provider data. Browser Web Locks coordinate a fresh read/merge/write/recheck between Threshold tabs. A thirteenth setup refuses a write, rather than evicting an existing recipe. A storage notification updates the list without replacing typed controls or results.

Malformed/future data, invalid settings/dates, repeated IDs and unknown fields block writes and preserve the raw value. **Backup notebook** keeps it exactly. Repair that origin's specific entry from its backup; the page does not clear or migrate unknown data. Quota/storage errors report failure. Browsers without Web Locks can read existing setups and run experiments, but notebook writes remain disabled. Removing a recipe refuses a stale removal if another writer changed that record. Browser clearing, eviction and unrelated writers outside the lock remain limitations. This is local convenience storage, not account sync or durable evidence.

## Verify or capture

From the owning repository, the required gate is `npm run verify`. Change into `examples/observatory` for the focused commands below:

```sh
node tools/verify-source.mjs --source /absolute/cost-governor-kit
node --test tests/session.check.mjs tests/insights.check.mjs tests/notebook.check.mjs
node tools/verify-browser.mjs --url http://127.0.0.1:4320 --out /absolute/new-evidence-folder --playwright-root /absolute/playwright-package
node tools/measure-render.mjs --url http://127.0.0.1:4320/ --source /absolute/example-folder --out /absolute/new-measure-folder --pw /absolute/playwright-package
node tools/capture-showcase.mjs --out /absolute/new-capture-folder --scenario balanced --playwright-root /absolute/playwright-package --ffmpeg /absolute/ffmpeg
```

The browser tools reuse existing Playwright and Chrome. Captures record the rendered page and journal alongside selected local file hashes; the capture and browser harnesses do not verify that served bytes match those local files. Use `measure-render.mjs` for its separate served-source comparison, and keep every receipt scoped to the files and state it actually checks. See `VERIFICATION.md` for available evidence and limits. Earlier receipts and movies remain historical evidence of their own source.

Code and original UI: Lucas Kopietz / PlanrLabs, MIT. The SDK license is preserved. Typography uses system fonts; no remote fonts, third-party art, analytics or secrets are embedded.

## Reproducible presentation clock

`window.__threshold.state()` returns a frozen, detached snapshot of the visible recorded prefix: cursor, event, known counts, source identity and explicit recorded/synthetic flags. `step(n)` pauses and seeks to an existing journal step; `advance(seconds)` advances a controlled presentation clock at the chosen replay speed. These methods never run the SDK, edit conditions or write the notebook. They reject invalid time/step inputs. A hook on an idle page remains idle until the user runs the real experiment.

An external measurer used during development is not included in this repository. Its historical baseline is useful for comparison, but its contrast estimates do not model gradients, alpha composition or occlusion, and its initial stepped frames do not start a run. The current rendered checks pair deterministic geometry with separate visual critique. Neither a critic score nor a screenshot is proof of real provider cost, performance or live execution.

## Detailed creative direction

`DIRECTOR-PROMPT.md` expands Claude's full production-prompt slots for this asset; `DESIGN-LOOP.md` records the bounded builder/measurer/critic/verifier process. `GUIDED-DIRECTOR.md` describes the proposed ordinary-chat → visual examples/questions → detailed production prompt → collaborative render/revision interface. That guided chat product is proposed, not implemented by this canvas.
