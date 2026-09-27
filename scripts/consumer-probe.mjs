// Runtime consumer probe. scripts/verify-package.mjs copies this file into a
// clean project that installed the packed tarball, then runs it there, so
// every import below resolves the published package by name.
// Ported from the package probe in this repo's history and extended.
// No network, no provider calls.
import assert from 'node:assert/strict';
import * as root from 'cost-governor-kit';
import * as pricing from 'cost-governor-kit/pricing';
import * as ceiling from 'cost-governor-kit/preCallCeiling';
import * as reserve from 'cost-governor-kit/reserveConfirm';

// Subpaths re-export the same functions as the root entry.
for (const [name, fn] of Object.entries({ ...pricing, ...ceiling, ...reserve })) {
  assert.equal(root[name], fn, `root export ${name} differs from its subpath export`);
}

const {
  CACHE_CREATION_1H_MULTIPLIER, CACHE_CREATION_5M_MULTIPLIER, CACHE_READ_MULTIPLIER,
  checkPreCallCeiling, estimateCostUsd, formatRatesForLog, getRatesOrThrow,
  withCapacityReservation, withReserveConfirm,
} = root;

// Pricing: hand-calculated values.
assert.deepEqual([CACHE_READ_MULTIPLIER, CACHE_CREATION_5M_MULTIPLIER, CACHE_CREATION_1H_MULTIPLIER], [0.1, 1.25, 2]);
const rates = { inputPerMillion: 3, outputPerMillion: 15 };
assert.equal(estimateCostUsd(rates, { inputTokens: 1_000_000 }), 3);
assert.equal(
  estimateCostUsd(rates, { inputTokens: 1_200, outputTokens: 400, cacheReadTokens: 8_000, cacheCreation5mTokens: 2_000 }),
  0.0195,
);
assert.equal(estimateCostUsd(rates, { cacheCreation1hTokens: 1_000_000 }), 6);
// cacheReadPerMillion overrides the fixed 0.1x ratio (0.3 -> 1) when supplied.
assert.equal(estimateCostUsd({ ...rates, cacheReadPerMillion: 1 }, { cacheReadTokens: 1_000_000 }), 1);
assert.throws(
  () => estimateCostUsd({ ...rates, cacheReadPerMillion: -1 }, {}),
  /cacheReadPerMillion/,
);
assert.throws(() => estimateCostUsd(rates, { inputTokens: -1 }), /inputTokens/);
assert.throws(() => estimateCostUsd(rates, { input_tokens: 1_000 }), /unknown field "input_tokens"/);
assert.equal(formatRatesForLog(rates), '$3/M in, $15/M out');
assert.deepEqual(getRatesOrThrow({ 'toy-model': rates }, 'toy-model'), rates);
assert.throws(() => getRatesOrThrow({ 'toy-model': rates }, 'constructor'), /no pricing entry/);

// Pre-call ceiling: allowed at the ceiling, denied above it.
const atCeiling = checkPreCallCeiling({
  rates, spentSoFarUsd: 4, ceilingUsd: 7, estimatedNextCallUsage: { inputTokens: 1_000_000 },
});
assert.deepEqual(atCeiling, {
  allowed: true, projectedNextCallCostUsd: 3, projectedTotalUsd: 7, ceilingUsd: 7, reason: undefined,
});
const denied = checkPreCallCeiling({
  rates, spentSoFarUsd: 0, ceilingUsd: 0, estimatedNextCallUsage: { inputTokens: 1_000_000 },
});
assert.equal(denied.allowed, false);
assert.match(denied.reason, /would exceed the ceiling of \$0\.000000/);

// Strict reservation: a denial never runs work or touches confirm/release.
let calls = 0;
const deniedReservation = await withCapacityReservation({
  reserveCapacity: async () => ({ status: 'denied' }),
  confirmReservation: async () => { throw new Error('Must not confirm denied work'); },
  releaseReservation: async () => { throw new Error('Must not release denied work'); },
}, { key: 'synthetic-consumer', limit: 0, operationId: 'synthetic-operation' }, async () => {
  calls++;
  return { status: 'succeeded', value: 'unexpected' };
});
assert.equal(deniedReservation.status, 'denied');
assert.equal(calls, 0);

// Strict reservation: acquired -> work once -> confirm once.
const log = [];
const confirmed = await withCapacityReservation({
  reserveCapacity: async (request) => {
    log.push('reserve');
    return {
      status: 'acquired',
      reservation: { id: 'r-1', key: request.key, operationId: request.operationId, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    };
  },
  confirmReservation: async () => { log.push('confirm'); },
  releaseReservation: async () => { log.push('release'); },
}, { key: 'synthetic-consumer', limit: 1, operationId: 'op-1' }, async () => {
  log.push('work');
  return { status: 'succeeded', value: 42 };
});
assert.equal(confirmed.status, 'confirmed');
assert.equal(confirmed.value, 42);
assert.deepEqual(log, ['reserve', 'work', 'confirm']);
await assert.rejects(
  withCapacityReservation({}, { key: 'k', limit: Number.NaN, operationId: 'op' }, async () => ({ status: 'succeeded', value: 1 })),
  /limit must be a non-negative safe integer/,
);

// Advisory helper: commits only after success; a throw is never committed.
const counts = new Map();
const ledger = {
  checkUnderLimit: async (key, limit) => (counts.get(key) ?? 0) < limit,
  commitUsage: async (key) => { counts.set(key, (counts.get(key) ?? 0) + 1); },
};
assert.deepEqual(await withReserveConfirm(ledger, 'k', 1, async () => 'ok'), { allowed: true, result: 'ok' });
assert.deepEqual(await withReserveConfirm(ledger, 'k', 1, async () => 'blocked'), { allowed: false });
await assert.rejects(withReserveConfirm(ledger, 'j', 1, async () => { throw new Error('upstream 500'); }), /upstream 500/);
assert.equal(counts.get('j'), undefined);
await assert.rejects(
  withReserveConfirm({ checkUnderLimit: async () => ({ allowed: false }), commitUsage: async () => {} }, 'k', 1, async () => 'x'),
  /must resolve to a boolean/,
);
// A commit that fails after a successful call returns the result with
// commitError, instead of discarding it.
const commitFailure = new Error('ledger down');
const flakyLedger = {
  checkUnderLimit: async () => true,
  commitUsage: async () => { throw commitFailure; },
};
assert.deepEqual(
  await withReserveConfirm(flakyLedger, 'k', 1, async () => 'paid'),
  { allowed: true, result: 'paid', commitError: commitFailure },
);

console.log('consumer-probe: ok');
