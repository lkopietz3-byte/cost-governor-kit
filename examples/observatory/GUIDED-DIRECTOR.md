# Proposed next interface: a guided creative director

This is a product direction for the next bounded build. It is not an implemented chat service or paid generation connection.

The entry point is an ordinary request: “Make a promo that shows how Bagfolio helps someone choose a bag.” The harness turns it into Claude's full Prompt Spec, asks useful follow-ups, shows visual examples, and keeps the user and builder working on the same evolving promo.

## Interaction

1. Extract the audience, desired insight, product, placement, evidence, assets and output. Display what was inferred as editable chips; leave consequential unknowns explicit.
2. Show three concrete visual directions with examples: a product specimen, a cinematic walkthrough, and an explorable process. Each explains the insight it serves and the format it needs. Example imagery must be labeled reference or concept until the actual asset is rendered.
3. Ask a few relevant questions at each decision: viewer and desired action first, then supplied/owned assets and claims, then look/motion/format. Provide an advanced section for the many detailed choices. Each answer updates the storyboard and generated spec, so questions produce visible progress.
4. Expand a six-line director intent into the long builder prompt: deliverable, platform/fallback, palette/type/layout, measured subject, light/material, timed beats, every state, exact copy, source/truth, controls, test hook and quality bar. Fill every slot or say n/a. Show inferred choices and unresolved requirements.
5. Offer “Copy prompt” and “Build this draft”. Build only through a configured authorized adapter; show its actual job state, source, cost/budget and cancellation behavior. Unavailable tooling keeps the complete prompt/export usable. A capability being installed does not prove it can execute this job.
6. Put the rendered result beside its storyboard. Collect pinpoint feedback (“this transition is unclear”, “show the clasp”, “hold the result longer”), convert it into at most three measurable revisions, and replay that scene. Keep accepted manual edits and previous versions.
7. Let the independent critic and native verifier return their own evidence. Save the accepted scene recipe, prompt version, editable source, output, source hashes and checks. Reuse the recipe for future promo variations without copying private project data into a new global store.

## First useful slice

Use Threshold's real recorded journal as the fixture. Offer its existing four-slot/five-slot comparison as a storyboard, three illustrative direction cards and an editable filled Prompt Spec. Export the prompt and scene recipe before adding any remote generator. The first acceptance test is that a person can move from a normal request to a specific buildable promo spec, revise one scene, reopen the recipe, and tell which claims are recorded versus proposed.

Keep the chat, storyboard, preview and prompt as four views of one draft. The user should see what changed, what is running, and the next meaningful decision. Do not turn the interface into a wall of technical settings or fake animated worker activity.
