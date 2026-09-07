import { ManagedIdentityCredential } from '@azure/identity';
import { TableClient } from '@azure/data-tables';
import { canonicalAustralianZoneId } from '@daylight-saviour/domain/australian-zone-runtime';

import {
  hashOpaqueValue,
  opaqueRandomValue,
} from './reminder-subscriptions.js';

export const reminderDispatchLedgerTableName = 'ReminderDispatchLedger';
const ledgerPartitionPrefix = 'reminder-dispatch-v1-';
const tableMutationRetryLimit = 12;
const defaultClaimLeaseMs = 60_000;
const maxClaimLeaseMs = 60 * 60 * 1_000;

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
  readonly get: (
    partitionKey: string,
    rowKey: string,
  ) => Promise<Record<string, unknown>>;
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

  async function prepare(preparation: ReminderDispatchPreparation) {
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
    const base = {
      ...identity,
      attemptGeneration: preparation.attemptGeneration,
      createdAt: now,
      deliveryWindowEndsAt: endsAt,
      deliveryWindowStartsAt: startsAt,
      packValidUntil,
      status: 'pending' as const,
      updatedAt: now,
    };

    for (let attempt = 0; attempt < tableMutationRetryLimit; attempt += 1) {
      const existing = await get(identity);
      if (existing === null) {
        try {
          await table.create(
            entityFromRecord(base, reminderDispatchStorageKey(identity)),
          );
          const created = await get(identity);
          if (created !== null) return created;
        } catch (error) {
          if (!conflict(error)) {
            try {
              const reconciled = await get(identity);
              if (reconciled !== null) return reconciled;
            } catch {
              // Preserve the original create failure when reconciliation is
              // unavailable; a later operation can retry the preparation.
            }
            throw error;
          }
        }
        continue;
      }
      if (existing.attemptGeneration > base.attemptGeneration) return existing;
      if (existing.attemptGeneration === base.attemptGeneration) {
        const canRefresh =
          existing.status === 'transient-failure' ||
          existing.status === 'pending' ||
          terminalExpiryCanReset(existing) ||
          packExpiryCanReset(existing, packValidUntil, now);
        if (!canRefresh) return existing;
        const refreshed = {
          ...base,
          createdAt: existing.createdAt,
        };
        try {
          await replace(refreshed, existing.etag);
          const updated = await get(identity);
          if (updated !== null) return updated;
        } catch (error) {
          if (!conflict(error)) throw error;
        }
        continue;
      }
      if (
        existing.status === 'accepted' ||
        existing.status === 'uncertain' ||
        (existing.status === 'expired' &&
          !terminalExpiryCanReset(existing) &&
          !packExpiryCanReset(existing, packValidUntil, now))
      ) {
        return existing;
      }
      if (
        existing.status === 'claimed' &&
        existing.sendStartedAt !== undefined
      ) {
        const uncertain = uncertainRecord(existing, now);
        try {
          await replace(uncertain, existing.etag);
          const updated = await get(identity);
          if (updated !== null) return updated;
        } catch (error) {
          if (!conflict(error)) throw error;
        }
        continue;
      }
      try {
        await replace(base, existing.etag);
        const updated = await get(identity);
        if (updated !== null) return updated;
      } catch (error) {
        if (!conflict(error)) throw error;
      }
    }
    throw new Error(
      'Reminder dispatch preparation contention exceeded retry limit',
    );
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
      if (existing === null) return null;
      if (
        existing.status === 'accepted' ||
        existing.status === 'permanent-failure' ||
        existing.status === 'expired' ||
        existing.status === 'uncertain'
      ) {
        return null;
      }

      if (existing.status === 'claimed') {
        const claimExpiresAt = existing.claimExpiresAt?.getTime();
        const claimIsExpired =
          claimExpiresAt === undefined || claimExpiresAt <= now.getTime();
        if (!claimIsExpired) return null;
        if (existing.sendStartedAt !== undefined) {
          const uncertain = uncertainRecord(existing, now);
          try {
            await replace(uncertain, existing.etag);
          } catch (error) {
            if (!conflict(error)) throw error;
          }
          continue;
        }
        try {
          await replace(
            {
              ...withoutClaim(existing),
              status: 'pending' as const,
              updatedAt: now,
            },
            existing.etag,
          );
        } catch (error) {
          if (!conflict(error)) throw error;
        }
        continue;
      }

      const expiryReason = expiryReasonAt(existing, now.getTime());
      if (expiryReason !== undefined) {
        try {
          await replace(
            {
              ...withoutClaim(existing),
              expiryReason,
              status: 'expired' as const,
              updatedAt: now,
            },
            existing.etag,
          );
        } catch (error) {
          if (!conflict(error)) throw error;
        }
        continue;
      }
      if (now.getTime() < existing.deliveryWindowStartsAt.getTime())
        return null;

      const claimId = opaqueRandomValue();
      const claimExpiresAt = new Date(now.getTime() + leaseMs);
      const claimed = {
        ...withoutClaim(existing),
        claimExpiresAt,
        claimId,
        status: 'claimed' as const,
        updatedAt: now,
      };
      try {
        await replace(claimed, existing.etag);
        const updated = await get(normalized);
        if (
          updated?.status === 'claimed' &&
          updated.claimId === claimId &&
          updated.attemptGeneration === existing.attemptGeneration
        ) {
          return {
            ...normalized,
            attemptGeneration: updated.attemptGeneration,
            claimExpiresAt,
            claimId,
          };
        }
      } catch (error) {
        const reconciled = await get(normalized);
        if (
          reconciled?.status === 'claimed' &&
          reconciled.claimId === claimId &&
          reconciled.attemptGeneration === existing.attemptGeneration &&
          reconciled.claimExpiresAt !== undefined
        ) {
          return {
            ...normalized,
            attemptGeneration: reconciled.attemptGeneration,
            claimExpiresAt: reconciled.claimExpiresAt,
            claimId,
          };
        }
        if (!conflict(error)) throw error;
      }
    }
    throw new Error('Reminder dispatch claim contention exceeded retry limit');
  }

  async function beginSend(claim: ReminderDispatchClaim, nowInput: Date) {
    const now = nowDate(nowInput);
    for (let attempt = 0; attempt < tableMutationRetryLimit; attempt += 1) {
      const existing = await get(claim);
      if (
        existing === null ||
        existing.status !== 'claimed' ||
        existing.claimId !== claim.claimId ||
        existing.attemptGeneration !== claim.attemptGeneration
      ) {
        return { kind: 'stale' as const, record: existing ?? undefined };
      }
      const claimExpiresAt = existing.claimExpiresAt?.getTime();
      if (claimExpiresAt === undefined || claimExpiresAt <= now.getTime()) {
        const next =
          existing.sendStartedAt === undefined
            ? {
                ...withoutClaim(existing),
                status: 'pending' as const,
                updatedAt: now,
              }
            : uncertainRecord(existing, now);
        try {
          await replace(next, existing.etag);
          // The lease owner has lost authority. Returning the row after this
          // write is unsafe because another worker may claim it before the
          // read completes; the caller must abandon this operation.
          return { kind: 'stale' as const };
        } catch (error) {
          if (!conflict(error)) throw error;
        }
        continue;
      }
      if (existing.sendStartedAt !== undefined) {
        return { kind: 'updated' as const, record: existing };
      }
      const expiryReason = expiryReasonAt(existing, now.getTime());
      if (
        expiryReason !== undefined ||
        now.getTime() < existing.deliveryWindowStartsAt.getTime()
      ) {
        try {
          await replace(
            {
              ...withoutClaim(existing),
              ...(expiryReason === undefined ? {} : { expiryReason }),
              ...(expiryReason === undefined
                ? { status: 'pending' as const }
                : { status: 'expired' as const }),
              updatedAt: now,
            },
            existing.etag,
          );
          const updated = await get(claim);
          if (updated !== null)
            return { kind: 'updated' as const, record: updated };
        } catch (error) {
          if (!conflict(error)) throw error;
        }
        continue;
      }
      try {
        await replace(
          {
            ...existing,
            sendStartedAt: now,
            updatedAt: now,
          },
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
        try {
          const reconciled = await get(claim);
          if (
            reconciled?.status === 'claimed' &&
            reconciled.claimId === claim.claimId &&
            reconciled.attemptGeneration === claim.attemptGeneration &&
            reconciled.sendStartedAt !== undefined
          ) {
            return { kind: 'updated' as const, record: reconciled };
          }
        } catch {
          // Preserve the write error below when the reconciliation read fails.
        }
        if (!conflict(error)) throw error;
      }
    }
    throw new Error(
      'Reminder dispatch send intent contention exceeded retry limit',
    );
  }

  async function release(claim: ReminderDispatchClaim, nowInput: Date) {
    const now = nowDate(nowInput);
    for (let attempt = 0; attempt < tableMutationRetryLimit; attempt += 1) {
      const existing = await get(claim);
      if (
        existing === null ||
        existing.status !== 'claimed' ||
        existing.claimId !== claim.claimId ||
        existing.attemptGeneration !== claim.attemptGeneration
      ) {
        return { kind: 'stale' as const, record: existing ?? undefined };
      }
      const next =
        existing.sendStartedAt === undefined
          ? {
              ...withoutClaim(existing),
              status: 'pending' as const,
              updatedAt: now,
            }
          : {
              ...uncertainRecord(existing, now),
            };
      try {
        await replace(next, existing.etag);
        const updated = await get(claim);
        if (updated !== null)
          return { kind: 'updated' as const, record: updated };
      } catch (error) {
        if (!conflict(error)) throw error;
      }
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
      if (
        existing === null ||
        existing.status !== 'claimed' ||
        existing.claimId !== claim.claimId ||
        existing.attemptGeneration !== claim.attemptGeneration
      ) {
        return { kind: 'stale' as const, record: existing ?? undefined };
      }
      try {
        await replace(
          {
            ...withoutClaim(existing),
            status: 'pending' as const,
            updatedAt: now,
          },
          existing.etag,
        );
        const updated = await get(claim);
        if (updated !== null)
          return { kind: 'updated' as const, record: updated };
      } catch (error) {
        if (!conflict(error)) throw error;
      }
    }
    throw new Error(
      'Reminder dispatch pre-provider cancellation contention exceeded retry limit',
    );
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
    for (let attempt = 0; attempt < tableMutationRetryLimit; attempt += 1) {
      const existing = await get(claim);
      if (existing === null) return { kind: 'stale' };
      const activeClaim =
        existing.status === 'claimed' &&
        existing.claimId === claim.claimId &&
        existing.attemptGeneration === claim.attemptGeneration;
      const lateAccepted =
        outcome.kind === 'accepted' &&
        existing.status === 'uncertain' &&
        existing.lastClaimId === claim.claimId;
      const latePermanentFailure =
        outcome.kind === 'permanent-failure' &&
        existing.status === 'uncertain' &&
        existing.lastClaimId === claim.claimId;
      if (!activeClaim && !lateAccepted && !latePermanentFailure) {
        return { kind: 'stale', record: existing };
      }

      let next: Omit<ReminderDispatchLedgerRecord, 'etag'>;
      if (lateAccepted) {
        next = {
          ...withoutClaim(existing),
          status: 'accepted',
          updatedAt: now,
        };
      } else {
        const expiryReason =
          outcome.kind === 'transient-failure'
            ? expiryReasonAt(existing, now.getTime())
            : undefined;
        const status: ReminderDispatchStatus =
          outcome.kind === 'accepted'
            ? 'accepted'
            : outcome.kind === 'uncertain'
              ? 'uncertain'
              : outcome.kind === 'permanent-failure'
                ? 'permanent-failure'
                : expiryReason === undefined
                  ? 'transient-failure'
                  : 'expired';
        next = {
          ...withoutClaim(existing),
          ...(status === 'uncertain' ? { lastClaimId: claim.claimId } : {}),
          ...(outcome.kind === 'permanent-failure' && outcome.invalidToken
            ? { cleanupStatus: 'pending' as const }
            : {}),
          ...(outcome.kind === 'permanent-failure' &&
          outcome.invalidToken &&
          invalidatedAt !== undefined
            ? { invalidatedAt }
            : {}),
          ...(expiryReason === undefined ? {} : { expiryReason }),
          status,
          updatedAt: now,
        };
      }
      try {
        await replace(next, existing.etag);
        const updated = await get(claim);
        if (updated !== null) return { kind: 'updated', record: updated };
      } catch (error) {
        if (!conflict(error)) {
          const reconciled = await get(claim);
          if (
            reconciled !== null &&
            ((outcome.kind === 'accepted' &&
              reconciled.status === 'accepted') ||
              (outcome.kind === 'uncertain' &&
                reconciled.status === 'uncertain') ||
              (outcome.kind === 'transient-failure' &&
                (reconciled.status === 'transient-failure' ||
                  reconciled.status === 'expired')) ||
              (outcome.kind === 'permanent-failure' &&
                reconciled.status === 'permanent-failure'))
          ) {
            return { kind: 'updated', record: reconciled };
          }
          throw error;
        }
      }
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
        return { kind: 'stale' as const, record: existing };
      }
      if (
        terminalStatus(existing.status) &&
        !(existing.status === 'expired' && terminalExpiryCanReset(existing))
      ) {
        return { kind: 'updated' as const, record: existing };
      }
      const next =
        existing.status === 'claimed' && existing.sendStartedAt !== undefined
          ? uncertainRecord(existing, now)
          : {
              ...withoutClaim(existing),
              expiryReason: 'superseded' as const,
              status: 'expired' as const,
              updatedAt: now,
            };
      try {
        await replace(next, existing.etag);
        const updated = await get(normalized);
        if (updated !== null)
          return { kind: 'updated' as const, record: updated };
      } catch (error) {
        if (!conflict(error)) throw error;
      }
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
        return { kind: 'stale' as const, record: existing ?? undefined };
      }
      if (
        existing.cleanupStatus === 'removed' ||
        existing.cleanupStatus === 'not-found' ||
        existing.cleanupStatus === 'token-replaced'
      ) {
        return { kind: 'updated' as const, record: existing };
      }
      if (existing.cleanupStatus === cleanupStatus) {
        return { kind: 'updated' as const, record: existing };
      }
      try {
        await replace(
          {
            ...existing,
            cleanupStatus,
            updatedAt: now,
          },
          existing.etag,
        );
        const updated = await get(normalized);
        if (updated !== null)
          return { kind: 'updated' as const, record: updated };
      } catch (error) {
        if (!conflict(error)) {
          const reconciled = await get(normalized);
          if (reconciled?.cleanupStatus === cleanupStatus) {
            return { kind: 'updated' as const, record: reconciled };
          }
          throw error;
        }
      }
    }
    throw new Error(
      'Reminder dispatch cleanup contention exceeded retry limit',
    );
  }

  return {
    claim,
    complete,
    get,
    invalidate,
    prepare,
    release,
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
    replace: async (entity, etag) => {
      await table.updateEntity(entity as never, 'Replace', { etag });
    },
  });
}
