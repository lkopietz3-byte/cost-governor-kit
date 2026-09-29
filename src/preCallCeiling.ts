/**
 * preCallCeiling.ts — a hard dollar ceiling enforced BEFORE an API call, not
 * monitored after.
 *
 * Extracted from ~/lattice/scripts/classify-batch.mjs, a batch script in the
 * author's own projects. Before each batch call it checks cumulative spend
 * against a hard cap and stops cleanly once the cap is reached:
 *
 *   // Ceiling checked BEFORE the call, not after. This is the whole point.
 *   if (usd(spend) >= MAX_USD) { ...stop cleanly... }
 *
 * This module goes one step further than that script: it also prices the
 * next call from an estimate and refuses it if spend so far plus that
 * estimate would exceed the ceiling.
 *
 * THE "NEVER A STALE HARDCODED PRICE" DISCIPLINE
 * ------------------------------------------------
 * classify-batch.mjs takes its rates as `--input-rate` / `--output-rate` CLI
 * arguments and prints them on every run:
 *
 *   rates: $3/M in, $15/M out  <- VERIFY against current pricing
 *
 * From that script's header: "Rates are dollars per million tokens and MUST
 * be set to current published pricing. They default to placeholders and are
 * printed on every run so a stale number cannot silently corrupt the spend
 * cap." This module mirrors that: `rates` is required on every check and
 * has no default anywhere in this library. Log it with `formatRatesForLog()`.
 */

import { describe, isPlainRecord } from './internal.js';
import { estimateCostUsd, type ModelRates, type UsageTokens } from './pricing.js';

/**
 * Input to {@link checkPreCallCeiling}. The check itself, `rates` and
 * `estimatedNextCallUsage` must each be a plain or null-prototype object; a
 * `Map`, `Set`, `Date`, `RegExp`, array or class instance throws a
 * `TypeError` before any decision.
 */
export interface PreCallCeilingCheck {
  /** Cumulative spend already incurred this run/session/day, in USD. Finite and >= 0. */
  spentSoFarUsd: number;
  /**
   * The hard ceiling in USD. Finite and >= 0. The call is allowed when the
   * rounded projected total is less than or EQUAL to this value. It is
   * compared as given (not rounded), so pass whole micro-dollars.
   */
  ceilingUsd: number;
  /**
   * Estimated token usage for the call about to be made (not actual usage;
   * this runs before the call). The ceiling is only as accurate as this
   * estimate. Round fractional projections, such as averages, up to whole
   * tokens. Validated exactly like {@link estimateCostUsd}'s `usage`.
   */
  estimatedNextCallUsage: UsageTokens;
  /**
   * Rates for the model about to be called. Required; there is no default.
   * Source them from a flag, config value or recent pricing lookup and log
   * them with `formatRatesForLog` so a stale number is visible.
   */
  rates: ModelRates;
}

/** Output of {@link checkPreCallCeiling}. */
export interface PreCallCeilingResult {
  /** True if the call may proceed. False means: do not make the call. */
  allowed: boolean;
  /** `estimateCostUsd(rates, estimatedNextCallUsage)`, rounded to the nearest micro-dollar. */
  projectedNextCallCostUsd: number;
  /** `spentSoFarUsd + projectedNextCallCostUsd`, rounded to the nearest micro-dollar. */
  projectedTotalUsd: number;
  /** Echoed from the input. */
  ceilingUsd: number;
  /** Present only when `allowed` is false: a human-readable explanation with the amounts. */
  reason?: string;
}

/**
 * Decide whether the next call may proceed, BEFORE making it.
 *
 * Pure arithmetic: no side effects, no I/O, no clock. Returns
 * `allowed: projectedTotalUsd <= ceilingUsd`, where `projectedTotalUsd` is
 * `spentSoFarUsd + projectedNextCallCostUsd` rounded to the nearest
 * micro-dollar. Because both the next-call cost and the total are rounded, a
 * single check can allow a true total up to about $0.000001 over the ceiling,
 * and a call that costs less than $0.0000005 is priced at $0. A running total
 * built from rounded estimates can drift by up to $0.0000005 per call.
 *
 * It does not track spend for you, and it does not know what the call really
 * cost. Reconcile `spentSoFarUsd` from actual usage after each call.
 *
 * @example
 * ```ts
 * const check = checkPreCallCeiling({
 *   spentSoFarUsd: runningTotal,
 *   ceilingUsd: 25,
 *   estimatedNextCallUsage: { inputTokens: 2000, outputTokens: 500 },
 *   rates, // from a flag or config, never hardcoded
 * });
 * if (!check.allowed) throw new Error(check.reason);
 * // ...only now make the call, then add its real cost to runningTotal.
 * ```
 *
 * Each field of `check`, `check.rates` and the usage estimate is read exactly
 * once, and validation and the decision use those values, so a getter or
 * proxy that answers differently the second time cannot change the outcome.
 *
 * @throws TypeError when `check` or `rates` is not a plain or null-prototype
 *   object, `rates.inputPerMillion`/`outputPerMillion` is not a number,
 *   `ceilingUsd`/`spentSoFarUsd` is not a number, or the usage estimate is
 *   not a plain object of token counts (a `Map`, `Set`, `Date`, `RegExp`,
 *   array or class instance is rejected, never priced as zero).
 * @throws RangeError when a present, correctly-typed `rates` field,
 *   `ceilingUsd`, or `spentSoFarUsd` is negative or non-finite (these
 *   messages include the rejected value), the usage estimate is invalid
 *   (see {@link estimateCostUsd}), or the projected total is not finite.
 */
export function checkPreCallCeiling(check: PreCallCeilingCheck): PreCallCeilingResult {
  if (!isPlainRecord(check)) {
    throw new TypeError(
      'checkPreCallCeiling: check must be an object with spentSoFarUsd, ceilingUsd, estimatedNextCallUsage and rates ' +
        '(a plain object; not null, an array, a Map, a Date or a class instance)',
    );
  }
  const rates: unknown = check.rates;
  const ceilingUsd: unknown = check.ceilingUsd;
  const spentSoFarUsd: unknown = check.spentSoFarUsd;
  const estimatedNextCallUsage: unknown = check.estimatedNextCallUsage;

  if (!isPlainRecord(rates)) {
    throw new TypeError(RATES_REQUIRED_MESSAGE);
  }
  const inputPerMillion: unknown = rates.inputPerMillion;
  const outputPerMillion: unknown = rates.outputPerMillion;
  const cacheReadPerMillion: unknown = rates.cacheReadPerMillion;
  if (typeof inputPerMillion !== 'number' || typeof outputPerMillion !== 'number') {
    throw new TypeError(RATES_REQUIRED_MESSAGE);
  }
  if (
    !Number.isFinite(inputPerMillion) ||
    !Number.isFinite(outputPerMillion) ||
    inputPerMillion < 0 ||
    outputPerMillion < 0
  ) {
    throw new RangeError(RATES_REQUIRED_MESSAGE);
  }
  if (typeof ceilingUsd !== 'number') {
    throw new TypeError(`checkPreCallCeiling: ceilingUsd must be a non-negative finite number, got ${describe(ceilingUsd)}`);
  }
  if (!Number.isFinite(ceilingUsd) || ceilingUsd < 0) {
    throw new RangeError(`checkPreCallCeiling: ceilingUsd must be a non-negative finite number, got ${ceilingUsd}`);
  }
  if (typeof spentSoFarUsd !== 'number') {
    throw new TypeError(`checkPreCallCeiling: spentSoFarUsd must be a non-negative finite number, got ${describe(spentSoFarUsd)}`);
  }
  if (!Number.isFinite(spentSoFarUsd) || spentSoFarUsd < 0) {
    throw new RangeError(`checkPreCallCeiling: spentSoFarUsd must be a non-negative finite number, got ${spentSoFarUsd}`);
  }

  // estimateCostUsd validates the optional cacheReadPerMillion and the usage
  // estimate, from this copy of the rates (never the caller's object again).
  const projectedNextCallCostUsd = estimateCostUsd(
    { inputPerMillion, outputPerMillion, cacheReadPerMillion } as ModelRates,
    estimatedNextCallUsage as UsageTokens,
  );
  const unroundedProjectedTotalUsd = spentSoFarUsd + projectedNextCallCostUsd;
  if (!Number.isFinite(unroundedProjectedTotalUsd)) {
    throw new Error('checkPreCallCeiling: projected total must remain finite');
  }
  const projectedTotalUsd = round6(unroundedProjectedTotalUsd);
  const allowed = projectedTotalUsd <= ceilingUsd;

  return {
    allowed,
    projectedNextCallCostUsd,
    projectedTotalUsd,
    ceilingUsd,
    reason: allowed
      ? undefined
      : `Projected total spend $${projectedTotalUsd.toFixed(6)} ` +
        `(already spent $${spentSoFarUsd.toFixed(6)} + projected next call $${projectedNextCallCostUsd.toFixed(6)}) ` +
        `would exceed the ceiling of $${ceilingUsd.toFixed(6)}. Refusing to make the call.`,
  };
}

const RATES_REQUIRED_MESSAGE =
  'checkPreCallCeiling: `rates` (a plain object with non-negative finite numeric inputPerMillion/outputPerMillion) is required. ' +
  'This library never defaults or hardcodes a price — pass the live rate explicitly, ' +
  'the same way classify-batch.mjs takes --input-rate/--output-rate as CLI arguments, ' +
  'so a stale price cannot silently corrupt the spend cap.';

function round6(n: number): number {
  const rounded = Math.round(n * 1e6) / 1e6;
  if (!Number.isFinite(rounded)) {
    throw new Error('checkPreCallCeiling: rounded projected total must remain finite');
  }
  return rounded;
}
