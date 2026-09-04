/**
 * reserveConfirm.ts — two database-agnostic usage-counting patterns.
 *
 * `withReserveConfirm` is source-compatible and keeps its useful failure
 * guarantee, but its read-only check cannot reserve capacity and is advisory
 * under concurrency. `withCapacityReservation` uses an adapter that atomically
 * reserves capacity before upstream work, then confirms or releases that hold.
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
 * DATABASE-AGNOSTIC BY DESIGN: this file defines only an interface
 * (`UsageLedger`/`CapacityReservationLedger`) and small orchestrators. It has
 * no Supabase, Postgres, or any other
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
 * Orchestrates the legacy check-then-commit pattern around any async call.
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
  // commitUsage is never reached. This preserves the legacy source-compatible
  // behavior, but it cannot prove whether a timeout reached a paid provider.
  // Re-running the read-only quota check is safe; retrying paid work is a
  // caller decision that requires provider reconciliation/idempotency.
  const result = await doTheCall();

  await ledger.commitUsage(key);

  return { allowed: true, result };
}

export type ReserveConfirmResult<T> =
  | { allowed: true; result: T }
  | { allowed: false; result?: undefined };

// ---------------------------------------------------------------------------
// Strict capacity reservation
// ---------------------------------------------------------------------------

/** One adapter-issued hold on capacity. Pass it back unchanged to the adapter. */
export interface CapacityReservation {
  id: string;
  key: string;
  /** Stable idempotency key for one logical upstream operation. */
  operationId: string;
  /** ISO-8601 expiry selected and enforced by the adapter. */
  expiresAt: string;
}

export interface ReserveCapacityRequest {
  key: string;
  /** Strict maximum for committed plus active reservations under this key. */
  limit: number;
  /** Reuse for recovery of this operation; never replace after an ambiguity. */
  operationId: string;
}

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
 * Storage contract for a strict concurrent capacity limit.
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
 * Reserve capacity before one classified upstream operation. Denied work is
 * never invoked. Known failed work releases the exact hold; success confirms.
 * Ambiguous work and confirmation failures keep the hold and never retry or
 * blindly release possibly paid work.
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
