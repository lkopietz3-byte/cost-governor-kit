/**
 * reserveConfirm.ts — two database-agnostic usage-counting patterns.
 *
 * `withReserveConfirm` never counts a call that throws, but its read-only
 * check cannot reserve capacity, so it is advisory under concurrency.
 * `withCapacityReservation` asks YOUR adapter to reserve capacity before
 * upstream work, then confirms or releases that hold. Whether the limit holds
 * under concurrency depends entirely on that adapter being atomic.
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
 * THE ADVISORY FIX: split into two phases.
 *   Phase 1 (BEFORE the call): check the count WITHOUT incrementing. If
 *     over the limit, deny (e.g. HTTP 429) with zero side effects — the
 *     denial itself costs nothing, so it's safe to retry a check.
 *   Phase 2 (AFTER the call succeeds): increment atomically, ONLY once the
 *     upstream call has actually returned a successful result. If the call
 *     throws, phase 2 never runs, so a failed call never burns a slot.
 *
 * From cruise-almanac's own comment on the fix: "the gate only CHECKS, the
 * bump only fires on a confirmed-successful upstream." That's the entire
 * pattern `withReserveConfirm` encodes as a portable, advisory contract.
 *
 * DATABASE-AGNOSTIC BY DESIGN: this file defines only interfaces
 * (`UsageLedger`, `CapacityReservationLedger`) and two small orchestrators.
 * It has no database dependency and keeps no state of its own. All counting,
 * atomicity and durability live in the adapter you implement.
 * reference-impl/supabase-usage-ledger.sql is a Postgres sketch of the
 * advisory `UsageLedger` only; this kit ships no `CapacityReservationLedger`.
 */

/**
 * Storage contract for the advisory {@link withReserveConfirm} helper. `key`
 * is caller-defined: a user id, `${userId}:${date}` for a daily cap, or any
 * other string that identifies what is being limited.
 */
export interface UsageLedger {
  /**
   * Phase 1, read-only. Resolve `true` if usage under `key` is below
   * `limit`, otherwise `false`. Must not mutate state. Must resolve a real
   * boolean: {@link withReserveConfirm} throws on anything else.
   */
  checkUnderLimit(key: string, limit: number): Promise<boolean>;

  /**
   * Phase 2 — mutating. Increments usage under `key`. Call this
   * ONLY after the guarded call has succeeded — never speculatively, never
   * before the call, and never if the call threw. Implementations should
   * make this atomic with respect to their own writes, but this method does
   * not receive `limit` or a reservation. It cannot turn the preceding
   * read-only check into a strict concurrent ceiling. Use
   * `CapacityReservationLedger` + `withCapacityReservation` when the limit
   * must hold under concurrent requests.
   */
  commitUsage(key: string): Promise<void>;
}

/**
 * Advisory check-then-commit around one async call. Not a concurrent limit.
 *
 * 1. Awaits `ledger.checkUnderLimit(key, limit)` (`limit` is passed through
 *    unvalidated). `false` returns `{ allowed: false }` without calling
 *    `doTheCall`. A non-boolean result throws a TypeError, also without
 *    calling `doTheCall`.
 * 2. Otherwise awaits `doTheCall()`. If it throws or rejects, that error
 *    propagates unchanged and `commitUsage` is never called: a call that
 *    fails before reporting success is never counted. (That does not prove a
 *    timed-out provider call was not charged.)
 * 3. After success, awaits `ledger.commitUsage(key)` and returns
 *    `{ allowed: true, result }`. If `commitUsage` rejects, this function
 *    rejects with that error and the successful result is discarded, even
 *    though the paid call happened.
 *
 * Concurrent callers can all pass step 1 before any of them commits, so the
 * limit can be exceeded. It never retries anything.
 *
 * @example
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
  const underLimit: unknown = await ledger.checkUnderLimit(key, limit);
  // A truthy non-boolean (for example a whole RPC response object) used to
  // count as "under the limit" and let paid work run. Fail closed instead.
  if (typeof underLimit !== 'boolean') {
    throw new TypeError('withReserveConfirm: ledger.checkUnderLimit must resolve to a boolean');
  }
  if (!underLimit) {
    return { allowed: false };
  }

  // If doTheCall() throws, this function throws too (no try/catch here) and
  // commitUsage is never reached. This preserves the legacy source-compatible
  // behavior, but it cannot prove whether a timeout reached a paid provider.
  // Re-running the read-only quota check is safe; retrying paid work is a
  // caller decision that requires provider reconciliation/idempotency.
  const result = await doTheCall();

  await ledger.commitUsage(key);

  return { allowed: true, result };
}

/** Result of {@link withReserveConfirm}. */
export type ReserveConfirmResult<T> =
  | { allowed: true; result: T }
  | { allowed: false; result?: undefined };

// ---------------------------------------------------------------------------
// Strict capacity reservation
// ---------------------------------------------------------------------------

/** One adapter-issued hold on capacity. Pass it back unchanged to the adapter. */
export interface CapacityReservation {
  /** Adapter-chosen id; must be a non-empty string. */
  id: string;
  /** Must equal the request's `key`. */
  key: string;
  /** Stable idempotency key for one logical upstream operation. */
  operationId: string;
  /**
   * Expiry chosen by the adapter; must parse with `Date.parse`. For a newly
   * acquired hold it must also be later than this process's `Date.now()`, so
   * clock skew between the adapter and the app matters.
   */
  expiresAt: string;
}

/** Input to {@link withCapacityReservation} and `reserveCapacity`. */
export interface ReserveCapacityRequest {
  /** Non-empty (after trimming) string identifying what is limited. Not trimmed. */
  key: string;
  /**
   * Maximum for confirmed usage plus unexpired holds under this key, enforced
   * by the adapter. Must be a safe integer >= 0; 0 is passed to the adapter,
   * which should deny.
   */
  limit: number;
  /** Non-empty idempotency key for one logical operation. Reuse it on every retry; a new id is a new operation. */
  operationId: string;
}

/** What an adapter's `reserveCapacity` returns. */
export type ReserveCapacityResult =
  /** This invocation newly acquired the hold and is the only one allowed to execute work. */
  | { status: "acquired"; reservation: CapacityReservation }
  /** Capacity was unavailable before this operation acquired a hold. */
  | { status: "denied"; reason?: string }
  /** The same operation is already active or unresolved; reconcile, do not execute again. */
  | { status: "operation_in_progress"; reservation: CapacityReservation }
  /** The same operation is already terminal; recover its durable outcome, do not execute again. */
  | { status: "operation_terminal"; operationId: string; reason?: string };

/**
 * Storage contract for a strict concurrent capacity limit. This is the
 * safety boundary: {@link withCapacityReservation} has no counter of its own
 * and trusts these decisions.
 *
 * `reserveCapacity` MUST atomically count confirmed usage and unexpired active
 * reservations for `key`, and create a hold only when that total is below
 * `limit`. Repeating `(key, operationId)` MUST return
 * `operation_in_progress` for an active/unresolved hold, or
 * `operation_terminal` after it is final. Only the invocation that receives
 * `acquired` may run provider work; duplicates must never create another hold
 * or restart work. Confirmation and release MUST be idempotent too. Adapters
 * need durable state, an expiry longer than expected provider work, and a
 * reconciliation/fencing policy for expired or ambiguous reservations. Expiry
 * alone never proves possibly executing work is safe to release.
 */
export interface CapacityReservationLedger {
  reserveCapacity(request: ReserveCapacityRequest): Promise<ReserveCapacityResult>;
  confirmReservation(reservation: CapacityReservation): Promise<void>;
  releaseReservation(reservation: CapacityReservation): Promise<void>;
}

/**
 * Return `failed` only when the provider definitely performed no charge and
 * no relevant side effect. A user-visible rejection alone is not enough. Throw
 * or reject when its outcome is unknown (for example a timeout after request
 * write), so the reservation remains held for reconciliation.
 */
export type CapacityWorkOutcome<T> =
  | { status: "succeeded"; value: T }
  | { status: "failed"; error: unknown };

/** Result of {@link withCapacityReservation}. Every status except `denied` and `confirmed` needs reconciliation before any retry of paid work. */
export type CapacityReservationResult<T> =
  | { status: "denied"; reason?: string }
  | { status: "operation_in_progress"; reservation: CapacityReservation }
  | { status: "operation_terminal"; operationId: string; reason?: string }
  | { status: "confirmed"; reservation: CapacityReservation; value: T }
  | { status: "released_after_failure"; reservation: CapacityReservation; error: unknown }
  | {
      status: "release_failed";
      reservation: CapacityReservation;
      workError: unknown;
      releaseError: unknown;
    }
  | {
      status: "work_outcome_ambiguous";
      reservation: CapacityReservation;
      error: unknown;
    }
  | {
      status: "confirmation_failed";
      reservation: CapacityReservation;
      value: T;
      error: unknown;
    };

/**
 * Reserve capacity before one upstream operation, then confirm or release it.
 *
 * What this helper guarantees (given any adapter):
 * - It validates `request` first and throws, without calling the adapter,
 *   for a limit that is not a safe integer >= 0 or an empty key/operationId.
 * - It calls `reserveCapacity` exactly once and `doTheWork` at most once,
 *   only for an `acquired` decision whose reservation has a non-empty id,
 *   the request's key and operationId, and an `expiresAt` later than
 *   `Date.now()`. A malformed or unknown decision throws before any work;
 *   if the adapter did create a hold, it is left in place (not released).
 * - `{ status: 'succeeded' }` leads to one `confirmReservation` call;
 *   `{ status: 'failed' }` to one `releaseReservation` call. It never calls
 *   both, never calls either twice, and never retries.
 * - A thrown or rejected `doTheWork`, or an outcome of the wrong shape,
 *   returns `work_outcome_ambiguous` and keeps the hold. A failed confirm
 *   returns `confirmation_failed` (with the value) and keeps the hold.
 * - A rejected `reserveCapacity` propagates; no work runs. A hold may or may
 *   not exist; retry with the same operationId to find out.
 *
 * What it does NOT guarantee: the limit itself, atomicity, duplicate
 * suppression and durability all come from your adapter. It keeps no state,
 * sets no timers, and has no timeout: a hung adapter or `doTheWork` hangs
 * this call. If the process crashes after a hold is created, the hold stays
 * in your storage until your reconciliation confirms or releases it; while
 * unexpired it counts toward the limit and same-operationId retries get
 * `operation_in_progress`. Once it expires it stops counting (per the
 * contract), so paid work that was never confirmed can then push real usage
 * past the limit until reconciliation confirms it.
 */
export async function withCapacityReservation<T>(
  ledger: CapacityReservationLedger,
  request: ReserveCapacityRequest,
  doTheWork: (reservation: CapacityReservation) => Promise<CapacityWorkOutcome<T>>,
): Promise<CapacityReservationResult<T>> {
  validateReserveCapacityRequest(request);
  const decision = await ledger.reserveCapacity(request);
  if (!decision || typeof decision !== "object" || !("status" in decision)) {
    throw new Error("withCapacityReservation: adapter returned an invalid reservation decision");
  }
  const decisionStatus: unknown = (decision as { status?: unknown }).status;
  if (decision.status === "denied") return { status: "denied", reason: decision.reason };
  if (decision.status === "operation_in_progress") {
    validateReservationIdentity(decision.reservation, request, false);
    return { status: "operation_in_progress", reservation: decision.reservation };
  }
  if (decision.status === "operation_terminal") {
    if (decision.operationId !== request.operationId) {
      throw new Error("withCapacityReservation: adapter terminal decision operationId does not match request");
    }
    return { status: "operation_terminal", operationId: decision.operationId, reason: decision.reason };
  }
  if (decisionStatus !== "acquired") {
    throw new Error(`withCapacityReservation: adapter returned unknown reservation decision status ${String(decisionStatus)}`);
  }

  const { reservation } = decision;
  validateReservationIdentity(reservation, request);
  let outcome: CapacityWorkOutcome<T>;
  try {
    outcome = await doTheWork(reservation);
  } catch (error) {
    return { status: "work_outcome_ambiguous", reservation, error };
  }

  if (!isCapacityWorkOutcome(outcome)) {
    return {
      status: "work_outcome_ambiguous",
      reservation,
      error: new Error("withCapacityReservation: doTheWork returned an invalid outcome"),
    };
  }

  if (outcome.status === "failed") {
    try {
      await ledger.releaseReservation(reservation);
      return { status: "released_after_failure", reservation, error: outcome.error };
    } catch (releaseError) {
      return { status: "release_failed", reservation, workError: outcome.error, releaseError };
    }
  }

  try {
    await ledger.confirmReservation(reservation);
    return { status: "confirmed", reservation, value: outcome.value };
  } catch (error) {
    return { status: "confirmation_failed", reservation, value: outcome.value, error };
  }
}

function validateReserveCapacityRequest(request: ReserveCapacityRequest): void {
  if (!Number.isSafeInteger(request.limit) || request.limit < 0) {
    throw new Error("withCapacityReservation: limit must be a non-negative safe integer");
  }
  if (typeof request.key !== "string" || !request.key.trim()) {
    throw new Error("withCapacityReservation: key must be a non-empty string");
  }
  if (typeof request.operationId !== "string" || !request.operationId.trim()) {
    throw new Error("withCapacityReservation: operationId must be a non-empty string");
  }
}

function validateReservationIdentity(
  reservation: CapacityReservation,
  request: ReserveCapacityRequest,
  requireUnexpired = true,
): void {
  if (!reservation || typeof reservation !== "object") {
    throw new Error("withCapacityReservation: adapter returned an invalid reservation");
  }
  if (typeof reservation.id !== "string" || !reservation.id.trim()) {
    throw new Error("withCapacityReservation: reservation id must be a non-empty string");
  }
  if (reservation.key !== request.key) {
    throw new Error("withCapacityReservation: reservation key does not match request");
  }
  if (reservation.operationId !== request.operationId) {
    throw new Error("withCapacityReservation: reservation operationId does not match request");
  }
  if (typeof reservation.expiresAt !== "string" || !Number.isFinite(Date.parse(reservation.expiresAt))) {
    throw new Error("withCapacityReservation: reservation expiresAt must be a valid ISO-8601 timestamp");
  }
  if (requireUnexpired && Date.parse(reservation.expiresAt) <= Date.now()) {
    throw new Error("withCapacityReservation: adapter returned an expired reservation");
  }
}

function isCapacityWorkOutcome(value: unknown): value is CapacityWorkOutcome<unknown> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.status === "succeeded") return Object.prototype.hasOwnProperty.call(record, "value");
  if (record.status === "failed") return Object.prototype.hasOwnProperty.call(record, "error");
  return false;
}
