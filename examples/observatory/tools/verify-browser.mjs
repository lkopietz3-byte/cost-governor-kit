import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './serve.mjs';

const options = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  if (!['--out', '--url', '--playwright-root', '--chrome'].includes(args[index]) ||
      !args[index + 1] || options[args[index]]) throw new Error(
    'Usage: node tools/verify-browser.mjs --out /absolute/new-directory [--url http://127.0.0.1:4321] [--playwright-root /absolute/playwright-package] [--chrome /absolute/browser]');
  options[args[index]] = args[index + 1];
}
const output = options['--out'];
if (!output || !path.isAbsolute(output)) throw new Error('Use an absolute new evidence directory.');
const origin = options['--url'] || 'http://127.0.0.1:4321';
const url = new URL(origin);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) {
  throw new Error('Only local HTTP previews are allowed.');
}
const pw = options['--playwright-root']
  ? await import(pathToFileURL(path.join(options['--playwright-root'], 'index.mjs')).href)
  : await import('playwright');
await mkdir(output, { recursive: false });
const report = {
  schema: 'threshold-motion-browser-v1',
  status: 'running',
  environment: {
    node: process.version, origin, browser: null, desktop: '1500x1080',
    phoneEmulation: ['390x844', '360x800'], physicalPhone: false,
  },
  source: {}, checks: [], screenshots: [], pageErrors: [],
  limits: [
    'Synthetic sequential memory adapter; no provider, Jev, MCP, production concurrency, durable ledger or billing evidence.',
    'Desktop Chrome with phone-width emulation; not a physical phone, assistive-technology audit or cross-browser certification.',
  ],
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = [
  'app.mjs', 'index.html', 'style.css', 'viewport.css', 'flow-map.css', 'lib/flow-map.mjs',
  'lib/session.mjs', 'lib/insights.mjs', 'lib/notebook.mjs',
  'tools/verify-browser.mjs', 'vendor/cost-governor-kit/source.json',
];
for (const name of sourceFiles) report.source[name] = sha(await readFile(path.join(ROOT, name)));
const save = () => writeFile(path.join(output, 'browser.json'), JSON.stringify(report, null, 2) + '\n');
async function check(name, work) {
  try { await work(); report.checks.push({ name, result: 'PASS' }); }
  catch (error) { report.checks.push({ name, result: 'FAIL', detail: error.message }); throw error; }
  finally { await save(); }
}
const ready = page => page.waitForFunction(() => document.body.dataset.ready === 'true');
const captured = page => page.waitForFunction(() => document.querySelector('#instrument')?.dataset.mode === 'recorded');
async function completeRun(page) {
  if (await page.locator('#conditions-dialog').evaluate(el => el.open)) await page.locator('#conditions-done').click();
  await page.locator(await page.locator('#quick-run').isVisible() ? '#quick-run' : '#run').click();
  await captured(page);
  const finish = page.locator('#finish');
  if (await finish.isVisible()) await finish.click();
  await page.waitForFunction(() => document.body.dataset.complete === 'true');
}
async function finishCaptured(page) {
  const finish = page.locator('#finish');
  if (await finish.isVisible()) await finish.click();
  await page.waitForFunction(() => document.body.dataset.complete === 'true');
}
async function setCursor(page, sequence) {
  await page.locator('#timeline').evaluate((element, value) => {
    element.value = String(value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, sequence);
  await page.waitForFunction(value => document.body.dataset.cursor === String(value), sequence);
}
async function selectScenario(page, id) {
  if (await page.locator('#configure').isVisible()) await page.locator('#configure').click();
  await page.locator('#scenario').selectOption(id);
}
async function exported(page, name, button = '#export') {
  const pending = page.waitForEvent('download');
  await page.locator(button).click();
  const item = await pending;
  assert.equal(await item.failure(), null);
  const target = path.join(output, name);
  await item.saveAs(target);
  return JSON.parse(await readFile(target, 'utf8'));
}
async function downloadedText(page, button, name) {
  const pending = page.waitForEvent('download');
  await page.locator(button).click();
  const item = await pending;
  assert.equal(await item.failure(), null);
  const target = path.join(output, name);
  await item.saveAs(target);
  return readFile(target, 'utf8');
}
async function noClipping(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal page overflow');
  const clipped = await page.locator('button,input,select').evaluateAll(items => items.filter(item => {
    const box = item.getBoundingClientRect();
    return box.width && box.height && (box.left < -1 || box.right > innerWidth + 1);
  }).map(item => item.id || item.textContent.trim()));
  assert.deepEqual(clipped, [], 'An interactive control is clipped');
}
async function settleLayout(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function shot(page, name) {
  await settleLayout(page);
  await page.screenshot({ path: path.join(output, name), animations: 'disabled' });
  report.screenshots.push(name);
  await save();
}
function attachPage(page) {
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('request', request => {
    try { if (new URL(request.url()).origin !== origin) report.externalRequests.push(request.url()); }
    catch { report.externalRequests.push(request.url()); }
  });
}
function position(page) {
  return page.locator('.flow-map__packet').evaluate(element => [element.getAttribute('cx'), element.getAttribute('cy')]);
}

let browser;
try {
  browser = await pw.chromium.launch({
    executablePath: options['--chrome'] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  report.environment.browser = browser.version();
  report.externalRequests = [];
  const context = await browser.newContext({ viewport: { width: 1500, height: 1080 }, acceptDownloads: true });
  const page = await context.newPage();
  attachPage(page);

  await check('Idle canvas is honest: no run, invented metrics, or enabled replay', async () => {
    await page.goto(origin); await ready(page);
    assert.equal(await page.locator('#mode-label').textContent(), 'Ready');
    assert.equal(await page.locator('#confirmed-count').textContent(), '—');
    assert.equal(await page.locator('#held-count').textContent(), '—');
    assert.equal(await page.locator('#known-spend').textContent(), '—');
    assert.equal(await page.locator('#play').isEnabled(), false);
    assert.equal(await page.locator('#run').isEnabled(), true);
    assert.match(await page.locator('#status').textContent(), /No experiment has run/);
    assert.equal(await page.locator('.flow-map__packet').count(), 1);
    assert.equal(await page.locator('.flow-map__particle').evaluate(element => element.style.opacity), '0');
    await noClipping(page);
    const readme = await page.request.get(new URL('README.md', origin).href);
    assert.equal(readme.status(), 200);
    await shot(page, 'desktop-ready.png');
  });

  await check('Run captures real SDK decisions once, then animates a recorded packet and pauses statically', async () => {
    await page.locator('#run').click(); await captured(page);
    await page.waitForFunction(() => document.querySelector('#instrument').dataset.playing === 'true');
    assert.match(await page.locator('#mode-label').textContent(), /Recorded run.*replay/);
    assert.match(await page.locator('#truth-label').textContent(), /Actual SDK.*synthetic requests.*local memory ledger/);
    assert.equal(await page.locator('#outcome').isVisible(), false);
    const samples = await page.evaluate(async () => {
      const element = document.querySelector('.flow-map__packet');
      const values = [];
      for (let index = 0; index < 10; index++) {
        values.push(element.getAttribute('cx') + ',' + element.getAttribute('cy'));
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      return values;
    });
    assert.ok(new Set(samples).size > 1, 'Packet did not travel along the recorded path.');
    await page.locator('#play').click();
    await page.waitForFunction(() => document.querySelector('#instrument').dataset.playing === 'false');
    const fixed = await position(page);
    await page.waitForTimeout(180);
    assert.deepEqual(await position(page), fixed, 'Paused packet kept moving.');
    await setCursor(page, 1);
    assert.equal(await page.locator('#confirmed-count').textContent(), '0');
    assert.equal(await page.locator('#held-count').textContent(), '0');
    assert.equal(await page.locator('#known-spend').textContent(), '$0.0000');
    assert.equal(await page.locator('#outcome').isVisible(), false);
    assert.equal(await page.locator('#copy').isEnabled(), false);
    assert.equal(await page.locator('.flow-map__node[data-flow-node="work"]').getAttribute('data-state'), 'idle');
    const packet = await exported(page, 'balanced-prefix.json');
    assert.equal(packet.presentation, 'Recorded journal playback; motion is not live execution.');
    assert.equal(packet.events[0].kind, 'requested');
    assert.equal(packet.operations[0].workInvocations, 1);
    await finishCaptured(page);
    assert.equal(await page.locator('#open-result').isVisible(), true);
    await page.locator('#open-result').click();
    assert.equal(await page.locator('#outcome').isVisible(), true);
    await page.locator('#close-result').click();
    await shot(page, 'desktop-balanced.png');
  });

  await check('Prefix state follows each captured snapshot; cost denial never visits work', async () => {
    const packet = await exported(page, 'balanced-complete.json');
    assert.equal(packet.summary.completedAttempts, 7);
    assert.equal(packet.summary.confirmed, 4);
    assert.equal(packet.summary.workCalls, 5);
    const denied = packet.events.find(event => event.attemptId === 'oversized' && event.kind === 'cost_denied');
    assert.ok(denied);
    await setCursor(page, denied.sequence);
    assert.equal(await page.locator('#confirmed-count').textContent(), String(denied.snapshot.confirmed));
    assert.equal(await page.locator('#held-count').textContent(), String(denied.snapshot.held));
    assert.equal(await page.locator('#known-spend').textContent(), '$' + denied.snapshot.spentUsd.toFixed(4));
    assert.equal(await page.locator('.flow-map__node[data-flow-node="work"]').getAttribute('data-state'), 'idle');
    assert.equal(packet.operations.find(row => row.id === 'oversized').workInvocations, 0);
    assert.equal(await page.locator('#outcome').isVisible(), false);
    await finishCaptured(page);
    await page.locator('#tab-flow').focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#tab-compare').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#panel-compare').isVisible(), true);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#tab-setups').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#tab-flow').getAttribute('aria-selected'), 'true');
  });

  await check('Capacity refusal physically bypasses the Work card, and pending places are not unresolved', async () => {
    const packet = await exported(page, 'capacity-bypass.json');
    const held = packet.events.find(row => row.kind === 'acquired');
    await setCursor(page, held.sequence);
    assert.equal(await page.locator('[data-flow-slots]').getAttribute('data-unresolved'), '0');
    assert.equal(await page.locator('.flow-map__slot[data-state="held"]').count(), 1);
    assert.equal(await page.locator('.flow-map__slot[data-state="unresolved"]').count(), 0);
    const refused = packet.events.find(row => row.kind === 'denied' && row.stage === 'settle');
    await setCursor(page, refused.sequence);
    assert.equal(await page.locator('.flow-map__node[data-flow-node="work"]').getAttribute('data-state'), 'idle');
    const geometry = await page.evaluate(() => {
      const wire = document.querySelector('[data-flow-edge="reserve-settle"]');
      const work = document.querySelector('.flow-map__node[data-flow-node="work"]').getBoundingClientRect();
      const crossesWork = path => Array.from({ length: 121 }, (_, index) => {
        const point = path.getPointAtLength(path.getTotalLength() * index / 120).matrixTransform(path.getScreenCTM());
        return point.x > work.left && point.x < work.right && point.y > work.top && point.y < work.bottom;
      }).some(Boolean);
      const actualCrosses = crossesWork(wire);
      const first = wire.getPointAtLength(0), last = wire.getPointAtLength(wire.getTotalLength());
      const flat = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const middle = (first.x + last.x) / 2;
      flat.setAttribute('d', `M ${first.x} ${first.y} C ${middle} ${first.y}, ${middle} ${last.y}, ${last.x} ${last.y}`);
      wire.parentElement.append(flat); const priorFlatCrosses = crossesWork(flat); flat.remove();
      return { actualCrosses, priorFlatCrosses, followsWire: document.querySelector('.flow-map__travel-guide').getAttribute('d').startsWith(wire.getAttribute('d')) };
    });
    assert.equal(geometry.actualCrosses, false, 'The refused request crosses Work visually.');
    assert.equal(geometry.priorFlatCrosses, true, 'Regression fixture must expose the previous straight-line bypass.');
    assert.equal(geometry.followsWire, true, 'Recorded packet diverges from the illuminated bypass.');
    await shot(page, 'desktop-capacity-bypass.png');
  });

  await check('Release branch confirms the next operation and leaves no held capacity', async () => {
    await selectScenario(page, 'failure'); await completeRun(page);
    const packet = await exported(page, 'failure-release.json');
    assert.equal(packet.operations[0].status, 'released_after_failure');
    assert.equal(packet.operations[0].workInvocations, 1);
    assert.equal(packet.summary.confirmed, 1);
    assert.equal(packet.summary.held, 0);
    assert.equal(packet.summary.workCalls, 2);
    const release = packet.events.find(event => event.kind === 'released_after_failure');
    await setCursor(page, release.sequence);
    assert.equal(await page.locator('.flow-map__branch[data-flow-node="release"]').getAttribute('data-state'), 'current');
    assert.match(await page.locator('.flow-map__slots-label').textContent(), /0 confirmed · 0 held \/ 1/);
    const nextSettled = packet.events.find(event => event.attemptId === 'next' && event.stage === 'settle');
    assert.ok(nextSettled, 'the released slot must be followed by a captured successful operation');
    await setCursor(page, nextSettled.sequence);
    assert.match(await page.locator('.flow-map__slots-label').textContent(), /1 confirmed · 0 held \/ 1/);
    await shot(page, 'desktop-release.png');
  });

  await check('Unknown usage remains an unresolved hold and is excluded from the known spend total', async () => {
    await selectScenario(page, 'ambiguous'); await completeRun(page);
    const packet = await exported(page, 'ambiguous.json');
    assert.equal(packet.summary.held, 2);
    assert.equal(packet.summary.unknownCostOperations, 1);
    assert.equal(packet.summary.spentUsd, 0.0045);
    assert.match(await page.locator('#known-spend').textContent(), /\+\s*\?/);
    assert.equal(await page.locator('#copy').isEnabled(), true);
    const ambiguous = packet.events.find(event => event.kind === 'work_outcome_ambiguous');
    await setCursor(page, ambiguous.sequence);
    assert.equal(await page.locator('[data-flow-slots]').getAttribute('data-unresolved'), '1');
    assert.equal(await page.locator('.flow-map__slot[data-state="unresolved"]').count(), 1);
    assert.equal(await page.locator('.flow-map__branch[data-flow-node="reconcile"]').getAttribute('data-state'), 'current');
    assert.equal(await page.locator('#known-spend').textContent(), '$0.0000 + ?');
    await shot(page, 'desktop-uncertain-prefix.png');
  });

  await check('Duplicate IDs suppress duplicate callbacks; cache lens exposes all five SDK buckets', async () => {
    await selectScenario(page, 'duplicate'); await completeRun(page);
    const duplicates = await exported(page, 'duplicate.json');
    assert.equal(duplicates.summary.workCalls, 2);
    assert.deepEqual(duplicates.operations.map(row => row.workInvocations), [1, 0, 1, 0]);
    assert.equal(duplicates.operations[1].status, 'operation_in_progress');
    assert.equal(duplicates.operations[3].status, 'operation_terminal');
    await selectScenario(page, 'cache'); await completeRun(page);
    const cache = await exported(page, 'cache.json');
    assert.equal(cache.operations.length, 4);
    assert.equal(cache.operations[1].estimatedUsage.cacheReadTokens, 10000);
    await page.locator('#inspect').click();
    assert.equal(await page.locator('#inspector').evaluate(element => element.open), true);
    await page.locator('#inspector details summary').click();
    await page.locator('#operation-list button[data-attempt="read"]').click();
    await page.locator('#inspect').click();
    assert.equal(await page.locator('#pricing-lens').isVisible(), true);
    assert.equal(await page.locator('#token-buckets [data-bucket]').count(), 5);
    assert.equal(await page.locator('#token-buckets [data-bucket="cacheReadTokens"] b').textContent(), '10,000 tokens');
    assert.match(await page.locator('.drawer-source').textContent(), /Jev and MCP workers are not connected/);
    assert.match(await page.locator('.drawer-source').textContent(), /playback speed is presentation timing/);
    await shot(page, 'desktop-cache-inspector.png');
    await page.locator('#inspector').evaluate(element => element.close());
  });

  await check('Invalid draft and changed conditions preserve the immutable captured journal', async () => {
    await selectScenario(page, 'balanced'); await completeRun(page);
    const before = await exported(page, 'before-invalid.json');
    await page.locator('#capacity').fill('1.5'); await page.locator('#run').click();
    assert.equal(await page.locator('#form-error').isVisible(), true);
    assert.match(await page.locator('#form-error').textContent(), /whole number/);
    assert.equal((await exported(page, 'after-invalid.json')).id, before.id);
    await page.locator('#capacity').fill('5');
    assert.match(await page.locator('#draft-note').textContent(), /Draft changed/);
    assert.equal((await exported(page, 'changed-draft.json')).id, before.id);
    assert.equal((await readFile(path.join(output, 'changed-draft.json'), 'utf8')).includes('"capacityLimit": 4'), true);
    assert.equal(await page.locator('#run').isEnabled(), true);
  });

  let baselineId, currentId;
  await check('Baseline 4 to current 5 compares only same-plan metrics and exports both journals', async () => {
    await page.locator('#capacity').fill('4'); await completeRun(page);
    const baseline = await exported(page, 'comparison-baseline.json');
    baselineId = baseline.id;
    await page.locator('#open-result').click();
    await page.locator('#pin').click();
    await page.locator('#capacity').fill('5'); await completeRun(page);
    currentId = (await exported(page, 'comparison-current.json')).id;
    assert.notEqual(currentId, baselineId);
    await page.locator('#tab-compare').click();
    assert.equal(await page.locator('#comparison-body').isVisible(), true);
    assert.match(await page.locator('#baseline-settings').textContent(), /4 slots/);
    assert.match(await page.locator('#current-settings').textContent(), /5 slots/);
    assert.equal(await page.locator('.compare-metric').count(), 3);
    assert.equal(await page.locator('[data-metric="confirmed"] b').textContent(), '4 → 5');
    assert.equal(await page.locator('[data-metric="work_calls"] b').textContent(), '5 → 6');
    assert.match(await page.locator('[data-metric="known_estimated_spend_usd"] small').textContent(), /known-estimate delta/);
    const packet = await exported(page, 'comparison.json', '#export-comparison');
    assert.equal(packet.baseline.id, baselineId);
    assert.equal(packet.current.id, currentId);
    assert.equal(packet.current.summary.confirmed, 5);
    assert.equal(packet.comparison.comparable, true);
  });

  await check('Watching baseline A keeps current B; unpin returns to B without replacing its journal', async () => {
    await page.locator('#watch-baseline').click();
    await captured(page);
    await page.waitForFunction(() => document.querySelector('#recorded-settings').textContent.startsWith('A /'));
    await finishCaptured(page);
    assert.match(await page.locator('#mode-label').textContent(), /Baseline/);
    assert.equal((await exported(page, 'watched-baseline.json')).id, baselineId);
    await page.locator('#tab-compare').click();
    await page.locator('#unpin').click();
    assert.match(await page.locator('#recorded-settings').textContent(), /5 slots/);
    assert.doesNotMatch(await page.locator('#recorded-settings').textContent(), /^A\s*\//);
    assert.equal((await exported(page, 'after-unpin-current.json')).id, currentId);
    await page.locator('#tab-flow').click();
    assert.equal(await page.locator('#open-result').isVisible(), true);
    await page.locator('#open-result').click();
    assert.equal(await page.locator('#outcome').isVisible(), true);
    await page.locator('#close-result').click();
  });

  await check('Native tabs and inspector support keyboard selection, accessible naming, Escape, and focus return', async () => {
    await page.locator('#tab-flow').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#tab-compare').getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-compare');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#panel-setups').isVisible(), true);
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#tab-flow').getAttribute('aria-selected'), 'true');
    await page.locator('#about').click();
    assert.equal(await page.locator('#inspector').evaluate(element => element.open), true);
    assert.equal(await page.locator('#inspector').getAttribute('aria-labelledby'), 'inspector-title');
    assert.equal(await page.locator('#inspector').evaluate(element => element.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#inspector').evaluate(element => element.open), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'about');
  });

  const notebookKey = 'planrlabs.threshold.notebook.v1';
  const seeded = {
    schema: 'threshold-notebook-v1', revision: 4,
    setups: [{
      id: '5e2e9ee2-7295-4e31-a592-c3bbdc4ec991', name: 'Recovered local setup',
      savedAt: '2026-09-30T15:00:00.000Z',
      settings: { scenarioId: 'failure', ceilingUsd: 0.12, capacityLimit: 1 },
    }],
  };
  const seededRaw = JSON.stringify(seeded);
  await check('Original v1 notebook recovers after reload and opens draft conditions without running work', async () => {
    const seededContext = await browser.newContext({ viewport: { width: 1500, height: 1080 } });
    const seededPage = await seededContext.newPage(); attachPage(seededPage);
    await seededPage.addInitScript(({ key, raw }) => localStorage.setItem(key, raw), { key: notebookKey, raw: seededRaw });
    await seededPage.goto(origin); await ready(seededPage);
    await seededPage.locator('#tab-setups').click();
    assert.equal(await seededPage.locator('.saved-setup').count(), 1);
    assert.equal(await seededPage.evaluate(key => localStorage.getItem(key), notebookKey), seededRaw);
    await seededPage.locator('.saved-setup').click();
    assert.equal(await seededPage.locator('#scenario').inputValue(), 'failure');
    assert.equal(await seededPage.locator('#capacity').inputValue(), '1');
    assert.equal(await seededPage.locator('#mode-label').textContent(), 'Ready');
    assert.equal(await seededPage.locator('#play').isEnabled(), false);
    assert.equal(await seededPage.evaluate(key => localStorage.getItem(key), notebookKey), seededRaw);
    await seededPage.reload(); await ready(seededPage);
    await seededPage.locator('#tab-setups').click();
    assert.equal(await seededPage.locator('.saved-setup').count(), 1);
    await seededPage.locator('.saved-setup').click();
    assert.equal(await seededPage.locator('#capacity').inputValue(), '1');
    assert.equal(await seededPage.locator('#mode-label').textContent(), 'Ready');
    assert.equal(await seededPage.evaluate(key => localStorage.getItem(key), notebookKey), seededRaw);
    await seededContext.close();
  });

  await check('Two tabs merge notebook saves while preserving each tab’s open draft', async () => {
    const shared = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const one = await shared.newPage(), two = await shared.newPage(); attachPage(one); attachPage(two);
    await Promise.all([one.goto(origin), two.goto(origin)]); await Promise.all([ready(one), ready(two)]);
    await one.locator('#capacity').fill('5'); await two.locator('#capacity').fill('6');
    await Promise.all([one.locator('#tab-setups').click(), two.locator('#tab-setups').click()]);
    await one.locator('#setup-name').fill('First tab'); await two.locator('#setup-name').fill('Second tab');
    await Promise.all([one.locator('#save-setup').click(), two.locator('#save-setup').click()]);
    await one.waitForFunction(() => document.querySelectorAll('.saved-setup').length === 2);
    await two.waitForFunction(() => document.querySelectorAll('.saved-setup').length === 2);
    const stored = await one.evaluate(key => JSON.parse(localStorage.getItem(key)), notebookKey);
    assert.equal(stored.schema, 'threshold-notebook-v1');
    assert.equal(stored.revision, 2);
    assert.deepEqual(stored.setups.map(row => row.name).sort(), ['First tab', 'Second tab']);
    assert.ok(stored.setups.every(row => Object.keys(row).join(',') === 'id,name,savedAt,settings'));
    assert.equal(await one.locator('#capacity').inputValue(), '5');
    assert.equal(await two.locator('#capacity').inputValue(), '6');
    await shared.close();
  });

  await check('Corrupt and future notebook data stay intact and can be backed up verbatim', async () => {
    for (const [name, raw, prefix] of [
      ['corrupt', '{broken', /needs repair/],
      ['future', JSON.stringify({ schema: 'threshold-notebook-v2', revision: 9, setups: [] }), /unsupported version/],
    ]) {
      const isolated = await browser.newContext({ acceptDownloads: true });
      const damaged = await isolated.newPage(); attachPage(damaged);
      await damaged.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: notebookKey, value: raw });
      await damaged.goto(origin); await ready(damaged); await damaged.locator('#tab-setups').click();
      assert.match(await damaged.locator('#notebook-status').textContent(), prefix);
      assert.equal(await damaged.locator('#save-setup').isEnabled(), false);
      assert.equal(await damaged.evaluate(key => localStorage.getItem(key), notebookKey), raw);
      const saved = await downloadedText(damaged, '#notebook-backup', name + '-notebook.json');
      assert.equal(saved, raw);
      await isolated.close();
    }
  });

  await check('No-lock and quota failures preserve notebook state and never report a save', async () => {
    const noLock = await browser.newContext();
    await noLock.addInitScript(({ key, raw }) => {
      localStorage.setItem(key, raw);
      Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    }, { key: notebookKey, raw: seededRaw });
    const locked = await noLock.newPage(); attachPage(locked);
    await locked.goto(origin); await ready(locked); await locked.locator('#tab-setups').click();
    assert.equal(await locked.locator('#save-setup').isEnabled(), false);
    assert.match(await locked.locator('#notebook-status').textContent(), /coordination/);
    assert.equal(await locked.evaluate(key => localStorage.getItem(key), notebookKey), seededRaw);
    await noLock.close();

    const quotaContext = await browser.newContext();
    await quotaContext.addInitScript(() => {
      Storage.prototype.setItem = function () { throw new DOMException('Test quota', 'QuotaExceededError'); };
    });
    const quota = await quotaContext.newPage(); attachPage(quota);
    await quota.goto(origin); await ready(quota); await quota.locator('#tab-setups').click();
    await quota.locator('#setup-name').fill('Must not save'); await quota.locator('#save-setup').click();
    await quota.waitForFunction(() => document.querySelector('#notebook-status').textContent.startsWith('Not saved:'));
    assert.equal(await quota.evaluate(key => localStorage.getItem(key), notebookKey), null);
    assert.equal(await quota.locator('#run').isEnabled(), true);
    await quotaContext.close();
  });

  await check('Reduced motion stays static but keeps manual journal inspection', async () => {
    const reducedContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const reduced = await reducedContext.newPage(); attachPage(reduced);
    await reduced.emulateMedia({ reducedMotion: 'reduce' });
    await reduced.goto(origin); await ready(reduced); await completeRun(reduced);
    assert.equal(await reduced.locator('#play').isEnabled(), false);
    assert.equal(await reduced.locator('#instrument').getAttribute('data-playing'), 'false');
    assert.equal(await reduced.locator('.flow-map').evaluate(element => element.classList.contains('flow-map--reduced')), true);
    await setCursor(reduced, 0);
    await reduced.locator('#step').click();
    assert.equal(await reduced.locator('#timeline').inputValue(), '1');
    const fixed = await position(reduced); await reduced.waitForTimeout(180);
    assert.deepEqual(await position(reduced), fixed);
    assert.equal(await reduced.locator('#outcome').isVisible(), false);
    await reduced.locator('#finish').click();
    assert.equal(await reduced.locator('#open-result').isVisible(), true);
    await reduced.locator('#open-result').click();
    assert.equal(await reduced.locator('#outcome').isVisible(), true);
    await reduced.locator('#close-result').click();
    await reducedContext.close();
  });

  await check('390 and 360 phone layouts remain reachable, unclipped, and showcase the recorded source', async () => {
    for (const width of [390, 360]) {
      const phoneContext = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 800 }, acceptDownloads: true,
      });
      const phone = await phoneContext.newPage(); attachPage(phone);
      await phone.goto(origin); await ready(phone); await selectScenario(phone, 'failure'); await completeRun(phone);
      assert.equal(await phone.locator('#truth-label').textContent(), 'Actual SDK · synthetic requests · local memory ledger');
      assert.equal(await phone.locator('#mode-label').textContent(), 'Recorded run · complete');
      await noClipping(phone); await shot(phone, 'phone-' + width + '.png');
      await phone.locator('#showcase').click();
      assert.equal(await phone.locator('#showcase').getAttribute('aria-pressed'), 'true');
      assert.equal(await phone.locator('#panel-flow').isVisible(), true);
      assert.match(await phone.locator('#truth-label').textContent(), /Actual SDK.*synthetic requests.*local memory ledger/);
      await noClipping(phone); await shot(phone, 'showcase-' + width + '.png');
      await phone.locator('#showcase').click();
      await phoneContext.close();
    }
  });

  await check('Presentation fits a 1280 by 720 app window without hiding playback or source', async () => {
    const compact = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const windowPage = await compact.newPage(); attachPage(windowPage);
    await windowPage.goto(origin); await ready(windowPage); await completeRun(windowPage);
    await windowPage.locator('#showcase').click();
    await windowPage.keyboard.press('Control+Home');
    const fit = await windowPage.evaluate(() => {
      const panel = document.querySelector('#instrument').getBoundingClientRect();
      const source = document.querySelector('.canvas-foot').getBoundingClientRect();
      const reserve = document.querySelector('.flow-map__node[data-flow-node="reserve"]').getBoundingClientRect();
      const slots = document.querySelector('[data-flow-slots]').getBoundingClientRect();
      return { panelTop: panel.top, panelBottom: panel.bottom, sourceBottom: source.bottom, viewport: innerHeight, slotsClear: slots.top > reserve.bottom };
    });
    assert.ok(fit.panelTop >= 0 && fit.panelBottom <= fit.viewport, 'Presentation canvas exceeds the actual app window.');
    assert.ok(fit.sourceBottom <= fit.viewport, 'Source label is outside the presentation frame.');
    assert.equal(fit.slotsClear, true, 'Short-window occupancy overlaps Reserve.');
    await noClipping(windowPage); await shot(windowPage, 'showcase-app-window.png');
    await compact.close();
  });

  await check('Presentation keeps a fixed wide frame through short and long recorded captions', async () => {
    const cinema = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const cinemaPage = await cinema.newPage(); attachPage(cinemaPage);
    await cinemaPage.goto(origin); await ready(cinemaPage); await completeRun(cinemaPage);
    await cinemaPage.locator('#showcase').click();
    const dimensions = [];
    for (const sequence of [0, 1, 4, 10, 29, 31]) {
      await setCursor(cinemaPage, sequence);
      dimensions.push(await cinemaPage.locator('#instrument').evaluate(el => {
        const r = el.getBoundingClientRect(); return { width: r.width, left: r.left, right: r.right };
      }));
    }
    assert.ok(dimensions.every(r => r.width >= 1344), 'The cinema composition shrank to its caption.');
    assert.ok(dimensions.every(r => Math.abs(r.width - dimensions[0].width) <= 1 && Math.abs(r.left - dimensions[0].left) <= 1), 'Recorded captions changed frame geometry.');
    assert.equal(await cinemaPage.locator('.flow-map--narrow').count(), 0, 'Full HD presentation must use the wide rail.');
    await shot(cinemaPage, 'presentation-fixed-frame.png'); await cinema.close();
  });

  await check('Damaged vendored source fails closed and repaired reload restores Run', async () => {
    const isolated = await browser.newContext();
    const broken = await isolated.newPage(); attachPage(broken);
    await broken.route('**/vendor/cost-governor-kit/source.json', async route => {
      const response = await route.fetch();
      const manifest = await response.json();
      manifest.outputs['pricing.js'] = '0'.repeat(64);
      await route.fulfill({ response, json: manifest });
    });
    await broken.goto(origin);
    await broken.waitForFunction(() => document.body.dataset.ready === 'false');
    assert.equal(await broken.locator('#run').isEnabled(), false);
    assert.equal(await broken.locator('#form-error').isVisible(), true);
    assert.match(await broken.locator('#form-error').textContent(), /does not match/);
    await broken.unroute('**/vendor/cost-governor-kit/source.json');
    await broken.reload(); await ready(broken);
    assert.equal(await broken.locator('#run').isEnabled(), true);
    await isolated.close();
  });

  await check('Loopback server rejects mutation, foreign host, and traversal', async () => {
    assert.equal((await page.request.post(origin)).status(), 405);
    assert.equal((await page.request.get(origin, { headers: { Host: 'untrusted.example' } })).status(), 403);
    assert.equal((await page.request.get(origin + '/%2e%2e/%2e%2e/.codex/config.toml')).status(), 404);
    assert.deepEqual(report.externalRequests, []);
  });

  assert.deepEqual(report.pageErrors, []);
  report.status = 'PASS'; await save();
  await context.close();
  process.stdout.write('Threshold motion browser: ' + report.checks.length + ' checks PASS; ' +
    report.screenshots.length + ' screenshots; no page errors or external requests. Evidence: ' + output + '\n');
} catch (error) {
  report.status = 'FAIL'; report.error = error.message; await save(); throw error;
} finally {
  if (browser) await browser.close();
}
