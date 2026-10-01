import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, runExperiment, validateSettings } from '../lib/session.mjs';

const defaults = (id) => {
  const scenario = SCENARIOS.find((item) => item.id === id);
  return { scenarioId: id, ...scenario.defaults };
};

test('settings admit only bounded, known numeric inputs', () => {
  assert.deepEqual(validateSettings(defaults('balanced')), defaults('balanced'));
  for (const scenarioId of ['unknown', '', null]) {
    assert.throws(() => validateSettings({ ...defaults('balanced'), scenarioId }));
  }
  for (const ceilingUsd of [-1, 10.01, Infinity, NaN, '0.12']) {
    assert.throws(() => validateSettings({ ...defaults('balanced'), ceilingUsd }));
  }
  for (const capacityLimit of [-1, 13, 1.5, '2', NaN]) {
    assert.throws(() => validateSettings({ ...defaults('balanced'), capacityLimit }));
  }
  assert.throws(() => validateSettings({ ...defaults('balanced'), surprise: true }));
  assert.throws(() => validateSettings([]));
});

test('balanced circuit records both denials, a real release, and only four work confirmations', async () => {
  const session = await runExperiment(defaults('balanced'));
  const byId = Object.fromEntries(session.operations.map((operation) => [operation.id, operation]));
  assert.equal(session.schema, 'threshold-session-v1');
  assert.equal(byId.oversized.status, 'cost_denied');
  assert.equal(byId.oversized.workInvocations, 0);
  assert.equal(byId.oversized.eventSequences.length, 2); // no reserve call
  const costDenial = session.events.find((event) => event.attemptId === 'oversized' && event.kind === 'cost_denied');
  assert.equal(costDenial.snapshot.completedAttempts, 2);
  assert.equal(byId['local-failure'].status, 'released_after_failure');
  assert.equal(byId['over-capacity'].status, 'denied');
  assert.equal(byId['over-capacity'].workInvocations, 0);
  assert.equal(session.summary.confirmed, 4);
  assert.equal(session.summary.held, 0);
  assert.equal(session.summary.settled, 5); // four confirmations and one release
  assert.equal(session.summary.workCalls, 5);
  assert.equal(session.summary.spentUsd, 0.018);
  assert.equal(session.initial.completedAttempts, 0);
  assert.equal(session.initial.totalAttempts, session.operations.length);
  assert.equal(session.summary.completedAttempts, session.operations.length);
  assert.equal(session.summary.canClaimStrictProductionLimit, false);
});

test('zero capacity reaches SDK denial without invoking work', async () => {
  const session = await runExperiment({ ...defaults('failure'), capacityLimit: 0 });
  assert.ok(session.operations.every((operation) => operation.status === 'denied'));
  assert.ok(session.operations.every((operation) => operation.workInvocations === 0));
  assert.equal(session.summary.workCalls, 0);
  assert.equal(session.summary.total, 0);
  assert.equal(session.summary.spentUsd, 0);
});

test('known failure releases capacity for a distinct operation', async () => {
  const session = await runExperiment(defaults('failure'));
  assert.deepEqual(session.operations.map((operation) => operation.status), [
    'released_after_failure', 'confirmed',
  ]);
  const release = session.events.find((event) => event.kind === 'released_after_failure');
  assert.equal(release.snapshot.held, 0);
  assert.equal(release.snapshot.settled, 1);
  assert.equal(session.summary.confirmed, 1);
  assert.equal(session.summary.spentUsd, 0.0045);
});

test('uncertain work and confirmation failure keep holds, while known usage has estimated spend', async () => {
  const session = await runExperiment(defaults('ambiguous'));
  assert.deepEqual(session.operations.map((operation) => operation.status), [
    'work_outcome_ambiguous', 'confirmation_failed', 'denied',
  ]);
  assert.equal(session.summary.held, 2);
  assert.equal(session.summary.confirmed, 0);
  assert.equal(session.summary.unknownCostOperations, 1); // only the thrown callback
  assert.equal(session.summary.spentUsd, 0.0045); // known synthetic usage from failed confirmation
  assert.equal(session.summary.workCalls, 2);
});

test('duplicate active and terminal IDs do not execute a second callback', async () => {
  const session = await runExperiment(defaults('duplicate'));
  assert.deepEqual(session.operations.map((operation) => operation.status), [
    'work_outcome_ambiguous', 'operation_in_progress', 'confirmed', 'operation_terminal',
  ]);
  assert.deepEqual(session.operations.map((operation) => operation.workInvocations), [1, 0, 1, 0]);
  assert.equal(session.summary.workCalls, 2);
  assert.equal(session.operations[0].operationId, session.operations[1].operationId);
  assert.notEqual(session.operations[0].attemptId, session.operations[1].attemptId);
  assert.equal(session.events.find((event) => event.attemptId === 'active-repeat').operationId, 'active');
});

test('cache scenario prices cold, read, and both writes through SDK with visible request envelopes', async () => {
  const session = await runExperiment(defaults('cache'));
  assert.deepEqual(session.operations.map((operation) => operation.status),
    ['confirmed', 'confirmed', 'confirmed', 'confirmed']);
  assert.deepEqual(session.operations.map((operation) => operation.estimatedCostUsd),
    [0.0375, 0.0105, 0.045, 0.0675]);
  assert.deepEqual(session.operations[0].estimatedUsage,
    { inputTokens: 10_000, outputTokens: 500 });
  assert.deepEqual(session.operations[1].estimatedUsage,
    { inputTokens: 0, cacheReadTokens: 10_000, outputTokens: 500 });
  assert.deepEqual(session.operations[2].estimatedUsage,
    { inputTokens: 0, cacheCreation5mTokens: 10_000, outputTokens: 500 });
  assert.deepEqual(session.operations[3].estimatedUsage,
    { inputTokens: 0, cacheCreation1hTokens: 10_000, outputTokens: 500 });
  assert.equal(session.summary.spentUsd, 0.1605);
  assert.equal(session.summary.confirmed, 4);
  assert.equal(session.summary.workCalls, 4);
  assert.equal(session.summary.completedAttempts, 4);
  assert.equal(session.summary.unknownCostOperations, 0);
});

test('journal snapshots are immutable after each actual transition and match the final summary', async () => {
  for (const scenario of SCENARIOS) {
    const session = await runExperiment(defaults(scenario.id));
    assert.ok(session.events.length > 0);
    assert.equal(session.events.at(-1).snapshot.spentUsd, session.summary.spentUsd);
    assert.equal(session.events.at(-1).snapshot.held, session.summary.held);
    assert.equal(session.events.at(-1).snapshot.confirmed, session.summary.confirmed);
    assert.equal(session.events.at(-1).snapshot.workCalls, session.summary.workCalls);
    assert.equal(session.initial.completedAttempts, 0);
    assert.equal(session.summary.completedAttempts, session.operations.length);
    assert.equal(session.summary.totalAttempts, session.operations.length);
    assert.equal(session.events.at(-1).snapshot.completedAttempts, session.operations.length);
    assert.deepEqual(session.events.map((event) => event.sequence),
      Array.from({ length: session.events.length }, (_, index) => index + 1));
    for (const operation of session.operations) {
      assert.deepEqual(operation.eventSequences.map((sequence) => session.events[sequence - 1].attemptId),
        Array(operation.eventSequences.length).fill(operation.attemptId));
      assert.ok(operation.workInvocations <= 1);
    }
    assert.ok(Object.isFrozen(session));
    assert.ok(Object.isFrozen(session.events[0].snapshot));
    assert.throws(() => { session.events[0].snapshot.held = 999; }, TypeError);
  }
});
