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
import * as admission from 'cost-governor-kit/admission';

// Subpaths re-export the same functions as the root entry.
for (const [name, fn] of Object.entries({ ...pricing, ...ceiling, ...reserve, ...admission })) {
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
// Records must be plain: a Map, Set, Date, RegExp or class instance is a TypeError,
// never priced as zero usage or read as an empty table.
for (const usage of [new Map([['inputTokens', 1_000_000]]), new Set(), new Date(0), /x/, new (class Usage { inputTokens = 1_000_000 })()]) {
  assert.throws(() => estimateCostUsd(rates, usage), TypeError);
  assert.throws(
    () => checkPreCallCeiling({ rates, spentSoFarUsd: 0, ceilingUsd: 0, estimatedNextCallUsage: usage }),
    TypeError,
  );
}
assert.equal(estimateCostUsd(rates, Object.assign(Object.create(null), { inputTokens: 1_000_000 })), 3);
assert.throws(() => estimateCostUsd(new Map(), {}), TypeError);
assert.throws(() => getRatesOrThrow(new Map([['toy-model', rates]]), 'toy-model'), TypeError);
assert.throws(() => getRatesOrThrow({ 'toy-model': rates }, ['toy-model']), TypeError);
assert.deepEqual(getRatesOrThrow({ 'toy-model': rates }, 'toy-model'), rates);
assert.throws(() => getRatesOrThrow({ 'toy-model': rates }, 'constructor'), /no pricing entry/);

// Pre-call ceiling: allowed at the ceiling, denied above it.
const atCeiling = checkPreCallCeiling({
  rates, spentSoFarUsd: 4, ceilingUsd: 7, estimatedNextCallUsage: { inputTokens: 1_000_000 },
});
assert.deepStrictEqual(atCeiling, {
  allowed: true, projectedNextCallCostUsd: 3, projectedTotalUsd: 7, ceilingUsd: 7,
});
assert.equal(Object.hasOwn(atCeiling, 'reason'), false);
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
// A key that shows nothing (zero-width space, bidi isolates) is blank, and no adapter is called.
await assert.rejects(
  withCapacityReservation({}, { key: '\u200B\u2066', limit: 1, operationId: 'op' }, async () => ({ status: 'succeeded', value: 1 })),
  RangeError,
);
await assert.rejects(
  withCapacityReservation({}, new Map(), async () => ({ status: 'succeeded', value: 1 })),
  TypeError,
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
// A ledger may reject with any value, including a falsy one: detect the failure by
// presence (Object.hasOwn), not truthiness.
for (const rejection of [undefined, null, false, 0, '']) {
  const falsyLedger = { checkUnderLimit: async () => true, commitUsage: () => Promise.reject(rejection) };
  const outcome = await withReserveConfirm(falsyLedger, 'k', 1, async () => 'paid');
  assert.equal(outcome.result, 'paid');
  assert.equal(Object.hasOwn(outcome, 'commitError'), true);
  assert.equal(outcome.commitError, rejection);
}
assert.equal(Object.hasOwn(await withReserveConfirm(ledger, 'fresh', 1, async () => 'ok'), 'commitError'), false);

// Admission: all or nothing across scopes, fail closed, HTTP mapping.
{
  const { admitBeforeCall, admissionHttpStatus, createInMemoryAdmissionStore, DEFAULT_ADMISSION_TIMEOUT_MS } = root;
  assert.equal(DEFAULT_ADMISSION_TIMEOUT_MS, 5_000);
  const store = createInMemoryAdmissionStore({ now: () => new Date('2026-10-10T12:00:00Z') });
  const scopes = [{ key: 'probe:global', limit: 3 }, { key: 'probe:user:a', limit: 1 }];
  assert.deepEqual(await admitBeforeCall(store, { scopes }), { status: 'admitted', windowId: '2026-10-10' });
  const limited = await admitBeforeCall(store, { scopes });
  assert.deepEqual(limited, { status: 'limited', scopeKey: 'probe:user:a', windowId: '2026-10-10' });
  assert.equal(admissionHttpStatus(limited, { perUserScopePrefixes: ['probe:user:'] }), 429);
  assert.equal(admissionHttpStatus({ status: 'limited', scopeKey: 'probe:global', windowId: '2026-10-10' }), 503);
  assert.equal(admissionHttpStatus({ status: 'admitted', windowId: '2026-10-10' }), null);
  // The global scope was not counted by the limited attempt: two more users fit.
  assert.equal((await admitBeforeCall(store, { scopes: [scopes[0], { key: 'probe:user:b', limit: 1 }] })).status, 'admitted');
  assert.equal((await admitBeforeCall(store, { scopes: [scopes[0], { key: 'probe:user:c', limit: 1 }] })).status, 'admitted');
  assert.equal((await admitBeforeCall(store, { scopes: [scopes[0], { key: 'probe:user:d', limit: 1 }] })).status, 'limited');
  // Fail closed: throw, malformed reply, bad request. Never rejects.
  let calls = 0;
  const throwing = { admit: async () => { calls++; throw new Error('db down'); } };
  assert.equal((await admitBeforeCall(throwing, { scopes })).reason, 'store_error');
  assert.equal(calls, 1);
  const bare = { admit: async () => true };
  assert.equal((await admitBeforeCall(bare, { scopes })).reason, 'malformed_reply');
  const dup = await admitBeforeCall(store, { scopes: [scopes[0], scopes[0]] });
  assert.equal(dup.reason, 'invalid_request');
  assert.ok(dup.cause instanceof RangeError);
  const concurrent = createInMemoryAdmissionStore();
  const many = await Promise.all(Array.from({ length: 50 }, () => admitBeforeCall(concurrent, { scopes: [{ key: 'k', limit: 10 }] })));
  assert.equal(many.filter((o) => o.status === 'admitted').length, 10);
}

// Commit once, micros, mappers, dated tables, amount reservations.
{
  const {
    createCommitOnce, estimateCostMicros, usageFromAnthropic, usageFromOpenAI,
    definePricingTable, assertPricingFresh, lookupRatesOrThrow,
  } = root;
  let runs = 0;
  const once = createCommitOnce(async () => { runs++; return 'counted'; });
  assert.deepEqual(await Promise.all([once(), once(), once()]), ['counted', 'counted', 'counted']);
  assert.equal(runs, 1);
  assert.equal(once.state, 'committed');

  assert.equal(estimateCostMicros(rates, { inputTokens: 1_200, outputTokens: 400, cacheReadTokens: 8_000, cacheCreation5mTokens: 2_000 }), 19_500);
  assert.equal(estimateCostMicros({ inputPerMillion: 0.1, outputPerMillion: 0 }, { inputTokens: 1 }), 1);

  assert.deepEqual(usageFromAnthropic({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100 }), {
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreation5mTokens: 100, cacheCreation1hTokens: 0,
  });
  assert.throws(() => usageFromAnthropic({ input_tokens: 1, output_tokens: 1, surprise: 1 }), TypeError);
  assert.deepEqual(usageFromOpenAI({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } }), {
    inputTokens: 60, outputTokens: 5, cacheReadTokens: 40,
  });

  const table = definePricingTable({
    checkedAt: '2026-10-01', source: 'synthetic',
    rates: { 'toy:model': { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 } },
  });
  assert.deepEqual(lookupRatesOrThrow(table, 'toy:model'), { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 });
  assert.throws(() => lookupRatesOrThrow(table, 'toy:other'), /no pricing entry/);
  assertPricingFresh(table, new Date('2026-10-10T00:00:00Z'), 30);
  assert.throws(() => assertPricingFresh(table, new Date('2027-01-01T00:00:00Z'), 30), /days old/);

  const settled = [];
  const amountResult = await withCapacityReservation({
    reserveCapacity: async (request) => ({
      status: 'acquired',
      reservation: { id: 'r', key: request.key, operationId: request.operationId, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    }),
    confirmReservation: async (_reservation, settlement) => { settled.push(settlement); },
    releaseReservation: async () => {},
  }, { key: 'budget', limit: 1_000_000, operationId: 'op', amount: 500 }, async () => ({ status: 'succeeded', value: 1, settle: { usage: 'unknown' } }));
  assert.equal(amountResult.status, 'confirmed');
  assert.deepEqual(settled, [{ usage: 'unknown', amount: 500, reservedAmount: 500 }]);
}

console.log('consumer-probe: ok');
