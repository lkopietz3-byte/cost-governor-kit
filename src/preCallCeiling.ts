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

import { estimateCostUsd, type ModelRates, type UsageTokens } from './pricing.js';

/** Input to {@link checkPreCallCeiling}. */
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
 * @throws Error when `rates` is missing or invalid, `ceilingUsd` or
 *   `spentSoFarUsd` is not a finite number >= 0 (these messages include the
 *   rejected value), the usage estimate is invalid, or the total is not finite.
 *   A null or undefined `check` throws a TypeError.
 */
export function checkPreCallCeiling(check: PreCallCeilingCheck): PreCallCeilingResult {
  if (
    !check.rates ||
    typeof check.rates.inputPerMillion !== 'number' ||
    typeof check.rates.outputPerMillion !== 'number' ||
    !Number.isFinite(check.rates.inputPerMillion) ||
    !Number.isFinite(check.rates.outputPerMillion) ||
    check.rates.inputPerMillion < 0 ||
    check.rates.outputPerMillion < 0
  ) {
    throw new Error(
      'checkPreCallCeiling: `rates` (with non-negative finite numeric inputPerMillion/outputPerMillion) is required. ' +
        'This library never defaults or hardcodes a price — pass the live rate explicitly, ' +
        'the same way classify-batch.mjs takes --input-rate/--output-rate as CLI arguments, ' +
        'so a stale price cannot silently corrupt the spend cap.',
    );
  }
  if (!Number.isFinite(check.ceilingUsd) || check.ceilingUsd < 0) {
    throw new Error(`checkPreCallCeiling: ceilingUsd must be a non-negative finite number, got ${check.ceilingUsd}`);
  }
  if (!Number.isFinite(check.spentSoFarUsd) || check.spentSoFarUsd < 0) {
    throw new Error(`checkPreCallCeiling: spentSoFarUsd must be a non-negative finite number, got ${check.spentSoFarUsd}`);
  }

  const projectedNextCallCostUsd = estimateCostUsd(check.rates, check.estimatedNextCallUsage);
  const unroundedProjectedTotalUsd = check.spentSoFarUsd + projectedNextCallCostUsd;
  if (!Number.isFinite(unroundedProjectedTotalUsd)) {
    throw new Error('checkPreCallCeiling: projected total must remain finite');
  }
  const projectedTotalUsd = round6(unroundedProjectedTotalUsd);
  const allowed = projectedTotalUsd <= check.ceilingUsd;

  return {
    allowed,
    projectedNextCallCostUsd,
    projectedTotalUsd,
    ceilingUsd: check.ceilingUsd,
    reason: allowed
      ? undefined
      : `Projected total spend $${projectedTotalUsd.toFixed(6)} ` +
        `(already spent $${check.spentSoFarUsd.toFixed(6)} + projected next call $${projectedNextCallCostUsd.toFixed(6)}) ` +
        `would exceed the ceiling of $${check.ceilingUsd.toFixed(6)}. Refusing to make the call.`,
  };
}

function round6(n: number): number {
  const rounded = Math.round(n * 1e6) / 1e6;
  if (!Number.isFinite(rounded)) {
    throw new Error('checkPreCallCeiling: rounded projected total must remain finite');
  }
  return rounded;
}
