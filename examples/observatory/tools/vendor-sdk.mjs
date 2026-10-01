import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--source')) throw new Error('Usage: node tools/vendor-sdk.mjs [--source /absolute/cost-governor-kit]');
const source = path.resolve(args[1] || path.join(root, '../..'));
const require = createRequire(path.join(source, 'package.json'));
const ts = require('typescript');
const hash = data => createHash('sha256').update(data).digest('hex');
const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
if (pkg.name !== 'cost-governor-kit') throw new Error('Source must be the owning Cost Governor package.');
const destination = path.join(root, 'vendor/cost-governor-kit');
await mkdir(destination, { recursive: true });
const manifest = {
  schema: 'threshold-sdk-source-v1', package: pkg.name, version: pkg.version,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
  sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain', '--', 'src', 'package.json', 'LICENSE'], { cwd: source, encoding: 'utf8' }).trim()),
  generatedAt: new Date().toISOString(), compiler: `typescript ${ts.version}`,
  method: 'Fresh ES2022 module transpilation from the owning src; no dist cache.',
  sources: {}, outputs: {},
};
for (const name of ['index', 'internal', 'pricing', 'preCallCeiling', 'reserveConfirm']) {
  const text = await readFile(path.join(source, `src/${name}.ts`), 'utf8');
  const result = ts.transpileModule(text, { fileName: `${name}.ts`, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, newLine: ts.NewLineKind.LineFeed } });
  const errors = result.diagnostics?.filter(row => row.category === ts.DiagnosticCategory.Error) || [];
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: x => x, getCurrentDirectory: () => source, getNewLine: () => '\n' }));
  await writeFile(path.join(destination, `${name}.js`), result.outputText);
  manifest.sources[`src/${name}.ts`] = hash(text);
  manifest.outputs[`${name}.js`] = hash(result.outputText);
}
const license = await readFile(path.join(source, 'LICENSE'));
await writeFile(path.join(destination, 'LICENSE'), license);
manifest.sources.LICENSE = hash(license);
manifest.outputs.LICENSE = hash(license);
await writeFile(path.join(destination, 'source.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(`Prepared ${pkg.name}@${pkg.version}: 5 modules freshly derived from ${manifest.revision.slice(0, 7)}; core source dirty=${manifest.sourceDirty}.\n`);
