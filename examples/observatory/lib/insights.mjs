import { validateSettings } from './session.mjs';

const ROUND = (value) => Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
const dollars = (value) => `$${value.toFixed(6)}`;
const shortDollars = (value) => `$${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

function requireSession(session) {
  if (!session || session.schema !== 'threshold-session-v1' ||
      !Array.isArray(session.operations) || !Array.isArray(session.events) ||
      !session.summary || !session.rates || !session.settings ||
      session.summary.completedAttempts !== session.operations.length) {
    throw new TypeError('A completed Threshold session is required.');
  }
  validateSettings(session.settings);
  return session;
}

function count(session, status) {
  // An outcome counts attempts. It is deliberately separate from the ledger's
  // unique confirmed/held reservation counts, especially for duplicate IDs.
  return session.operations.filter((operation) => operation.status === status).length;
}

function action(id, label, detail, settings) {
  return { id, label, detail, settings: validateSettings(settings) };
}

/** Explain recorded local SDK decisions, never provider billing or future results. */
export function explainSession(input) {
  const session = requireSession(input);
  const { summary, settings } = session;
  const costDenied = count(session, 'cost_denied');
  const capacityDenied = count(session, 'denied');
  const ambiguous = count(session, 'work_outcome_ambiguous');
  const confirmFailed = count(session, 'confirmation_failed');
  const releaseFailed = count(session, 'release_failed');
  const duplicateActive = count(session, 'operation_in_progress');
  const duplicateTerminal = count(session, 'operation_terminal');
  const released = count(session, 'released_after_failure');
  const unresolved = summary.held > 0 || ambiguous > 0 || confirmFailed > 0 || releaseFailed > 0;
  const facts = [
    { label: 'Completed attempts', value: `${summary.completedAttempts} / ${summary.totalAttempts}` },
    { label: 'Confirmed reservations', value: String(summary.confirmed) },
    { label: 'Held reservations', value: String(summary.held) },
    { label: 'Cost-refused attempts', value: String(costDenied) },
    { label: 'Capacity-refused attempts', value: String(capacityDenied) },
    { label: 'Known estimated spend', value: dollars(summary.spentUsd) },
  ];
  if (summary.unknownCostOperations > 0) {
    facts.push({ label: 'Unknown-usage holds', value: String(summary.unknownCostOperations) });
  }

  let tone;
  let headline;
  let detail;
  if (unresolved) {
    tone = 'warning';
    headline = 'A hold needs reconciliation';
    const uncertainty = summary.unknownCostOperations > 0
      ? 'Unknown usage prevents a total-spend or budget-safe claim. '
      : 'Known usage is estimated, but failed settlement prevents a settled or budget-safe claim. ';
    detail = `${summary.held} unique hold${summary.held === 1 ? ' remains' : 's remain'} unresolved. ` +
      `${ambiguous} attempt${ambiguous === 1 ? '' : 's'} had an unknown work outcome; ` +
      `${confirmFailed} confirmation${confirmFailed === 1 ? '' : 's'} failed. ` +
      `Known synthetic usage estimates total ${dollars(summary.spentUsd)}. ${uncertainty}` +
      'This in-memory demonstration cannot reconcile the holds or establish a production limit.';
  } else if (costDenied > 0 || capacityDenied > 0) {
    tone = 'blocked';
    headline = 'Some attempts stopped at a gate';
    detail = `${costDenied} attempt${costDenied === 1 ? '' : 's'} stopped before reservation at the cost check; ` +
      `${capacityDenied} stopped at the local capacity ledger. ` +
      `${summary.confirmed} unique reservation${summary.confirmed === 1 ? '' : 's'} confirmed. ` +
      'These are recorded synthetic decisions, not provider charges or a strict production ceiling.';
  } else {
    tone = 'calm';
    headline = duplicateActive + duplicateTerminal > 0 ? 'Repeated IDs did not restart work' :
      released > 0 ? 'A known failure released its place' : 'All planned attempts were processed';
    detail = `${summary.confirmed} unique reservation${summary.confirmed === 1 ? '' : 's'} confirmed; ` +
      `${released} known local failure${released === 1 ? '' : 's'} released a place. ` +
      `${duplicateActive + duplicateTerminal} repeated-ID attempt${duplicateActive + duplicateTerminal === 1 ? '' : 's'} skipped work. ` +
      'Spend is an estimate from synthetic known usage, not provider billing or a strict production guarantee.';
  }

  const actions = [];
  if (!unresolved) {
    if (costDenied > 0) {
      const firstDenial = session.events.find((event) => event.kind === 'cost_denied');
      const proposed = firstDenial && ROUND(firstDenial.projectedTotalUsd);
      if (Number.isFinite(proposed) && proposed > settings.ceilingUsd && proposed <= 10) {
        actions.push(action('try-projected-ceiling', `Try a ${shortDollars(proposed)} ceiling`,
          'Changes the illustrative input ceiling only. Run the variation to observe its actual decisions.',
          { ...settings, ceilingUsd: proposed }));
      }
    }
    if (capacityDenied > 0 && settings.capacityLimit < 12) {
      actions.push(action('try-one-more-place', `Try ${settings.capacityLimit + 1} capacity slots`,
        'Changes local demonstration capacity by one. Run the variation to observe its actual decisions.',
        { ...settings, capacityLimit: settings.capacityLimit + 1 }));
    }
  }
  return freezeDeep({ tone, headline, detail, facts, actions: actions.slice(0, 2) });
}

function comparablePlan(baseline, current) {
  if (baseline.scenarioId !== current.scenarioId ||
      baseline.settings.scenarioId !== current.settings.scenarioId) {
    return 'Different scenarios have different planned operations.';
  }
  for (const key of ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion']) {
    if (baseline.rates[key] !== current.rates[key]) {
      return 'Illustrative rates differ; estimated USD values cannot be compared.';
    }
  }
  if (baseline.operations.length !== current.operations.length) {
    return 'The planned attempt counts differ.';
  }
  for (let index = 0; index < baseline.operations.length; index++) {
    const before = baseline.operations[index];
    const after = current.operations[index];
    if (before.id !== after.id || before.attemptId !== after.attemptId || before.operationId !== after.operationId ||
        before.label !== after.label || before.estimatedCostUsd !== after.estimatedCostUsd ||
        !sameUsage(before.estimatedUsage, after.estimatedUsage)) {
      return 'The planned attempt IDs, operation IDs, or usage envelopes differ.';
    }
  }
  // The built-in scenario fixes behavior; a serialized session does not expose
  // behavior independently. This comparison assumes both sessions came from
  // the same loaded engine manifest, as the UI does.
  return null;
}

function sameUsage(before, after) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return false;
  const left = Object.keys(before).sort();
  const right = Object.keys(after).sort();
  return left.length === right.length && left.every((key, index) => key === right[index] && before[key] === after[key]);
}

function metric(key, label, before, after) {
  return { key, label, before, after, delta: ROUND(after - before) };
}

/** Compare two completed local runs of the same planned teaching scenario. */
export function compareSessions(beforeInput, afterInput) {
  const baseline = requireSession(beforeInput);
  const current = requireSession(afterInput);
  const reason = comparablePlan(baseline, current);
  if (reason) return freezeDeep({
    comparable: false,
    reason,
    settingsChanges: [],
    metrics: [],
    operations: [],
    headline: 'These sessions use different plans',
    detail: 'Choose two runs of the same planned scenario at the same illustrative rates. No outcome comparison is made.',
  });

  const settingsChanges = ['ceilingUsd', 'capacityLimit']
    .filter((key) => baseline.settings[key] !== current.settings[key])
    .map((key) => ({ key, before: baseline.settings[key], after: current.settings[key] }));
  const unknown = baseline.summary.unknownCostOperations > 0 || current.summary.unknownCostOperations > 0;
  const metrics = [
    metric('confirmed', 'Confirmed reservations', baseline.summary.confirmed, current.summary.confirmed),
    metric('held', 'Unresolved holds', baseline.summary.held, current.summary.held),
    metric('cost_denied', 'Cost-refused attempts', count(baseline, 'cost_denied'), count(current, 'cost_denied')),
    metric('capacity_denied', 'Capacity-refused attempts', count(baseline, 'denied'), count(current, 'denied')),
    metric('released', 'Released after known failure', count(baseline, 'released_after_failure'), count(current, 'released_after_failure')),
    metric('work_calls', 'Synthetic work callbacks', baseline.summary.workCalls, current.summary.workCalls),
    { ...metric('known_estimated_spend_usd', 'Known estimated spend (USD)', baseline.summary.spentUsd, current.summary.spentUsd),
      delta: unknown ? null : ROUND(current.summary.spentUsd - baseline.summary.spentUsd) },
    metric('unknown_usage_holds', 'Unknown-usage holds', baseline.summary.unknownCostOperations, current.summary.unknownCostOperations),
  ];
  const operations = baseline.operations.map((operation, index) => {
    const after = current.operations[index];
    return {
      attemptId: operation.attemptId,
      label: operation.label,
      before: operation.status,
      after: after.status,
      changed: operation.status !== after.status,
    };
  });
  const changed = operations.filter((operation) => operation.changed).length;
  const unsettled = baseline.summary.held > 0 || current.summary.held > 0;
  const headline = unknown ? 'Unresolved usage limits this comparison' :
    unsettled ? 'Unresolved holds limit this comparison' :
    changed > 0 ? `${changed} recorded decision${changed === 1 ? '' : 's'} changed` :
      'The recorded decisions match';
  const detail = unknown
    ? `Known portions of estimated spend are ${dollars(baseline.summary.spentUsd)} before and ${dollars(current.summary.spentUsd)} after. ` +
      'At least one work outcome has unknown usage, so no total-spend or savings delta is reported. Reconcile the hold before a budget conclusion.'
    : unsettled
      ? `Known estimated spend changed from ${dollars(baseline.summary.spentUsd)} to ${dollars(current.summary.spentUsd)}. ` +
        'At least one hold remains unsettled. Compare recorded decisions, but do not infer settled usage or production budget safety.'
    : changed > 0
      ? `Known estimated spend changed from ${dollars(baseline.summary.spentUsd)} to ${dollars(current.summary.spentUsd)}. ` +
        'The differing outcomes are recorded synthetic SDK decisions under the shown settings; this is not provider billing or a production savings claim.'
      : `Both runs recorded the same attempt outcomes and ${dollars(current.summary.spentUsd)} in known estimated synthetic usage. ` +
        'No improvement is observed in these local results.';
  return freezeDeep({ comparable: true, reason: null, settingsChanges, metrics, operations, headline, detail });
}
