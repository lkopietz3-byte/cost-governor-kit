// Strict NodeNext type probe. scripts/verify-package.mjs compiles this against
// the installed tarball's declarations with --strict and --skipLibCheck false.
// Ported from the package probe in this repo's history and extended.
import {
  checkPreCallCeiling,
  estimateCostUsd,
  getRatesOrThrow,
  withCapacityReservation,
  withReserveConfirm,
  type CapacityReservationResult,
  type ModelRates,
  type PricingTable,
  type UsageLedger,
  type UsageTokens,
} from 'cost-governor-kit';
import {
  CACHE_READ_MULTIPLIER,
  estimateCostUsd as pricingSubpath,
  formatRatesForLog,
  type ModelRates as SubpathRates,
  type UsageTokens as SubpathUsage,
} from 'cost-governor-kit/pricing';
import {
  checkPreCallCeiling as ceilingSubpath,
  type PreCallCeilingCheck,
  type PreCallCeilingResult,
} from 'cost-governor-kit/preCallCeiling';
import {
  withCapacityReservation as reservationSubpath,
  type CapacityReservation,
  type CapacityReservationLedger,
  type CapacityWorkOutcome,
  type ReserveCapacityRequest,
  type ReserveCapacityResult,
  type ReserveConfirmResult,
} from 'cost-governor-kit/reserveConfirm';

const table: PricingTable = { 'toy-model': { inputPerMillion: 3, outputPerMillion: 15 } };
const rates: ModelRates = getRatesOrThrow(table, 'toy-model');
const usage: UsageTokens = { inputTokens: 1000, cacheCreation1hTokens: 10 };
const cost: number = estimateCostUsd(rates, usage);
const multiplier: number = CACHE_READ_MULTIPLIER;
const logLine: string = formatRatesForLog(rates);

// @ts-expect-error snake_case provider fields are not UsageTokens.
estimateCostUsd(rates, { input_tokens: 1000 });

const allowed: boolean = checkPreCallCeiling({ rates, estimatedNextCallUsage: usage, spentSoFarUsd: cost, ceilingUsd: 1 }).allowed;
const subpathRates: SubpathRates = rates;
const subpathUsage: SubpathUsage = usage;
const subpathCost: number = pricingSubpath(subpathRates, subpathUsage);
const subpathCheck: PreCallCeilingCheck = { rates: subpathRates, estimatedNextCallUsage: subpathUsage, spentSoFarUsd: subpathCost, ceilingUsd: 1 };
const subpathResult: PreCallCeilingResult = ceilingSubpath(subpathCheck);
const reason: string | undefined = subpathResult.reason;

// @ts-expect-error rates are required; there is no default.
checkPreCallCeiling({ estimatedNextCallUsage: usage, spentSoFarUsd: 0, ceilingUsd: 1 });

const request: ReserveCapacityRequest = { key: 'consumer', limit: 1, operationId: 'synthetic-operation' };
const ledger: CapacityReservationLedger = {
  reserveCapacity: async (): Promise<ReserveCapacityResult> => ({ status: 'denied' }),
  confirmReservation: async (_reservation: CapacityReservation) => undefined,
  releaseReservation: async (_reservation: CapacityReservation) => undefined,
};

async function strict(): Promise<string> {
  const work = async (reservation: CapacityReservation): Promise<CapacityWorkOutcome<{ id: string }>> => ({
    status: 'succeeded',
    value: { id: reservation.operationId },
  });
  const result: CapacityReservationResult<{ id: string }> = await withCapacityReservation(ledger, request, work);
  switch (result.status) {
    case 'confirmed':
      return result.value.id;
    case 'confirmation_failed':
      return `${result.reservation.id} ${result.value.id}`;
    case 'release_failed':
      return String(result.releaseError);
    case 'denied':
      return result.reason ?? 'denied';
    case 'operation_terminal':
      return result.operationId;
    case 'operation_in_progress':
    case 'released_after_failure':
    case 'work_outcome_ambiguous':
      return result.reservation.expiresAt;
  }
}

async function advisory(): Promise<number | undefined> {
  const usageLedger: UsageLedger = {
    checkUnderLimit: async (_key: string, limit: number) => limit > 0,
    commitUsage: async (_key: string) => undefined,
  };
  const outcome: ReserveConfirmResult<number> = await withReserveConfirm(usageLedger, 'consumer', 1, async () => 7);
  return outcome.allowed ? outcome.result : outcome.result;
}

void reservationSubpath;
void [strict, advisory, allowed, multiplier, logLine, reason];
