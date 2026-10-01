# Threshold production prompt / v1

Expanded from Claude's `PROMPT-SPEC.md`, P6 and P9. The six-line director intent is the intake; this detailed specification is the builder input. P3 remains the specification for a future frame-driven film export. The existing captured WebM is a recording of the real interactive page, not a claimed frame-perfect P3 loop.

## Deliverable and purpose

Improve the existing editable Threshold browser instrument, its CSS/SVG motion map, reproducible stepping hook, rendered checks and local showcase. Preserve the actual Cost Governor SDK and saved conditions. A portfolio viewer should understand in five seconds: a request can do work only after its cost estimate and capacity reservation pass; uncertainty keeps a hold. The user can run a synthetic experiment, pause and inspect the decisions, compare two compatible runs, and reopen a saved question.

## Platform and failure first

Use the existing browser ES modules, native HTML controls/dialogs, CSS and SVG. Add no runtime library, external font, analytics, GPU requirement or provider call. Serve through the existing GET-only loopback server. Verify all six prepared SDK file hashes before enabling either Run control. Damaged/missing source disables execution and explains repair; it must not invent a completed experiment. Keep the previous journal if a draft is invalid or a new run fails. Local notebook corruption, unsupported versions, missing coordination or quota failure preserve raw stored data and report the failure.

Use the native reduced-motion preference. Keep static inspection, next-step controls and a complete result accessible when timed motion is unavailable. Short/zoomed windows should reflow rather than clip text merely to pass a fixed-screen screenshot.

## Look and layout

Ground `#0b1010`; surfaces `#121919` and `#182020`; hairline `#293533`; ink `#e5ece6`; muted `#a3b1a9`; mint `#bff1cf`; refused coral `#ef9c87`; released amber `#e6c079`; unresolved violet `#c5acf1`. Use system sans for UI, Georgia/Iowan italic only for “find its way.”, monospace caps for technical labels. Color is always paired with a label or shape.

Keep one headline moment and a visible Run action. Reading order: question → Run → moving decision → human caption → inspection/result. At 1440×900 and 1024×768, the conditions sit beside the canvas. At 768×1024 retain usable controls and a compact graph. At 390×844, the question/Edit action and Run sit above the canvas; conditions open in a labeled native dialog. Show Compare and Saved setups as separate views. Complete results open in their own focused dialog. Long evidence may scroll inside a named panel; the primary flow and playback stay within the viewport.

Retain the exact five-stage order: 01 Request, 02 Ceiling, 03 Reserve, 04 Work, 05 Settle. On narrow screens it bends down and left; add explicit direction marks so 04→05 is understandable. Four outcome plates below carry Stopped, Released, Reconcile, Confirmed. Never let a refusal wire intersect Work. Occupancy has confirmed, held, unresolved and open states; it reads the visible recorded snapshot.

## Light and material logic / tier 0

Use one broad key from the upper left, with falloff toward the lower right. Restrained surface highlights belong on upper/left edges. Contact shadows go below/right of every stage and exit plate: a short dark shadow at 3×7px, a wider soft shadow around 7×16px. A matte dark backing protects capacity text from wires. Resting Request has a mint outline/glow inviting inspection; it is not a claimed SDK result. Recorded state glow uses the actual outcome color, with shadows retained through refusal and uncertainty. Atmospheric/background texture must recede behind the encoded signal. Do not add lens flare, particle noise, glow everywhere, or a new color system.

## Motion and interrupt behavior

Keep one traveling packet on the exact illuminated SVG path, with three trailing points. Only a transition already exposed in the recorded prefix can animate. Use the existing out-cubic arrival; the current packet transition is bounded at 280–480ms inside a 550/730/1100ms replay interval. These are presentation timings, not SDK latency. Pausing, seeking, inspecting, changing a condition, hiding the page or Escape stops timed movement. Reduced motion leaves the same counts/path/caption as a still. A selection explains a mechanism; it does not fabricate a visited stage.

Do not rewrite the current engine into a staged fake job. The SDK completes and captures its journal before replay. A future P3 exporter must render each frame as a pure function of source journal and timeline time, validate its requested duration and loop seam, and report unsupported media formats rather than substituting a nominal success.

## States and exact copy

Idle: “Start the flow.” / “Ready to run. No provider is called.” Metrics are dashes until an actual capture exists. Source loading: “Checking SDK”. Source failure: “Source unavailable” plus actual repair detail. Success remains “Recorded run”, with replay/paused/complete states. The subtitle is “Every path tells you what happened. Playback follows captured SDK decisions.” Run action: “Run & watch”. Controls: “Next recorded event”, “Finish” (accessible name “Finish recorded replay”), “Inspect”, “Result”, “Pin baseline”, “Compare”, “Saved setups”, “Export run”, “Copy summary”. Phone conditions show a plain “Edit” action.

Use the established event-specific captions: “A request enters the circuit.”; “The estimate clears the ceiling.”; “A place is reserved.”; “The work returns a result.”; “This request is confirmed.”; “The failed call gives its place back.”; “The outcome is still unknown.”; “The hold stays until reconciliation.” Other event captions must retain their existing domain meaning. No generic success caption can replace unknown usage or failed settlement.

## Data and trust

Show “Actual SDK · synthetic requests · local memory ledger”. Label rates illustrative. Visible metrics and node history use only events at/before the cursor. Keep logical operation ID separate from attempt ID. Pending holds are cream; unresolved holds are violet only after an observed uncertain event. Unknown cost is excluded from the known estimate and marked `+ ?`. It is not zero. A failed definite no-work call releases; ambiguous work/confirmation retains a hold. Duplicate IDs must not run another callback.

An export can contain the complete captured journal while the canvas shows its prefix; label that distinction. Compatible comparisons require the same scenario, rates and requests. Watching baseline A never replaces current B; unpin restores B. Save only conditions/name/ID/time under the original v1 notebook key. No live Jev/MCP, provider billing, account sync, strict production concurrency, savings or revenue claim is authorized by these local results.

## Controls and test hook

Every semantic control has at least a 44×44px usable target, including icon actions, range inputs, native selects, tabs and dialog close buttons. Keep keyboard focus visible. Tabs use arrows/Home/End. Dialogs retain focus, close with Escape and restore focus to the opener. The skip link must reach the visible workspace, including when phone conditions are closed.

Expose `window.__threshold.state()`, `.step(n)`, `.advance(seconds)`. State is a frozen, detached copy of the visible prefix. The hook may move playback only; it cannot run the SDK, mutate conditions, save or release a hold. Reject non-finite/negative time and invalid steps. Repeated stepping through an idle page remains idle.

## Done condition and critic input

At 1440×900, 1024×768, 768×1024 and 390×844: document height ≤ viewport+2px, width ≤ viewport+1px; primary canvas ≥60% of viewport height; required controls and truth labels visible, not merely hidden by overflow. Verify full-size targets and modal focus/recovery, not just bounding-box counts. Hold out one additional viewport from builder screenshots. Capture idle, acquired, complete and unknown states, plus actual moving/paused evidence. Bind served source and measurement tool to hashes.

Run the original 22 behavioral example checks and preserve all 20 browser acceptance paths. Finish with the owning `npm run verify`. A different critic scores all ten dimensions from pixels/numbers, evidence per score, at most three fixes per round and three rounds maximum. No dimension <3; hierarchy/responsiveness/informativeness/truthfulness ≥4; total ≥38/50. A score is a visual judgment, not user approval. Report FPS, complete accessibility, production and financial outcomes as unmeasured unless independently tested.
