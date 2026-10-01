import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--source')) throw new Error('Usage: node tools/verify-source.mjs [--source /absolute/cost-governor-kit]');
const manifest = JSON.parse(await readFile(path.join(root, 'vendor/cost-governor-kit/source.json'), 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
assert.equal(manifest.schema, 'threshold-sdk-source-v1');
assert.equal(manifest.package, 'cost-governor-kit');
for (const name of ['index.js', 'internal.js', 'pricing.js', 'preCallCeiling.js', 'reserveConfirm.js', 'LICENSE']) {
  assert.equal(hash(await readFile(path.join(root, 'vendor/cost-governor-kit', name))), manifest.outputs[name], `Prepared file changed: ${name}`);
}
if (args[1]) {
  const source = path.resolve(args[1]);
  for (const [name, expected] of Object.entries(manifest.sources)) {
    assert.equal(hash(await readFile(path.join(source, name))), expected, `Current SDK source changed; regenerate the browser copy: ${name}`);
  }
}
for (const name of ['index.html', 'style.css', 'app.mjs', 'lib/session.mjs', 'README.md']) await readFile(path.join(root, name));
process.stdout.write(`Threshold SDK copy: 6 prepared files match their manifest${args[1] ? '; 6 owning source files match' : ''}.\n`);
