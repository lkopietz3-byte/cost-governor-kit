import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotebook, parseNotebook, NOTEBOOK_KEY } from '../lib/notebook.mjs';

const settings = { scenarioId: 'balanced', ceilingUsd: 0.12, capacityLimit: 4 };
function fixture() {
  let raw = null;
  let rejectWrite = false;
  let chain = Promise.resolve();
  const storage = { getItem: key => { assert.equal(key, NOTEBOOK_KEY); return raw; }, setItem: (key, value) => { assert.equal(key, NOTEBOOK_KEY); if (rejectWrite) throw new Error('quota'); raw = value; } };
  const withLock = action => { const task = chain.then(action); chain = task.catch(() => {}); return task; };
  const options = { getStorage: () => storage, withLock };
  return { book: createNotebook(options), options, value: () => raw, inject: value => { raw = value; }, quota: () => { rejectWrite = true; } };
}
test('explicit save persists only detached conditions and a bounded name; reopening does not run work', async () => {
  const f = fixture();
  assert.equal(f.value(), null);
  const result = await f.book.save(settings, '  My first boundary  ');
  assert.equal(result.document.setups[0].name, 'My first boundary');
  assert.deepEqual(result.document.setups[0].settings, settings);
  assert.deepEqual(Object.keys(result.document.setups[0]), ['id', 'name', 'savedAt', 'settings']);
  assert.equal(result.document.revision, 1);
  assert.ok(Object.isFrozen(result.document.setups[0].settings));
  assert.equal(createNotebook(f.options).read().document.setups.length, 1);
});
test('coordinated writers merge their changes rather than replacing a stale snapshot', async () => {
  const f = fixture();
  const second = createNotebook(f.options);
  await Promise.all([f.book.save(settings, 'First tab'), second.save({ ...settings, capacityLimit: 5 }, 'Second tab')]);
  assert.equal(f.book.read().document.revision, 2);
  assert.deepEqual(f.book.read().document.setups.map(row => row.name), ['First tab', 'Second tab']);
});
test('malformed, future-version, invalid conditions and oversized notebooks are preserved and cannot be overwritten', async () => {
  const f = fixture();
  await f.book.save(settings, 'Valid');
  const original = JSON.parse(f.value());
  for (const raw of ['{broken', JSON.stringify({ ...original, schema: 'threshold-notebook-v2' }), JSON.stringify({ ...original, setups: [{ ...original.setups[0], settings: { ...settings, capacityLimit: 1.5 } }] }), 'x'.repeat(24_001)]) {
    f.inject(raw);
    assert.equal(f.book.read().status, 'invalid');
    await assert.rejects(f.book.save(settings, 'Other'), /Not saved/);
    assert.equal(f.value(), raw);
  }
});
test('storage unavailable, quota denied and no lock do not report a save or overwrite existing data', async () => {
  const unavailable = createNotebook({ getStorage: () => { throw new Error('denied'); }, withLock: task => task() });
  assert.equal(unavailable.read().status, 'unavailable');
  await assert.rejects(unavailable.save(settings, 'No'), /Not saved/);
  const f = fixture(); await f.book.save(settings, 'Kept'); const before = f.value(); f.quota();
  await assert.rejects(f.book.save(settings, 'Blocked'), /Not saved/);
  assert.equal(f.value(), before);
  const readonly = createNotebook({ getStorage: f.options.getStorage });
  assert.equal(readonly.read().writable, false);
  assert.equal(readonly.read().document.setups.length, 1);
  await assert.rejects(readonly.save(settings, 'No'), /Not saved/);
  assert.equal(f.value(), before);
});
test('full notebook refuses eviction; names reject injection controls; unknown fields and duplicate IDs rejected', async () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) await f.book.save(settings, `Setup ${i + 1}`);
  const before = f.value();
  await assert.rejects(f.book.save(settings, '13th'), /12 setups/);
  assert.equal(f.value(), before);
  assert.throws(() => f.book.save(settings, 'bad\u202ename'), /hidden control/);
  assert.throws(() => f.book.save(settings, 'x'.repeat(61)), /1–60/);
  const current = JSON.parse(before);
  assert.throws(() => parseNotebook(JSON.stringify({ ...current, journal: {} })), /unsupported shape/);
  assert.throws(() => parseNotebook(JSON.stringify({ ...current, setups: [current.setups[0], current.setups[0]] })), /repeated/);
});
test('remove touches only the selected unchanged record, and refuses stale removal', async () => {
  const f = fixture(); await f.book.save(settings, 'One'); await f.book.save(settings, 'Two');
  const original = f.book.read().document.setups[0];
  const mutated = JSON.parse(f.value()); mutated.setups[0].name = 'Edited elsewhere'; f.inject(JSON.stringify(mutated));
  const before = f.value(); await assert.rejects(f.book.remove(original.id, original), /changed/); assert.equal(f.value(), before);
  const actual = f.book.read().document.setups[0]; await f.book.remove(actual.id, actual);
  assert.deepEqual(f.book.read().document.setups.map(row => row.name), ['Two']);
});
