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

import { describe, isBlank, isPlainRecord } from './internal.js';

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
   * before the call, and never if the call threw. It must REJECT when usage
   * was not recorded: {@link withReserveConfirm} ignores the resolved value,
   * so resolving after a failed or refused write reads as "recorded".
   * Implementations should
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
 * 3. After success, awaits `ledger.commitUsage(key)`. If it resolves, returns
 *    `{ allowed: true, result }`. If it rejects, the paid call already
 *    happened and its result is NOT discarded: this returns
 *    `{ allowed: true, result, commitError }` instead of rejecting, where
 *    `commitError` is exactly what `commitUsage` rejected with (whatever type
 *    that was). The presence of `commitError` is the caller's signal that the
 *    usage count may be under-recorded for this call.
 *
 * Concurrent callers can all pass step 1 before any of them commits, so the
 * limit can be exceeded. It never retries anything. The value `commitUsage`
 * resolves is ignored; only a rejection signals that usage was not recorded.
 *
 * Detect an unrecorded commit with `Object.hasOwn(result, 'commitError')`, not
 * `if (result.commitError)`: a ledger may reject with `undefined`, `null`,
 * `false`, `0` or `''`, and every one of those is falsy.
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

  try {
    await ledger.commitUsage(key);
  } catch (commitError) {
    // The paid call already succeeded; only recording it failed afterward.
    // Return the result instead of discarding it — the usage count may now
    // be under-recorded, which the caller can detect via `commitError`.
    return { allowed: true, result, commitError };
  }

  return { allowed: true, result };
}

/**
 * Result of {@link withReserveConfirm}. `commitError` is present only when
 * `commitUsage` rejected after a successful call; its absence means the call
 * both succeeded and was recorded.
 */
export type ReserveConfirmResult<T> =
  | { allowed: true; result: T; commitError?: unknown }
  | { allowed: false; result?: undefined };

// ---------------------------------------------------------------------------
// Strict capacity reservation
// ---------------------------------------------------------------------------

/** One adapter-issued hold on capacity. Pass it back unchanged to the adapter. */
export interface CapacityReservation {
  /** Adapter-chosen id; must be a non-blank string (not empty, not only whitespace or invisible characters). */
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
  /**
   * Non-blank string identifying what is limited. Blank means empty or only
   * whitespace and invisible (Default_Ignorable_Code_Point) characters. Not
   * trimmed.
   */
  key: string;
  /**
   * Maximum for confirmed usage plus unexpired holds under this key, enforced
   * by the adapter. Must be a safe integer >= 0; 0 is passed to the adapter,
   * which should deny.
   */
  limit: number;
  /** Non-blank idempotency key for one logical operation (see `key` for "blank"). Reuse it on every retry; a new id is a new operation. */
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
 * - It reads `request` once (its `limit`, `key` and `operationId`), validates
 *   that snapshot and throws, without calling the adapter, for a `request`
 *   that is not a plain or null-prototype object, a limit that is not a safe
 *   integer >= 0, or a blank key/operationId (empty, or only whitespace and
 *   invisible characters). The adapter receives a fresh
 *   `{ key, limit, operationId }` copy, and every later comparison uses the
 *   validated values, so neither the caller changing its object nor the
 *   adapter editing its argument can change what a reservation is checked
 *   against.
 * - It calls `reserveCapacity` exactly once and `doTheWork` at most once,
 *   only for an `acquired` decision whose reservation has a non-blank id,
 *   the request's key and operationId, and an `expiresAt` later than
 *   `Date.now()`. A malformed or unknown decision throws before any work;
 *   if the adapter did create a hold, it is left in place (not released).
 * - Each field of the decision, the reservation and the work outcome is read
 *   once.
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
 *
 * @throws TypeError when `request` is not a plain object, `key` or
 *   `operationId` is not a string, `limit` is not a number, or the adapter
 *   returns a decision or reservation of the wrong shape.
 * @throws RangeError for a `limit` that is not a safe integer >= 0, a blank
 *   key, operationId or reservation id, a reservation for a different key or
 *   operationId, an unparseable or already-expired `expiresAt`, a terminal
 *   decision for a different operation, or an unknown decision status.
 */
export async function withCapacityReservation<T>(
  ledger: CapacityReservationLedger,
  request: ReserveCapacityRequest,
  doTheWork: (reservation: CapacityReservation) => Promise<CapacityWorkOutcome<T>>,
): Promise<CapacityReservationResult<T>> {
  const { key, limit, operationId } = readReserveCapacityRequest(request);
  const decision: unknown = await ledger.reserveCapacity({ key, limit, operationId });
  if (!decision || typeof decision !== 'object' || !('status' in decision)) {
    throw new TypeError("withCapacityReservation: adapter returned an invalid reservation decision");
  }
  const decisionRecord = decision as { status?: unknown; reason?: unknown; reservation?: unknown; operationId?: unknown };
  const status: unknown = decisionRecord.status;
  if (status === "denied") {
    const reason = decisionRecord.reason as string | undefined;
    return { status: "denied", reason };
  }
  if (status === "operation_in_progress") {
    const reservation = decisionRecord.reservation as CapacityReservation;
    validateReservationIdentity(reservation, key, operationId, false);
    return { status: "operation_in_progress", reservation };
  }
  if (status === "operation_terminal") {
    const terminalOperationId = decisionRecord.operationId as string;
    const reason = decisionRecord.reason as string | undefined;
    if (terminalOperationId !== operationId) {
      throw new RangeError("withCapacityReservation: adapter terminal decision operationId does not match request");
    }
    return { status: "operation_terminal", operationId: terminalOperationId, reason };
  }
  if (status !== "acquired") {
    throw new RangeError(`withCapacityReservation: adapter returned unknown reservation decision status ${describe(status)}`);
  }

  const reservation = decisionRecord.reservation as CapacityReservation;
  validateReservationIdentity(reservation, key, operationId);
  let outcome: unknown;
  try {
    outcome = await doTheWork(reservation);
  } catch (error) {
    return { status: "work_outcome_ambiguous", reservation, error };
  }

  const parsed = readCapacityWorkOutcome<T>(outcome);
  if (!parsed) {
    return {
      status: "work_outcome_ambiguous",
      reservation,
      error: new Error("withCapacityReservation: doTheWork returned an invalid outcome"),
    };
  }

  if (parsed.status === "failed") {
    try {
      await ledger.releaseReservation(reservation);
      return { status: "released_after_failure", reservation, error: parsed.error };
    } catch (releaseError) {
      return { status: "release_failed", reservation, workError: parsed.error, releaseError };
    }
  }

  try {
    await ledger.confirmReservation(reservation);
    return { status: "confirmed", reservation, value: parsed.value };
  } catch (error) {
    return { status: "confirmation_failed", reservation, value: parsed.value, error };
  }
}

/** Read the request once and validate what was read. Returns plain copies of the three fields. */
function readReserveCapacityRequest(request: ReserveCapacityRequest): ReserveCapacityRequest {
  if (!isPlainRecord(request)) {
    throw new TypeError(
      "withCapacityReservation: request must be an object with key, limit and operationId " +
        "(a plain object; not null, an array, a Map, a Date or a class instance)",
    );
  }
  const limit: unknown = request.limit;
  const key: unknown = request.key;
  const operationId: unknown = request.operationId;
  if (typeof limit !== "number") {
    throw new TypeError("withCapacityReservation: limit must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("withCapacityReservation: limit must be a non-negative safe integer");
  }
  if (typeof key !== "string") {
    throw new TypeError("withCapacityReservation: key must be a non-empty string");
  }
  if (isBlank(key)) {
    throw new RangeError("withCapacityReservation: key must be a non-empty string");
  }
  if (typeof operationId !== "string") {
    throw new TypeError("withCapacityReservation: operationId must be a non-empty string");
  }
  if (isBlank(operationId)) {
    throw new RangeError("withCapacityReservation: operationId must be a non-empty string");
  }
  return { key, limit, operationId };
}

function validateReservationIdentity(
  reservation: CapacityReservation,
  requestKey: string,
  requestOperationId: string,
  requireUnexpired = true,
): void {
  if (!reservation || typeof reservation !== "object") {
    throw new TypeError("withCapacityReservation: adapter returned an invalid reservation");
  }
  const id: unknown = reservation.id;
  const key: unknown = reservation.key;
  const operationId: unknown = reservation.operationId;
  const expiresAt: unknown = reservation.expiresAt;
  if (typeof id !== "string") {
    throw new TypeError("withCapacityReservation: reservation id must be a non-empty string");
  }
  if (isBlank(id)) {
    throw new RangeError("withCapacityReservation: reservation id must be a non-empty string");
  }
  if (key !== requestKey) {
    throw new RangeError("withCapacityReservation: reservation key does not match request");
  }
  if (operationId !== requestOperationId) {
    throw new RangeError("withCapacityReservation: reservation operationId does not match request");
  }
  if (typeof expiresAt !== "string") {
    throw new TypeError("withCapacityReservation: reservation expiresAt must be a valid ISO-8601 timestamp");
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new RangeError("withCapacityReservation: reservation expiresAt must be a valid ISO-8601 timestamp");
  }
  if (requireUnexpired && expiresAtMs <= Date.now()) {
    throw new RangeError("withCapacityReservation: adapter returned an expired reservation");
  }
}

/** Read a work outcome once. Returns `undefined` for anything that is not a well-formed outcome. */
function readCapacityWorkOutcome<T>(
  value: unknown,
): { status: "succeeded"; value: T } | { status: "failed"; error: unknown } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const status: unknown = record.status;
  if (status === "succeeded") {
    return Object.prototype.hasOwnProperty.call(record, "value") ? { status, value: record.value as T } : undefined;
  }
  if (status === "failed") {
    return Object.prototype.hasOwnProperty.call(record, "error") ? { status, error: record.error } : undefined;
  }
  return undefined;
}
