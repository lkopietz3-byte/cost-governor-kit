import { SCENARIOS, validateSettings, runExperiment } from './lib/session.mjs';
import { explainSession, compareSessions } from './lib/insights.mjs';
import { createNotebook, NOTEBOOK_KEY } from './lib/notebook.mjs';
import { createFlowMap } from './lib/flow-map.mjs';
import { estimateCostUsd } from './vendor/cost-governor-kit/index.js';

const $ = id => document.getElementById(id);
const node = (tag, text, className = '') => Object.assign(document.createElement(tag), { textContent: text, className });
const money = value => `$${value.toFixed(4)}`;
const scenario = id => SCENARIOS.find(row => row.id === id);
const conditions = settings => `${money(settings.ceilingUsd)} ceiling · ${settings.capacityLimit} slots`;
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const compactLayout = matchMedia('(max-width: 700px)');
let playbackClock = 0;
const views = ['flow', 'compare', 'setups'];
const labels = { requested: 'Requested', cost_allowed: 'Estimate admitted', cost_denied: 'Cost refused', acquired: 'Place held', denied: 'Capacity refused', succeeded: 'Work returned', confirmed: 'Confirmed', released_after_failure: 'Released', known_local_failure: 'Known failure', outcome_ambiguous: 'Outcome unknown', work_outcome_ambiguous: 'Needs reconciliation', confirmation_failed: 'Confirmation unresolved', release_failed: 'Release unresolved', operation_in_progress: 'Repeated held ID', operation_terminal: 'Repeated terminal ID' };
const captions = { requested: 'A request enters the circuit.', cost_allowed: 'The estimate clears the ceiling.', cost_denied: 'The estimate reaches its boundary.', acquired: 'A place is reserved.', denied: 'Capacity has reached its limit.', succeeded: 'The work returns a result.', confirmed: 'This request is confirmed.', known_local_failure: 'The callback reports a definite failure.', released_after_failure: 'The failed call gives its place back.', outcome_ambiguous: 'The outcome is still unknown.', work_outcome_ambiguous: 'The hold stays until reconciliation.', confirmation_failed: 'The result returned. Confirmation did not.', operation_in_progress: 'This ID already holds a place.', operation_terminal: 'This ID has already finished.' };
const mechanisms = {
  request: ['Request', 'A stable operation ID and a synthetic token envelope enter the local SDK. Repeated attempts share an ID.'],
  ceiling: ['Spend ceiling', 'The SDK checks known estimated spend plus the next projected estimate. Unknown usage prevents a complete spend total.'],
  reserve: ['Capacity reservation', 'The local ledger admits a new operation, refuses capacity, or recognizes a repeated ID. Confirmed and held places both occupy capacity.'],
  work: ['Synthetic work', 'A local callback runs only after a newly acquired hold. Its known success, definite failure, or uncertain outcome determines settlement.'],
  settle: ['Settlement', 'Known usage confirms a hold. A definite no-work failure releases it. Uncertain work and failed settlement retain a hold for reconciliation.'],
};
let session = null, displaySession = null, baseline = null, cursor = 0;
let playing = false, timer = null, busy = false, sdkReady = false, source = null;
let selectedStage = null, activeView = 'flow', notebookBusy = false, notebookState = null;
const currentEvent = () => displaySession?.events[cursor - 1] || null;
const completeView = () => Boolean(displaySession && cursor === displaySession.events.length);
const draft = () => validateSettings({ scenarioId: $('scenario').value, ceilingUsd: $('ceiling').valueAsNumber, capacityLimit: $('capacity').valueAsNumber });
const announce = text => { $('status').textContent = text; };
const map = createFlowMap($('flow-map'), { onSelect: openInspector });
const notebook = createNotebook({ getStorage: () => window.localStorage,
  withLock: navigator.locks?.request ? async action => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try { return await navigator.locks.request(NOTEBOOK_KEY, { mode: 'exclusive', signal: controller.signal }, action); }
    catch (error) { if (error.name === 'AbortError') throw new Error('Not saved: another tab is using the notebook. Try again in a moment.', { cause: error }); throw error; }
    finally { clearTimeout(timeout); }
  } : null,
});

function stop() { playing = false; clearTimeout(timer); timer = null; }
function setView(view, focus = false) {
  stop(); activeView = view;
  views.forEach(key => {
    $(`panel-${key}`).hidden = key !== view;
    $(`tab-${key}`).setAttribute('aria-selected', String(key === view));
    $(`tab-${key}`).tabIndex = key === view ? 0 : -1;
  });
  if (view === 'setups') renderNotebook();
  render();
  if (focus) $(`tab-${view}`).focus();
}
function renderDraft() {
  let settings;
  try { settings = draft(); } catch { /* A partial draft never mutates a captured run. */ }
  const changed = session && (!settings || Object.keys(settings).some(key => settings[key] !== session.settings[key]));
  $('draft-note').textContent = !settings ? 'Check the conditions before running.' : changed ? 'Draft changed. Run to see the difference.' : session ? 'Conditions match the captured run.' : 'Ready to run. No provider is called.';
  $('draft-note').classList.toggle('changed', Boolean(changed));
  $('quick-conditions').textContent = `${scenario($('scenario').value).label} · ${settings ? settings.capacityLimit + ' slots' : 'check draft'}`;
  $('quick-run').disabled = !sdkReady || busy;
  $('setup-draft').textContent = settings ? `CURRENT DRAFT / ${scenario(settings.scenarioId).label} / ${conditions(settings)}` : 'Correct the conditions in Flow before saving.';
  $('save-setup').disabled = notebookBusy || busy || !settings || !notebookState?.writable;
  $('scenario-description').textContent = scenario($('scenario').value).description;
}
function renderOutcome() {
  const completedCurrent = completeView() && displaySession === session;
  $('outcome').hidden = !completedCurrent;
  $('open-result').hidden = !completedCurrent;
  if (!completedCurrent && $('result-dialog').open) $('result-dialog').close();
  if (!completedCurrent) return;
  const insight = explainSession(session), summary = session.summary;
  $('outcome').dataset.tone = insight.tone;
  $('outcome-title').textContent = insight.headline;
  $('outcome-detail').textContent = summary.unknownCostOperations > 0
    ? `${summary.confirmed} confirmed · ${summary.held} held · ${summary.unknownCostOperations} unknown outcome. The spend total needs reconciliation.`
    : `${summary.confirmed} confirmed · ${summary.held} held · ${summary.workCalls} synthetic callbacks · ${money(summary.spentUsd)} known estimate.`;
  $('pin').disabled = busy || baseline === session;
  $('pin').textContent = baseline === session ? 'Baseline pinned ✓' : 'Pin baseline';
  $('variations').replaceChildren(...insight.actions.map(action => {
    const button = node('button', `${action.label} ↗`, 'variation'); button.type = 'button'; button.dataset.variation = action.id;
    button.title = `${action.detail} Pins the current result and loads draft conditions; no work runs.`;
    button.addEventListener('click', () => { baseline = session; $('result-dialog').close(); loadSettings(action.settings, 'Baseline pinned. Variation loaded as draft conditions. Run & watch to compare.'); });
    return button;
  }));
}
function renderComparison() {
  const twoRuns = Boolean(baseline && session && baseline !== session);
  const comparison = twoRuns ? compareSessions(baseline, session) : null;
  const allowed = twoRuns && completeView() && comparison.comparable;
  $('compare-dot').hidden = !twoRuns;
  $('unpin').hidden = !baseline; $('unpin').disabled = busy;
  $('export-comparison').disabled = !allowed || busy;
  $('comparison-body').hidden = !allowed; $('comparison-empty').hidden = Boolean(allowed);
  $('comparison-title').textContent = allowed ? comparison.headline : baseline ? 'Baseline pinned. Change one thing.' : 'Make the difference visible.';
  $('comparison-note').textContent = twoRuns && !completeView() ? 'Finish the recorded flow to compare its complete result. The baseline is preserved.'
    : comparison && !comparison.comparable ? comparison.reason
      : allowed ? comparison.detail : baseline ? `A: ${conditions(baseline.settings)}. Change a condition and run the same requests again.` : 'Finish a flow and pin it as a baseline. Change one condition and run again.';
  if (!allowed) return;
  $('baseline-settings').textContent = conditions(baseline.settings); $('current-settings').textContent = conditions(session.settings);
  $('comparison-metrics').replaceChildren(...comparison.metrics.filter(row => ['confirmed', 'work_calls', 'known_estimated_spend_usd'].includes(row.key)).map(metric => {
    const box = node('div', '', 'compare-metric'); box.dataset.metric = metric.key;
    const isCost = metric.key === 'known_estimated_spend_usd';
    const format = value => isCost ? money(value) : String(value);
    box.append(node('span', metric.label), node('b', `${format(metric.before)} → ${format(metric.after)}`), node('small', metric.delta === null ? 'Delta unavailable: unknown usage' : isCost ? `${metric.delta > 0 ? '+' : metric.delta < 0 ? '−' : ''}${money(Math.abs(metric.delta))} known-estimate delta` : `${metric.delta > 0 ? '+' : ''}${metric.delta} difference`));
    return box;
  }));
  const changes = comparison.operations.filter(row => row.changed);
  $('comparison-operations').replaceChildren(...(changes.length ? changes : [{ label: 'No attempt outcomes changed', before: null, after: null }]).map(row => {
    const item = node('div', '', 'changed-path'); item.append(node('span', row.label));
    if (row.before) { const pair = node('div', '', 'path-pair'); pair.append(node('span', labels[row.before] || row.before, 'before'), node('span', '→'), node('span', labels[row.after] || row.after, 'after')); item.append(pair); }
    return item;
  }));
}
function render({ animate = false } = {}) {
  const event = currentEvent(), state = event?.snapshot || displaySession?.initial;
  const viewingBaseline = displaySession && displaySession === baseline && displaySession !== session;
  $('instrument').dataset.mode = busy ? 'running' : displaySession ? 'recorded' : 'idle';
  $('instrument').dataset.playing = String(playing);
  document.body.dataset.playing = String(playing); document.body.dataset.cursor = String(cursor); document.body.dataset.complete = String(completeView()); document.body.dataset.session = displaySession?.id || '';
  $('mode-label').textContent = busy ? 'Running local SDK' : displaySession ? `${viewingBaseline ? 'Baseline' : 'Recorded run'} · ${playing ? 'replay' : completeView() ? 'complete' : 'paused'}` : 'Ready';
  $('confirmed-count').textContent = state ? String(state.confirmed) : '—'; $('held-count').textContent = state ? String(state.held) : '—';
  $('known-spend').textContent = state ? `${money(state.spentUsd)}${state.unknownCostOperations ? ' + ?' : ''}` : '—';
  $('known-spend').title = state?.unknownCostOperations ? 'Unknown usage is excluded. A complete spend total is unavailable.' : 'Known synthetic usage at illustrative rates.';
  $('event-tag').textContent = event ? `${event.operationId} / ${labels[event.kind] || event.kind}` : 'ONE REQUEST. FIVE DECISIONS.';
  $('event-title').textContent = event ? captions[event.kind] || event.title : 'Start the flow.';
  $('event-detail').textContent = event?.detail || 'Run an experiment. Follow its paths. Select any node to look closer.';
  $('recorded-settings').textContent = displaySession ? `${viewingBaseline ? 'A / ' : ''}${conditions(displaySession.settings)}` : 'No captured run';
  $('truth-label').textContent = 'Actual SDK · synthetic requests · local memory ledger';
  $('timeline').max = String(displaySession?.events.length || 1); $('timeline').value = String(cursor);
  $('timeline-label').textContent = displaySession ? `${cursor} / ${displaySession.events.length}` : 'No run yet';
  $('timeline').setAttribute('aria-valuetext', displaySession ? `Recorded step ${cursor} of ${displaySession.events.length}` : 'No recorded run');
  $('play').textContent = playing ? 'Ⅱ' : '▷'; $('play').setAttribute('aria-label', playing ? 'Pause recorded flow' : 'Play recorded flow');
  for (const id of ['timeline', 'inspect', 'export', 'finish']) $(id).disabled = !displaySession || busy;
  $('play').disabled = !displaySession || busy || motion.matches;
  $('play').title = motion.matches ? 'Reduced motion is enabled. Use Next recorded event or View result.' : '';
  $('step').disabled = !displaySession || busy || completeView(); $('finish').hidden = !displaySession || completeView();
  $('copy').disabled = !completeView() || busy;
  for (const id of ['scenario', 'ceiling', 'capacity', 'reset']) $(id).disabled = busy;
  $('run').disabled = !sdkReady || busy; $('run').children[1].textContent = busy ? 'Running…' : 'Run & watch';
  map.render({ session: displaySession, cursor, playing, selectedStage, reducedMotion: motion.matches, animate });
  renderDraft(); renderOutcome(); renderComparison();
}
function seek(value, announceStep = false, animate = false, clockSeconds = null) {
  if (!displaySession) return;
  cursor = Math.max(0, Math.min(displaySession.events.length, Math.trunc(value))); selectedStage = null;
  playbackClock = clockSeconds ?? cursor * Number($('speed').value) / 1000;
  render({ animate });
  if (announceStep) announce(cursor ? `Recorded step ${cursor}: ${currentEvent().title}.` : 'At the beginning of the captured run.');
}
function nextFrame() {
  if (!playing || !displaySession) return;
  if (cursor >= displaySession.events.length) { stop(); render(); announce('Recorded flow finished. The SDK experiment was already complete. Inspect the result or try a changed boundary.'); return; }
  seek(cursor + 1, false, true); timer = setTimeout(nextFrame, Number($('speed').value));
}
function startReplay() {
  if (!displaySession || busy || motion.matches || document.hidden || activeView !== 'flow') return;
  if (completeView()) cursor = 0;
  playing = true; nextFrame(); announce('Playing captured SDK decisions. The movement is recorded playback.');
}
function loadSettings(settings, message) {
  stop(); $('scenario').value = settings.scenarioId; $('ceiling').value = String(settings.ceilingUsd); $('capacity').value = String(settings.capacityLimit);
  for (const id of ['ceiling', 'capacity']) $(id).setAttribute('aria-invalid', 'false');
  $('form-error').hidden = true; setView('flow'); announce(message); if (!$('conditions-dialog').open) (compactLayout.matches ? $('quick-run') : $('run')).focus({ preventScroll: true });
}
async function run() {
  if (busy || !sdkReady) return;
  let settings;
  try { settings = draft(); }
  catch (error) {
    $('form-error').textContent = error.message; $('form-error').hidden = false;
    $('ceiling').setAttribute('aria-invalid', String(!Number.isFinite($('ceiling').valueAsNumber) || $('ceiling').valueAsNumber < 0 || $('ceiling').valueAsNumber > 10));
    $('capacity').setAttribute('aria-invalid', String(!Number.isSafeInteger($('capacity').valueAsNumber) || $('capacity').valueAsNumber < 0 || $('capacity').valueAsNumber > 12));
    if (compactLayout.matches && !$('conditions-dialog').open) $('conditions-dialog').showModal();
    announce('Check the conditions. The recorded run is preserved.'); return;
  }
  if ($('conditions-dialog').open) $('conditions-dialog').close();
  if ($('result-dialog').open) $('result-dialog').close();
  playbackClock = 0;
  stop(); busy = true; $('form-error').hidden = true;
  for (const id of ['ceiling', 'capacity']) $(id).setAttribute('aria-invalid', 'false');
  render(); announce('Running the local SDK against synthetic requests.');
  let succeeded = false;
  try {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const result = await runExperiment(settings);
    session = result; displaySession = result; cursor = motion.matches ? result.events.length : 0; selectedStage = null; succeeded = true;
  } catch (error) {
    $('form-error').textContent = `Local experiment failed: ${error.message}. The previous run is preserved.`;
    $('form-error').hidden = false; announce('The experiment failed. No success was recorded.');
  } finally { busy = false; render(); renderNotebook(); }
  if (succeeded) {
    announce(`Local experiment complete: ${session.summary.completedAttempts} attempts captured. ${motion.matches ? 'Reduced motion is enabled; inspect the static result or step through the journal.' : 'Starting recorded playback.'}`);
    startReplay();
  }
}
function openInspector(stage = null) {
  stop(); selectedStage = stage; render();
  const event = currentEvent();
  const visibleStageEvent = stage && displaySession?.events.findLast(row => row.sequence <= cursor && row.attemptId === event?.attemptId && row.stage === stage);
  const visible = stage ? visibleStageEvent : event;
  $('inspector-title').textContent = stage ? mechanisms[stage][0] : event ? labels[event.kind] || event.title : 'What am I watching?';
  $('inspector-state').textContent = visible ? `RECORDED STEP ${visible.sequence} / ${labels[visible.kind] || visible.kind}` : stage ? 'MECHANISM / NOT REACHED IN THIS ATTEMPT' : 'REAL SDK / CAPTURED PLAYBACK';
  $('inspector-detail').textContent = visible?.detail || (stage ? mechanisms[stage][1] : 'Run a bounded local experiment. Watch its recorded request move through five decisions. Lights show visited stages and the actual recorded outcome.');
  const state = event?.snapshot;
  const facts = displaySession ? [['Operation ID', event?.operationId || 'Awaiting step'], ['Attempt ID', event?.attemptId || 'Awaiting step'], ['Captured conditions', conditions(displaySession.settings)], ['Known estimate', state ? `${money(state.spentUsd)}${state.unknownCostOperations ? ' + unknown usage' : ''}` : '$0.0000'], ['Source revision', source?.revision.slice(0, 7) || 'Unavailable']] : [['Source', source ? `cost-governor-kit ${source.version}` : 'Unavailable'], ['Animation', 'Completed journal playback'], ['Execution', 'Synthetic local callbacks']];
  $('inspector-facts').replaceChildren(...facts.map(([label, value]) => { const row = node('div', ''); row.append(node('dt', label), node('dd', value)); return row; }));
  const operation = event && displaySession.operations.find(row => row.attemptId === event.attemptId);
  $('pricing-lens').hidden = !operation;
  if (operation) $('token-buckets').replaceChildren(...[['inputTokens', 'Input'], ['outputTokens', 'Output'], ['cacheReadTokens', 'Cache read'], ['cacheCreation5mTokens', 'Write · 5m'], ['cacheCreation1hTokens', 'Write · 1h']].map(([key, label]) => {
    const count = operation.estimatedUsage[key] || 0, cost = estimateCostUsd(displaySession.rates, { [key]: count });
    const row = node('div', '', 'token-bucket'); row.dataset.bucket = key; row.append(node('span', label), node('b', `${count.toLocaleString('en-US')} tokens`), node('small', money(cost))); return row;
  }));
  $('operation-list').replaceChildren(...(displaySession?.operations || []).map(row => {
    const last = displaySession.events.findLast(item => item.attemptId === row.attemptId && item.sequence <= cursor);
    const button = node('button', '', 'operation'); button.type = 'button'; button.dataset.attempt = row.attemptId;
    button.append(node('span', row.label), node('small', last ? labels[last.kind] || last.kind : 'Not reached'));
    button.setAttribute('aria-label', `${row.label}; ${last ? labels[last.kind] || last.kind : 'Not reached'}. Inspect its recorded outcome.`);
    button.addEventListener('click', () => { $('inspector').close(); stop(); seek(row.eventSequences.at(-1), true); }); return button;
  }));
  if (!$('inspector').open) {
    $('inspector').showModal();
    $('inspector').scrollTop = 0;
    $('close-inspector').focus({ preventScroll: true });
  }
}
function renderNotebook(message = '') {
  notebookState = notebook.read(); const rows = notebookState.document?.setups || [];
  $('setup-count').textContent = notebookState.status === 'ready' ? String(rows.length) : '!';
  $('notebook-status').textContent = notebookState.status !== 'ready' ? notebookState.message : message || notebookState.message || (rows.length ? 'Open a setup to load its conditions. Your recorded result stays intact.' : 'Name a useful question and save its conditions.');
  $('notebook-status').classList.toggle('notebook-error', notebookState.status !== 'ready');
  $('notebook-backup').disabled = notebookBusy || notebookState.raw === null;
  $('saved-setups').replaceChildren(...rows.map(row => {
    const item = node('li', ''); const button = node('button', '', 'saved-setup'); button.type = 'button'; button.dataset.setup = row.id; button.disabled = busy || notebookBusy;
    button.append(node('b', row.name), node('span', `${scenario(row.settings.scenarioId).label} / ${conditions(row.settings)}`), node('small', 'Open draft ↗'));
    button.addEventListener('click', () => loadSettings(row.settings, `Opened “${row.name}” as draft conditions. No work ran.`));
    const remove = node('button', 'Remove', 'remove-setup text-button'); remove.type = 'button'; remove.disabled = busy || notebookBusy || !notebookState.writable; remove.setAttribute('aria-label', `Remove saved setup ${row.name}`);
    remove.addEventListener('click', () => updateNotebook(() => notebook.remove(row.id, row), `Removed “${row.name}”.`));
    item.append(button, remove); return item;
  })); renderDraft();
}
async function updateNotebook(action, message) {
  if (notebookBusy || busy) return;
  notebookBusy = true; renderNotebook(); let feedback;
  try { await action(); feedback = message; }
  catch (error) { feedback = error.message; }
  finally { notebookBusy = false; renderNotebook(feedback); announce(feedback); }
}
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type })); const anchor = node('a', ''); anchor.href = url; anchor.download = name;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function summaryMarkdown() {
  const result = displaySession;
  return `# Threshold / ${scenario(result.scenarioId).label}\n\nSynthetic local requests; real cost-governor-kit ${source.version} decisions. Recorded playback.\n\n- SDK source revision: ${source.revision}\n- Captured conditions: ${conditions(result.settings)}\n- Known estimated spend: ${money(result.summary.spentUsd)}\n- Confirmed: ${result.summary.confirmed}; held: ${result.summary.held}; unknown outcomes: ${result.summary.unknownCostOperations}\n- Completed attempts: ${result.summary.completedAttempts}\n\n${result.operations.map(row => `- ${row.label} / ${row.operationId}: ${row.status}. ${row.detail}`).join('\n')}\n\nIllustrative prices; synthetic sequential memory ledger. No provider billing, live Jev or MCP, production persistence or concurrency is established.\n`;
}
async function verifySource() {
  try {
    const response = await fetch('./vendor/cost-governor-kit/source.json'); if (!response.ok) throw new Error('Local SDK source manifest is unavailable');
    const candidate = await response.json();
    if (candidate.schema !== 'threshold-sdk-source-v1' || candidate.package !== 'cost-governor-kit' || !/^[a-f0-9]{40}$/.test(candidate.revision) || typeof candidate.version !== 'string') throw new Error('Local SDK source manifest has an invalid shape');
    for (const name of ['index.js', 'internal.js', 'pricing.js', 'preCallCeiling.js', 'reserveConfirm.js', 'LICENSE']) {
      const response = await fetch(`./vendor/cost-governor-kit/${name}`); if (!response.ok) throw new Error(`SDK file unavailable: ${name}`);
      const bytes = await response.arrayBuffer(); const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join('');
      if (digest !== candidate.outputs?.[name]) throw new Error(`SDK file does not match its local source manifest: ${name}`);
    }
    source = Object.freeze(candidate); sdkReady = true; document.body.dataset.ready = 'true';
    $('sdk-source').textContent = `SDK ${source.version} · verified`; $('source-dot').dataset.ready = 'true';
    announce('Ready. SDK files match the local source manifest. No experiment has run.');
  } catch (error) {
    sdkReady = false; document.body.dataset.ready = 'false'; $('sdk-source').textContent = 'Source unavailable';
    $('form-error').textContent = `${error.message}. Rebuild the local SDK copy with tools/vendor-sdk.mjs, then reload.`; $('form-error').hidden = false;
    announce('The experiment is unavailable until its local source is repaired.');
  } finally { render(); }
}

$('experiment-form').addEventListener('submit', event => { event.preventDefault(); run(); });
$('scenario').addEventListener('change', () => { const settings = scenario($('scenario').value).defaults; loadSettings({ scenarioId: $('scenario').value, ...settings }, 'Experiment conditions loaded. Run to capture its actual path.'); });
for (const id of ['ceiling', 'capacity']) $(id).addEventListener('input', () => { stop(); render(); });
$('reset').addEventListener('click', () => loadSettings({ scenarioId: $('scenario').value, ...scenario($('scenario').value).defaults }, 'Conditions reset. The captured run is preserved.'));
$('play').addEventListener('click', () => { if (playing) { stop(); render(); announce('Recorded playback paused.'); } else startReplay(); });
$('step').addEventListener('click', () => { stop(); seek(cursor + 1, true); });
$('finish').addEventListener('click', () => { stop(); seek(displaySession.events.length, true); });
$('timeline').addEventListener('input', () => { stop(); seek(Number($('timeline').value), true); });
$('speed').addEventListener('change', () => { if (playing) { clearTimeout(timer); timer = setTimeout(nextFrame, Number($('speed').value)); } });
$('inspect').addEventListener('click', () => openInspector()); $('about').addEventListener('click', () => openInspector());
$('close-inspector').addEventListener('click', () => $('inspector').close());
$('inspector').addEventListener('close', () => { selectedStage = null; render(); });
views.forEach((view, index) => {
  $(`tab-${view}`).addEventListener('click', () => setView(view));
  $(`tab-${view}`).addEventListener('keydown', event => {
    const target = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null;
    if (target !== null) { event.preventDefault(); setView(views[target], true); }
  });
});
$('go-flow').addEventListener('click', () => { setView('flow'); $('run').focus(); });
$('pin').addEventListener('click', () => { if (!completeView() || displaySession !== session) return; baseline = session; $('result-dialog').close(); render(); announce('Baseline pinned in this page. Change one condition and run again, then open Compare.'); });
$('unpin').addEventListener('click', () => { if (displaySession === baseline && session) { displaySession = session; cursor = session.events.length; } baseline = null; render(); announce('Baseline unpinned. The current captured result is preserved.'); });
for (const [id, getResult] of [['watch-baseline', () => baseline], ['watch-current', () => session]]) $(id).addEventListener('click', () => { displaySession = getResult(); cursor = motion.matches ? displaySession.events.length : 0; setView('flow'); startReplay(); });
$('export').addEventListener('click', () => { if (!displaySession) return; download(`${displaySession.id}.json`, JSON.stringify({ ...displaySession, sdkSource: source, presentation: 'Recorded journal playback; motion is not live execution.' }, null, 2) + '\n', 'application/json'); announce('Complete captured run exported. It includes the journal and source identity.'); });
$('export-comparison').addEventListener('click', () => download(`threshold-comparison-${session.id}.json`, JSON.stringify({ schema: 'threshold-comparison-v1', exportedAt: new Date().toISOString(), sdkSource: source, baseline, current: session, comparison: compareSessions(baseline, session) }, null, 2) + '\n', 'application/json'));
$('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(summaryMarkdown()); announce('Complete local-result summary copied.'); } catch { announce('Clipboard unavailable. Export the run to keep its result.'); } });
$('notebook-form').addEventListener('submit', event => { event.preventDefault(); if (notebookBusy || busy) return; let settings; try { settings = draft(); } catch (error) { announce(error.message); return; } updateNotebook(() => notebook.save(settings, $('setup-name').value.trim()), 'Setup saved in this browser. Conditions only; no work ran.'); });
$('notebook-backup').addEventListener('click', () => { const state = notebook.read(); if (state.raw !== null) { download('threshold-notebook-backup.json', state.raw, 'application/json'); announce('Notebook backed up exactly as stored.'); } });
window.addEventListener('storage', event => { if (event.key === NOTEBOOK_KEY || event.key === null) renderNotebook('Notebook refreshed from another tab. Draft conditions and captured runs are preserved.'); });
$('showcase').addEventListener('click', () => { const enabled = !document.body.classList.contains('showcase'); if (enabled && activeView !== 'flow') setView('flow'); document.body.classList.toggle('showcase', enabled); $('showcase').setAttribute('aria-pressed', String(enabled)); $('showcase').setAttribute('aria-label', enabled ? 'Exit presentation view' : 'Enter presentation view'); });
document.addEventListener('visibilitychange', () => { if (document.hidden && playing) { stop(); render(); announce('Recorded playback paused while this page was hidden.'); } });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && playing) { stop(); render(); announce('Recorded playback paused.'); } });
motion.addEventListener('change', () => { stop(); render(); });
window.addEventListener('pagehide', () => stop());
window.addEventListener('pageshow', event => { if (event.persisted) render(); });

// A controlled presentation clock. These methods only move through an existing
// immutable journal; they never run the SDK, change conditions or save anything.
function presentationState() {
  const event = currentEvent();
  return Object.freeze({ schema: 'threshold-presentation-v1', ready: sdkReady,
    sourceRevision: source?.revision ?? null, sessionId: displaySession?.id ?? null,
    cursor, eventCount: displaySession?.events.length ?? 0, complete: completeView(),
    playing, clockSeconds: playbackClock, view: activeView,
    recorded: Boolean(displaySession), synthetic: true,
    event: event ? Object.freeze({ sequence: event.sequence, stage: event.stage, kind: event.kind, operationId: event.operationId }) : null,
    snapshot: displaySession ? Object.freeze({ ...(event?.snapshot ?? displaySession.initial) }) : null });
}
Object.defineProperty(window, '__threshold', { value: Object.freeze({
  state: presentationState,
  step(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError('Step must be a non-negative integer.');
    stop(); seek(sequence); playbackClock = cursor * Number($('speed').value) / 1000;
    return presentationState();
  },
  advance(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) throw new RangeError('Advance must be 0–3600 finite seconds.');
    stop(); playbackClock += seconds;
    seek(Math.floor((playbackClock * 1000 + 1e-7) / Number($('speed').value)), false, false, playbackClock);
    return presentationState();
  },
}), writable: false, configurable: false, enumerable: true });
function placeConditions() {
  if (!compactLayout.matches && $('conditions-dialog').open) $('conditions-dialog').close();
  if (compactLayout.matches) $('conditions-host').append($('experiment-form'));
  else $('controls-owner').insertBefore($('experiment-form'), $('controls-owner').querySelector('.control-bottom'));
}
compactLayout.addEventListener('change', placeConditions);
$('configure').addEventListener('click', () => { stop(); render(); $('conditions-dialog').showModal(); });
for (const id of ['close-conditions', 'conditions-done']) $(id).addEventListener('click', () => $('conditions-dialog').close());
$('quick-run').addEventListener('click', () => $('experiment-form').requestSubmit());
$('open-result').addEventListener('click', () => { stop(); render(); $('result-dialog').showModal(); });
for (const id of ['close-result', 'result-done']) $(id).addEventListener('click', () => $('result-dialog').close());
placeConditions();

renderNotebook(); render(); verifySource();
