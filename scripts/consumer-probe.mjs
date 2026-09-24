// STUB-PROBE-REPLACE-ME
// Replace this with a probe that imports the package by name, calls the real API,
// and asserts real outputs (the way a consumer would use it).
import assert from 'node:assert/strict';
for (const spec of ["cost-governor-kit","cost-governor-kit/pricing","cost-governor-kit/preCallCeiling","cost-governor-kit/reserveConfirm"]) {
  const mod = await import(spec);
  assert.ok(Object.keys(mod).length > 0, `${spec} exports nothing`);
}
