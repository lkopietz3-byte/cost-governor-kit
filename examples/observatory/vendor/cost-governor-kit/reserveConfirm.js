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
import { describe, isBlank, isPlainRecord, parseIsoInstant } from './internal.js';
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
export async function withReserveConfirm(ledger, key, limit, doTheCall) {
    const underLimit = await ledger.checkUnderLimit(key, limit);
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
    }
    catch (commitError) {
        // The paid call already succeeded; only recording it failed afterward.
        // Return the result instead of discarding it — the usage count may now
        // be under-recorded, which the caller can detect via `commitError`.
        return { allowed: true, result, commitError };
    }
    return { allowed: true, result };
}
/**
 * Reserve capacity before one upstream operation, then confirm or release it.
 *
 * What this helper guarantees (given any adapter):
 * - It reads `request` once (its `limit`, `key` and `operationId`), validates
 *   that snapshot and throws, without calling the adapter, for a `request`
 *   that is not a plain or null-prototype object, a limit that is not a safe
 *   integer >= 0, a blank key/operationId (empty, or only whitespace and
 *   invisible characters), or an `amount` that is present but not a safe
 *   integer >= 1. The adapter receives a fresh
 *   `{ key, limit, operationId }` copy (plus `amount` only when it was given;
 *   see {@link CapacitySettlement}), and every later comparison uses the
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
 * - The reservation is copied once into a snapshot. `doTheWork` gets a frozen
 *   shallow copy of it (see {@link CapacityReservation}), and the snapshot is
 *   what `confirmReservation` or `releaseReservation` receives and what the
 *   result returns, so the callback cannot change which hold is confirmed.
 * - `{ status: 'succeeded' }` leads to one `confirmReservation` call;
 *   `{ status: 'failed' }` to one `releaseReservation` call. It never calls
 *   both, never calls either twice, and never retries.
 * - A thrown or rejected `doTheWork`, an outcome of the wrong shape, or an
 *   outcome whose fields throw when read (a hostile getter or proxy), returns
 *   `work_outcome_ambiguous` and keeps the hold. A failed confirm
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
 *   operationId, an `expiresAt` that is not a strict ISO-8601 timestamp with a zone, or is already expired, a terminal
 *   decision for a different operation, or an unknown decision status.
 */
export async function withCapacityReservation(ledger, request, doTheWork) {
    const { key, limit, operationId, amount } = readReserveCapacityRequest(request);
    const decision = await ledger.reserveCapacity(amount === undefined ? { key, limit, operationId } : { key, limit, operationId, amount });
    if (!decision || typeof decision !== 'object' || !('status' in decision)) {
        throw new TypeError("withCapacityReservation: adapter returned an invalid reservation decision");
    }
    const decisionRecord = decision;
    const status = decisionRecord.status;
    if (status === "denied") {
        const reason = decisionRecord.reason;
        return { status: "denied", reason };
    }
    if (status === "operation_in_progress") {
        const reservation = readReservation(decisionRecord.reservation, key, operationId, false);
        return { status: "operation_in_progress", reservation };
    }
    if (status === "operation_terminal") {
        const terminalOperationId = decisionRecord.operationId;
        const reason = decisionRecord.reason;
        if (terminalOperationId !== operationId) {
            throw new RangeError("withCapacityReservation: adapter terminal decision operationId does not match request");
        }
        return { status: "operation_terminal", operationId: terminalOperationId, reason };
    }
    if (status !== "acquired") {
        throw new RangeError(`withCapacityReservation: adapter returned unknown reservation decision status ${describe(status)}`);
    }
    const reservation = readReservation(decisionRecord.reservation, key, operationId);
    let parsed;
    let settlement;
    try {
        // The callback gets a frozen copy, so nothing it does can change the
        // snapshot that is confirmed or released below.
        const outcome = await doTheWork(Object.freeze({ ...reservation }));
        // Reading the outcome runs the caller's getters or proxy traps. Paid work
        // has already happened, so a throw here must be the documented ambiguous
        // result with the hold kept, never an exception that loses the reservation.
        parsed = readCapacityWorkOutcome(outcome, amount !== undefined);
        if (parsed?.status === "succeeded" && amount !== undefined) {
            settlement = readSettle(parsed.settle, amount);
        }
    }
    catch (error) {
        return { status: "work_outcome_ambiguous", reservation, error };
    }
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
        }
        catch (releaseError) {
            return { status: "release_failed", reservation, workError: parsed.error, releaseError };
        }
    }
    if (settlement === undefined) {
        try {
            await ledger.confirmReservation(reservation);
            return { status: "confirmed", reservation, value: parsed.value };
        }
        catch (error) {
            return { status: "confirmation_failed", reservation, value: parsed.value, error };
        }
    }
    // An actual amount above the hold is recorded as is (see readSettle); the
    // result also says by how much, and only when it happened.
    const overrun = settlement.amount > settlement.reservedAmount ? { overrunAmount: settlement.amount - settlement.reservedAmount } : {};
    try {
        await ledger.confirmReservation(reservation, settlement);
        return { status: "confirmed", reservation, value: parsed.value, settlement, ...overrun };
    }
    catch (error) {
        return { status: "confirmation_failed", reservation, value: parsed.value, error, settlement, ...overrun };
    }
}
/** Turn the work's `settle` report into what the adapter records. Throws (making the outcome ambiguous) on anything malformed. */
function readSettle(settle, reservedAmount) {
    if (settle === undefined) {
        return Object.freeze({ usage: "unknown", amount: reservedAmount, reservedAmount });
    }
    if (!isPlainRecord(settle)) {
        throw new TypeError("withCapacityReservation: outcome.settle must be { actualAmount } or { usage: 'unknown' }");
    }
    const keys = Reflect.ownKeys(settle);
    if (keys.length === 1 && keys[0] === "actualAmount") {
        const actualAmount = settle.actualAmount;
        if (typeof actualAmount !== "number" || !Number.isSafeInteger(actualAmount) || actualAmount < 0) {
            throw new RangeError("withCapacityReservation: outcome.settle.actualAmount must be a non-negative safe integer");
        }
        return Object.freeze({ usage: "reported", amount: actualAmount + 0, reservedAmount }); // -0 reads as 0
    }
    if (keys.length === 1 && keys[0] === "usage") {
        const usage = settle.usage;
        if (usage === "unknown") {
            return Object.freeze({ usage: "unknown", amount: reservedAmount, reservedAmount });
        }
    }
    throw new TypeError("withCapacityReservation: outcome.settle must be { actualAmount } or { usage: 'unknown' }");
}
/** Read the request once and validate what was read. Returns plain copies of the three fields. */
function readReserveCapacityRequest(request) {
    if (!isPlainRecord(request)) {
        throw new TypeError("withCapacityReservation: request must be an object with key, limit and operationId " +
            "(a plain object; not null, an array, a Map, a Date or a class instance)");
    }
    const limit = request.limit;
    const key = request.key;
    const operationId = request.operationId;
    const amount = request.amount;
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
    if (amount === undefined) {
        return { key, limit, operationId };
    }
    if (typeof amount !== "number") {
        throw new TypeError("withCapacityReservation: amount must be a safe integer >= 1 when present");
    }
    if (!Number.isSafeInteger(amount) || amount < 1) {
        throw new RangeError("withCapacityReservation: amount must be a safe integer >= 1 when present");
    }
    return { key, limit, operationId, amount };
}
const EXPIRES_AT_MESSAGE = "withCapacityReservation: reservation expiresAt must be a valid ISO-8601 timestamp with a time zone " +
    "(for example 2026-10-10T16:17:14.411Z or 2026-10-10T11:17:14.411-05:00); a timestamp without Z or an offset is rejected";
function readReservation(candidate, requestKey, requestOperationId, requireUnexpired = true) {
    if (!candidate || typeof candidate !== "object") {
        throw new TypeError("withCapacityReservation: adapter returned an invalid reservation");
    }
    const reservation = candidate;
    // One read of every own enumerable field (the spread), so the adapter's
    // extra fields survive and each getter runs once. A required field that is
    // not an own enumerable property (an inherited or non-enumerable accessor)
    // is read directly, once.
    const copy = { ...reservation };
    const field = (name) => (Object.hasOwn(copy, name) ? copy[name] : reservation[name]);
    const id = field("id");
    const key = field("key");
    const operationId = field("operationId");
    const expiresAt = field("expiresAt");
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
        throw new TypeError(EXPIRES_AT_MESSAGE);
    }
    // Strict, zone-required parse. `Date.parse` would read a string without a
    // zone as this machine's local time, so the same hold could look live or
    // expired depending on the server's TZ.
    const expiresAtMs = parseIsoInstant(expiresAt);
    if (expiresAtMs === undefined) {
        throw new RangeError(EXPIRES_AT_MESSAGE);
    }
    if (requireUnexpired && expiresAtMs <= Date.now()) {
        throw new RangeError("withCapacityReservation: adapter returned an expired reservation");
    }
    return { ...copy, id, key, operationId, expiresAt };
}
/** Read a work outcome once. Returns `undefined` for anything that is not a well-formed outcome. */
function readCapacityWorkOutcome(value, readSettleField = false) {
    if (!value || typeof value !== "object")
        return undefined;
    const record = value;
    const status = record.status;
    if (status === "succeeded") {
        if (!Object.prototype.hasOwnProperty.call(record, "value"))
            return undefined;
        const outcomeValue = record.value;
        // Read only for an `amount` request, so every other outcome is read exactly as before.
        const settle = readSettleField && Object.prototype.hasOwnProperty.call(record, "settle") ? record.settle : undefined;
        return { status, value: outcomeValue, settle };
    }
    if (status === "failed") {
        return Object.prototype.hasOwnProperty.call(record, "error") ? { status, error: record.error } : undefined;
    }
    return undefined;
}
/**
 * Wrap a commit (for example `commitUsage`) so it runs at most once, however
 * many times and however concurrently it is called. Made for counting a
 * streamed call on its FIRST visible output: call the returned function from
 * every chunk handler, and the usage is recorded exactly once, as soon as the
 * user has seen something.
 *
 * - The first call runs `fn` synchronously and returns a promise of its
 *   result. Every other call, concurrent or later, returns that same promise
 *   and never runs `fn` again.
 * - A failure is surfaced, not swallowed: if `fn` throws or rejects, the
 *   shared promise rejects with that error for every caller, including later
 *   ones, and `state` becomes `failed`.
 * - **A failed commit cannot be retried through the same instance.** `fn`
 *   runs at most once, ever. A commit can fail after its write landed (a lost
 *   reply), so retrying automatically could count the call twice. Decide in
 *   your own code whether to reconcile or create a new `createCommitOnce` for
 *   a deliberate retry.
 * - Await the returned promise to see a failure. The instance tracks `state`
 *   with its own handler, so a fire-and-forget call does not produce an
 *   unhandled rejection; it is not silent either, because `state` stays
 *   `failed` and every later call rejects with the same error.
 *
 * It keeps no timers and no global state; each call to `createCommitOnce`
 * makes an independent instance.
 *
 * @example
 *   const countOnce = createCommitOnce(() => ledger.commitUsage(`${userId}:${today}`));
 *   for await (const chunk of stream) {
 *     if (chunk.text) await countOnce(); // counted on first visible output, once
 *     write(chunk.text);
 *   }
 *   // countOnce.state === 'idle' here means nothing was shown and nothing was counted.
 *
 * @throws TypeError (synchronously, at creation) when `fn` is not a function.
 */
export function createCommitOnce(fn) {
    if (typeof fn !== "function") {
        throw new TypeError("createCommitOnce: fn must be a function");
    }
    let state = "idle";
    let shared;
    const commit = () => {
        if (shared)
            return shared;
        let resolveShared;
        let rejectShared;
        // Assign the shared promise before running fn, so a re-entrant call from
        // inside fn joins it instead of running fn a second time.
        shared = new Promise((resolve, reject) => {
            resolveShared = resolve;
            rejectShared = reject;
        });
        state = "pending";
        const settled = shared.then(() => {
            state = "committed";
        }, () => {
            state = "failed";
        });
        void settled;
        try {
            resolveShared(fn());
        }
        catch (error) {
            rejectShared(error);
        }
        return shared;
    };
    const attempt = () => {
        const ran = shared === undefined; // true only for the call that is about to run fn
        return commit().then((value) => ({ ran, status: "committed", value }), (error) => ({ ran, status: "failed", error }));
    };
    Object.defineProperty(commit, "state", { get: () => state, enumerable: true });
    Object.defineProperty(commit, "attempt", { value: attempt, enumerable: true });
    return commit;
}
const MAX_RESERVATION_SCOPES = 8;
/**
 * Reserve the same amount on several scopes, run paid work once, and settle
 * every scope: the daily-dollars-per-user-and-global pattern.
 *
 * It is {@link withCapacityReservation} nested once per scope, in request
 * order, so everything that function guarantees holds for each scope: work runs
 * at most once and only after EVERY scope gave a hold; it never retries; a
 * thrown or malformed outcome keeps every hold; confirm and release are each
 * called at most once per scope. What it adds is the bookkeeping nobody should
 * hand-write:
 *
 * - If a later scope refuses, the holds already taken are released (no paid
 *   work ran), and the result names the refusing scope.
 * - If the work fails (`failed`), every hold is released.
 * - If the work succeeds, every scope is confirmed with the same settlement:
 *   the reported `actualAmount`, or the full estimate for `{ usage: 'unknown' }`
 *   (a missing `settle` means unknown). An actual above the hold is recorded as
 *   is and reported as `overrunAmount`.
 * - Anything unresolved (ambiguous work, a failed confirm, a failed release)
 *   returns `needs_reconciliation` with the scope's own result, and the holds
 *   stay in place.
 *
 * Holds are taken one ledger round trip per scope, so this is not atomic across
 * scopes: a refusal on the second scope briefly held capacity on the first.
 * That errs toward refusing, never toward overspending.
 *
 * Invalid input (no scopes, more than 8, duplicate or blank keys, a bad limit
 * or amount) throws before the ledger is called. A ledger that rejects on the
 * first scope propagates the rejection, with no work run; on a later scope the
 * earlier holds are kept and the result is `needs_reconciliation`.
 *
 * `doTheWork` receives a frozen array of the holds, in request order.
 */
export async function withCapacityReservations(ledger, request, doTheWork) {
    const fn = 'withCapacityReservations';
    if (!isPlainRecord(request)) {
        throw new TypeError(`${fn}: request must be an object with scopes, operationId and amount (a plain object)`);
    }
    const rawScopes = request.scopes;
    const operationId = request.operationId;
    const amount = request.amount;
    if (!Array.isArray(rawScopes)) {
        throw new TypeError(`${fn}: scopes must be an array of { key, limit }`);
    }
    const count = rawScopes.length;
    if (count < 1 || count > MAX_RESERVATION_SCOPES) {
        throw new RangeError(`${fn}: scopes must have between 1 and ${MAX_RESERVATION_SCOPES} entries`);
    }
    if (amount === undefined) {
        throw new TypeError(`${fn}: amount is required: a safe integer >= 1`);
    }
    const scopes = [];
    const seen = new Set();
    for (let i = 0; i < count; i++) {
        const scope = rawScopes[i];
        if (!isPlainRecord(scope)) {
            throw new TypeError(`${fn}: scopes[${i}] must be a plain { key, limit } object`);
        }
        const read = readReserveCapacityRequest({
            key: scope.key,
            limit: scope.limit,
            operationId: operationId,
            amount: amount,
        });
        if (seen.has(read.key)) {
            throw new RangeError(`${fn}: scopes must have distinct keys`);
        }
        seen.add(read.key);
        scopes.push({ key: read.key, limit: read.limit, operationId: read.operationId, amount: read.amount });
    }
    if (typeof doTheWork !== 'function') {
        throw new TypeError(`${fn}: doTheWork must be a function`);
    }
    const held = [];
    async function level(i) {
        const scope = scopes[i];
        let deeperProblem;
        const result = await withCapacityReservation(ledger, scope, async (reservation) => {
            held[i] = reservation;
            let inner;
            if (i + 1 < scopes.length) {
                inner = await level(i + 1);
            }
            else {
                // The innermost level runs the paid work. The outcome is read once here;
                // a throw, a getter that throws or a malformed outcome keeps every hold.
                const outcome = await doTheWork(Object.freeze([...held]));
                inner = { kind: 'done', outcome: readScopedOutcome(outcome) };
            }
            switch (inner.kind) {
                case 'done':
                    return inner.outcome.status === 'succeeded'
                        ? { status: 'succeeded', value: inner, settle: inner.outcome.settle }
                        : { status: 'failed', error: inner };
                case 'confirmed':
                    return { status: 'succeeded', value: inner, settle: settleOf(inner.settlement) };
                case 'refused':
                case 'failed':
                    return { status: 'failed', error: inner };
                case 'problem':
                    deeperProblem = inner;
                    throw new Error(`${fn}: a deeper scope needs reconciliation, so this hold is kept`);
            }
        });
        switch (result.status) {
            case 'denied':
                return { kind: 'refused', refusal: 'denied', scopeKey: scope.key, ...(result.reason === undefined ? {} : { reason: result.reason }) };
            case 'operation_in_progress':
                return { kind: 'refused', refusal: 'operation_in_progress', scopeKey: scope.key };
            case 'operation_terminal':
                return { kind: 'refused', refusal: 'operation_terminal', scopeKey: scope.key, ...(result.reason === undefined ? {} : { reason: result.reason }) };
            case 'confirmed': {
                const inner = result.value;
                const value = inner.kind === 'done' ? inner.outcome.value : inner.value;
                return {
                    kind: 'confirmed',
                    value,
                    settlement: result.settlement,
                    ...(result.overrunAmount === undefined ? {} : { overrunAmount: result.overrunAmount }),
                };
            }
            case 'released_after_failure': {
                const inner = result.error;
                if (inner.kind === 'done')
                    return { kind: 'failed', error: inner.outcome.error };
                return inner; // refused or failed, from a deeper scope
            }
            case 'work_outcome_ambiguous':
                return deeperProblem ?? { kind: 'problem', scopeKey: scope.key, result };
            case 'release_failed':
            case 'confirmation_failed':
                return { kind: 'problem', scopeKey: scope.key, result };
        }
    }
    const top = await level(0);
    switch (top.kind) {
        case 'confirmed':
            return {
                status: 'confirmed',
                value: top.value,
                settlement: top.settlement,
                ...(top.overrunAmount === undefined ? {} : { overrunAmount: top.overrunAmount }),
                reservations: Object.freeze([...held]),
            };
        case 'refused':
            return { status: 'refused', refusal: top.refusal, scopeKey: top.scopeKey, ...(top.reason === undefined ? {} : { reason: top.reason }) };
        case 'failed':
            return { status: 'released_after_failure', error: top.error };
        case 'problem':
            return { status: 'needs_reconciliation', scopeKey: top.scopeKey, result: top.result };
        case 'done':
            // Unreachable: level() never returns 'done'. Fail closed if it ever does.
            throw new Error(`${fn}: internal error: unresolved work outcome`);
    }
}
/** Settle value that records the same amount a confirmed scope recorded. */
function settleOf(settlement) {
    return settlement.usage === 'reported' ? { actualAmount: settlement.amount } : { usage: 'unknown' };
}
/** Read the paid work's outcome once. Throws (keeping every hold) on anything malformed. */
function readScopedOutcome(outcome) {
    const parsed = readCapacityWorkOutcome(outcome, true);
    if (!parsed) {
        throw new Error('withCapacityReservations: doTheWork returned an invalid outcome');
    }
    return parsed.status === 'succeeded'
        ? { status: 'succeeded', value: parsed.value, settle: parsed.settle }
        : { status: 'failed', error: parsed.error };
}
