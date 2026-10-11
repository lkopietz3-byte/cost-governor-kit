/**
 * capacityLedger.ts — an in-memory CapacityReservationLedger for unit tests.
 *
 * `withCapacityReservation` and `withCapacityReservations` trust the ledger you
 * give them for the limit, the holds and the idempotency. This is a reference
 * implementation of that contract for tests: atomic within one JavaScript
 * process, nothing durable. It does not hold a cap across serverless
 * instances, processes or restarts.
 */
import { isBlank, isPlainRecord } from './internal.js';
/**
 * An in-memory ledger for tests. It follows the contract in
 * {@link CapacityReservationLedger}: `reserveCapacity` creates a hold only when
 * confirmed usage plus unexpired holds plus the request's `amount` (default 1)
 * is at most `limit`, answers `operation_in_progress` for a repeated unresolved
 * `(key, operationId)` and `operation_terminal` for a repeated settled one;
 * confirm and release are idempotent. A repeated confirm after a release, or a
 * release after a confirm, throws, because a settled hold must not flip.
 * Confirming with a settlement records `settlement.amount`, which may exceed
 * the hold; without one it records the hold's size.
 *
 * Expired holds stop counting but stay unresolved, as in the contract. The
 * reservation's `expiresAt` is built from `now()` and is checked by
 * `withCapacityReservation` against the real `Date.now()`, so inject a `now`
 * only when it tracks the real clock.
 */
export function createInMemoryCapacityLedger(options = {}) {
    if (!isPlainRecord(options))
        throw new TypeError('createInMemoryCapacityLedger: options must be a plain object');
    const holdMsRaw = options.holdMs;
    const nowFn = options.now;
    const holdMs = holdMsRaw === undefined ? 60_000 : holdMsRaw;
    if (typeof holdMs !== 'number' || !Number.isSafeInteger(holdMs) || holdMs < 1) {
        throw new RangeError('createInMemoryCapacityLedger: holdMs must be a safe integer >= 1');
    }
    if (nowFn !== undefined && typeof nowFn !== 'function') {
        throw new TypeError('createInMemoryCapacityLedger: now must be a function');
    }
    const clock = nowFn ?? Date.now;
    const confirmed = new Map();
    const holds = new Map(); // key -> operationId -> hold
    /** Run a synchronous step and return its result, or its throw, as a promise. */
    const atomic = (step) => new Promise((resolve) => resolve(step()));
    let nextId = 1;
    const heldAmount = (key, at) => {
        let total = 0;
        for (const hold of holds.get(key)?.values() ?? []) {
            if (hold.state === 'held' && hold.expiresAtMs > at)
                total += hold.amount;
        }
        return total;
    };
    const findHold = (reservation) => {
        const hold = holds.get(reservation.key)?.get(reservation.operationId);
        if (!hold || hold.reservation.id !== reservation.id) {
            throw new Error('createInMemoryCapacityLedger: unknown reservation');
        }
        return hold;
    };
    return {
        // Each method runs to completion in one synchronous step, so it is atomic in this process.
        reserveCapacity: (request) => atomic(() => {
            const { key, limit, operationId } = request;
            const amount = request.amount ?? 1;
            if (typeof key !== 'string' || isBlank(key) || typeof operationId !== 'string' || isBlank(operationId)) {
                throw new TypeError('createInMemoryCapacityLedger: key and operationId must be non-blank strings');
            }
            if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(amount) || amount < 1) {
                throw new RangeError('createInMemoryCapacityLedger: limit must be a safe integer >= 0 and amount a safe integer >= 1');
            }
            const existing = holds.get(key)?.get(operationId);
            if (existing) {
                return existing.state === 'held'
                    ? { status: 'operation_in_progress', reservation: existing.reservation }
                    : { status: 'operation_terminal', operationId, reason: existing.state };
            }
            const at = clock();
            if ((confirmed.get(key) ?? 0) + heldAmount(key, at) + amount > limit) {
                return { status: 'denied', reason: 'limit' };
            }
            const reservation = {
                id: `mem-${nextId++}`,
                key,
                operationId,
                expiresAt: new Date(at + holdMs).toISOString(),
            };
            let byOperation = holds.get(key);
            if (!byOperation)
                holds.set(key, (byOperation = new Map()));
            byOperation.set(operationId, { amount, expiresAtMs: at + holdMs, state: 'held', reservation });
            return { status: 'acquired', reservation };
        }),
        confirmReservation: (reservation, settlement) => atomic(() => {
            const hold = findHold(reservation);
            if (hold.state === 'confirmed')
                return; // idempotent
            if (hold.state === 'released')
                throw new Error('createInMemoryCapacityLedger: cannot confirm a released hold');
            hold.state = 'confirmed';
            confirmed.set(reservation.key, (confirmed.get(reservation.key) ?? 0) + (settlement ? settlement.amount : hold.amount));
        }),
        releaseReservation: (reservation) => atomic(() => {
            const hold = findHold(reservation);
            if (hold.state === 'released')
                return; // idempotent
            if (hold.state === 'confirmed')
                throw new Error('createInMemoryCapacityLedger: cannot release a confirmed hold');
            hold.state = 'released';
        }),
        usage: (key) => ({ confirmed: confirmed.get(key) ?? 0, held: heldAmount(key, clock()) }),
    };
}
