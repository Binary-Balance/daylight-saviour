import { canonicalAustralianZoneId } from '@daylight-saviour/domain/australian-zone-runtime';

import {
  type ReminderDispatchCleanupStatus,
  type ReminderDispatchCompletionOutcome,
  type ReminderDispatchIdentity,
  type ReminderDispatchLedgerRecord,
  type ReminderDispatchLedgerStore,
} from './reminder-dispatch-ledger.js';
import type {
  ReminderSubscriptionStore,
  ReminderSubscriptionSnapshot,
} from './reminder-subscriptions.js';

export type ReminderDispatchDirection = 'forward' | 'backward';
export type ReminderDispatchTiming = 'one-week' | 'one-day';

export interface ReminderDispatchDelivery {
  readonly changeDirection:
    | ReminderDispatchDirection
    | 'Backward Change'
    | 'Forward Change';
  readonly changeEventAt: string;
  readonly deliveryWindow: {
    readonly endsAt: string;
    readonly startsAt: string;
  };
  readonly homeTimeZone: string;
  readonly timing: ReminderDispatchTiming;
}

export interface ReminderDispatchContext {
  readonly activePackValidUntil: string;
  readonly completeOperationDeadline: string;
  readonly delivery: ReminderDispatchDelivery;
  readonly subscription: ReminderSubscriptionSnapshot;
}

export interface ReminderDispatchProviderRequest {
  readonly changeDirection: ReminderDispatchDirection;
  readonly changeEventAt: Date;
  readonly completeOperationDeadline: Date;
  readonly homeTimeZone: string;
  readonly providerExpiresAt: Date;
  readonly subscription: ReminderSubscriptionSnapshot;
  readonly timing: ReminderDispatchTiming;
}

/**
 * A transient failure is safe to retry. A thrown error or `uncertain` result
 * means the provider acknowledgement may have been lost and must not replay.
 * `not-authorized` means the provider completed its asynchronous preparation,
 * called the authorization hook, and did not invoke its external transport.
 */
export type ReminderDispatchProviderResult =
  | ReminderDispatchCompletionOutcome
  | { readonly kind: 'not-authorized' };

export type ReminderDispatchProviderAuthorization = () => Promise<boolean>;

export interface ReminderDispatchProvider {
  readonly send: (
    request: ReminderDispatchProviderRequest,
    authorizeBeforeExternalSend: ReminderDispatchProviderAuthorization,
  ) => Promise<ReminderDispatchProviderResult>;
}

export type ReminderDispatchResultKind =
  | 'accepted'
  | 'claimed'
  | 'expired'
  | 'not-due'
  | 'pending'
  | 'permanent-failure'
  | 'stale'
  | 'transient-failure'
  | 'uncertain';

export interface ReminderDispatchResult {
  readonly cleanupStatus?: ReminderDispatchCleanupStatus;
  readonly kind: ReminderDispatchResultKind;
}

export interface ReminderDispatchOperationDependencies {
  readonly ledger: ReminderDispatchLedgerStore;
  readonly provider: ReminderDispatchProvider;
  readonly readCurrentContext: (
    installationId: string,
    identity: ReminderDispatchIdentity,
  ) => Promise<ReminderDispatchContext | null>;
  readonly subscriptionStore: Pick<
    ReminderSubscriptionStore,
    'getSubscriptionSnapshot' | 'removeIfDeviceTokenAndGenerationMatches'
  >;
  readonly claimLeaseMs?: number;
  readonly clock?: () => Date;
}

const maximumDateMilliseconds = 8_640_000_000_000_000;

function copyDate(value: Date, name: string) {
  const milliseconds = value.getTime();
  if (
    !Number.isFinite(milliseconds) ||
    Math.abs(milliseconds) > maximumDateMilliseconds
  ) {
    throw new Error(`Invalid reminder dispatch ${name}`);
  }
  return new Date(milliseconds);
}

function parseInstant(value: string, name: string) {
  if (typeof value !== 'string')
    throw new Error(`Invalid reminder dispatch ${name}`);
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error(`Invalid reminder dispatch ${name}`);
  }
  return new Date(milliseconds);
}

function direction(value: ReminderDispatchDelivery['changeDirection']) {
  if (value === 'forward' || value === 'Forward Change')
    return 'forward' as const;
  if (value === 'backward' || value === 'Backward Change')
    return 'backward' as const;
  throw new Error('Invalid reminder dispatch direction');
}

function identityOf(
  context: ReminderDispatchContext,
): ReminderDispatchIdentity {
  const delivery = context.delivery;
  if (
    canonicalAustralianZoneId(delivery.homeTimeZone) !== delivery.homeTimeZone
  ) {
    throw new Error('Invalid reminder dispatch Home Time Zone');
  }
  if (delivery.timing !== 'one-week' && delivery.timing !== 'one-day') {
    throw new Error('Invalid reminder dispatch timing');
  }
  const eventAt = parseInstant(delivery.changeEventAt, 'Change Event instant');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(context.subscription.installationId)) {
    throw new Error('Invalid reminder dispatch installation ID');
  }
  if (
    context.subscription.attemptGeneration < 1 ||
    !Number.isSafeInteger(context.subscription.attemptGeneration)
  ) {
    throw new Error('Invalid reminder dispatch generation');
  }
  if (
    context.subscription.homeTimeZone !== delivery.homeTimeZone ||
    context.subscription.installationId.length === 0
  ) {
    throw new Error('Reminder dispatch subscription does not match its plan');
  }
  return {
    changeEventAt: eventAt.toISOString(),
    homeTimeZone: delivery.homeTimeZone,
    installationId: context.subscription.installationId,
    timing: delivery.timing,
  };
}

function parsedContext(context: ReminderDispatchContext) {
  const identity = identityOf(context);
  const delivery = context.delivery;
  const startsAt = parseInstant(
    delivery.deliveryWindow.startsAt,
    'delivery window start',
  );
  const endsAt = parseInstant(
    delivery.deliveryWindow.endsAt,
    'delivery window end',
  );
  const packValidUntil = parseInstant(
    context.activePackValidUntil,
    'pack Validity Horizon',
  );
  const completeOperationDeadline = parseInstant(
    context.completeOperationDeadline,
    'complete-operation deadline',
  );
  if (endsAt.getTime() < startsAt.getTime()) {
    throw new Error('Invalid reminder dispatch delivery window');
  }
  if (
    !context.subscription.oneDayEnabled &&
    !context.subscription.oneWeekEnabled
  ) {
    throw new Error('Reminder dispatch has no enabled timing');
  }
  if (
    (identity.timing === 'one-day' && !context.subscription.oneDayEnabled) ||
    (identity.timing === 'one-week' && !context.subscription.oneWeekEnabled)
  ) {
    throw new Error('Reminder dispatch timing is disabled');
  }
  return {
    completeOperationDeadline,
    delivery,
    endsAt,
    identity,
    packValidUntil,
    startsAt,
    eventAt: parseInstant(identity.changeEventAt, 'Change Event instant'),
  } as const;
}

function effectiveExpiry(endsAt: Date, packValidUntil: Date, eventAt: Date) {
  return new Date(
    Math.min(endsAt.getTime(), packValidUntil.getTime(), eventAt.getTime()),
  );
}

function withinDeliveryWindow(
  now: Date,
  startsAt: Date,
  endsAt: Date,
  packValidUntil: Date,
  eventAt: Date,
) {
  return (
    now.getTime() >= startsAt.getTime() &&
    now.getTime() <= endsAt.getTime() &&
    now.getTime() <= packValidUntil.getTime() &&
    now.getTime() < eventAt.getTime()
  );
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

function sameContext(
  context: ReminderDispatchContext,
  expected: ReminderDispatchContext,
) {
  const identity = identityOf(context);
  const expectedIdentity = identityOf(expected);
  return (
    sameIdentity(identity, expectedIdentity) &&
    context.subscription.attemptGeneration ===
      expected.subscription.attemptGeneration &&
    context.subscription.deviceToken === expected.subscription.deviceToken &&
    context.subscription.platform === expected.subscription.platform &&
    context.subscription.homeTimeZone === expected.subscription.homeTimeZone &&
    context.subscription.oneDayEnabled ===
      expected.subscription.oneDayEnabled &&
    context.subscription.oneWeekEnabled ===
      expected.subscription.oneWeekEnabled &&
    context.subscription.registeredAt?.getTime() ===
      expected.subscription.registeredAt?.getTime()
  );
}

function sameProviderContext(
  context: ReminderDispatchContext,
  expected: ReminderDispatchContext,
) {
  return (
    sameContext(context, expected) &&
    context.activePackValidUntil === expected.activePackValidUntil &&
    context.completeOperationDeadline === expected.completeOperationDeadline &&
    context.delivery.changeDirection === expected.delivery.changeDirection &&
    context.delivery.deliveryWindow.startsAt ===
      expected.delivery.deliveryWindow.startsAt &&
    context.delivery.deliveryWindow.endsAt ===
      expected.delivery.deliveryWindow.endsAt
  );
}

function resultForRecord(
  record: ReminderDispatchLedgerRecord | null,
): ReminderDispatchResult {
  if (record === null) return { kind: 'pending' };
  if (record.status === 'accepted') return { kind: 'accepted' };
  if (record.status === 'claimed') return { kind: 'claimed' };
  if (record.status === 'expired') return { kind: 'expired' };
  if (record.status === 'uncertain') return { kind: 'uncertain' };
  if (record.status === 'permanent-failure') {
    return {
      ...(record.cleanupStatus === undefined
        ? {}
        : { cleanupStatus: record.cleanupStatus }),
      kind: 'permanent-failure',
    };
  }
  if (record.status === 'transient-failure') {
    return { kind: 'transient-failure' };
  }
  return { kind: 'pending' };
}

function providerResult(value: unknown): ReminderDispatchProviderResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'uncertain' };
  }
  const kind = (value as { readonly kind?: unknown }).kind;
  if (
    kind === 'accepted' ||
    kind === 'transient-failure' ||
    kind === 'uncertain' ||
    kind === 'not-authorized'
  ) {
    return { kind };
  }
  if (kind === 'permanent-failure') {
    const invalidatedAt = (value as { readonly invalidatedAt?: unknown })
      .invalidatedAt;
    if (invalidatedAt !== undefined) {
      if (
        !(invalidatedAt instanceof Date) ||
        !Number.isFinite(invalidatedAt.getTime())
      ) {
        // A malformed provider invalidation timestamp cannot safely authorize
        // token cleanup. Keep the permanent result terminal without cleanup.
        return { kind, invalidToken: false };
      }
    }
    return {
      invalidToken:
        (value as { readonly invalidToken?: unknown }).invalidToken === true,
      ...(invalidatedAt === undefined
        ? {}
        : { invalidatedAt: new Date(invalidatedAt.getTime()) }),
      kind,
    };
  }
  return { kind: 'uncertain' };
}

function newerSameIdentity(
  current: ReminderDispatchContext | null,
  expected: ReminderDispatchContext,
) {
  if (current === null) return false;
  return (
    current.subscription.attemptGeneration !==
      expected.subscription.attemptGeneration &&
    sameIdentity(identityOf(current), identityOf(expected))
  );
}

export function createReminderDispatchOperation(
  dependencies: ReminderDispatchOperationDependencies,
) {
  const clock = dependencies.clock ?? (() => new Date());
  const claimLeaseMs = dependencies.claimLeaseMs;

  async function cleanupInvalidToken(
    identity: ReminderDispatchIdentity,
    attemptGeneration: number,
    sentSubscription?: ReminderSubscriptionSnapshot,
  ): Promise<ReminderDispatchCleanupStatus | undefined> {
    let record: ReminderDispatchLedgerRecord | null;
    try {
      record = await dependencies.ledger.get(identity);
    } catch {
      return 'failed';
    }
    if (
      record === null ||
      record.status !== 'permanent-failure' ||
      record.attemptGeneration !== attemptGeneration
    ) {
      return record?.cleanupStatus;
    }
    if (record.cleanupStatus === undefined) return undefined;
    if (
      record.cleanupStatus !== 'pending' &&
      record.cleanupStatus !== 'failed'
    ) {
      return record.cleanupStatus;
    }

    let cleanupStatus: ReminderDispatchCleanupStatus;
    try {
      const current =
        await dependencies.subscriptionStore.getSubscriptionSnapshot(
          identity.installationId,
        );
      if (current === null) {
        cleanupStatus = 'not-found';
      } else if (current.attemptGeneration !== attemptGeneration) {
        cleanupStatus = 'token-replaced';
      } else {
        const sent =
          sentSubscription?.attemptGeneration === attemptGeneration
            ? sentSubscription
            : current;
        cleanupStatus =
          await dependencies.subscriptionStore.removeIfDeviceTokenAndGenerationMatches(
            {
              deviceToken: sent.deviceToken,
              installationId: sent.installationId,
            },
            attemptGeneration,
            record.invalidatedAt,
          );
      }
    } catch {
      cleanupStatus = 'failed';
    }
    try {
      const result = await dependencies.ledger.updateCleanup(
        identity,
        attemptGeneration,
        cleanupStatus,
        copyDate(clock(), 'clock'),
      );
      return result.record?.cleanupStatus ?? cleanupStatus;
    } catch {
      return cleanupStatus;
    }
  }

  async function retryInvalidTokenCleanup(
    identity: ReminderDispatchIdentity,
  ): Promise<ReminderDispatchCleanupStatus | undefined> {
    let record: ReminderDispatchLedgerRecord | null;
    try {
      record = await dependencies.ledger.get(identity);
    } catch {
      return 'failed';
    }
    if (record === null || record.status !== 'permanent-failure') {
      return record?.cleanupStatus;
    }
    return cleanupInvalidToken(identity, record.attemptGeneration);
  }

  async function dispatch(
    initial: ReminderDispatchContext,
  ): Promise<ReminderDispatchResult> {
    const parsed = parsedContext(initial);
    const now = copyDate(clock(), 'clock');
    const beforeWindow = now.getTime() < parsed.startsAt.getTime();
    if (beforeWindow) return { kind: 'not-due' };

    const preparation = await dependencies.ledger.prepare({
      ...parsed.identity,
      attemptGeneration: initial.subscription.attemptGeneration,
      deliveryWindowEndsAt: parsed.endsAt,
      deliveryWindowStartsAt: parsed.startsAt,
      now,
      packValidUntil: parsed.packValidUntil,
    });
    if (
      preparation.status === 'accepted' ||
      preparation.status === 'uncertain' ||
      preparation.status === 'expired' ||
      preparation.status === 'permanent-failure'
    ) {
      const cleanupStatus =
        preparation.status === 'permanent-failure'
          ? await cleanupInvalidToken(
              parsed.identity,
              preparation.attemptGeneration,
              initial.subscription,
            )
          : preparation.cleanupStatus;
      return {
        ...resultForRecord(preparation),
        ...(cleanupStatus === undefined ? {} : { cleanupStatus }),
      };
    }

    if (
      !withinDeliveryWindow(
        now,
        parsed.startsAt,
        parsed.endsAt,
        parsed.packValidUntil,
        parsed.eventAt,
      )
    ) {
      await dependencies.ledger.claim(parsed.identity, now, claimLeaseMs);
      return resultForRecord(await dependencies.ledger.get(parsed.identity));
    }

    const claim = await dependencies.ledger.claim(
      parsed.identity,
      now,
      claimLeaseMs,
    );
    if (claim === null)
      return resultForRecord(await dependencies.ledger.get(parsed.identity));

    let current: ReminderDispatchContext | null;
    try {
      current = await dependencies.readCurrentContext(
        initial.subscription.installationId,
        parsed.identity,
      );
    } catch {
      await dependencies.ledger.release(claim, copyDate(clock(), 'clock'));
      return { kind: 'transient-failure' };
    }
    if (
      current === null ||
      !sameContext(current, initial) ||
      current.subscription.attemptGeneration !== claim.attemptGeneration
    ) {
      await dependencies.ledger.release(claim, copyDate(clock(), 'clock'));
      if (!newerSameIdentity(current, initial)) {
        await dependencies.ledger.invalidate(
          parsed.identity,
          claim.attemptGeneration,
          copyDate(clock(), 'clock'),
        );
      }
      return { kind: 'stale' };
    }

    const currentParsed = parsedContext(current);
    const sendNow = copyDate(clock(), 'clock');
    if (
      !withinDeliveryWindow(
        sendNow,
        currentParsed.startsAt,
        currentParsed.endsAt,
        currentParsed.packValidUntil,
        currentParsed.eventAt,
      ) ||
      sendNow.getTime() >= currentParsed.completeOperationDeadline.getTime()
    ) {
      await dependencies.ledger.release(claim, sendNow);
      if (
        sendNow.getTime() >= currentParsed.eventAt.getTime() ||
        sendNow.getTime() > currentParsed.endsAt.getTime() ||
        sendNow.getTime() > currentParsed.packValidUntil.getTime()
      ) {
        await dependencies.ledger.claim(parsed.identity, sendNow, claimLeaseMs);
        return resultForRecord(await dependencies.ledger.get(parsed.identity));
      }
      return { kind: 'transient-failure' };
    }

    const started = await dependencies.ledger.beginSend(claim, sendNow);
    if (started.kind === 'stale') return { kind: 'stale' };
    if (
      started.record.status !== 'claimed' ||
      started.record.claimId !== claim.claimId ||
      started.record.attemptGeneration !== claim.attemptGeneration ||
      started.record.sendStartedAt === undefined
    ) {
      return resultForRecord(started.record);
    }

    // beginSend is a durable async boundary. Re-read the subscription and
    // plan after it so a changed generation, preference, pack, or deadline
    // cannot send stale facts.
    let finalCurrent: ReminderDispatchContext | null;
    try {
      finalCurrent = await dependencies.readCurrentContext(
        initial.subscription.installationId,
        parsed.identity,
      );
    } catch {
      await dependencies.ledger.cancelBeforeProvider(
        claim,
        copyDate(clock(), 'clock'),
      );
      return { kind: 'transient-failure' };
    }
    const finalNow = copyDate(clock(), 'clock');
    if (
      finalCurrent === null ||
      !sameContext(finalCurrent, current) ||
      finalCurrent.subscription.attemptGeneration !== claim.attemptGeneration
    ) {
      await dependencies.ledger.cancelBeforeProvider(claim, finalNow);
      if (!newerSameIdentity(finalCurrent, initial)) {
        await dependencies.ledger.invalidate(
          parsed.identity,
          claim.attemptGeneration,
          finalNow,
        );
      }
      return { kind: 'stale' };
    }
    const finalParsed = parsedContext(finalCurrent);
    if (
      !withinDeliveryWindow(
        finalNow,
        finalParsed.startsAt,
        finalParsed.endsAt,
        finalParsed.packValidUntil,
        finalParsed.eventAt,
      ) ||
      finalNow.getTime() >= finalParsed.completeOperationDeadline.getTime()
    ) {
      await dependencies.ledger.cancelBeforeProvider(claim, finalNow);
      if (
        finalNow.getTime() >= finalParsed.eventAt.getTime() ||
        finalNow.getTime() > finalParsed.endsAt.getTime() ||
        finalNow.getTime() > finalParsed.packValidUntil.getTime()
      ) {
        await dependencies.ledger.claim(
          parsed.identity,
          finalNow,
          claimLeaseMs,
        );
        return resultForRecord(await dependencies.ledger.get(parsed.identity));
      }
      return { kind: 'transient-failure' };
    }

    const finalExpiry = effectiveExpiry(
      finalParsed.endsAt,
      finalParsed.packValidUntil,
      finalParsed.eventAt,
    );
    const providerExpiresAt =
      finalExpiry.getTime() < finalParsed.completeOperationDeadline.getTime()
        ? finalExpiry
        : finalParsed.completeOperationDeadline;
    const boundedDeadline = providerExpiresAt;
    const authorizeBeforeExternalSend = async () => {
      let durable: ReminderDispatchLedgerRecord | null;
      try {
        durable = await dependencies.ledger.get(parsed.identity);
      } catch {
        return false;
      }
      if (
        durable?.status !== 'claimed' ||
        durable.claimId !== claim.claimId ||
        durable.attemptGeneration !== claim.attemptGeneration ||
        durable.sendStartedAt === undefined
      ) {
        return false;
      }
      let authorizedCurrent: ReminderDispatchContext | null;
      try {
        authorizedCurrent = await dependencies.readCurrentContext(
          initial.subscription.installationId,
          parsed.identity,
        );
      } catch {
        return false;
      }
      if (
        authorizedCurrent === null ||
        !sameProviderContext(authorizedCurrent, finalCurrent) ||
        authorizedCurrent.subscription.attemptGeneration !==
          claim.attemptGeneration
      ) {
        return false;
      }
      let authorizedParsed: ReturnType<typeof parsedContext>;
      try {
        authorizedParsed = parsedContext(authorizedCurrent);
      } catch {
        return false;
      }
      const authorizedNow = copyDate(clock(), 'clock');
      if (
        !withinDeliveryWindow(
          authorizedNow,
          authorizedParsed.startsAt,
          authorizedParsed.endsAt,
          authorizedParsed.packValidUntil,
          authorizedParsed.eventAt,
        ) ||
        authorizedNow.getTime() >=
          authorizedParsed.completeOperationDeadline.getTime()
      ) {
        return false;
      }
      if (
        durable.claimExpiresAt === undefined ||
        durable.claimExpiresAt.getTime() <= authorizedNow.getTime()
      ) {
        return false;
      }
      return true;
    };
    let outcome: ReminderDispatchProviderResult;
    try {
      outcome = providerResult(
        await dependencies.provider.send(
          {
            changeDirection: direction(finalParsed.delivery.changeDirection),
            changeEventAt: finalParsed.eventAt,
            completeOperationDeadline: boundedDeadline,
            homeTimeZone: finalParsed.delivery.homeTimeZone,
            providerExpiresAt,
            subscription: finalCurrent.subscription,
            timing: finalParsed.delivery.timing,
          },
          authorizeBeforeExternalSend,
        ),
      );
    } catch {
      outcome = { kind: 'uncertain' };
    }

    if (outcome.kind === 'not-authorized') {
      await dependencies.ledger.cancelBeforeProvider(
        claim,
        copyDate(clock(), 'clock'),
      );
      return { kind: 'stale' };
    }

    let completed;
    try {
      completed = await dependencies.ledger.complete(
        claim,
        outcome,
        copyDate(clock(), 'clock'),
      );
    } catch {
      return { kind: 'uncertain' };
    }
    const record =
      completed.record ?? (await dependencies.ledger.get(parsed.identity));
    if (outcome.kind === 'permanent-failure' && outcome.invalidToken) {
      const cleanupStatus = await cleanupInvalidToken(
        parsed.identity,
        claim.attemptGeneration,
        finalCurrent.subscription,
      );
      return {
        ...resultForRecord(record),
        ...(cleanupStatus === undefined ? {} : { cleanupStatus }),
      };
    }
    return resultForRecord(record);
  }

  return { dispatch, retryInvalidTokenCleanup };
}
