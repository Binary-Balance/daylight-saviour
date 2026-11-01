import { ManagedIdentityCredential } from '@azure/identity';
import { odata, TableClient } from '@azure/data-tables';
import { canonicalAustralianZoneId } from '@daylight-saviour/domain/australian-zone-runtime';

import {
  hashOpaqueValue,
  opaqueRandomValue,
  operationalRetentionMs,
} from './reminder-subscriptions.ts';

export const reminderDispatchLedgerTableName = 'ReminderDispatchLedger';
const ledgerPartitionPrefix = 'reminder-dispatch-v1-';
const tableMutationRetryLimit = 12;
const defaultClaimLeaseMs = 60_000;
const maxClaimLeaseMs = 60 * 60 * 1_000;
const unsettledPageSize = 100;
// Shorter than any real installation ID, so a sweep marker takes a storage key
// no delivery can have, and keeps the ledger's retention and purge.
const sweepInstallationId = 'zone-sweep';

export type ReminderDispatchStatus =
  | 'pending'
  | 'claimed'
  | 'accepted'
  | 'transient-failure'
  | 'permanent-failure'
  | 'expired'
  | 'uncertain';

export type ReminderDispatchTiming = 'one-week' | 'one-day';

export interface ReminderDispatchIdentity {
  readonly changeEventAt: string;
  readonly homeTimeZone: string;
  readonly installationId: string;
  readonly timing: ReminderDispatchTiming;
}

/** The zone, Change Event and timing that one Delivery Window belongs to. */
export type ReminderDispatchWindow = Omit<
  ReminderDispatchIdentity,
  'installationId'
>;

export type ReminderDispatchWindowReport = 'not-swept' | 'sweep-incomplete';

export type ReminderDispatchExpiryReason =
  | 'event'
  | 'pack'
  | 'superseded'
  | 'window';

export type ReminderDispatchCleanupStatus =
  | 'failed'
  | 'not-found'
  | 'pending'
  | 'removed'
  | 'token-replaced';

export interface ReminderDispatchLedgerRecord extends ReminderDispatchIdentity {
  readonly attemptGeneration: number;
  readonly createdAt: Date;
  readonly deliveryWindowEndsAt: Date;
  readonly deliveryWindowStartsAt: Date;
  readonly etag: string;
  readonly packValidUntil: Date;
  readonly status: ReminderDispatchStatus;
  readonly updatedAt: Date;
  readonly claimExpiresAt?: Date;
  readonly claimId?: string;
  readonly cleanupStatus?: ReminderDispatchCleanupStatus;
  readonly expiryReason?: ReminderDispatchExpiryReason;
  readonly invalidatedAt?: Date;
  readonly lastClaimId?: string;
  readonly sendStartedAt?: Date;
}

export interface ReminderDispatchPreparation extends ReminderDispatchIdentity {
  readonly attemptGeneration: number;
  readonly deliveryWindowEndsAt: Date;
  readonly deliveryWindowStartsAt: Date;
  readonly now: Date;
  readonly packValidUntil: Date;
}

export interface ReminderDispatchClaim extends ReminderDispatchIdentity {
  readonly attemptGeneration: number;
  readonly claimExpiresAt: Date;
  readonly claimId: string;
}

export type ReminderDispatchCompletionOutcome =
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'permanent-failure';
      readonly invalidToken: boolean;
      readonly invalidatedAt?: Date;
    }
  | { readonly kind: 'transient-failure' }
  | { readonly kind: 'uncertain' };

export type ReminderDispatchCompletionResult =
  | {
      readonly kind: 'stale';
      readonly record?: ReminderDispatchLedgerRecord | undefined;
    }
  | { readonly kind: 'updated'; readonly record: ReminderDispatchLedgerRecord };

export type ReminderDispatchMutationResult =
  | {
      readonly kind: 'stale';
      readonly record?: ReminderDispatchLedgerRecord | undefined;
    }
  | { readonly kind: 'updated'; readonly record: ReminderDispatchLedgerRecord };

/** The adapter is deliberately tiny so deterministic tests do not need Azure. */
export interface ReminderDispatchLedgerTable {
  readonly create: (entity: Record<string, unknown>) => Promise<void>;
  readonly delete: (
    partitionKey: string,
    rowKey: string,
    etag: string,
  ) => Promise<void>;
  readonly get: (
    partitionKey: string,
    rowKey: string,
  ) => Promise<Record<string, unknown>>;
  readonly listUnsettledPages: (
    now: Date,
  ) => AsyncIterable<readonly Record<string, unknown>[]>;
  readonly listUpdatedBefore: (
    cutoff: Date,
  ) => AsyncIterable<Record<string, unknown>>;
  readonly replace: (
    entity: Record<string, unknown>,
    etag: string,
  ) => Promise<void>;
}

export interface ReminderDispatchLedgerStore {
  readonly claim: (
    identity: ReminderDispatchIdentity,
    now: Date,
    leaseMs?: number,
  ) => Promise<ReminderDispatchClaim | null>;
  readonly complete: (
    claim: ReminderDispatchClaim,
    outcome: ReminderDispatchCompletionOutcome,
    now: Date,
  ) => Promise<ReminderDispatchCompletionResult>;
  readonly get: (
    identity: ReminderDispatchIdentity,
  ) => Promise<ReminderDispatchLedgerRecord | null>;
  readonly invalidate: (
    identity: ReminderDispatchIdentity,
    attemptGeneration: number,
    now: Date,
  ) => Promise<ReminderDispatchMutationResult>;
  readonly prepare: (
    preparation: ReminderDispatchPreparation,
  ) => Promise<ReminderDispatchLedgerRecord>;
  /**
   * Yields bounded pages of records no later dispatch will reach: those left
   * open after their Delivery Window, and rejected tokens still to clean up.
   * A row that cannot be read is skipped and passed to `onInvalidRow`.
   */
  readonly listUnsettledPages: (
    now: Date,
    onInvalidRow: () => void,
  ) => AsyncIterable<readonly ReminderDispatchLedgerRecord[]>;
  /**
   * Deletes, in one pass, records last updated more than 30 days ago whose
   * Change Event has passed, or cannot be read. Returns how many rows it left
   * because it could not date or key them.
   */
  readonly purgeExpired: (now: Date) => Promise<number>;
  /**
   * Records a finished sweep of a zone. One sweep that reached the last page
   * completes the window, whatever the other sweeps did.
   */
  readonly recordSweep: (
    window: ReminderDispatchWindow,
    reachedLastPage: boolean,
    now: Date,
  ) => Promise<void>;
  /**
   * Says, to at most one run, what stopped a closed window being fully swept.
   * The report is marked before the caller logs it, so a run killed between
   * the two loses the event.
   */
  readonly reportClosedWindow: (
    window: ReminderDispatchWindow,
    now: Date,
  ) => Promise<ReminderDispatchWindowReport | null>;
  readonly release: (
    claim: ReminderDispatchClaim,
    now: Date,
  ) => Promise<ReminderDispatchMutationResult>;
  readonly beginSend: (
    claim: ReminderDispatchClaim,
    now: Date,
  ) => Promise<ReminderDispatchMutationResult>;
  /**
   * Reverts a durable send intent when this worker has not invoked the
   * provider yet. Recovery after a process crash still treats sendStartedAt
   * as uncertain; only the owning live operation may use this boundary.
   */
  readonly cancelBeforeProvider: (
    claim: ReminderDispatchClaim,
    now: Date,
  ) => Promise<ReminderDispatchMutationResult>;
  readonly updateCleanup: (
    identity: ReminderDispatchIdentity,
    attemptGeneration: number,
    status: ReminderDispatchCleanupStatus,
    now: Date,
  ) => Promise<ReminderDispatchMutationResult>;
}

export function reminderDispatchStorageKey(
  identity: ReminderDispatchIdentity,
): { readonly partitionKey: string; readonly rowKey: string } {
  const normalized = normalizeIdentity(identity);
  return {
    partitionKey: `${ledgerPartitionPrefix}${hashOpaqueValue(normalized.homeTimeZone)}`,
    rowKey: hashOpaqueValue(
      [
        'daylight-saviour:reminder-dispatch:v1',
        normalized.installationId,
        normalized.homeTimeZone,
        normalized.changeEventAt,
        normalized.timing,
      ].join(':'),
    ),
  };
}

function sweepStorageKey(window: ReminderDispatchWindow) {
  return reminderDispatchStorageKey({
    ...window,
    installationId: sweepInstallationId,
  });
}

function sweepEntity(
  window: ReminderDispatchWindow,
  sweep: 'complete' | 'incomplete' | 'reported',
  updatedAt: Date,
) {
  return {
    ...sweepStorageKey(window),
    changeEventAt: window.changeEventAt,
    homeTimeZone: window.homeTimeZone,
    sweep,
    timing: window.timing,
    updatedAt,
  };
}

function statusCode(error: unknown) {
  if (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
  ) {
    return error.statusCode;
  }
  return undefined;
}

function conflict(error: unknown) {
  const status = statusCode(error);
  return status === 409 || status === 412;
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid reminder dispatch ${name}`);
  }
  return value;
}

function instant(value: unknown, name: string) {
  const text = requiredString(value, name);
  const milliseconds = Date.parse(text);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== text
  ) {
    throw new Error(`Invalid reminder dispatch ${name}`);
  }
  return new Date(milliseconds);
}

function dateValue(value: unknown, name: string) {
  const result =
    value instanceof Date ? new Date(value.getTime()) : instant(value, name);
  if (!Number.isFinite(result.getTime())) {
    throw new Error(`Invalid reminder dispatch ${name}`);
  }
  return result;
}

function normalizeIdentity(identity: ReminderDispatchIdentity) {
  if (
    typeof identity.installationId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(identity.installationId)
  ) {
    throw new Error('Invalid reminder dispatch installation ID');
  }
  if (
    canonicalAustralianZoneId(identity.homeTimeZone) !== identity.homeTimeZone
  ) {
    throw new Error('Invalid reminder dispatch Home Time Zone');
  }
  const changeEventAt = instant(identity.changeEventAt, 'Change Event instant');
  if (identity.timing !== 'one-week' && identity.timing !== 'one-day') {
    throw new Error('Invalid reminder dispatch timing');
  }
  return {
    changeEventAt: changeEventAt.toISOString(),
    homeTimeZone: identity.homeTimeZone,
    installationId: identity.installationId,
    timing: identity.timing,
  } as const;
}

function validStatus(value: unknown): value is ReminderDispatchStatus {
  return (
    value === 'pending' ||
    value === 'claimed' ||
    value === 'accepted' ||
    value === 'transient-failure' ||
    value === 'permanent-failure' ||
    value === 'expired' ||
    value === 'uncertain'
  );
}

function validCleanupStatus(
  value: unknown,
): value is ReminderDispatchCleanupStatus {
  return (
    value === 'failed' ||
    value === 'not-found' ||
    value === 'pending' ||
    value === 'removed' ||
    value === 'token-replaced'
  );
}

function validExpiryReason(
  value: unknown,
): value is ReminderDispatchExpiryReason {
  return (
    value === 'event' ||
    value === 'pack' ||
    value === 'superseded' ||
    value === 'window'
  );
}

function recordFromEntity(entity: Record<string, unknown>) {
  const identity = normalizeIdentity({
    changeEventAt: requiredString(entity.changeEventAt, 'Change Event instant'),
    homeTimeZone: requiredString(entity.homeTimeZone, 'Home Time Zone'),
    installationId: requiredString(entity.installationId, 'installation ID'),
    timing: entity.timing as ReminderDispatchTiming,
  });
  if (!validStatus(entity.status)) {
    throw new Error('Invalid reminder dispatch status');
  }
  if (
    typeof entity.attemptGeneration !== 'number' ||
    !Number.isSafeInteger(entity.attemptGeneration) ||
    entity.attemptGeneration < 1
  ) {
    throw new Error('Invalid reminder dispatch generation');
  }
  const etag = requiredString(entity.etag, 'ETag');
  const createdAt = dateValue(entity.createdAt, 'createdAt');
  const deliveryWindowStartsAt = dateValue(
    entity.deliveryWindowStartsAt,
    'delivery window start',
  );
  const deliveryWindowEndsAt = dateValue(
    entity.deliveryWindowEndsAt,
    'delivery window end',
  );
  const packValidUntil = dateValue(
    entity.packValidUntil,
    'pack Validity Horizon',
  );
  const updatedAt = dateValue(entity.updatedAt, 'updatedAt');
  if (deliveryWindowEndsAt.getTime() < deliveryWindowStartsAt.getTime()) {
    throw new Error('Invalid reminder dispatch delivery window');
  }

  const result = {
    ...identity,
    attemptGeneration: entity.attemptGeneration,
    createdAt,
    deliveryWindowEndsAt,
    deliveryWindowStartsAt,
    etag,
    packValidUntil,
    status: entity.status,
    updatedAt,
    ...(entity.claimExpiresAt === undefined
      ? {}
      : { claimExpiresAt: dateValue(entity.claimExpiresAt, 'claim expiry') }),
    ...(entity.claimId === undefined
      ? {}
      : { claimId: requiredString(entity.claimId, 'claim ID') }),
    ...(entity.cleanupStatus === undefined
      ? {}
      : validCleanupStatus(entity.cleanupStatus)
        ? { cleanupStatus: entity.cleanupStatus }
        : (() => {
            throw new Error('Invalid reminder dispatch cleanup status');
          })()),
    ...(entity.expiryReason === undefined
      ? {}
      : validExpiryReason(entity.expiryReason)
        ? { expiryReason: entity.expiryReason }
        : (() => {
            throw new Error('Invalid reminder dispatch expiry reason');
          })()),
    ...(entity.invalidatedAt === undefined
      ? {}
      : {
          invalidatedAt: dateValue(
            entity.invalidatedAt,
            'provider invalidation',
          ),
        }),
    ...(entity.lastClaimId === undefined
      ? {}
      : { lastClaimId: requiredString(entity.lastClaimId, 'last claim ID') }),
    ...(entity.sendStartedAt === undefined
      ? {}
      : { sendStartedAt: dateValue(entity.sendStartedAt, 'send start') }),
  };
  return result satisfies ReminderDispatchLedgerRecord;
}

function entityFromRecord(
  record: Omit<ReminderDispatchLedgerRecord, 'etag'>,
  key: { readonly partitionKey: string; readonly rowKey: string },
) {
  return {
    partitionKey: key.partitionKey,
    rowKey: key.rowKey,
    installationId: record.installationId,
    homeTimeZone: record.homeTimeZone,
    changeEventAt: record.changeEventAt,
    timing: record.timing,
    attemptGeneration: record.attemptGeneration,
    deliveryWindowStartsAt: record.deliveryWindowStartsAt,
    deliveryWindowEndsAt: record.deliveryWindowEndsAt,
    packValidUntil: record.packValidUntil,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.claimExpiresAt === undefined
      ? {}
      : { claimExpiresAt: record.claimExpiresAt }),
    ...(record.claimId === undefined ? {} : { claimId: record.claimId }),
    ...(record.cleanupStatus === undefined
      ? {}
      : { cleanupStatus: record.cleanupStatus }),
    ...(record.expiryReason === undefined
      ? {}
      : { expiryReason: record.expiryReason }),
    ...(record.invalidatedAt === undefined
      ? {}
      : { invalidatedAt: record.invalidatedAt }),
    ...(record.lastClaimId === undefined
      ? {}
      : { lastClaimId: record.lastClaimId }),
    ...(record.sendStartedAt === undefined
      ? {}
      : { sendStartedAt: record.sendStartedAt }),
  } satisfies Record<string, unknown>;
}

function withoutClaim(record: ReminderDispatchLedgerRecord) {
  const {
    claimExpiresAt: _claimExpiresAt,
    claimId: _claimId,
    sendStartedAt: _sendStartedAt,
    ...base
  } = record;
  return base;
}

function uncertainRecord(
  record: ReminderDispatchLedgerRecord,
  updatedAt: Date,
) {
  return {
    ...withoutClaim(record),
    ...(record.claimId === undefined ? {} : { lastClaimId: record.claimId }),
    status: 'uncertain' as const,
    updatedAt,
  };
}

function pendingRecord(record: ReminderDispatchLedgerRecord, updatedAt: Date) {
  return { ...withoutClaim(record), status: 'pending' as const, updatedAt };
}

function expiredRecord(
  record: ReminderDispatchLedgerRecord,
  expiryReason: ReminderDispatchExpiryReason,
  updatedAt: Date,
) {
  return {
    ...withoutClaim(record),
    expiryReason,
    status: 'expired' as const,
    updatedAt,
  };
}

/** Frees a claim: pending again, or uncertain once a send may have started. */
function releasedRecord(record: ReminderDispatchLedgerRecord, updatedAt: Date) {
  return record.sendStartedAt === undefined
    ? pendingRecord(record, updatedAt)
    : uncertainRecord(record, updatedAt);
}

function nowDate(value: Date) {
  const result = new Date(value.getTime());
  if (!Number.isFinite(result.getTime()))
    throw new Error('Invalid reminder dispatch clock');
  return result;
}

function optionalDate(value: unknown, name: string) {
  if (value === undefined) return undefined;
  if (!(value instanceof Date))
    throw new Error(`Invalid reminder dispatch ${name}`);
  return nowDate(value);
}

function sameIdentity(
  left: ReminderDispatchIdentity,
  right: ReminderDispatchIdentity,
) {
  return (
    left.installationId === right.installationId &&
    left.homeTimeZone === right.homeTimeZone &&
    left.changeEventAt === right.changeEventAt &&
    left.timing === right.timing
  );
}

function holdsClaim(
  record: ReminderDispatchLedgerRecord,
  claim: ReminderDispatchClaim,
) {
  return (
    record.status === 'claimed' &&
    record.claimId === claim.claimId &&
    record.attemptGeneration === claim.attemptGeneration
  );
}

function stale(record: ReminderDispatchLedgerRecord | null) {
  return { kind: 'stale' as const, record: record ?? undefined };
}

function expiryReasonAt(
  record: ReminderDispatchLedgerRecord,
  nowMilliseconds: number,
): ReminderDispatchExpiryReason | undefined {
  if (nowMilliseconds >= Date.parse(record.changeEventAt)) return 'event';
  if (nowMilliseconds > record.deliveryWindowEndsAt.getTime()) return 'window';
  if (nowMilliseconds > record.packValidUntil.getTime()) return 'pack';
  return undefined;
}

function terminalStatus(status: ReminderDispatchStatus) {
  return (
    status === 'accepted' ||
    status === 'permanent-failure' ||
    status === 'uncertain' ||
    status === 'expired'
  );
}

function cleanupSettled(status: ReminderDispatchCleanupStatus | undefined) {
  return (
    status === 'removed' ||
    status === 'not-found' ||
    status === 'token-replaced'
  );
}

function terminalExpiryCanReset(record: ReminderDispatchLedgerRecord) {
  return record.status === 'expired' && record.expiryReason === 'superseded';
}

function packExpiryCanReset(
  record: ReminderDispatchLedgerRecord,
  packValidUntil: Date,
  now: Date,
) {
  return (
    record.status === 'expired' &&
    record.expiryReason === 'pack' &&
    packValidUntil.getTime() >= now.getTime()
  );
}

function preparedRecord(preparation: ReminderDispatchPreparation) {
  const identity = normalizeIdentity(preparation);
  const now = nowDate(preparation.now);
  const startsAt = nowDate(preparation.deliveryWindowStartsAt);
  const endsAt = nowDate(preparation.deliveryWindowEndsAt);
  const packValidUntil = nowDate(preparation.packValidUntil);
  if (
    !Number.isSafeInteger(preparation.attemptGeneration) ||
    preparation.attemptGeneration < 1 ||
    endsAt.getTime() < startsAt.getTime()
  ) {
    throw new Error('Invalid reminder dispatch preparation');
  }
  return {
    ...identity,
    attemptGeneration: preparation.attemptGeneration,
    createdAt: now,
    deliveryWindowEndsAt: endsAt,
    deliveryWindowStartsAt: startsAt,
    packValidUntil,
    status: 'pending' as const,
    updatedAt: now,
  };
}

/**
 * The record that replaces `existing` for a preparation, or null when
 * `existing` stands. A newer registration restarts the delivery unless it
 * was accepted, is uncertain or expired for good, and a claim that may have
 * sent becomes uncertain instead. The same registration only refreshes a
 * delivery that can still be retried, and an older one never overwrites a
 * newer.
 */
function preparedReplacement(
  existing: ReminderDispatchLedgerRecord,
  base: ReturnType<typeof preparedRecord>,
) {
  const resettableExpiry =
    terminalExpiryCanReset(existing) ||
    packExpiryCanReset(existing, base.packValidUntil, base.updatedAt);
  if (existing.attemptGeneration > base.attemptGeneration) return null;
  if (existing.attemptGeneration === base.attemptGeneration) {
    const canRefresh =
      existing.status === 'transient-failure' ||
      existing.status === 'pending' ||
      resettableExpiry;
    return canRefresh ? { ...base, createdAt: existing.createdAt } : null;
  }
  if (
    existing.status === 'accepted' ||
    existing.status === 'uncertain' ||
    (existing.status === 'expired' && !resettableExpiry)
  ) {
    return null;
  }
  return existing.status === 'claimed' && existing.sendStartedAt !== undefined
    ? uncertainRecord(existing, base.updatedAt)
    : base;
}

/**
 * What invalidation leaves: uncertain if a send may have started, otherwise
 * expired as superseded.
 */
function supersededRecord(record: ReminderDispatchLedgerRecord, now: Date) {
  return record.status === 'claimed' && record.sendStartedAt !== undefined
    ? uncertainRecord(record, now)
    : expiredRecord(record, 'superseded', now);
}

function leaseLapsed(record: ReminderDispatchLedgerRecord, now: Date) {
  const claimExpiresAt = record.claimExpiresAt?.getTime();
  return claimExpiresAt === undefined || claimExpiresAt <= now.getTime();
}

/**
 * What must be written before a claim can be decided: a lapsed claim freed,
 * or a delivery whose time is up expired. Undefined when neither applies.
 */
function settlementBeforeClaim(
  existing: ReminderDispatchLedgerRecord,
  now: Date,
) {
  if (existing.status === 'claimed') {
    return leaseLapsed(existing, now)
      ? releasedRecord(existing, now)
      : undefined;
  }
  const expiryReason = expiryReasonAt(existing, now.getTime());
  return expiryReason === undefined
    ? undefined
    : expiredRecord(existing, expiryReason, now);
}

/**
 * What a claim that cannot send is restored to: expired once its time is up,
 * or pending when its Delivery Window has not opened. Undefined when it can.
 */
function unsendableRecord(existing: ReminderDispatchLedgerRecord, now: Date) {
  const expiryReason = expiryReasonAt(existing, now.getTime());
  if (expiryReason !== undefined) {
    return expiredRecord(existing, expiryReason, now);
  }
  return now.getTime() < existing.deliveryWindowStartsAt.getTime()
    ? pendingRecord(existing, now)
    : undefined;
}

// The statuses an outcome leaves in the record. After a failed write, finding
// one of them shows that the write landed.
const completedStatuses: Record<
  ReminderDispatchCompletionOutcome['kind'],
  readonly ReminderDispatchStatus[]
> = {
  accepted: ['accepted'],
  'permanent-failure': ['permanent-failure'],
  'transient-failure': ['transient-failure', 'expired'],
  uncertain: ['uncertain'],
};

function completedStatus(
  outcome: ReminderDispatchCompletionOutcome,
  expiryReason: ReminderDispatchExpiryReason | undefined,
): ReminderDispatchStatus {
  if (outcome.kind !== 'transient-failure') return outcome.kind;
  return expiryReason === undefined ? 'transient-failure' : 'expired';
}

/** A rejected token is queued for cleanup, with when it was invalidated. */
function tokenCleanup(
  outcome: ReminderDispatchCompletionOutcome,
  invalidatedAt: Date | undefined,
) {
  if (outcome.kind !== 'permanent-failure' || !outcome.invalidToken) return {};
  return {
    cleanupStatus: 'pending' as const,
    ...(invalidatedAt === undefined ? {} : { invalidatedAt }),
  };
}

function completedRecord(
  existing: ReminderDispatchLedgerRecord,
  claim: ReminderDispatchClaim,
  outcome: ReminderDispatchCompletionOutcome,
  invalidatedAt: Date | undefined,
  now: Date,
): Omit<ReminderDispatchLedgerRecord, 'etag'> {
  const expiryReason =
    outcome.kind === 'transient-failure'
      ? expiryReasonAt(existing, now.getTime())
      : undefined;
  const status = completedStatus(outcome, expiryReason);
  return {
    ...withoutClaim(existing),
    ...(status === 'uncertain' ? { lastClaimId: claim.claimId } : {}),
    ...tokenCleanup(outcome, invalidatedAt),
    ...(expiryReason === undefined ? {} : { expiryReason }),
    status,
    updatedAt: now,
  };
}

/**
 * The record that completes `existing` with an outcome, or null when the
 * claim has no say in it. A worker that was cut off may still learn what the
 * provider said, so a definite answer settles the record that went uncertain
 * under its own claim. Nothing else overwrites an uncertain record.
 */
function completionRecord(
  existing: ReminderDispatchLedgerRecord,
  claim: ReminderDispatchClaim,
  outcome: ReminderDispatchCompletionOutcome,
  invalidatedAt: Date | undefined,
  now: Date,
): Omit<ReminderDispatchLedgerRecord, 'etag'> | null {
  if (holdsClaim(existing, claim)) {
    return completedRecord(existing, claim, outcome, invalidatedAt, now);
  }
  const late =
    existing.status === 'uncertain' && existing.lastClaimId === claim.claimId;
  if (late && outcome.kind === 'accepted') {
    return { ...withoutClaim(existing), status: 'accepted', updatedAt: now };
  }
  if (late && outcome.kind === 'permanent-failure') {
    return completedRecord(existing, claim, outcome, invalidatedAt, now);
  }
  return null;
}

function isUnsettled(record: ReminderDispatchLedgerRecord, now: Date) {
  if (record.status === 'permanent-failure') {
    return (
      record.cleanupStatus === 'pending' || record.cleanupStatus === 'failed'
    );
  }
  return (
    (record.status === 'pending' ||
      record.status === 'claimed' ||
      record.status === 'transient-failure') &&
    record.deliveryWindowEndsAt.getTime() < now.getTime()
  );
}

function changeEventAhead(value: unknown, now: Date) {
  try {
    return instant(value, 'Change Event instant').getTime() > now.getTime();
  } catch {
    // Dispatch first writes a row at most about eight days before its event,
    // so a row old enough to purge has passed it. With none to read, age
    // alone decides.
    return false;
  }
}

/**
 * The keys of a listed row due for deletion, or null to keep it. Throws for
 * a row it cannot date or key.
 */
function expiredRowKeys(
  entity: Record<string, unknown>,
  now: Date,
  cutoff: number,
) {
  if (dateValue(entity.updatedAt, 'updatedAt').getTime() >= cutoff) return null;
  // A deleted record no longer fences its delivery identity. Keep it while
  // its Change Event is ahead so a later dispatch cannot send it again.
  if (changeEventAhead(entity.changeEventAt, now)) return null;
  return {
    etag: requiredString(entity.etag, 'ETag'),
    partitionKey: requiredString(entity.partitionKey, 'partition key'),
    rowKey: requiredString(entity.rowKey, 'row key'),
  };
}

export function createTableReminderDispatchLedgerStore(
  table: ReminderDispatchLedgerTable,
): ReminderDispatchLedgerStore {
  async function get(identity: ReminderDispatchIdentity) {
    const normalized = normalizeIdentity(identity);
    const key = reminderDispatchStorageKey(normalized);
    try {
      const entity = await table.get(key.partitionKey, key.rowKey);
      const record = recordFromEntity(entity);
      if (!sameIdentity(record, normalized)) {
        throw new Error('Reminder dispatch ledger identity mismatch');
      }
      return record;
    } catch (error) {
      if (statusCode(error) === 404) return null;
      throw error;
    }
  }

  async function replace(
    record: Omit<ReminderDispatchLedgerRecord, 'etag'>,
    etag: string,
  ) {
    const key = reminderDispatchStorageKey(record);
    await table.replace(entityFromRecord(record, key), etag);
  }

  /**
   * Replaces `existing` and reads the record back. Undefined when another
   * worker's write won, so the caller reads again.
   */
  async function replaceAndRead(
    next: Omit<ReminderDispatchLedgerRecord, 'etag'>,
    existing: ReminderDispatchLedgerRecord,
  ) {
    try {
      await replace(next, existing.etag);
      const updated = await get(existing);
      if (updated !== null) {
        return { kind: 'updated' as const, record: updated };
      }
    } catch (error) {
      if (!conflict(error)) throw error;
    }
    return undefined;
  }

  /** Undefined when another worker created the record first. */
  async function createPrepared(base: ReturnType<typeof preparedRecord>) {
    try {
      await table.create(
        entityFromRecord(base, reminderDispatchStorageKey(base)),
      );
      const created = await get(base);
      if (created !== null) return created;
    } catch (error) {
      if (conflict(error)) return undefined;
      try {
        const reconciled = await get(base);
        if (reconciled !== null) return reconciled;
      } catch {
        // Preserve the original create failure when reconciliation is
        // unavailable; a later operation can retry the preparation.
      }
      throw error;
    }
    return undefined;
  }

  async function prepare(preparation: ReminderDispatchPreparation) {
    const base = preparedRecord(preparation);
    for (let attempt = 0; attempt < tableMutationRetryLimit; attempt += 1) {
      const existing = await get(base);
      if (existing === null) {
        const created = await createPrepared(base);
        if (created !== undefined) return created;
        continue;
      }
      const next = preparedReplacement(existing, base);
      if (next === null) return existing;
      const updated = await replaceAndRead(next, existing);
      if (updated !== undefined) return updated.record;
    }
    throw new Error(
      'Reminder dispatch preparation contention exceeded retry limit',
    );
  }

  /** False when another worker's write won, so the caller reads again. */
  async function replaceUnlessConflict(
    next: Omit<ReminderDispatchLedgerRecord, 'etag'>,
    existing: ReminderDispatchLedgerRecord,
  ) {
    try {
      await replace(next, existing.etag);
      return true;
    } catch (error) {
      if (conflict(error)) return false;
      throw error;
    }
  }

  /** Undefined when the write did not make this worker the claimant. */
  async function writeClaim(
    normalized: ReminderDispatchIdentity,
    existing: ReminderDispatchLedgerRecord,
    now: Date,
    leaseMs: number,
  ) {
    const claimId = opaqueRandomValue();
    const claimExpiresAt = new Date(now.getTime() + leaseMs);
    const claimed = {
      ...withoutClaim(existing),
      claimExpiresAt,
      claimId,
      status: 'claimed' as const,
      updatedAt: now,
    };
    const issued = (expiresAt: Date) => ({
      ...normalized,
      attemptGeneration: existing.attemptGeneration,
      claimExpiresAt: expiresAt,
      claimId,
    });
    const isOurs = (
      record: ReminderDispatchLedgerRecord | null,
    ): record is ReminderDispatchLedgerRecord =>
      record?.status === 'claimed' &&
      record.claimId === claimId &&
      record.attemptGeneration === existing.attemptGeneration;
    try {
      await replace(claimed, existing.etag);
      if (isOurs(await get(normalized))) return issued(claimExpiresAt);
    } catch (error) {
      const reconciled = await get(normalized);
      if (isOurs(reconciled) && reconciled.claimExpiresAt !== undefined) {
        return issued(reconciled.claimExpiresAt);
      }
      if (!conflict(error)) throw error;
    }
    return undefined;
  }

  async function claim(
    identity: ReminderDispatchIdentity,
    nowInput: Date,
    leaseMs = defaultClaimLeaseMs,
  ) {
    const normalized = normalizeIdentity(identity);
    const now = nowDate(nowInput);
    if (
      !Number.isSafeInteger(leaseMs) ||
      leaseMs <= 0 ||
      leaseMs > maxClaimLeaseMs
    ) {
      throw new Error('Invalid reminder dispatch claim lease');
    }

    for (let attempt = 0; attempt < tableMutationRetryLimit; attempt += 1) {
      const existing = await get(normalized);
      if (existing === null || terminalStatus(existing.status)) return null;

      const settlement = settlementBeforeClaim(existing, now);
      if (settlement !== undefined) {
        await replaceUnlessConflict(settlement, existing);
        continue;
      }
      if (
        existing.status === 'claimed' ||
        now.getTime() < existing.deliveryWindowStartsAt.getTime()
      ) {
        return null;
      }

      const claimed = await writeClaim(normalized, existing, now, leaseMs);
      if (claimed !== undefined) return claimed;
    }
    throw new Error('Reminder dispatch claim contention exceeded retry limit');
  }

  /** The send intent of this claim, if a write that failed in fact landed. */
  async function savedIntent(claim: ReminderDispatchClaim) {
    try {
      const reconciled = await get(claim);
      if (
        reconciled !== null &&
        holdsClaim(reconciled, claim) &&
        reconciled.sendStartedAt !== undefined
      ) {
        return reconciled;
      }
    } catch {
      // Preserve the write error when the reconciliation read fails.
    }
    return null;
  }

  /** Undefined when another worker's write won, so the caller reads again. */
  async function recordIntent(
    existing: ReminderDispatchLedgerRecord,
    claim: ReminderDispatchClaim,
    now: Date,
  ) {
    try {
      await replace(
        { ...existing, sendStartedAt: now, updatedAt: now },
        existing.etag,
      );
      const updated = await get(claim);
      if (
        updated?.status === 'claimed' &&
        updated.claimId === claim.claimId &&
        updated.sendStartedAt !== undefined
      ) {
        return { kind: 'updated' as const, record: updated };
      }
    } catch (error) {
      const saved = await savedIntent(claim);
      if (saved !== null) return { kind: 'updated' as const, record: saved };
      if (!conflict(error)) throw error;
    }
    return undefined;
  }

  /** One attempt for a claim this worker holds; undefined means read again. */
  async function attemptSend(
    existing: ReminderDispatchLedgerRecord,
    claim: ReminderDispatchClaim,
    now: Date,
  ) {
    if (leaseLapsed(existing, now)) {
      // The lease owner has lost authority. Returning the row after this
      // write is unsafe because another worker may claim it before the read
      // completes; the caller must abandon this operation.
      const freed = releasedRecord(existing, now);
      return (await replaceUnlessConflict(freed, existing))
        ? { kind: 'stale' as const }
        : undefined;
    }
    if (existing.sendStartedAt !== undefined) {
      return { kind: 'updated' as const, record: existing };
    }
    const unsendable = unsendableRecord(existing, now);
    if (unsendable !== undefined) return replaceAndRead(unsendable, existing);
    return recordIntent(existing, claim, now);
  }

  async function beginSend(claim: ReminderDispatchClaim, nowInput: Date) {
    const now = nowDate(nowInput);
    for (let attempt = 0; attempt < tableMutationRetryLimit; attempt += 1) {
      const existing = await get(claim);
      if (existing === null || !holdsClaim(existing, claim)) {
        return stale(existing);
      }
      const result = await attemptSend(existing, claim, now);
      if (result !== undefined) return result;
    }
    throw new Error(
      'Reminder dispatch send intent contention exceeded retry limit',
    );
  }

  async function release(claim: ReminderDispatchClaim, nowInput: Date) {
    const now = nowDate(nowInput);
    for (let attempt = 0; attempt < tableMutationRetryLimit; attempt += 1) {
      const existing = await get(claim);
      if (existing === null || !holdsClaim(existing, claim)) {
        return stale(existing);
      }
      const released = await replaceAndRead(
        releasedRecord(existing, now),
        existing,
      );
      if (released !== undefined) return released;
    }
    throw new Error(
      'Reminder dispatch claim release contention exceeded retry limit',
    );
  }

  async function cancelBeforeProvider(
    claim: ReminderDispatchClaim,
    nowInput: Date,
  ) {
    const now = nowDate(nowInput);
    for (let attempt = 0; attempt < tableMutationRetryLimit; attempt += 1) {
      const existing = await get(claim);
      if (existing === null || !holdsClaim(existing, claim)) {
        return stale(existing);
      }
      const cancelled = await replaceAndRead(
        pendingRecord(existing, now),
        existing,
      );
      if (cancelled !== undefined) return cancelled;
    }
    throw new Error(
      'Reminder dispatch pre-provider cancellation contention exceeded retry limit',
    );
  }

  /**
   * Replaces `existing` and reads the record back. Undefined when another
   * worker's write won, so the caller reads again. After any other failure
   * the write may still have landed, which `landed` tells from the record.
   */
  async function replaceAndReconcile(
    next: Omit<ReminderDispatchLedgerRecord, 'etag'>,
    existing: ReminderDispatchLedgerRecord,
    landed: (record: ReminderDispatchLedgerRecord) => boolean,
  ) {
    try {
      await replace(next, existing.etag);
      const updated = await get(existing);
      if (updated !== null) {
        return { kind: 'updated' as const, record: updated };
      }
    } catch (error) {
      if (!conflict(error)) {
        const reconciled = await get(existing);
        if (reconciled !== null && landed(reconciled)) {
          return { kind: 'updated' as const, record: reconciled };
        }
        throw error;
      }
    }
    return undefined;
  }

  async function complete(
    claim: ReminderDispatchClaim,
    outcome: ReminderDispatchCompletionOutcome,
    nowInput: Date,
  ): Promise<ReminderDispatchCompletionResult> {
    const now = nowDate(nowInput);
    const invalidatedAt =
      outcome.kind === 'permanent-failure'
        ? optionalDate(outcome.invalidatedAt, 'provider invalidation')
        : undefined;
    const landed = (record: ReminderDispatchLedgerRecord) =>
      completedStatuses[outcome.kind].includes(record.status);
    for (let attempt = 0; attempt < tableMutationRetryLimit; attempt += 1) {
      const existing = await get(claim);
      if (existing === null) return { kind: 'stale' };
      const next = completionRecord(
        existing,
        claim,
        outcome,
        invalidatedAt,
        now,
      );
      if (next === null) return stale(existing);
      const completed = await replaceAndReconcile(next, existing, landed);
      if (completed !== undefined) return completed;
    }
    throw new Error(
      'Reminder dispatch completion contention exceeded retry limit',
    );
  }

  async function invalidate(
    identity: ReminderDispatchIdentity,
    attemptGeneration: number,
    nowInput: Date,
  ) {
    const normalized = normalizeIdentity(identity);
    const now = nowDate(nowInput);
    if (!Number.isSafeInteger(attemptGeneration) || attemptGeneration < 1) {
      throw new Error('Invalid reminder dispatch generation');
    }
    for (let attempt = 0; attempt < tableMutationRetryLimit; attempt += 1) {
      const existing = await get(normalized);
      if (existing === null) return { kind: 'stale' as const };
      if (existing.attemptGeneration !== attemptGeneration) {
        return stale(existing);
      }
      if (
        terminalStatus(existing.status) &&
        !terminalExpiryCanReset(existing)
      ) {
        return { kind: 'updated' as const, record: existing };
      }
      const invalidated = await replaceAndRead(
        supersededRecord(existing, now),
        existing,
      );
      if (invalidated !== undefined) return invalidated;
    }
    throw new Error(
      'Reminder dispatch invalidation contention exceeded retry limit',
    );
  }

  async function updateCleanup(
    identity: ReminderDispatchIdentity,
    attemptGeneration: number,
    cleanupStatus: ReminderDispatchCleanupStatus,
    nowInput: Date,
  ) {
    const normalized = normalizeIdentity(identity);
    const now = nowDate(nowInput);
    for (let attempt = 0; attempt < tableMutationRetryLimit; attempt += 1) {
      const existing = await get(normalized);
      if (
        existing === null ||
        existing.attemptGeneration !== attemptGeneration ||
        existing.status !== 'permanent-failure'
      ) {
        return stale(existing);
      }
      if (
        cleanupSettled(existing.cleanupStatus) ||
        existing.cleanupStatus === cleanupStatus
      ) {
        return { kind: 'updated' as const, record: existing };
      }
      const updated = await replaceAndReconcile(
        { ...existing, cleanupStatus, updatedAt: now },
        existing,
        (record) => record.cleanupStatus === cleanupStatus,
      );
      if (updated !== undefined) return updated;
    }
    throw new Error(
      'Reminder dispatch cleanup contention exceeded retry limit',
    );
  }

  async function* listUnsettledPages(
    nowInput: Date,
    onInvalidRow: () => void,
  ): AsyncGenerator<readonly ReminderDispatchLedgerRecord[], void, unknown> {
    const now = nowDate(nowInput);
    for await (const page of table.listUnsettledPages(now)) {
      yield page.flatMap((entity) => {
        try {
          const record = recordFromEntity(entity);
          return isUnsettled(record, now) ? [record] : [];
        } catch {
          // A bad row stays listed until the daily purge deletes it, or for
          // good if its last update is unreadable. Throwing here would cost
          // every later row, every run, until then.
          onInvalidRow();
          return [];
        }
      });
    }
  }

  async function readSweep(window: ReminderDispatchWindow) {
    const key = sweepStorageKey(window);
    try {
      return await table.get(key.partitionKey, key.rowKey);
    } catch (error) {
      if (statusCode(error) === 404) return null;
      throw error;
    }
  }

  /** Returns false when an overlapping run wrote first. */
  async function writeSweep(
    entity: ReturnType<typeof sweepEntity>,
    existing: Record<string, unknown> | null,
  ) {
    try {
      if (existing === null) await table.create(entity);
      else await table.replace(entity, requiredString(existing.etag, 'ETag'));
      return true;
    } catch (error) {
      if (conflict(error)) return false;
      throw error;
    }
  }

  async function recordSweep(
    window: ReminderDispatchWindow,
    reachedLastPage: boolean,
    now: Date,
  ) {
    const existing = await readSweep(window);
    if (
      existing !== null &&
      !(reachedLastPage && existing.sweep === 'incomplete')
    ) {
      return;
    }
    const sweep = reachedLastPage ? 'complete' : 'incomplete';
    await writeSweep(sweepEntity(window, sweep, nowDate(now)), existing);
  }

  async function reportClosedWindow(window: ReminderDispatchWindow, now: Date) {
    const existing = await readSweep(window);
    if (existing?.sweep === 'complete' || existing?.sweep === 'reported') {
      return null;
    }
    const entity = sweepEntity(window, 'reported', nowDate(now));
    if (!(await writeSweep(entity, existing))) return null;
    return existing === null ? 'not-swept' : 'sweep-incomplete';
  }

  async function purgeExpired(nowInput: Date) {
    const now = nowDate(nowInput);
    const cutoff = now.getTime() - operationalRetentionMs;
    let unreadable = 0;
    for await (const entity of table.listUpdatedBefore(new Date(cutoff))) {
      let keys: ReturnType<typeof expiredRowKeys>;
      try {
        keys = expiredRowKeys(entity, now, cutoff);
      } catch {
        // Throwing here would stop the purge at this row, every day, and
        // leave every row listed after it.
        unreadable += 1;
        continue;
      }
      if (keys === null) continue;
      try {
        await table.delete(keys.partitionKey, keys.rowKey, keys.etag);
      } catch (error) {
        // A newer write or an overlapping run wins; the next run reconsiders.
        if (statusCode(error) !== 404 && !conflict(error)) throw error;
      }
    }
    return unreadable;
  }

  return {
    claim,
    complete,
    get,
    invalidate,
    listUnsettledPages,
    prepare,
    purgeExpired,
    recordSweep,
    release,
    reportClosedWindow,
    beginSend,
    cancelBeforeProvider,
    updateCleanup,
  };
}

interface AzureReminderDispatchLedgerStoreDependencies {
  readonly createCredential: (
    clientId: string,
  ) => Pick<ManagedIdentityCredential, 'getToken'>;
  readonly createTableClient: (
    endpoint: string,
    tableName: string,
    credential: Pick<ManagedIdentityCredential, 'getToken'>,
  ) => TableClient;
}

const azureReminderDispatchLedgerStoreDependencies: AzureReminderDispatchLedgerStoreDependencies =
  {
    createCredential: (clientId) => new ManagedIdentityCredential(clientId),
    createTableClient: (endpoint, tableName, credential) =>
      new TableClient(endpoint, tableName, credential),
  };

export function createAzureReminderDispatchLedgerStore(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: AzureReminderDispatchLedgerStoreDependencies = azureReminderDispatchLedgerStoreDependencies,
): ReminderDispatchLedgerStore {
  const accountName = environment.REMINDER_STORAGE_ACCOUNT_NAME?.trim();
  if (accountName === undefined || accountName.length === 0) {
    throw new Error('REMINDER_STORAGE_ACCOUNT_NAME is required');
  }
  const managedIdentityClientId =
    environment.REMINDER_MANAGED_IDENTITY_CLIENT_ID?.trim();
  if (
    managedIdentityClientId === undefined ||
    managedIdentityClientId.length === 0
  ) {
    throw new Error('REMINDER_MANAGED_IDENTITY_CLIENT_ID is required');
  }
  const endpoint = `https://${accountName}.table.core.windows.net`;
  const credential = dependencies.createCredential(managedIdentityClientId);
  const table = dependencies.createTableClient(
    endpoint,
    reminderDispatchLedgerTableName,
    credential,
  );
  return createTableReminderDispatchLedgerStore({
    create: async (entity) => {
      await table.createEntity(entity as never);
    },
    delete: async (partitionKey, rowKey, etag) => {
      await table.deleteEntity(partitionKey, rowKey, { etag });
    },
    get: async (partitionKey, rowKey) => {
      const entity = await table.getEntity<Record<string, unknown>>(
        partitionKey,
        rowKey,
      );
      return {
        ...entity,
        etag: entity.etag,
        partitionKey,
        rowKey,
      };
    },
    listUnsettledPages: (now) =>
      table
        .listEntities<Record<string, unknown>>({
          queryOptions: {
            filter: odata`((status eq 'pending' or status eq 'claimed' or status eq 'transient-failure') and deliveryWindowEndsAt lt ${now}) or (status eq 'permanent-failure' and (cleanupStatus eq 'pending' or cleanupStatus eq 'failed'))`,
          },
        })
        .byPage({ maxPageSize: unsettledPageSize }),
    listUpdatedBefore: (cutoff) =>
      table.listEntities<Record<string, unknown>>({
        queryOptions: { filter: odata`updatedAt lt ${cutoff}` },
      }),
    replace: async (entity, etag) => {
      await table.updateEntity(entity as never, 'Replace', { etag });
    },
  });
}
