// CommonJS require() smoke test: proves `require('cost-governor-kit')` works
// for a plain CommonJS consumer, the way package.json `exports`' `default`
// condition promises. scripts/verify-package.mjs only runs this file on a
// Node version that supports `require(esm)` (Node 22.12+ or 20.19+); on an
// older Node it logs a skip instead, since `require()` of an ESM-only
// package throws there regardless of `exports`. See README's install note.
'use strict';

const assert = require('node:assert/strict');

const root = require('cost-governor-kit');
const pricing = require('cost-governor-kit/pricing');
const ceiling = require('cost-governor-kit/preCallCeiling');

assert.equal(root.estimateCostUsd, pricing.estimateCostUsd, 'require()d root and subpath should share the same module');
assert.equal(root.checkPreCallCeiling, ceiling.checkPreCallCeiling, 'require()d root and subpath should share the same module');

const rates = { inputPerMillion: 3, outputPerMillion: 15 };
assert.equal(root.estimateCostUsd(rates, { inputTokens: 1_000_000 }), 3);
assert.throws(() => root.estimateCostUsd(rates, { inputTokens: -1 }), RangeError, 'a negative token count should still throw a RangeError via require()');
assert.throws(() => root.estimateCostUsd(rates, null), TypeError, 'a non-object usage should still throw a TypeError via require()');

const denied = root.checkPreCallCeiling({
  rates,
  spentSoFarUsd: 0,
  ceilingUsd: 0,
  estimatedNextCallUsage: { inputTokens: 1_000_000 },
});
assert.equal(denied.allowed, false);

console.log('consumer-probe.cjs: require() works');
