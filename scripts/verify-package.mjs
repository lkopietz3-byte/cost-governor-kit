import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = mkdtempSync(join(tmpdir(), 'cost-governor-package-'));
const consumer = join(evidence, 'consumer');
mkdirSync(consumer);

function run(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

// Read the actual manifest produced by npm, then install that tarball offline.
// Lifecycle scripts are disabled for both operations. No provider is invoked.
console.log(`Package verification evidence: ${evidence}`);
const manifestText = run('npm', [
  'pack', '--json', '--offline', '--ignore-scripts', '--pack-destination', evidence,
]);
writeFileSync(join(evidence, 'pack.json'), manifestText);
const manifest = JSON.parse(manifestText);
assert.equal(manifest.length, 1, 'Expected one packed package');
const filename = manifest[0].filename;
assert.equal(typeof filename, 'string');
assert.equal(basename(filename), filename, 'Packed filename must be a basename');
const tarball = join(evidence, filename);
run('npm', [
  'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
  '--prefix', consumer, tarball,
]);

writeFileSync(join(consumer, 'probe.mjs'), `
import assert from 'node:assert/strict';
import { estimateCostUsd, checkPreCallCeiling, withCapacityReservation } from 'cost-governor-kit';
import { estimateCostUsd as pricing } from 'cost-governor-kit/pricing';
import { checkPreCallCeiling as ceiling } from 'cost-governor-kit/preCallCeiling';
import { withCapacityReservation as reservation } from 'cost-governor-kit/reserveConfirm';
assert.equal(estimateCostUsd, pricing);
assert.equal(checkPreCallCeiling, ceiling);
assert.equal(withCapacityReservation, reservation);
const rates = { inputPerMillion: 3, outputPerMillion: 15 };
assert.equal(estimateCostUsd(rates, { inputTokens: 1_000_000 }), 3);
assert.throws(() => estimateCostUsd(rates, { inputTokens: -1 }));
assert.equal(checkPreCallCeiling({ rates, spentSoFarUsd: 0, ceilingUsd: 0, estimatedNextCallUsage: { inputTokens: 1_000_000 } }).allowed, false);
let calls = 0;
const result = await withCapacityReservation({
  reserveCapacity: async () => ({ status: 'denied' }),
  confirmReservation: async () => { throw new Error('Must not confirm denied work'); },
  releaseReservation: async () => { throw new Error('Must not release denied work'); },
}, { key: 'synthetic-consumer', limit: 0, operationId: 'synthetic-operation' }, async () => {
  calls++;
  return { status: 'succeeded', value: 'unexpected' };
});
assert.equal(result.status, 'denied');
assert.equal(calls, 0);
`);
run(process.execPath, ['probe.mjs'], consumer);

writeFileSync(join(consumer, 'probe.mts'), `
import { estimateCostUsd, checkPreCallCeiling, type ModelRates, type UsageTokens } from 'cost-governor-kit';
import { estimateCostUsd as pricingSubpath, type ModelRates as SubpathRates, type UsageTokens as SubpathUsage } from 'cost-governor-kit/pricing';
import { checkPreCallCeiling as ceilingSubpath, type PreCallCeilingCheck, type PreCallCeilingResult } from 'cost-governor-kit/preCallCeiling';
import { withCapacityReservation, type CapacityReservationLedger } from 'cost-governor-kit/reserveConfirm';
const rates: ModelRates = { inputPerMillion: 3, outputPerMillion: 15 };
const usage: UsageTokens = { inputTokens: 1000 };
const cost: number = estimateCostUsd(rates, usage);
const allowed: boolean = checkPreCallCeiling({ rates, estimatedNextCallUsage: usage, spentSoFarUsd: cost, ceilingUsd: 1 }).allowed;
const subpathRates: SubpathRates = rates;
const subpathUsage: SubpathUsage = usage;
const subpathCost: number = pricingSubpath(subpathRates, subpathUsage);
const subpathCheck: PreCallCeilingCheck = { rates: subpathRates, estimatedNextCallUsage: subpathUsage, spentSoFarUsd: subpathCost, ceilingUsd: 1 };
const subpathResult: PreCallCeilingResult = ceilingSubpath(subpathCheck);
const subpathAllowed: boolean = subpathResult.allowed;
const ledger: CapacityReservationLedger = {
  reserveCapacity: async () => ({ status: 'denied' }),
  confirmReservation: async () => undefined,
  releaseReservation: async () => undefined,
};
void withCapacityReservation(ledger, { key: 'consumer', limit: 1, operationId: 'synthetic-operation' }, async () => ({ status: 'succeeded', value: { allowed, subpathAllowed } }));
`);
run(process.execPath, [
  join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict',
  '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'probe.mts',
], consumer);

console.log(JSON.stringify({
  status: 'passed',
  packedFiles: manifest[0].files.length,
  tarballSha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'),
  offlineInstall: true,
  rootAndSubpathImports: true,
  strictDeclarations: true,
  realProviderCalls: 0,
}));
