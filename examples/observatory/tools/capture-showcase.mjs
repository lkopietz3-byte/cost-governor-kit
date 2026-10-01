import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ROOT } from './serve.mjs';
import { SCENARIOS } from '../lib/session.mjs';

const options = {}, args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  if (!['--out', '--scenario', '--url', '--playwright-root', '--chrome', '--ffmpeg'].includes(args[index]) || !args[index + 1] || options[args[index]]) throw new Error('Usage: node tools/capture-showcase.mjs --out /absolute/new-directory [--scenario balanced] [--playwright-root /absolute/playwright-package] [--ffmpeg /absolute/ffmpeg]');
  options[args[index]] = args[index + 1];
}
const output = options['--out'], scenario = options['--scenario'] || 'balanced';
if (!output || !path.isAbsolute(output) || !SCENARIOS.some(row => row.id === scenario)) throw new Error('Choose a new absolute output directory and a known scenario.');
const origin = options['--url'] || 'http://127.0.0.1:4320', url = new URL(origin);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) throw new Error('Capture is limited to a loopback HTTP preview.');
const pw = options['--playwright-root'] ? await import(pathToFileURL(path.join(options['--playwright-root'], 'index.mjs')).href) : await import('playwright');
await mkdir(output, { recursive: false });
const sha = data => createHash('sha256').update(data).digest('hex');
const source = {};
for (const name of ['app.mjs', 'style.css', 'viewport.css', 'flow-map.css', 'index.html', 'lib/flow-map.mjs', 'lib/session.mjs', 'tools/capture-showcase.mjs', 'vendor/cost-governor-kit/source.json']) source[name] = sha(await readFile(path.join(ROOT, name)));
let browser, context;
try {
  browser = await pw.chromium.launch({ executablePath: options['--chrome'] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, acceptDownloads: true, recordVideo: { dir: path.join(output, 'raw'), size: { width: 1920, height: 1080 } } });
  const page = await context.newPage(); const video = page.video(); const errors = [];
  const recordedFrom = performance.now();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.waitForFunction(() => document.body.dataset.ready === 'true');
  await page.locator('#scenario').selectOption(scenario);
  await page.locator('#run').click(); await page.waitForFunction(() => document.body.dataset.playing === 'true');
  await page.locator('#play').click();
  const pending = page.waitForEvent('download'); await page.locator('#export').click();
  const download = await pending; await download.saveAs(path.join(output, 'session.json'));
  const session = JSON.parse(await readFile(path.join(output, 'session.json'), 'utf8'));
  await page.locator('#showcase').click();
  await page.locator('#speed').selectOption('550');
  await page.locator('#timeline').fill('0'); await page.locator('#timeline').dispatchEvent('input');
  assert.ok(await page.locator('.canvas-foot').evaluate(item => { const box = item.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }), 'Source/synthetic label must fit inside the capture');
  await page.waitForTimeout(300);
  const presentationStart = (performance.now() - recordedFrom) / 1000;
  await page.waitForTimeout(800);
  await page.locator('#play').click();
  await page.waitForFunction(() => document.body.dataset.cursor === '4');
  await page.screenshot({ path: path.join(output, 'poster.png') });
  await page.waitForFunction(() => document.querySelector('#instrument').dataset.playing === 'false', null, { timeout: 30000 });
  assert.equal(Number(await page.locator('#timeline').inputValue()), session.events.length);
  await page.waitForTimeout(1400);
  const presentationDuration = (performance.now() - recordedFrom) / 1000 - presentationStart;
  await page.screenshot({ path: path.join(output, 'complete.png'), animations: 'disabled' });
  await context.close(); context = null;
  const raw = await video.path(), final = path.join(output, `threshold-${scenario}.webm`);
  if (options['--ffmpeg']) {
    execFileSync(options['--ffmpeg'], ['-hide_banner', '-loglevel', 'error', '-ss', presentationStart.toFixed(3), '-i', raw, '-t', presentationDuration.toFixed(3), '-an', '-c:v', 'libvpx', '-b:v', '1400k', '-deadline', 'good', '-cpu-used', '3', '-n', final], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
  } else await copyFile(raw, final);
  assert.deepEqual(errors, []);
  const bytes = await readFile(final); assert.ok(bytes.length > 20000, 'Video output is unexpectedly empty');
  const receipt = { schema: 'threshold-motion-showcase-v1', scenario, origin, browser: browser.version(), node: process.version, viewport: { width: 1920, height: 1080 }, source,
    sourceSessionSha256: sha(await readFile(path.join(output, 'session.json'))), video: path.basename(final), videoBytes: bytes.length, videoSha256: sha(bytes),
    presentationSeconds: Number(presentationDuration.toFixed(3)), trimmedSetup: Boolean(options['--ffmpeg']), secondsPerRecordedEvent: 0.55, events: session.events.length,
    completedAttempts: session.summary.completedAttempts, pageErrors: errors,
    scope: 'Actual browser replay of real local SDK decisions on synthetic input; silent showcase; no provider billing or production enforcement evidence.' };
  await writeFile(path.join(output, 'capture.json'), JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(`Captured ${scenario}: ${session.events.length} real journal events, ${receipt.presentationSeconds}s, ${Math.round(bytes.length / 1024)} KiB WebM. ${final}\n`);
} finally { if (context) await context.close(); if (browser) await browser.close(); }
