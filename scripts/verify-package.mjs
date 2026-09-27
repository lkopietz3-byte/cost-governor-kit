// Verifies the package a consumer would actually install.
//
//   node scripts/verify-package.mjs               check
//   node scripts/verify-package.mjs --update-api  rewrite api-surface.json
//
// What it does, in order:
//   1. `npm pack` the built package (run `npm run build` first).
//   2. Fail if the tarball contains anything outside the intended file set
//      (tests, configs, CI files, env files, node_modules).
//   3. Install that tarball into an empty temp project, offline, no scripts.
//   4. Import every `exports` entry by its public specifier, and check that
//      each declared types file exists.
//   5. Compare the exported names to the committed api-surface.json, so API
//      changes are always a deliberate diff.
//   6. Run scripts/consumer-probe.mjs (required, kit-specific) from the
//      consumer project, importing the package by name like a real user.
//   7. If scripts/consumer-probe.cjs exists, `require()` the package from a
//      plain CommonJS consumer, on a Node version that supports
//      require(esm) (20.19+/22.12+) — otherwise this step is skipped.
//   8. If scripts/consumer-probe.mts exists, compile it with strict
//      NodeNext settings against the installed declarations.
//
// No network access is needed and no package lifecycle scripts run.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const updateApi = process.argv.includes('--update-api');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const evidence = mkdtempSync(join(tmpdir(), `${pkg.name.replace(/[^a-z0-9]+/gi, '-')}-verify-`));
const consumer = join(evidence, 'consumer');
mkdirSync(consumer);

function run(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

console.log(`Package verification evidence: ${evidence}`);

// 1. Pack ------------------------------------------------------------------
const manifestText = run('npm', [
  'pack', '--json', '--offline', '--ignore-scripts', '--pack-destination', evidence,
]);
writeFileSync(join(evidence, 'pack.json'), manifestText);
const manifest = JSON.parse(manifestText);
assert.equal(manifest.length, 1, 'Expected exactly one packed package');
const filename = manifest[0].filename;
assert.equal(basename(filename), filename, 'Packed filename must be a basename');
const tarball = join(evidence, filename);

// 2. Tarball contents --------------------------------------------------------
const packed = manifest[0].files.map((f) => f.path);
const forbidden = [
  /(^|\/)node_modules\//, /(^|\/)\.env/, /(^|\/)\.github\//, /(^|\/)\.git(ignore|attributes)?$/,
  /\.test\.[cm]?[jt]s$/, /(^|\/)tests?\//, /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)eslint\.config\./, /(^|\/)vitest\.config\./, /(^|\/)scripts\//,
  /(^|\/)package-lock\.json$/, /\.tgz$/,
];
const leaked = packed.filter((p) => forbidden.some((re) => re.test(p)));
assert.deepEqual(leaked, [], `Tarball contains files that must not ship: ${leaked.join(', ')}`);
for (const required of ['package.json', 'README.md', 'LICENSE']) {
  assert.ok(packed.includes(required), `Tarball is missing ${required}`);
}
assert.ok(packed.some((p) => p.startsWith('dist/')), 'Tarball has no dist/ output; run npm run build first');

// 2b. Every source map's `sources` entry must resolve for a consumer: either
// that source file is itself shipped in the tarball, or the map embeds its
// text via a non-empty `sourcesContent` entry. This kit currently emits no
// source maps at all (see README/ENGINEERING), so this is a no-op today; it
// guards against a future tsconfig change (or a stale dist/ tsc did not
// clean up after one) shipping a map nothing can resolve.
const packedSet = new Set(packed);
for (const mapPath of packed.filter((p) => p.endsWith('.map'))) {
  const map = JSON.parse(readFileSync(join(root, mapPath), 'utf8'));
  const sources = Array.isArray(map.sources) ? map.sources : [];
  const sourcesContent = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
  const mapDir = mapPath.split('/').slice(0, -1);
  sources.forEach((src, i) => {
    const parts = [...mapDir, ...String(src).split('/')];
    const resolved = [];
    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') resolved.pop();
      else resolved.push(part);
    }
    const shipped = packedSet.has(resolved.join('/'));
    const embedded = typeof sourcesContent[i] === 'string' && sourcesContent[i].length > 0;
    assert.ok(
      shipped || embedded,
      `${mapPath}: source "${src}" is neither shipped in the tarball nor embedded via sourcesContent ` +
        `(stale dist/? rebuild from clean, or check inlineSources)`,
    );
  });
}

// 3. Install into a clean consumer --------------------------------------------
run('npm', [
  'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
  '--prefix', consumer, tarball,
]);
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type: 'module', private: true, dependencies: { [pkg.name]: `file:${tarball}` } }));
const installed = join(consumer, 'node_modules', ...pkg.name.split('/'));

// 4. Every exports entry imports and has declarations -----------------------------
const entries = [];
for (const [subpath, target] of Object.entries(pkg.exports ?? { '.': pkg.main })) {
  if (subpath.includes('*')) continue; // pattern exports are checked by the kit's own probe
  const spec = subpath === '.' ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//, '')}`;
  const types = typeof target === 'object' ? target.types : undefined;
  if (types) assert.ok(existsSync(join(installed, types)), `${spec}: declared types file ${types} is missing from the tarball`);
  entries.push(spec);
}
assert.ok(entries.length > 0, 'No importable entries found in package.json exports');
writeFileSync(join(consumer, 'surface.mjs'), `
const out = {};
for (const spec of ${JSON.stringify(entries)}) {
  const mod = await import(spec);
  out[spec] = Object.keys(mod).sort();
}
console.log(JSON.stringify(out));
`);
const surface = JSON.parse(run(process.execPath, ['surface.mjs'], consumer));

// 5. Public API surface is a deliberate diff ---------------------------------------
const surfacePath = join(root, 'api-surface.json');
const surfaceText = `${JSON.stringify(surface, null, 2)}\n`;
if (updateApi) {
  writeFileSync(surfacePath, surfaceText);
  console.log(`Wrote ${surfacePath}`);
} else {
  assert.ok(existsSync(surfacePath), 'api-surface.json is missing; run: node scripts/verify-package.mjs --update-api');
  assert.equal(
    surfaceText,
    readFileSync(surfacePath, 'utf8'),
    'Exported names differ from api-surface.json. If the change is intended, run: node scripts/verify-package.mjs --update-api',
  );
}

// 6. Kit-specific runtime probe, importing by package name ---------------------------------
const probe = join(root, 'scripts', 'consumer-probe.mjs');
assert.ok(existsSync(probe), 'scripts/consumer-probe.mjs is required: exercise the real API the way a consumer would');
if (!updateApi) {
  assert.ok(
    !readFileSync(probe, 'utf8').includes('STUB-PROBE-REPLACE-ME'),
    'scripts/consumer-probe.mjs is still the generated stub. Replace it with a probe that calls the real API and asserts real outputs.',
  );
}
copyFileSync(probe, join(consumer, 'probe.mjs'));
run(process.execPath, ['probe.mjs'], consumer);

// 7. Optional CommonJS require() smoke test, on Node versions that support it -----------------
const cjsProbe = join(root, 'scripts', 'consumer-probe.cjs');
let commonjsChecked = false;
if (existsSync(cjsProbe)) {
  if (supportsRequireEsm(process.versions.node)) {
    // The .cjs extension makes Node treat this as CommonJS regardless of the
    // consumer project's own package.json "type": "module".
    copyFileSync(cjsProbe, join(consumer, 'probe.cjs'));
    run(process.execPath, ['probe.cjs'], consumer);
    commonjsChecked = true;
  } else {
    console.log(`Skipping CommonJS require() probe: Node ${process.versions.node} predates require(esm) support (20.19+/22.12+).`);
  }
}

/** Node 20.19+ and 22.12+ (and every 23+) support `require()` of an ESM package. */
function supportsRequireEsm(version) {
  const [major, minor] = version.split('.').map(Number);
  if (major > 22) return true;
  if (major === 22) return minor >= 12;
  if (major === 20) return minor >= 19;
  return false;
}

// 8. Optional strict type probe --------------------------------------------------------------
const typeProbe = join(root, 'scripts', 'consumer-probe.mts');
let typeChecked = false;
if (existsSync(typeProbe)) {
  copyFileSync(typeProbe, join(consumer, 'probe.mts'));
  run(process.execPath, [
    join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022',
    '--skipLibCheck', 'false', 'probe.mts',
  ], consumer);
  typeChecked = true;
}

console.log(JSON.stringify({
  status: 'passed',
  package: `${pkg.name}@${pkg.version}`,
  packedFiles: packed.length,
  tarballSha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'),
  importedEntries: entries,
  apiSurfaceChecked: !updateApi,
  commonjsChecked,
  strictDeclarationsChecked: typeChecked,
}));
