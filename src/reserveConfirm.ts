/**
 * reserveConfirm.ts — the two-phase, database-agnostic contract for atomic
 * usage counting: reserve (check), call, confirm (commit) — never commit on
 * a failed call.
 *
 * Extracted from cruise-almanac's api/chat.js, which fixed a real slot-leak
 * bug (AUDIT-2026-05-01-v2, finding F3-CC-E-4). The original (pre-fix) code
 * checked a user's daily-count limit and incremented it in the SAME step,
 * BEFORE calling the upstream Anthropic API:
 *
 *   check-and-increment(user)   // one step, before the call
 *   callUpstream()              // if this fails...
 *
 * If the upstream call then failed (a 5xx, a timeout, a network blip) and
 * the client retried — completely reasonable client behavior — the retry
 * burned a SECOND slot for what was really one logical usage attempt that
 * never actually succeeded even once. A user could lose their entire daily
 * quota to a single flaky request plus its retry, with zero real usage to
 * show for it.
 *
 * THE FIX: split into two phases.
 *   Phase 1 (BEFORE the call): check the count WITHOUT incrementing. If
 *     over the limit, deny (e.g. HTTP 429) with zero side effects — the
 *     denial itself costs nothing, so it's safe to retry a check.
 *   Phase 2 (AFTER the call succeeds): increment atomically, ONLY once the
 *     upstream call has actually returned a successful result. If the call
 *     throws, phase 2 never runs, so a failed call never burns a slot.
 *
 * From cruise-almanac's own comment on the fix: "the gate only CHECKS, the
 * bump only fires on a confirmed-successful upstream." That's the entire
 * pattern this module encodes as a portable contract.
 *
 * DATABASE-AGNOSTIC BY DESIGN: this file defines only an interface
 * (`UsageLedger`) and an orchestrator function that calls it
 * (`withReserveConfirm`). It has no Supabase, Postgres, or any other
 * database dependency — implement `UsageLedger` against whatever storage
 * your app already uses (Postgres RPC, Redis, DynamoDB, an in-memory map for
 * tests). See reference-impl/supabase-usage-ledger.sql for a ready-to-copy
 * Postgres/Supabase implementation of this exact contract.
 */

/**
 * The contract any app implements against its own database. `key` is
 * caller-defined — a user id, `${userId}:${date}` for a daily cap,
 * `${userId}:${feature}` for a per-feature cap, or any other string your
 * app uses to identify what's being rate-limited.
 */
export interface UsageLedger {
  /**
   * Phase 1 — read-only. Returns true if usage under `key` is currently
   * under `limit`. MUST NOT increment or otherwise mutate state — a caller
   * that finds itself over the limit needs to be able to deny the request
   * (e.g. return a 429) with zero side effects, including on a retry.
   */
  checkUnderLimit(key: string, limit: number): Promise<boolean>;

  /**
   * Phase 2 — mutating. Atomically increments usage under `key`. Call this
   * ONLY after the guarded call has succeeded — never speculatively, never
   * before the call, and never if the call threw. Implementations should
   * make this atomic against concurrent commits for the same key (e.g. a
   * SQL `UPDATE ... WHERE count < limit RETURNING ...`, not a
   * read-then-write in application code) so two concurrent successful calls
   * can't both slip past the limit between their own check and commit.
   */
  commitUsage(key: string): Promise<void>;
}

/**
 * Orchestrates the reserve-then-confirm pattern around any async call.
 *
 * 1. Calls `ledger.checkUnderLimit(key, limit)`. If it returns false, denies
 *    immediately — `doTheCall` is never invoked and nothing is committed.
 * 2. Otherwise invokes `doTheCall()`. If it throws/rejects, the error
 *    propagates to the caller UNCHANGED and `commitUsage` is never called —
 *    this is the core guarantee: a failed call never burns a slot.
 * 3. Only if `doTheCall()` resolves successfully does it call
 *    `ledger.commitUsage(key)`, then return the result.
 *
 * Example:
 *
 *   const result = await withReserveConfirm(
 *     myLedger,
 *     `${userId}:${today}`,
 *     FREE_DAILY_LIMIT,
 *     () => callAnthropic(userId, prompt),
 *   );
 *   if (!result.allowed) {
 *     return send429("Daily limit reached");
 *   }
 *   return send200(result.result);
 */
export async function withReserveConfirm<T>(
  ledger: UsageLedger,
  key: string,
  limit: number,
  doTheCall: () => Promise<T>,
): Promise<ReserveConfirmResult<T>> {
  const underLimit = await ledger.checkUnderLimit(key, limit);
  if (!underLimit) {
    return { allowed: false };
  }

  // If doTheCall() throws, this function throws too (no try/catch here) and
  // commitUsage is never reached — that omission IS the fix. Do not wrap
  // this call in a try/catch that swallows the error; let it propagate so
  // the caller's normal error handling (and the caller's own retry logic,
  // if any) applies unchanged. A retry after a thrown error simply re-runs
  // checkUnderLimit from scratch, which is safe because phase 1 never
  // mutates state.
  const result = await doTheCall();

  await ledger.commitUsage(key);

  return { allowed: true, result };
}

export type ReserveConfirmResult<T> =
  | { allowed: true; result: T }
  | { allowed: false; result?: undefined };
