import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ARGS = Object.fromEntries(process.argv.slice(2).reduce((out, item, index, all) => {
  if (item.startsWith('--')) out.push([item.slice(2), all[index + 1]]);
  return out;
}, []));
const BASE_URL = ARGS.url;
const OUT = ARGS.out;
const SOURCE = ARGS.source;
const PW = ARGS.pw;
const CHROME = ARGS.chrome;
assertPlaceholder();

function assertPlaceholder() {
  for (const name of ['url', 'out', 'source', 'pw']) if (!ARGS[name]) throw new Error(`Required flag missing: --${name}`);
  for (const [name, value] of Object.entries({ out: OUT, source: SOURCE, pw: PW, ...(CHROME ? { chrome: CHROME } : {}) })) {
    if (!path.isAbsolute(value)) throw new Error(`--${name} must be an absolute path.`);
  }
  const url = new globalThis.URL(BASE_URL);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('--url must be a loopback HTTP URL.');
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'small-desktop', width: 1024, height: 768 },
  { name: 'tablet-portrait', width: 768, height: 1024 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'heldout-414x896', width: 414, height: 896, heldOut: true },
];
const SERVED_SOURCE_FILES = [
  'index.html', 'icon.svg', 'app.mjs', 'flow-map.css', 'style.css', 'viewport.css',
  'lib/flow-map.mjs', 'lib/insights.mjs', 'lib/notebook.mjs', 'lib/session.mjs',
  'vendor/cost-governor-kit/LICENSE', 'vendor/cost-governor-kit/index.js',
  'vendor/cost-governor-kit/internal.js', 'vendor/cost-governor-kit/preCallCeiling.js',
  'vendor/cost-governor-kit/pricing.js', 'vendor/cost-governor-kit/reserveConfirm.js',
  'vendor/cost-governor-kit/source.json', 'tools/verify-browser.mjs',
];
const sha = value => createHash('sha256').update(value).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function sourceManifest() {
  const rows = [];
  for (const rel of SERVED_SOURCE_FILES) rows.push({ path: rel, kind: rel === 'tools/verify-browser.mjs' ? 'verification-method' : 'served-source', sha256: sha(await fs.readFile(path.join(SOURCE, rel))) });
  return rows;
}
async function writeJson(file, value) { await fs.writeFile(path.join(OUT, file), `${JSON.stringify(value, null, 2)}\n`); }

await fs.mkdir(OUT, { recursive: true });
assert((await fs.readdir(OUT)).length === 0, `Output directory must be empty: ${OUT}`);
const scriptHashBefore = sha(await fs.readFile(fileURLToPath(import.meta.url)));
const sourceStart = await sourceManifest();
const sourceTreeHashBefore = sha(JSON.stringify(sourceStart));
const pw = await import(pathToFileURL(path.join(PW, 'index.mjs')).href);
const browser = await pw.chromium.launch(CHROME ? { executablePath: CHROME } : {});
const report = {
  schema: 'threshold-measurement-v1', url: BASE_URL, startedAt: new Date().toISOString(),
  command: process.argv,
  script: { path: path.relative(process.cwd(), fileURLToPath(import.meta.url)), sha256: scriptHashBefore },
  source: { path: SOURCE, startTreeSha256: sourceTreeHashBefore },
  heldOutViewport: '414x896; screenshot retained under this output directory and must not be shown to the builder',
  measurementLimits: ['Contrast is not measured: this run does not composite ancestor alpha, gradients, or images.', 'Visible modal controls are enumerated only inside the top open dialog because native modal dialogs inert their background.'],
  browser: { version: browser.version(), executable: CHROME || 'Playwright bundled Chromium' },
  assertions: [], viewports: [],
};

const stateEval = () => {
  const s = window.__threshold?.state?.();
  if (!s) return null;
  return { ...s, snapshot: s.snapshot ? { ...s.snapshot } : null };
};

async function screenshot(page, name) {
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(OUT, file), fullPage: false, animations: 'disabled' });
  return file;
}

async function measure(page) {
  return page.evaluate(() => {
    const rectOf = el => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) }; };
    const visible = el => {
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return !el.hidden && s.display !== 'none' && s.visibility === 'visible' && Number(s.opacity) > 0.01 && r.width > 0 && r.height > 0 && el.getClientRects().length > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
    };
    const selectorFor = el => el.id ? `#${CSS.escape(el.id)}` : `${el.tagName.toLowerCase()}${el.classList.length ? '.' + [...el.classList].slice(0, 2).map(CSS.escape).join('.') : ''}`;
    const clipping = el => {
      const r = el.getBoundingClientRect(), hits = [];
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p), pr = p.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(`${s.overflowX} ${s.overflowY}`)) {
          if (r.left < pr.left - 1 || r.right > pr.right + 1 || r.top < pr.top - 1 || r.bottom > pr.bottom + 1) hits.push(selectorFor(p));
        }
      }
      return hits;
    };
    const hitSamples = el => {
      const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const pts = [[cx, cy], [cx - 20, cy], [cx + 20, cy], [cx, cy - 20], [cx, cy + 20]]
        .filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
      return pts.map(([x, y]) => {
        const top = document.elementFromPoint(x, y);
        const label = top?.closest?.('label');
        const usable = Boolean(top && (el === top || el.contains(top) || (el instanceof HTMLInputElement && label?.control === el)));
        return { x: +x.toFixed(1), y: +y.toFixed(1), usable, topElement: top ? `${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ''}${top.classList?.length ? '.' + [...top.classList].slice(0, 2).join('.') : ''}` : null };
      });
    };
    const modal = [...document.querySelectorAll('dialog[open]')].at(-1) || null;
    const required = modal ? [`#${CSS.escape(modal.id)}`] : ['header', 'main', '#instrument', '#flow-map', '#event-title', '#play', '#step', '#timeline', '#speed', '#truth-label', '#recorded-settings', 'footer'];
    const requiredVisibility = required.map(sel => {
      const el = document.querySelector(sel), ok = Boolean(el && visible(el));
      const r = el ? rectOf(el) : null;
      return { selector: sel, visible: ok, inViewport: Boolean(r && r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1), rect: r };
    });
    const interactiveSelector = 'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [tabindex]:not([tabindex="-1"])';
    const scope = modal || document;
    const controls = [...scope.querySelectorAll(interactiveSelector)].filter(visible).map(el => {
      const r = rectOf(el), samples = hitSamples(el), clippedBy = clipping(el);
      const enabled = !('disabled' in el && el.disabled) && el.getAttribute('aria-disabled') !== 'true';
      return { selector: selectorFor(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), label: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 60), enabled, rect: r, withinViewport: r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, min44: r.width >= 44 && r.height >= 44, usable44Samples: samples.length === 5 && samples.every(p => p.usable), samples, clippedBy };
    });
    const labels = [...document.querySelectorAll('.flow-map__node, .flow-map__branch, .flow-map__node-label, .flow-map__branch-label, .flow-map__slots-label, .flow-map__node-index')].map(el => {
      const r = rectOf(el), owner = el.closest('.flow-map') || document.querySelector('#flow-map'), o = owner.getBoundingClientRect();
      return { selector: selectorFor(el), text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60), rect: r,
        withinMap: r.x >= o.left - 1 && r.right <= o.right + 1 && r.y >= o.top - 1 && r.bottom <= o.bottom + 1,
        withinViewport: r.x >= -1 && r.right <= innerWidth + 1 && r.y >= -1 && r.bottom <= innerHeight + 1,
        clippedBy: clipping(el) };
    });
    const internals = [...document.querySelectorAll('body *')].filter(el => {
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && ((/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 2) || (/(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 2));
    }).map(el => ({ selector: selectorFor(el), context: el.closest('dialog')?.id || el.id || '', overflowX: getComputedStyle(el).overflowX, overflowY: getComputedStyle(el).overflowY, client: [el.clientWidth, el.clientHeight], scroll: [el.scrollWidth, el.scrollHeight] }));
    const de = document.documentElement, body = document.body;
    return { viewport: { width: innerWidth, height: innerHeight }, modalScope: modal?.id || null, root: { scrollWidth: de.scrollWidth, scrollHeight: de.scrollHeight, bodyScrollWidth: body.scrollWidth, bodyScrollHeight: body.scrollHeight,
      horizontalOverflow: de.scrollWidth > innerWidth + 1, verticalOverflow: de.scrollHeight > innerHeight + 2 }, requiredVisibility,
      controls, controlCounts: { visible: controls.length, under44: controls.filter(c => !c.min44).length, badHitSamples: controls.filter(c => !c.usable44Samples).length, clipped: controls.filter(c => c.clippedBy.length).length },
      modalRect: modal ? rectOf(modal) : null, modalScrollTop: modal?.scrollTop ?? null,
      labels, labelCounts: { total: labels.length, outsideMap: labels.filter(x => !x.withinMap).length, outsideViewport: labels.filter(x => !x.withinViewport).length, clipped: labels.filter(x => x.clippedBy.length).length },
      internalScrollers: internals, internalScrollerCount: internals.length,
      activeElement: document.activeElement?.id || document.activeElement?.tagName || null,
      mainVisible: visible(document.querySelector('main')), dialogStates: [...document.querySelectorAll('dialog')].map(d => ({ id: d.id, open: d.open })),
      directionCues: document.querySelectorAll('.flow-map__direction[data-active="true"]').length,
      activeBranches: document.querySelectorAll('.flow-map__branch[data-state="current"]').length,
      activeNodes: [...document.querySelectorAll('.flow-map__node[data-state="current"]')].map(e => e.dataset.flowNode || e.textContent.trim()),
      mode: document.querySelector('#instrument')?.dataset.mode || null, ready: document.body.dataset.ready || null,
      scenario: document.querySelector('#scenario')?.value || null };
  });
}

async function runViaVisibleControl(page) {
  const mainRun = page.locator('#run');
  if (await mainRun.isVisible().catch(() => false)) { await mainRun.click(); return '#run'; }
  const quick = page.locator('#quick-run');
  assert(await quick.isVisible().catch(() => false), 'No visible Run control (#run or #quick-run).');
  await quick.click(); return '#quick-run';
}

async function waitForCapture(page) {
  await page.waitForFunction(() => {
    const s = window.__threshold?.state?.();
    return Boolean(s?.recorded && s.eventCount > 0 && document.querySelector('#instrument')?.dataset.mode !== 'running');
  }, null, { timeout: 20000 });
}

async function hookAudit(page) {
  return page.evaluate(() => {
    const api = window.__threshold, before = api.state(), scenario = document.querySelector('#scenario')?.value,
      ceiling = document.querySelector('#ceiling')?.value, capacity = document.querySelector('#capacity')?.value,
      localBefore = JSON.stringify(Object.fromEntries(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)])));
    const frozen = Object.isFrozen(api) && Object.isFrozen(before) && (!before.snapshot || Object.isFrozen(before.snapshot));
    const frozenSnapshotFields = before.snapshot ? Object.keys(before.snapshot).every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(before.snapshot, key);
      return descriptor?.writable === false && !descriptor?.set;
    }) : true;
    const copyMutationBlocked = before.snapshot ? Object.keys(before.snapshot).every(key => !Reflect.set(before.snapshot, key, 987654321)) : !Reflect.set(before, 'cursor', 987654321);
    const idleStep = api.step(0), idleAdvance = api.advance(0);
    const invalid = [];
    for (const [label, action] of [['step-negative', () => api.step(-1)], ['step-fraction', () => api.step(1.5)], ['step-infinity', () => api.step(Infinity)], ['advance-negative', () => api.advance(-1)], ['advance-nan', () => api.advance(NaN)], ['advance-too-large', () => api.advance(3601)]]) {
      try { action(); invalid.push({ label, threw: false }); } catch (e) { invalid.push({ label, threw: true, name: e.name }); }
    }
    const after = api.state(), localAfter = JSON.stringify(Object.fromEntries(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)])));
    return { frozen, frozenSnapshotFields, copyMutationBlocked, invalid, idleStep, idleAdvance, before, after, sameScenario: scenario === document.querySelector('#scenario')?.value,
      sameCeiling: ceiling === document.querySelector('#ceiling')?.value, sameCapacity: capacity === document.querySelector('#capacity')?.value,
      noStorageChange: localBefore === localAfter, mode: document.querySelector('#instrument')?.dataset.mode,
      invalidAllRejected: invalid.every(x => x.threw),
      noRunBeforeExplicitClick: !before.recorded && !after.recorded && before.eventCount === 0 && after.eventCount === 0 };
  });
}

async function readonlyAudit(page) {
  return page.evaluate(() => {
    const api = window.__threshold, before = api.state(), scenario = document.querySelector('#scenario')?.value,
      ceiling = document.querySelector('#ceiling')?.value, capacity = document.querySelector('#capacity')?.value,
      stored = JSON.stringify(Object.fromEntries(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)])));
    const frozenState = Object.isFrozen(before), frozenEvent = !before.event || Object.isFrozen(before.event),
      frozenSnapshot = !before.snapshot || Object.isFrozen(before.snapshot);
    let mutationBlocked = false;
    if (before.snapshot) {
      const key = Object.keys(before.snapshot)[0];
      mutationBlocked = key === undefined || !Reflect.set(before.snapshot, key, '__critic_mutation__');
    } else if (before.event) mutationBlocked = !Reflect.set(before.event, 'stage', '__critic_mutation__');
    const after = api.state(), storedAfter = JSON.stringify(Object.fromEntries(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)])));
    return { frozenState, frozenEvent, frozenSnapshot, mutationBlocked,
      returnedSnapshotUnaffected: JSON.stringify(before.snapshot) === JSON.stringify(after.snapshot),
      sessionUnchanged: before.sessionId === after.sessionId, cursorUnchanged: before.cursor === after.cursor,
      sameScenario: scenario === document.querySelector('#scenario')?.value, sameCeiling: ceiling === document.querySelector('#ceiling')?.value,
      sameCapacity: capacity === document.querySelector('#capacity')?.value, noStorageChange: stored === storedAfter };
  });
}

async function checkConditionsDialog(page) {
  const trigger = page.locator('#configure');
  if (!(await trigger.isVisible().catch(() => false))) return { applicable: false };
  await trigger.click();
  const dialog = page.locator('#conditions-dialog');
  await dialog.waitFor({ state: 'visible' });
  const opened = await page.evaluate(() => ({ open: document.querySelector('#conditions-dialog').open, focusInside: document.querySelector('#conditions-dialog').contains(document.activeElement), active: document.activeElement?.id || null }));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#conditions-dialog').open);
  const escaped = await page.evaluate(() => ({ closed: !document.querySelector('#conditions-dialog').open, focusRestored: document.activeElement?.id === 'configure', active: document.activeElement?.id || null }));
  return { applicable: true, opened, escaped };
}

async function checkResultDialog(page) {
  const trigger = page.locator('#open-result');
  if (!(await trigger.isVisible().catch(() => false))) return { applicable: false };
  await trigger.click();
  await page.locator('#result-dialog').waitFor({ state: 'visible' });
  const opened = await page.evaluate(() => ({ open: document.querySelector('#result-dialog').open, focusInside: document.querySelector('#result-dialog').contains(document.activeElement), active: document.activeElement?.id || null,
    title: document.querySelector('#outcome-title')?.textContent?.trim(), detail: document.querySelector('#outcome-detail')?.textContent?.trim() }));
  const openMeasure = await measure(page);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#result-dialog').open);
  const escaped = await page.evaluate(() => ({ closed: !document.querySelector('#result-dialog').open, focusRestored: document.activeElement?.id === 'open-result', active: document.activeElement?.id || null,
    preservedSession: Boolean(window.__threshold.state().recorded), preservedCursor: window.__threshold.state().complete }));
  await trigger.click();
  await page.locator('#result-dialog').waitFor({ state: 'visible' });
  await page.locator('#result-done').click();
  await page.waitForFunction(() => !document.querySelector('#result-dialog').open);
  const returned = await page.evaluate(() => ({ closed: !document.querySelector('#result-dialog').open, focusRestored: document.activeElement?.id === 'open-result', preservedSession: Boolean(window.__threshold.state().recorded) }));
  return { applicable: true, opened, openMeasure, escaped, returned };
}

async function checkInspectorDialog(page) {
  const trigger = page.locator('#inspect');
  if (!(await trigger.isVisible().catch(() => false)) || !(await trigger.isEnabled())) return { applicable: false };
  await trigger.click();
  const dialog = page.locator('#inspector');
  await dialog.waitFor({ state: 'visible' });
  const opened = await page.evaluate(() => ({ open: document.querySelector('#inspector').open,
    focusInside: document.querySelector('#inspector').contains(document.activeElement), active: document.activeElement?.id || null }));
  const collapsedMeasure = await measure(page);
  const summary = page.locator('#inspector summary');
  const summaryVisible = await summary.isVisible();
  if (summaryVisible) await summary.click();
  const expanded = await page.evaluate(() => ({ detailsOpen: Boolean(document.querySelector('#inspector details')?.open),
    rows: document.querySelectorAll('#operation-list > *').length }));
  const expandedMeasure = await measure(page);
  await page.locator('#inspector').evaluate(el => { el.scrollTop = el.scrollHeight; });
  const lastOperationCount = await page.locator('#operation-list button').count();
  const scrolledLastOperation = await page.evaluate(() => {
    const d = document.querySelector('#inspector'), e = document.querySelector('#operation-list button:last-of-type');
    if (!d || !e) return { found: false };
    const dr = d.getBoundingClientRect(), er = e.getBoundingClientRect();
    return { found: true, scrollTop: d.scrollTop, scrollHeight: d.scrollHeight, clientHeight: d.clientHeight,
      rowWidth: +er.width.toFixed(1), rowHeight: +er.height.toFixed(1), withinDialog: er.left >= dr.left && er.right <= dr.right && er.top >= dr.top && er.bottom <= dr.bottom,
      withinViewport: er.left >= 0 && er.right <= innerWidth && er.top >= 0 && er.bottom <= innerHeight };
  });
  const bottomMeasure = await measure(page);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#inspector').open);
  const escaped = await page.evaluate(() => ({ closed: !document.querySelector('#inspector').open,
    focusRestored: document.activeElement?.id === 'inspect', active: document.activeElement?.id || null }));
  await trigger.click();
  await dialog.waitFor({ state: 'visible' });
  const reopenedMeasure = await measure(page);
  const reopened = await page.evaluate(() => {
    const d = document.querySelector('#inspector'), close = document.querySelector('#close-inspector');
    const r = close.getBoundingClientRect();
    return { open: d.open, scrollTop: d.scrollTop, focusInside: d.contains(document.activeElement), active: document.activeElement?.id || null,
      closeRect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) } };
  });
  const reopenedClose = reopenedMeasure.controls.find(c => c.selector === '#close-inspector');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#inspector').open);
  const reopenedEscaped = await page.evaluate(() => ({ closed: !document.querySelector('#inspector').open, focusRestored: document.activeElement?.id === 'inspect' }));
  return { applicable: true, opened, summaryVisible, expanded, collapsedMeasure, expandedMeasure, lastOperationCount, scrolledLastOperation, bottomMeasure, escaped,
    reopened, reopenedClose, reopenedEscaped };
}

async function chooseScenario(page, value) {
  let openedConditions = false;
  if (!(await page.locator('#scenario').isVisible().catch(() => false))) {
    const trigger = page.locator('#configure');
    assert(await trigger.isVisible().catch(() => false), 'Scenario chooser is not reachable through a visible control.');
    await trigger.click(); await page.locator('#conditions-dialog').waitFor({ state: 'visible' }); openedConditions = true;
  }
  await page.locator('#scenario').selectOption(value);
  if (openedConditions) await page.locator('#conditions-done').click();
}

async function auditViewport(vp) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  const consoleErrors = [], pageErrors = [], responseBodies = new Map(), pendingBodies = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 240)); });
  page.on('pageerror', e => pageErrors.push(String(e).slice(0, 240)));
  page.on('response', response => {
    if (new globalThis.URL(response.url()).origin !== new globalThis.URL(BASE_URL).origin) return;
    pendingBodies.push((async () => { try { const body = await response.body(); responseBodies.set(new URL(response.url()).pathname, sha(body)); } catch { /* navigation can close a response body */ } })());
  });
  const key = `${vp.width}x${vp.height}`;
  await page.goto(BASE_URL, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true' || document.querySelector('#form-error:not([hidden])'), null, { timeout: 20000 });
  await page.evaluate(() => document.fonts?.ready.then(() => true));
  const idleMeasure = await measure(page), idleShot = await screenshot(page, `${key}-idle`);
  await page.keyboard.press('Tab');
  const skipFocusCheck = await page.evaluate(() => {
    const e = document.querySelector('a.skip'), r = e.getBoundingClientRect();
    return { focused: document.activeElement === e, width: +r.width.toFixed(1), height: +r.height.toFixed(1), inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.id === 'workspace-main');
  const skipEnterCheck = await page.evaluate(() => ({ focusReachedMain: document.activeElement?.id === 'workspace-main', active: document.activeElement?.id || null }));
  await page.evaluate(() => document.activeElement?.blur());
  const hookBefore = await hookAudit(page);
  const conditionsDialog = await checkConditionsDialog(page);
  const runControl = await runViaVisibleControl(page);
  await waitForCapture(page);
  const sessionInitial = await page.evaluate(stateEval);
  const prefixZero = await page.evaluate(() => window.__threshold.step(0));
  const prefixThree = await page.evaluate(() => window.__threshold.step(3));
  const acquired = await page.evaluate(() => window.__threshold.step(4));
  const acquiredMeasure = await measure(page), acquiredShot = await screenshot(page, `${key}-acquired-step-4`);
  const readonlyHook = await readonlyAudit(page);
  const acquiredVisual = await page.evaluate(() => ({ mode: document.querySelector('#instrument').dataset.mode, currentNodes: [...document.querySelectorAll('.flow-map__node[data-state="current"]')].map(e => e.dataset.flowNode), currentBranches: [...document.querySelectorAll('.flow-map__branch[data-state="current"]')].map(e => e.textContent.trim()), activeDirections: document.querySelectorAll('.flow-map__direction[data-active="true"]').length }));
  const inspectorDialog = await checkInspectorDialog(page);
  const complete = await page.evaluate(() => window.__threshold.step(window.__threshold.state().eventCount));
  await page.waitForFunction(() => window.__threshold.state().complete);
  const completeMeasure = await measure(page), completeShot = await screenshot(page, `${key}-complete`);
  const resultDialog = await checkResultDialog(page);
  await chooseScenario(page, 'ambiguous');
  const unknownRunControl = await runViaVisibleControl(page);
  await waitForCapture(page);
  const unknownCount = await page.evaluate(() => window.__threshold.state().eventCount);
  let unknown = null;
  for (let cursor = 1; cursor <= unknownCount; cursor++) {
    const state = await page.evaluate(n => window.__threshold.step(n), cursor);
    if (state.snapshot?.unknownCostOperations > 0 || /unknown|ambiguous|unresolved/i.test(state.event?.kind || '')) { unknown = state; break; }
  }
  if (!unknown) unknown = await page.evaluate(() => window.__threshold.step(window.__threshold.state().eventCount));
  const unknownMeasure = await measure(page), unknownShot = await screenshot(page, `${key}-unknown-snapshot`);
  const unknownVisual = await page.evaluate(() => ({ event: window.__threshold.state().event, snapshot: window.__threshold.state().snapshot,
    activeDirections: document.querySelectorAll('.flow-map__direction[data-active="true"]').length,
    currentBranches: [...document.querySelectorAll('.flow-map__branch[data-state="current"]')].map(e => e.textContent.trim()),
    currentNodes: [...document.querySelectorAll('.flow-map__node[data-state="current"]')].map(e => e.dataset.flowNode) }));
  await page.evaluate(() => { document.querySelector('#tab-setups').click(); });
  const setupMeasure = await measure(page);
  await page.evaluate(() => { document.querySelector('#tab-compare').click(); });
  const compareMeasure = await measure(page);
  await Promise.all(pendingBodies);
  const fetched = [...responseBodies].map(([pathname, sha256]) => {
    const sourcePath = pathname === '/' ? 'index.html' : pathname.slice(1);
    return { pathname, sourcePath, sha256, diskSha256: sourceStart.find(x => x.path === sourcePath)?.sha256 || null };
  });
  await context.close();
  return { name: vp.name, width: vp.width, height: vp.height, heldOut: Boolean(vp.heldOut), screenshots: { idle: idleShot, acquiredStep4: acquiredShot, complete: completeShot, unknownSnapshot: unknownShot },
    sdkRunControl: runControl, unknownRunControl, initialSession: sessionInitial, skipFocusCheck, skipEnterCheck, hookBefore, readonlyHook, conditionsDialog, inspectorDialog, resultDialog,
    prefixZero, prefixThree, acquiredState: acquired, acquiredVisual, completeState: complete, unknownState: unknown, unknownVisual,
    states: { idle: idleMeasure, acquiredStep4: acquiredMeasure, complete: completeMeasure, unknownSnapshot: unknownMeasure, savedSetups: setupMeasure, comparison: compareMeasure },
    consoleErrors, pageErrors, fetchedSources: fetched, fetchedSourceMismatch: fetched.filter(x => x.diskSha256 && x.diskSha256 !== x.sha256) };
}

try {
  for (const vp of VIEWPORTS) {
    const row = await auditViewport(vp);
    report.viewports.push(row);
    process.stdout.write(`${row.width}x${row.height}${row.heldOut ? ' HOLDOUT' : ''} idle=${row.states.idle.root.scrollHeight}/${row.height} acquired=${row.states.acquiredStep4.controlCounts.under44} targets<44 unknown=${row.unknownVisual.event?.kind || 'none'} dirs=${row.unknownVisual.activeDirections} console=${row.consoleErrors.length + row.pageErrors.length}\n`);
  }
} finally {
  await browser.close();
}

const sourceEnd = await sourceManifest();
const sourceTreeHashAfter = sha(JSON.stringify(sourceEnd));
const scriptHashAfter = sha(await fs.readFile(fileURLToPath(import.meta.url)));
report.finishedAt = new Date().toISOString();
report.source.endTreeSha256 = sourceTreeHashAfter;
report.source.concurrentChange = sourceTreeHashBefore !== sourceTreeHashAfter;
report.script.sha256After = scriptHashAfter;
report.script.concurrentChange = scriptHashBefore !== scriptHashAfter;
report.source.diskFiles = sourceStart.length;
report.assertions = [
  'Root document scroll height <= viewport height + 2 and width <= viewport width + 1 in each primary flow state.',
  'Required canvas, playback controls, and source/truth labels are visible and within viewport.',
    'Every visible semantic control (including summary and range) has a >=44x44 bounding box and usable center/edge hit samples.',
  'Flow node and branch labels remain inside the map and viewport without clipping.',
  'Internal overflow containers are reported separately for result evidence and saved setup lists.',
  'Actual local SDK is started only through a visible Run control; presentation hook is tested for readonly state, invalid inputs, prefix snapshots, and no pre-run execution.',
    'Conditions, inspector, and result native dialogs retain focus, close on Escape, restore focus, and preserve the completed run; the inspector summary control is measured while visible.',
  '414x896 is held out from builder review; its image stays in this measurement output folder.',
];
const failures = [];
const check = (scope, name, condition, detail = '') => { if (!condition) failures.push({ scope, check: name, detail }); };
for (const v of report.viewports) {
  const scope = `${v.width}x${v.height}`;
  const primaryStates = new Set(['idle', 'acquiredStep4', 'complete', 'unknownSnapshot']);
  for (const [name, m] of Object.entries(v.states)) {
    const stateScope = `${scope}/${name}`;
    check(stateScope, 'root overflow', !m.root.verticalOverflow && !m.root.horizontalOverflow, JSON.stringify(m.root));
    if (primaryStates.has(name)) {
      check(stateScope, 'required visible controls', m.requiredVisibility.every(x => x.visible && x.inViewport), JSON.stringify(m.requiredVisibility.filter(x => !x.visible || !x.inViewport).map(x => x.selector)));
      check(stateScope, '44px in-viewport targets', m.controls.every(c => c.min44 && c.withinViewport && c.usable44Samples && c.clippedBy.length === 0), JSON.stringify(m.controls.filter(c => !c.min44 || !c.withinViewport || !c.usable44Samples || c.clippedBy.length).map(c => ({ selector: c.selector, rect: c.rect }))));
      check(stateScope, 'map labels unclipped', m.labels.every(x => x.withinMap && x.withinViewport && x.clippedBy.length === 0), JSON.stringify(m.labels.filter(x => !x.withinMap || !x.withinViewport || x.clippedBy.length).map(x => x.selector)));
    }
  }
  check(scope, 'browser errors', v.consoleErrors.length === 0 && v.pageErrors.length === 0, JSON.stringify([...v.consoleErrors, ...v.pageErrors]));
  check(scope, 'fetched source matches disk', v.fetchedSourceMismatch.length === 0, JSON.stringify(v.fetchedSourceMismatch.map(x => x.pathname)));
  check(scope, 'skip link focus and Enter', v.skipFocusCheck.focused && v.skipFocusCheck.width >= 44 && v.skipFocusCheck.height >= 44 && v.skipFocusCheck.inViewport && v.skipEnterCheck.focusReachedMain);
  check(scope, 'pre-run hook safety', v.hookBefore.frozen && v.hookBefore.frozenSnapshotFields && v.hookBefore.copyMutationBlocked && v.hookBefore.invalidAllRejected && v.hookBefore.noRunBeforeExplicitClick && v.hookBefore.noStorageChange && v.hookBefore.sameScenario && v.hookBefore.sameCeiling && v.hookBefore.sameCapacity);
  check(scope, 'readonly hook snapshot', v.readonlyHook.frozenState && v.readonlyHook.frozenEvent && v.readonlyHook.frozenSnapshot && v.readonlyHook.mutationBlocked && v.readonlyHook.returnedSnapshotUnaffected && v.readonlyHook.sessionUnchanged && v.readonlyHook.cursorUnchanged && v.readonlyHook.noStorageChange);
  check(scope, 'visible SDK run', ['#run', '#quick-run'].includes(v.sdkRunControl) && v.initialSession.recorded && v.initialSession.eventCount > 0 && Boolean(v.initialSession.sessionId));
  check(scope, 'journal prefix', v.prefixZero.cursor === 0 && v.prefixZero.event === null && v.prefixThree.cursor === 3 && v.prefixThree.event?.sequence === 3 && v.acquiredState.cursor === 4 && v.acquiredState.event?.sequence === 4 && v.prefixZero.sessionId === v.acquiredState.sessionId && v.prefixThree.sessionId === v.acquiredState.sessionId);
  check(scope, 'acquired checkpoint and cue', v.acquiredState.snapshot?.held > 0 && v.acquiredVisual.activeDirections > 0);
  check(scope, 'complete journal', v.completeState.complete && v.completeState.cursor === v.completeState.eventCount);
  check(scope, 'unknown snapshot and direction cue', v.unknownState.event?.kind === 'outcome_ambiguous' && v.unknownState.snapshot?.unknownCostOperations > 0 && v.unknownVisual.activeDirections > 0);
  const inspector = v.inspectorDialog;
  check(scope, 'inspector modal and summary', inspector.applicable && inspector.opened.open && inspector.opened.focusInside && inspector.summaryVisible && inspector.expanded.detailsOpen && inspector.escaped.closed && inspector.escaped.focusRestored);
  const summary = inspector.expandedMeasure.controls.find(c => c.tag === 'summary');
  check(scope, 'summary target', Boolean(summary && summary.rect.width >= 44 && summary.rect.height >= 44 && summary.usable44Samples && summary.withinViewport && summary.clippedBy.length === 0), JSON.stringify(summary || null));
  check(scope, 'inspector modal targets', inspector.expandedMeasure.controls.every(c => c.min44 && (!c.withinViewport || (c.usable44Samples && c.clippedBy.length === 0))), JSON.stringify(inspector.expandedMeasure.controls.filter(c => !c.min44 || (c.withinViewport && (!c.usable44Samples || c.clippedBy.length))).map(c => ({ selector: c.selector, label: c.label, rect: c.rect, samples: c.samples, clippedBy: c.clippedBy }))));
  check(scope, 'inspector reopen resets scroll and restores close target', inspector.reopened.open && inspector.reopened.scrollTop === 0 && inspector.reopened.focusInside && inspector.reopened.active === 'close-inspector' && inspector.reopenedClose?.min44 && inspector.reopenedClose?.withinViewport && inspector.reopenedClose?.usable44Samples && inspector.reopenedClose?.clippedBy.length === 0 && inspector.reopenedEscaped.closed && inspector.reopenedEscaped.focusRestored, JSON.stringify({ reopened: inspector.reopened, close: inspector.reopenedClose, escaped: inspector.reopenedEscaped }));
  check(scope, 'recorded list scroller reachability', inspector.lastOperationCount > 0 && inspector.scrolledLastOperation.found && inspector.scrolledLastOperation.rowWidth >= 44 && inspector.scrolledLastOperation.rowHeight >= 44 && inspector.scrolledLastOperation.withinDialog && inspector.scrolledLastOperation.withinViewport);
  check(scope, 'result modal focus and return', v.resultDialog.applicable && v.resultDialog.opened.open && v.resultDialog.opened.focusInside && v.resultDialog.escaped.closed && v.resultDialog.escaped.focusRestored && v.resultDialog.returned.closed && v.resultDialog.returned.focusRestored && v.resultDialog.returned.preservedSession);
  check(scope, 'result modal targets', v.resultDialog.openMeasure.controls.every(c => c.min44 && c.withinViewport && c.usable44Samples && c.clippedBy.length === 0));
  if (v.conditionsDialog.applicable) check(scope, 'conditions modal focus and Escape', v.conditionsDialog.opened.open && v.conditionsDialog.opened.focusInside && v.conditionsDialog.escaped.closed && v.conditionsDialog.escaped.focusRestored);
}
check('run', 'source freshness', !report.source.concurrentChange, `start=${sourceTreeHashBefore}; end=${sourceTreeHashAfter}`);
check('run', 'script freshness', !report.script.concurrentChange, `start=${scriptHashBefore}; end=${scriptHashAfter}`);
report.validation = { status: failures.length ? 'FAIL' : 'PASS', failureCount: failures.length, failures };
await writeJson('report.json', report);
const compact = report.viewports.map(v => {
  const stateNames = ['idle', 'acquiredStep4', 'complete', 'unknownSnapshot'];
  const stateSummary = Object.fromEntries(stateNames.map(name => {
    const m = v.states[name];
    return [name, { root: m.root, controls: m.controlCounts,
      targetFailures: m.controls.filter(c => !c.min44 || !c.withinViewport || !c.usable44Samples).map(c => ({ selector: c.selector, label: c.label, rect: c.rect, samples: c.samples })),
      requiredFailures: m.requiredVisibility.filter(x => !x.visible || !x.inViewport),
      clippedLabels: m.labels.filter(x => !x.withinMap || !x.withinViewport || x.clippedBy.length),
      internalScrollers: m.internalScrollers }];
  }));
  return { viewport: `${v.width}x${v.height}`, heldOut: v.heldOut, stateSummary, runControl: v.sdkRunControl,
    acquiredCheckpoint: { cursor: v.acquiredState.cursor, sequence: v.acquiredState.event?.sequence,
      stage: v.acquiredState.event?.stage, kind: v.acquiredState.event?.kind, held: v.acquiredState.snapshot?.held,
      activeDirections: v.acquiredVisual.activeDirections },
    complete: { cursor: v.completeState.cursor, eventCount: v.completeState.eventCount, complete: v.completeState.complete },
    unknown: { kind: v.unknownState.event?.kind, unknownCostOperations: v.unknownState.snapshot?.unknownCostOperations,
      held: v.unknownState.snapshot?.held, activeDirections: v.unknownVisual.activeDirections },
    skip: { focus: v.skipFocusCheck, enter: v.skipEnterCheck }, hook: { before: v.hookBefore, readonly: v.readonlyHook },
    conditionsDialog: v.conditionsDialog, inspectorDialog: v.inspectorDialog.applicable ? {
      opened: v.inspectorDialog.opened, summaryVisible: v.inspectorDialog.summaryVisible, expanded: v.inspectorDialog.expanded,
      summaryMetrics: v.inspectorDialog.expandedMeasure.controlCounts,
      targetFailures: v.inspectorDialog.expandedMeasure.controls.filter(c => !c.min44 || (c.withinViewport && (!c.usable44Samples || c.clippedBy.length))).map(c => ({ selector: c.selector, label: c.label, rect: c.rect })),
      offscreenScrollableControls: v.inspectorDialog.expandedMeasure.controls.filter(c => !c.withinViewport && c.clippedBy.length).map(c => ({ selector: c.selector, label: c.label, rect: c.rect, clippedBy: c.clippedBy })),
      lastOperationCount: v.inspectorDialog.lastOperationCount, scrolledLastOperation: v.inspectorDialog.scrolledLastOperation,
      bottomTargets: v.inspectorDialog.bottomMeasure.controls.map(c => ({ selector: c.selector, label: c.label, rect: c.rect, min44: c.min44, usable44Samples: c.usable44Samples, withinViewport: c.withinViewport })),
      scrollers: v.inspectorDialog.expandedMeasure.internalScrollers, escaped: v.inspectorDialog.escaped,
      reopened: v.inspectorDialog.reopened, reopenedClose: v.inspectorDialog.reopenedClose, reopenedEscaped: v.inspectorDialog.reopenedEscaped,
    } : v.inspectorDialog, resultDialog: v.resultDialog.applicable ? {
      opened: v.resultDialog.opened, modalTargets: v.resultDialog.openMeasure.controlCounts,
      modalTargetFailures: v.resultDialog.openMeasure.controls.filter(c => !c.min44 || !c.usable44Samples || !c.withinViewport).map(c => ({ selector: c.selector, label: c.label, rect: c.rect })),
      internalScrollers: v.resultDialog.openMeasure.internalScrollers, escaped: v.resultDialog.escaped, returned: v.resultDialog.returned,
    } : v.resultDialog,
    consoleErrors: v.consoleErrors, pageErrors: v.pageErrors, fetchedSourceMismatch: v.fetchedSourceMismatch };
});
await writeJson('critic-summary.json', { schema: 'threshold-critic-summary-v1', url: BASE_URL, source: report.source, script: report.script,
  browser: report.browser, validation: report.validation,
  note: 'No visual judgment or contrast claim. The held-out screenshot stays in this directory; its path is omitted here.', viewports: compact });
await writeJson('source-hashes.json', { script: report.script, source: report.source, fetchedSources: report.viewports.map(v => ({ viewport: `${v.width}x${v.height}`, sources: v.fetchedSources, mismatch: v.fetchedSourceMismatch })) });
process.stdout.write(`sourceConcurrentChange=${report.source.concurrentChange} scriptConcurrentChange=${report.script.concurrentChange} sourceTree=${sourceTreeHashBefore}\n`);
process.stdout.write(`validation=${report.validation.status} failures=${report.validation.failureCount}\n`);
if (report.validation.failureCount) process.exitCode = 1;
