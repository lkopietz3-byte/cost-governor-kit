import {
  checkPreCallCeiling,
  estimateCostUsd,
  withCapacityReservation,
} from '../vendor/cost-governor-kit/index.js';

// Teaching rates only. These are not a provider price list or a billing record.
const RATES = Object.freeze({ inputPerMillion: 3, outputPerMillion: 15 });
const usage = (inputTokens, outputTokens) => Object.freeze({ inputTokens, outputTokens });
const SMALL = usage(500, 200); // $0.004500 at the illustrative rates.
const LARGE = usage(10_000, 10_000); // $0.180000.
const MEDIUM = usage(2_000, 800); // $0.018000.
const COLD_CONTEXT = Object.freeze({ inputTokens: 10_000, outputTokens: 500 });
const CACHE_READ_CONTEXT = Object.freeze({ inputTokens: 0, cacheReadTokens: 10_000, outputTokens: 500 });
const CACHE_WRITE_5M_CONTEXT = Object.freeze({ inputTokens: 0, cacheCreation5mTokens: 10_000, outputTokens: 500 });
const CACHE_WRITE_1H_CONTEXT = Object.freeze({ inputTokens: 0, cacheCreation1hTokens: 10_000, outputTokens: 500 });

export const SCENARIOS = Object.freeze([
  Object.freeze({ id: 'balanced', label: 'The full circuit', description: 'Success, pre-call cost refusal, local failure and release, then capacity refusal.', defaults: Object.freeze({ ceilingUsd: 0.12, capacityLimit: 4 }) }),
  Object.freeze({ id: 'ceiling', label: 'The price gate', description: 'Estimated cost is checked before any reservation or synthetic work.', defaults: Object.freeze({ ceilingUsd: 0.01, capacityLimit: 4 }) }),
  Object.freeze({ id: 'failure', label: 'The reclaimed place', description: 'An explicit no-work local failure releases its hold so another operation can proceed.', defaults: Object.freeze({ ceilingUsd: 0.12, capacityLimit: 1 }) }),
  Object.freeze({ id: 'ambiguous', label: 'The unresolved hold', description: 'Uncertain work and failed confirmation retain holds for reconciliation.', defaults: Object.freeze({ ceilingUsd: 0.12, capacityLimit: 2 }) }),
  Object.freeze({ id: 'duplicate', label: 'The same operation twice', description: 'Active and terminal idempotency keys refuse duplicate synthetic work.', defaults: Object.freeze({ ceilingUsd: 0.12, capacityLimit: 2 }) }),
  Object.freeze({ id: 'cache', label: 'The cache advantage', description: 'The same synthetic context is priced as a cold input, a cache read, and two cache writes using illustrative SDK multipliers.', defaults: Object.freeze({ ceilingUsd: 0.20, capacityLimit: 4 }) }),
]);

const SCENARIO_IDS = new Set(SCENARIOS.map((scenario) => scenario.id));
const ROUND = (number) => Math.round((number + Number.EPSILON) * 1_000_000) / 1_000_000;

/** Return a safe, detached settings value. Rejects coercion and extra keys. */
export function validateSettings(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError('Settings must be a plain object.');
  }
  if (Reflect.ownKeys(value).some((key) => !['scenarioId', 'ceilingUsd', 'capacityLimit'].includes(key))) {
    throw new TypeError('Settings contain an unknown field.');
  }
  const { scenarioId, ceilingUsd, capacityLimit } = value;
  if (typeof scenarioId !== 'string' || !SCENARIO_IDS.has(scenarioId)) {
    throw new RangeError('Choose a known scenario.');
  }
  if (typeof ceilingUsd !== 'number' || !Number.isFinite(ceilingUsd) || ceilingUsd < 0 || ceilingUsd > 10) {
    throw new RangeError('The illustrative ceiling must be a number from $0 to $10.');
  }
  if (!Number.isSafeInteger(capacityLimit) || capacityLimit < 0 || capacityLimit > 12) {
    throw new RangeError('Capacity must be a whole number from 0 to 12.');
  }
  return Object.freeze({ scenarioId, ceilingUsd, capacityLimit });
}

const STEPS = Object.freeze({
  balanced: Object.freeze([
    { id: 'first', label: 'First small operation', usage: SMALL, behavior: 'succeed' },
    { id: 'oversized', label: 'Oversized operation', usage: LARGE, behavior: 'succeed' },
    { id: 'local-failure', label: 'Known local failure', usage: SMALL, behavior: 'fail' },
    { id: 'second', label: 'Second small operation', usage: SMALL, behavior: 'succeed' },
    { id: 'third', label: 'Third small operation', usage: SMALL, behavior: 'succeed' },
    { id: 'fourth', label: 'Fourth small operation', usage: SMALL, behavior: 'succeed' },
    { id: 'over-capacity', label: 'Another small operation', usage: SMALL, behavior: 'succeed' },
  ]),
  ceiling: Object.freeze([
    { id: 'first', label: 'Within the ceiling', usage: SMALL, behavior: 'succeed' },
    { id: 'large', label: 'Above the ceiling', usage: MEDIUM, behavior: 'succeed' },
    { id: 'second', label: 'Exactly another small call', usage: SMALL, behavior: 'succeed' },
    { id: 'third', label: 'Crosses the ceiling', usage: SMALL, behavior: 'succeed' },
  ]),
  failure: Object.freeze([
    { id: 'known-failure', label: 'Known local failure', usage: SMALL, behavior: 'fail' },
    { id: 'next', label: 'Next operation uses reclaimed place', usage: SMALL, behavior: 'succeed' },
  ]),
  ambiguous: Object.freeze([
    { id: 'uncertain', label: 'Outcome unknown after callback', usage: SMALL, behavior: 'ambiguous' },
    { id: 'confirm-error', label: 'Confirmation fails', usage: SMALL, behavior: 'confirm_fail' },
    { id: 'another', label: 'Another operation finds both holds', usage: SMALL, behavior: 'succeed' },
  ]),
  duplicate: Object.freeze([
    { id: 'active-first', logicalId: 'active', label: 'Unresolved operation', usage: SMALL, behavior: 'ambiguous' },
    { id: 'active-repeat', logicalId: 'active', label: 'Same active ID again', usage: SMALL, behavior: 'succeed' },
    { id: 'terminal-first', logicalId: 'terminal', label: 'Completed operation', usage: SMALL, behavior: 'succeed' },
    { id: 'terminal-repeat', logicalId: 'terminal', label: 'Same terminal ID again', usage: SMALL, behavior: 'succeed' },
  ]),
  cache: Object.freeze([
    { id: 'cold', label: 'Cold context', usage: COLD_CONTEXT, behavior: 'succeed' },
    { id: 'read', label: 'Warm cache read', usage: CACHE_READ_CONTEXT, behavior: 'succeed' },
    { id: 'write-5m', label: 'Five-minute cache write', usage: CACHE_WRITE_5M_CONTEXT, behavior: 'succeed' },
    { id: 'write-1h', label: 'One-hour cache write', usage: CACHE_WRITE_1H_CONTEXT, behavior: 'succeed' },
  ]),
});

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

/** Run at most seven sequential, wholly local operations through the real SDK. */
export async function runExperiment(input) {
  const settings = validateSettings(input);
  const { scenarioId, ceilingUsd, capacityLimit } = settings;
  const startedAt = new Date().toISOString();
  const steps = STEPS[scenarioId];
  const records = new Map();
  const events = [];
  const operations = [];
  let spentUsd = 0;
  let workCalls = 0;
  let completedAttempts = 0;

  const snapshot = () => {
    const entries = [...records.values()];
    const confirmed = entries.filter((entry) => entry.state === 'confirmed').length;
    const held = entries.filter((entry) => entry.state === 'held').length;
    const settled = entries.filter((entry) => entry.state !== 'held').length;
    return {
      spentUsd,
      confirmed,
      held,
      capacityLimit,
      settled,
      total: entries.length,
      workCalls,
      completedAttempts,
      totalAttempts: steps.length,
      unknownCostOperations: entries.filter((entry) => entry.state === 'held' && entry.uncertainOutcome).length,
    };
  };

  const journal = (operation, stage, kind, title, detail, extra = {}) => {
    const sequence = events.length + 1;
    events.push({ sequence, attemptId: operation.id, operationId: operation.operationId,
      stage, kind, title, detail, snapshot: snapshot(), ...extra });
    operation.eventSequences.push(sequence);
  };

  const ledger = {
    async reserveCapacity(request) {
      const existing = records.get(request.operationId);
      if (existing) {
        return existing.state === 'held'
          ? { status: 'operation_in_progress', reservation: existing.reservation }
          : { status: 'operation_terminal', operationId: request.operationId, reason: `Earlier operation ${existing.state}.` };
      }
      const occupied = [...records.values()].filter((entry) => entry.state === 'held' || entry.state === 'confirmed').length;
      if (occupied >= request.limit) return { status: 'denied', reason: 'Illustrative capacity is occupied.' };
      const reservation = {
        id: `hold-${request.operationId}`,
        key: request.key,
        operationId: request.operationId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      records.set(request.operationId, { state: 'held', reservation, uncertainOutcome: false, usage: null, failConfirmation: false });
      return { status: 'acquired', reservation };
    },
    async confirmReservation(reservation) {
      const entry = records.get(reservation.operationId);
      if (entry.failConfirmation) throw new Error('Synthetic ledger confirmation error.');
      if (entry.state === 'confirmed') return;
      if (entry.state !== 'held' || !entry.usage) throw new Error('Synthetic ledger cannot confirm this hold.');
      entry.state = 'confirmed';
    },
    async releaseReservation(reservation) {
      const entry = records.get(reservation.operationId);
      if (entry.state === 'released') return;
      if (entry.state !== 'held') throw new Error('Synthetic ledger cannot release this hold.');
      entry.state = 'released';
    },
  };

  const initial = snapshot();
  for (const step of steps) {
    const operation = {
      id: step.id,
      attemptId: step.id,
      operationId: step.logicalId ?? step.id,
      label: step.label,
      estimatedUsage: { ...step.usage },
      estimatedCostUsd: estimateCostUsd(RATES, step.usage),
      status: 'requested',
      detail: '',
      eventSequences: [],
      workInvocations: 0,
      usage: null,
    };
    operations.push(operation);
    journal(operation, 'request', 'requested', step.label, 'Synthetic operation submitted to local checks.');

    // A possibly charged, unresolved operation makes a strict spend claim impossible.
    // Continue the illustration, but keep that limitation explicit in every snapshot.
    const ceiling = checkPreCallCeiling({
      spentSoFarUsd: spentUsd,
      ceilingUsd,
      estimatedNextCallUsage: step.usage,
      rates: RATES,
    });
    if (!ceiling.allowed) {
      operation.status = 'cost_denied';
      operation.detail = 'Stopped before reservation or work.';
      completedAttempts++;
      journal(operation, 'ceiling', 'cost_denied', 'Projection exceeds ceiling', ceiling.reason,
        { estimatedCostUsd: ceiling.projectedNextCallCostUsd, projectedTotalUsd: ceiling.projectedTotalUsd });
      continue;
    }
    journal(operation, 'ceiling', 'cost_allowed', 'Projection within ceiling',
      snapshot().unknownCostOperations > 0
        ? `Known spend only: ${snapshot().unknownCostOperations} usage outcome remains unknown and excluded from this projection. Illustrative arithmetic check passed.`
        : 'Illustrative estimate passed the pre-call arithmetic check.',
      { estimatedCostUsd: ceiling.projectedNextCallCostUsd, projectedTotalUsd: ceiling.projectedTotalUsd });

    const originalReserve = ledger.reserveCapacity;
    // This wrapper observes the adapter decision after it has actually changed state.
    const observedLedger = {
      ...ledger,
      async reserveCapacity(request) {
        const decision = await originalReserve(request);
        journal(operation, 'reserve', decision.status, 'Capacity decision',
          decision.status === 'acquired' ? 'Local hold acquired.' :
          decision.status === 'denied' ? 'No local place available.' :
          decision.status === 'operation_in_progress' ? 'Same ID remains unresolved; no new work.' :
          'Same ID already settled; no new work.');
        return decision;
      },
    };
    const result = await withCapacityReservation(
      observedLedger,
      { key: 'threshold-local-demo', limit: capacityLimit, operationId: operation.operationId },
      async () => {
        operation.workInvocations++;
        workCalls++;
        const entry = records.get(operation.operationId);
        if (step.behavior === 'ambiguous') {
          entry.uncertainOutcome = true;
          journal(operation, 'work', 'outcome_ambiguous', 'Outcome unknown',
            'Synthetic callback threw after starting. Cost and side effects must be reconciled.');
          throw new Error('Synthetic outcome unknown.');
        }
        if (step.behavior === 'fail') {
          journal(operation, 'work', 'known_local_failure', 'Known local failure',
            'Synthetic work reported a definite failure before any charge or side effect.');
          return { status: 'failed', error: new Error('Synthetic no-work failure.') };
        }
        entry.usage = { ...step.usage };
        entry.failConfirmation = step.behavior === 'confirm_fail';
        operation.usage = { ...step.usage };
        // Known synthetic work usage enters the estimated spend even if its
        // later ledger confirmation fails. Unknown callback outcomes do not.
        spentUsd = ROUND(spentUsd + estimateCostUsd(RATES, entry.usage));
        journal(operation, 'work', 'succeeded', 'Synthetic work returned',
          'Synthetic token usage returned; no provider was called.');
        return { status: 'succeeded', value: { usage: { ...step.usage } } };
      },
    );
    operation.status = result.status;
    operation.detail = {
      confirmed: 'Synthetic usage was confirmed in the local ledger; spend is estimated.',
      denied: 'The local ledger denied capacity before work.',
      operation_in_progress: 'Existing unresolved hold retained; duplicate work skipped.',
      operation_terminal: 'Existing terminal record reused; duplicate work skipped.',
      released_after_failure: 'Definite local failure released the hold.',
      work_outcome_ambiguous: 'Hold retained; actual cost and side effects are unknown.',
      confirmation_failed: 'Work returned known synthetic usage, but confirmation failed; its hold remains.',
    }[result.status] ?? 'Requires reconciliation.';
    completedAttempts++;
    journal(operation, 'settle', result.status, 'SDK result', operation.detail);
  }

  const outcomes = {};
  for (const operation of operations) outcomes[operation.status] = (outcomes[operation.status] ?? 0) + 1;
  const session = {
    schema: 'threshold-session-v1',
    id: `threshold-${globalThis.crypto.randomUUID()}`,
    scenarioId,
    settings,
    rates: { ...RATES, source: 'Illustrative fixed teaching rates; not current provider prices.' },
    startedAt,
    initial,
    events,
    operations,
    summary: { ...snapshot(), outcomes, canClaimStrictProductionLimit: false },
  };
  return freezeDeep(session);
}
