import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, runExperiment } from '../lib/session.mjs';
import { compareSessions, explainSession } from '../lib/insights.mjs';

const defaults = (id) => ({ scenarioId: id, ...SCENARIOS.find((item) => item.id === id).defaults });
const metric = (comparison, key) => comparison.metrics.find((item) => item.key === key);

test('balanced explanation distinguishes attempt denials from confirmed ledger records', async () => {
  const session = await runExperiment(defaults('balanced'));
  const insight = explainSession(session);
  assert.equal(insight.tone, 'blocked');
  assert.deepEqual(insight.facts.find((fact) => fact.label === 'Confirmed reservations'),
    { label: 'Confirmed reservations', value: '4' });
  assert.deepEqual(insight.facts.find((fact) => fact.label === 'Cost-refused attempts'),
    { label: 'Cost-refused attempts', value: '1' });
  assert.deepEqual(insight.facts.find((fact) => fact.label === 'Capacity-refused attempts'),
    { label: 'Capacity-refused attempts', value: '1' });
  assert.equal(insight.facts.find((fact) => fact.label === 'Known estimated spend').value, '$0.018000');
  assert.deepEqual(insight.actions.map((action) => action.id), ['try-projected-ceiling', 'try-one-more-place']);
  assert.equal(insight.actions[0].settings.ceilingUsd, 0.1845);
  assert.equal(insight.actions[0].label, 'Try a $0.1845 ceiling');
  assert.equal(insight.actions[1].settings.capacityLimit, 5);
  assert.equal(insight.actions[1].label, 'Try 5 capacity slots');
  assert.ok(Object.isFrozen(insight.actions[0].settings));
});

test('unresolved usage takes priority and blocks a savings or budget-safe conclusion', async () => {
  const session = await runExperiment(defaults('ambiguous'));
  const insight = explainSession(session);
  assert.equal(insight.tone, 'warning');
  assert.match(insight.detail, /unknown usage prevents a total-spend or budget-safe claim/i);
  assert.equal(insight.facts.find((fact) => fact.label === 'Unknown-usage holds').value, '1');
  assert.equal(insight.facts.find((fact) => fact.label === 'Known estimated spend').value, '$0.004500');
  assert.deepEqual(insight.actions, []);
});

test('known local failure release remains visible without calling it provider savings', async () => {
  const session = await runExperiment(defaults('failure'));
  const insight = explainSession(session);
  assert.equal(insight.tone, 'calm');
  assert.match(insight.headline, /released its place/i);
  assert.match(insight.detail, /known local failure/i);
  assert.doesNotMatch(insight.detail, /provider savings/i);
});

test('a single unresolved reservation uses singular hold wording', async () => {
  const insight = explainSession(await runExperiment(defaults('duplicate')));
  assert.match(insight.detail, /^1 unique hold remains unresolved\./);
});

test('identical settings and plan produce no observed improvement', async () => {
  const first = await runExperiment(defaults('balanced'));
  const second = await runExperiment(defaults('balanced'));
  const comparison = compareSessions(first, second);
  assert.equal(comparison.comparable, true);
  assert.equal(comparison.reason, null);
  assert.deepEqual(comparison.settingsChanges, []);
  assert.ok(comparison.metrics.every((item) => item.delta === 0));
  assert.ok(comparison.operations.every((item) => item.changed === false));
  assert.match(comparison.detail, /no improvement is observed/i);
  assert.ok(Object.isFrozen(comparison.operations[0]));
});

test('a changed capacity shows the actual extra confirmation, not a forecast', async () => {
  const baseline = await runExperiment(defaults('balanced'));
  const current = await runExperiment({ ...defaults('balanced'), capacityLimit: 5 });
  const comparison = compareSessions(baseline, current);
  assert.equal(comparison.comparable, true);
  assert.deepEqual(comparison.settingsChanges,
    [{ key: 'capacityLimit', before: 4, after: 5 }]);
  assert.deepEqual(metric(comparison, 'confirmed'),
    { key: 'confirmed', label: 'Confirmed reservations', before: 4, after: 5, delta: 1 });
  assert.deepEqual(metric(comparison, 'capacity_denied'),
    { key: 'capacity_denied', label: 'Capacity-refused attempts', before: 1, after: 0, delta: -1 });
  assert.deepEqual(metric(comparison, 'cost_denied'),
    { key: 'cost_denied', label: 'Cost-refused attempts', before: 1, after: 1, delta: 0 });
  assert.deepEqual(metric(comparison, 'known_estimated_spend_usd'),
    { key: 'known_estimated_spend_usd', label: 'Known estimated spend (USD)', before: 0.018, after: 0.0225, delta: 0.0045 });
  assert.deepEqual(comparison.operations.filter((item) => item.changed).map((item) => item.attemptId), ['over-capacity']);
  assert.match(comparison.detail, /not provider billing/i);
});

test('different scenario, rates, or usage plan is incompatible; rate-source label alone is irrelevant', async () => {
  const balanced = await runExperiment(defaults('balanced'));
  const failure = await runExperiment(defaults('failure'));
  assert.equal(compareSessions(balanced, failure).comparable, false);
  const changedRate = structuredClone(balanced);
  changedRate.rates.inputPerMillion = 4;
  assert.equal(compareSessions(balanced, changedRate).comparable, false);
  const changedPlan = structuredClone(balanced);
  changedPlan.operations[0].estimatedUsage.inputTokens++;
  assert.equal(compareSessions(balanced, changedPlan).comparable, false);
  const changedSource = structuredClone(balanced);
  changedSource.rates.source = 'Different file label, same illustrative values';
  assert.equal(compareSessions(balanced, changedSource).comparable, true);
});

test('unknown outcome permits comparing recorded decisions but no total-spend claim', async () => {
  const before = await runExperiment(defaults('ambiguous'));
  const after = await runExperiment({ ...defaults('ambiguous'), capacityLimit: 3 });
  const comparison = compareSessions(before, after);
  assert.equal(comparison.comparable, true);
  assert.equal(metric(comparison, 'unknown_usage_holds').before, 1);
  assert.equal(metric(comparison, 'unknown_usage_holds').after, 1);
  assert.deepEqual(metric(comparison, 'known_estimated_spend_usd'),
    { key: 'known_estimated_spend_usd', label: 'Known estimated spend (USD)', before: 0.0045, after: 0.009, delta: null });
  assert.match(comparison.headline, /unresolved usage/i);
  assert.match(comparison.detail, /no total-spend or savings delta is reported/i);
  assert.doesNotMatch(comparison.detail, /budget.safe/i);
});
