/**
 * preCallCeiling.ts — a hard dollar ceiling enforced BEFORE an API call, not
 * monitored after.
 *
 * Extracted from ~/lattice/scripts/classify-batch.mjs, the only genuine
 * pre-call dollar ceiling found across an audited portfolio of AI-calling
 * apps. Every other app in that audit had post-hoc spend *monitoring*
 * (dashboards, alerts, anomaly detection) — useful, but reactive: by the time
 * an alert fires, the money is already spent. classify-batch.mjs instead
 * computes the projected cost of the NEXT call before making it, and refuses
 * to make the call at all if that would push cumulative spend past a hard
 * ceiling:
 *
 *   // Ceiling checked BEFORE the call, not after. This is the whole point.
 *   if (usd(spend) >= MAX_USD) { ...stop cleanly... }
 *
 * THE "NEVER A STALE HARDCODED PRICE" DISCIPLINE
 * ------------------------------------------------
 * classify-batch.mjs takes its rates as explicit `--input-rate` / `--output-rate`
 * CLI arguments (never hardcoded) and prints them on every run:
 *
 *   rates: $3/M in, $15/M out  <- VERIFY against current pricing
 *
 * The reasoning (from that script's own header comment): "Rates are dollars
 * per million tokens and MUST be set to current published pricing. They
 * default to placeholders and are printed on every run so a stale number
 * cannot silently corrupt the spend cap." A hardcoded price baked into a
 * library ships once and rots forever; a rate the caller must supply and the
 * caller can log is a rate someone is forced to look at.
 *
 * This module mirrors that discipline: `rates` is a REQUIRED parameter on
 * every check, with no default value anywhere in this file. See pricing.ts
 * for `formatRatesForLog()`, which callers should log alongside every batch
 * run for the same "stale price can't hide" reason.
 */

import { estimateCostUsd, type ModelRates, type UsageTokens } from './pricing.js';

export interface PreCallCeilingCheck {
  /** Cumulative spend already incurred this run/session/day, in USD. */
  spentSoFarUsd: number;
  /** The hard dollar ceiling. The call is denied if spentSoFarUsd + the
   * projected cost of the next call would exceed this. */
  ceilingUsd: number;
  /** Estimated token usage for the call about to be made — NOT actual usage,
   * since this check runs before the call. Estimate however you like (a
    * fixed per-record heuristic, a tokenizer count, a running average of
    * recent calls); accuracy of this estimate bounds the accuracy of the
   * ceiling (see the README's Limits section). Convert fractional projections
   * such as averages conservatively by rounding each bucket up to a whole
   * token, and ensure the result is a non-negative safe integer. This function
   * validates the supplied buckets and rejects values outside that contract. */
  estimatedNextCallUsage: UsageTokens;
  /**
   * Live rates for the model about to be called. REQUIRED — there is no
   * default. Pass the same rates you're about to bill against, ideally
   * sourced from an explicit CLI flag, config value, or recent pricing
   * lookup, and log them (see pricing.ts's formatRatesForLog) so a stale
   * number is visible rather than silently baked in.
   */
  rates: ModelRates;
}

export interface PreCallCeilingResult {
  /** True if the call is allowed to proceed. False means: do not make the call. */
  allowed: boolean;
  /** The estimated cost of the call about to be made, in USD. */
  projectedNextCallCostUsd: number;
  /** spentSoFarUsd + projectedNextCallCostUsd — what cumulative spend would
   * become if this call is made. */
  projectedTotalUsd: number;
  /** Echoed back from the input for convenience in logging/error messages. */
  ceilingUsd: number;
  /** Present only when allowed is false — a human-readable explanation. */
  reason?: string;
}

/**
 * Decide whether the next call is allowed to proceed, BEFORE making it.
 *
 * This function has no side effects and makes no network calls — it is pure
 * arithmetic over the numbers you give it. Call it immediately before your
 * actual API call and only proceed if `result.allowed` is true:
 *
 *   const check = checkPreCallCeiling({
 *     spentSoFarUsd: runningTotal,
 *     ceilingUsd: 25,
 *     estimatedNextCallUsage: { inputTokens: 2000, outputTokens: 500 },
 *     rates: { inputPerMillion: 3, outputPerMillion: 15 }, // from a CLI flag / config, never hardcoded
 *   });
 *   if (!check.allowed) {
 *     console.error(check.reason);
 *     process.exit(1); // or stop the batch loop cleanly, per classify-batch.mjs
 *   }
 *   // ...only now make the actual API call...
 *   runningTotal = check.projectedTotalUsd; // or reconcile with actual usage after the call
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
