import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createTableReminderDispatchLedgerStore,
  type ReminderDispatchIdentity,
  type ReminderDispatchLedgerTable,
} from './reminder-dispatch-ledger.js';
import {
  createReminderDispatchOperation,
  type ReminderDispatchContext,
  type ReminderDispatchProviderRequest,
  type ReminderDispatchProviderResult,
} from './reminder-dispatch.js';
import type {
  ReminderSubscriptionSnapshot,
  ReminderSubscriptionStore,
} from './reminder-subscriptions.js';

const identity: ReminderDispatchIdentity = {
  changeEventAt: '2026-10-04T16:00:00.000Z',
  homeTimeZone: 'Australia/Sydney',
  installationId: 'i'.repeat(43),
  timing: 'one-week',
};

const window = {
  endsAt: '2026-09-28T21:00:00.000Z',
  startsAt: '2026-09-28T09:00:00.000Z',
};

function azureError(statusCode: number) {
  return Object.assign(new Error(`Azure ${statusCode}`), { statusCode });
}

function createTable() {
  const rows = new Map<string, Record<string, unknown>>();
  let etag = 0;
  let afterReplace:
    | ((entity: Record<string, unknown>) => Promise<void>)
    | undefined;
  let loseNextReplaceAcknowledgement = false;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
  const key = (partitionKey: string, rowKey: string) =>
    `${partitionKey}/${rowKey}`;
  const table: ReminderDispatchLedgerTable = {
    async create(entity) {
      await pause();
      const rowKey = key(String(entity.partitionKey), String(entity.rowKey));
      if (rows.has(rowKey)) throw azureError(409);
      rows.set(rowKey, { ...entity, etag: String(++etag) });
    },
    async get(partitionKey, rowKey) {
      await pause();
      const row = rows.get(key(partitionKey, rowKey));
      if (row === undefined) throw azureError(404);
      return { ...row };
    },
    async replace(entity, expectedEtag) {
      await pause();
      const rowKey = key(String(entity.partitionKey), String(entity.rowKey));
      const row = rows.get(rowKey);
      if (row === undefined) throw azureError(404);
      if (row.etag !== expectedEtag) throw azureError(412);
      rows.set(rowKey, { ...entity, etag: String(++etag) });
      const hook = afterReplace;
      afterReplace = undefined;
      await hook?.(entity);
      if (loseNextReplaceAcknowledgement) {
        loseNextReplaceAcknowledgement = false;
        throw azureError(503);
      }
    },
  };
  return {
    loseNextReplaceAcknowledgement: () => {
      loseNextReplaceAcknowledgement = true;
    },
    rows,
    setAfterReplace: (
      hook: ((entity: Record<string, unknown>) => Promise<void>) | undefined,
    ) => {
      afterReplace = hook;
    },
    table,
  };
}

function preparation(attemptGeneration = 1, now = new Date(window.startsAt)) {
  return {
    ...identity,
    attemptGeneration,
    deliveryWindowEndsAt: new Date(window.endsAt),
    deliveryWindowStartsAt: new Date(window.startsAt),
    now,
    packValidUntil: new Date('2026-12-31T00:00:00.000Z'),
  };
}

describe('reminder dispatch ledger', () => {
  it('admits one concurrent claim and deduplicates accepted generations', async () => {
    const { table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    await ledger.prepare(preparation());

    const claims = await Promise.all([
      ledger.claim(identity, new Date(window.startsAt)),
      ledger.claim(identity, new Date(window.startsAt)),
    ]);
    assert.equal(claims.filter((claim) => claim !== null).length, 1);
    const claim = claims.find((candidate) => candidate !== null);
    assert.ok(claim);
    assert.equal(
      (await ledger.beginSend(claim, new Date(window.startsAt))).kind,
      'updated',
    );
    const completion = await ledger.complete(
      claim,
      { kind: 'accepted' },
      new Date(window.startsAt),
    );
    assert.equal(completion.kind, 'updated');
    assert.equal(completion.record.status, 'accepted');
    assert.equal(await ledger.claim(identity, new Date(window.startsAt)), null);

    const replay = await ledger.prepare(preparation(2));
    assert.equal(replay.status, 'accepted');
    assert.equal(replay.attemptGeneration, 1);
  });

  it('reclaims a crash before the provider send intent', async () => {
    const { table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    const firstNow = new Date(window.startsAt);
    await ledger.prepare(preparation(1, firstNow));
    const first = await ledger.claim(identity, firstNow, 1);
    assert.ok(first);

    const recovered = await ledger.claim(
      identity,
      new Date(firstNow.getTime() + 2),
      1,
    );
    assert.ok(recovered);
    assert.notEqual(recovered.claimId, first.claimId);
    assert.equal((await ledger.get(identity))?.status, 'claimed');
  });

  it('reconciles a committed claim when the write acknowledgement is lost', async () => {
    const fake = createTable();
    const ledger = createTableReminderDispatchLedgerStore(fake.table);
    const now = new Date(window.startsAt);
    await ledger.prepare(preparation(1, now));
    fake.loseNextReplaceAcknowledgement();

    const claim = await ledger.claim(identity, now);

    assert.ok(claim);
    assert.equal((await ledger.get(identity))?.claimId, claim.claimId);
  });

  it('does not let an expired worker send under a replacement claim', async () => {
    const fake = createTable();
    const ledger = createTableReminderDispatchLedgerStore(fake.table);
    const start = new Date(window.startsAt);
    await ledger.prepare(preparation(1, start));
    const oldClaim = await ledger.claim(identity, start, 1);
    assert.ok(oldClaim);
    let replacementId: string | undefined;
    fake.setAfterReplace(async (entity) => {
      if (entity.status !== 'pending' || entity.claimId !== undefined) return;
      const replacement = await ledger.claim(
        identity,
        new Date(start.getTime() + 2),
        1,
      );
      replacementId = replacement?.claimId;
    });

    const result = await ledger.beginSend(
      oldClaim,
      new Date(start.getTime() + 2),
    );

    assert.equal(result.kind, 'stale');
    assert.ok(replacementId);
    assert.equal((await ledger.get(identity))?.claimId, replacementId);
  });

  it('marks a crash after send intent uncertain and accepts a late result', async () => {
    const { table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    const firstNow = new Date(window.startsAt);
    await ledger.prepare(preparation(1, firstNow));
    const first = await ledger.claim(identity, firstNow, 1);
    assert.ok(first);
    assert.equal((await ledger.beginSend(first, firstNow)).kind, 'updated');

    assert.equal(
      await ledger.claim(identity, new Date(firstNow.getTime() + 2), 1),
      null,
    );
    assert.equal((await ledger.get(identity))?.status, 'uncertain');
    const late = await ledger.complete(
      first,
      { kind: 'accepted' },
      new Date(firstNow.getTime() + 3),
    );
    assert.equal(late.kind, 'updated');
    assert.equal(late.record.status, 'accepted');
    assert.equal(
      await ledger.claim(identity, new Date(firstNow.getTime() + 4)),
      null,
    );
  });

  it('keeps a late definitive invalid-token result after uncertainty', async () => {
    const { table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    const firstNow = new Date(window.startsAt);
    await ledger.prepare(preparation(1, firstNow));
    const first = await ledger.claim(identity, firstNow, 1);
    assert.ok(first);
    await ledger.beginSend(first, firstNow);
    assert.equal(
      await ledger.claim(identity, new Date(firstNow.getTime() + 2), 1),
      null,
    );

    const invalidatedAt = new Date('2026-09-27T07:30:00.000Z');
    const late = await ledger.complete(
      first,
      { kind: 'permanent-failure', invalidToken: true, invalidatedAt },
      new Date(firstNow.getTime() + 3),
    );

    assert.equal(late.kind, 'updated');
    assert.equal(late.record.status, 'permanent-failure');
    assert.equal(late.record.cleanupStatus, 'pending');
    assert.deepEqual(late.record.invalidatedAt, invalidatedAt);
  });

  it('reconciles an accepted completion when the write acknowledgement is lost', async () => {
    const fake = createTable();
    const ledger = createTableReminderDispatchLedgerStore(fake.table);
    const now = new Date(window.startsAt);
    await ledger.prepare(preparation(1, now));
    const claim = await ledger.claim(identity, now);
    assert.ok(claim);
    assert.equal((await ledger.beginSend(claim, now)).kind, 'updated');
    fake.loseNextReplaceAcknowledgement();

    const completion = await ledger.complete(claim, { kind: 'accepted' }, now);

    assert.equal(completion.kind, 'updated');
    assert.equal(completion.record.status, 'accepted');
  });

  it('reconciles a committed send intent when its write acknowledgement is lost', async () => {
    const fake = createTable();
    const ledger = createTableReminderDispatchLedgerStore(fake.table);
    const now = new Date(window.startsAt);
    await ledger.prepare(preparation(1, now));
    const claim = await ledger.claim(identity, now);
    assert.ok(claim);
    fake.loseNextReplaceAcknowledgement();

    const started = await ledger.beginSend(claim, now);

    assert.equal(started.kind, 'updated');
    assert.equal(
      started.record.sendStartedAt?.toISOString(),
      now.toISOString(),
    );
  });

  it('refreshes retryable metadata for the same generation after pack promotion', async () => {
    const fake = createTable();
    const ledger = createTableReminderDispatchLedgerStore(fake.table);
    const now = new Date(window.startsAt);
    await ledger.prepare(preparation(1, now));
    const claim = await ledger.claim(identity, now);
    assert.ok(claim);
    assert.equal(
      (await ledger.complete(claim, { kind: 'transient-failure' }, now)).kind,
      'updated',
    );

    const promoted = await ledger.prepare({
      ...preparation(1, now),
      deliveryWindowEndsAt: new Date('2026-09-28T22:00:00.000Z'),
      packValidUntil: new Date('2027-01-01T00:00:00.000Z'),
    });

    assert.equal(promoted.status, 'pending');
    assert.equal(
      promoted.deliveryWindowEndsAt.toISOString(),
      '2026-09-28T22:00:00.000Z',
    );
    assert.equal(
      promoted.packValidUntil.toISOString(),
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('keeps accepted, uncertain, and true expired tombstones across refresh', async () => {
    const acceptedFake = createTable();
    const acceptedLedger = createTableReminderDispatchLedgerStore(
      acceptedFake.table,
    );
    const now = new Date(window.startsAt);
    await acceptedLedger.prepare(preparation(1, now));
    const acceptedClaim = await acceptedLedger.claim(identity, now);
    assert.ok(acceptedClaim);
    await acceptedLedger.beginSend(acceptedClaim, now);
    await acceptedLedger.complete(acceptedClaim, { kind: 'accepted' }, now);
    assert.equal(
      (
        await acceptedLedger.prepare({
          ...preparation(2, now),
          deliveryWindowEndsAt: new Date('2026-09-28T22:00:00.000Z'),
        })
      ).status,
      'accepted',
    );

    const expiredFake = createTable();
    const expiredLedger = createTableReminderDispatchLedgerStore(
      expiredFake.table,
    );
    await expiredLedger.prepare(preparation(1, now));
    assert.equal(
      await expiredLedger.claim(identity, new Date('2026-09-28T21:00:00.001Z')),
      null,
    );
    assert.equal(
      (
        await expiredLedger.prepare({
          ...preparation(2, now),
          deliveryWindowEndsAt: new Date('2026-09-28T22:00:00.000Z'),
        })
      ).status,
      'expired',
    );
  });

  it('keeps exact window endpoints eligible and expires after the event or window', async () => {
    const { table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    const start = new Date(window.startsAt);
    await ledger.prepare(preparation(1, start));
    const claim = await ledger.claim(identity, start);
    assert.ok(claim);
    assert.equal((await ledger.beginSend(claim, start)).kind, 'updated');
    const transient = await ledger.complete(
      claim,
      { kind: 'transient-failure' },
      new Date(window.endsAt),
    );
    assert.equal(transient.kind, 'updated');
    assert.equal(transient.record.status, 'transient-failure');

    await ledger.prepare(preparation(1, new Date('2026-09-28T21:00:00.001Z')));
    assert.equal(
      await ledger.claim(identity, new Date('2026-09-28T21:00:00.001Z')),
      null,
    );
    assert.equal((await ledger.get(identity))?.status, 'expired');
  });

  it('checks the exact window, event, and pack boundaries', async () => {
    const windowEnd = new Date(window.endsAt);
    const windowFake = createTable();
    const windowLedger = createTableReminderDispatchLedgerStore(
      windowFake.table,
    );
    await windowLedger.prepare(preparation(1, windowEnd));
    const windowClaim = await windowLedger.claim(identity, windowEnd);
    assert.ok(windowClaim);
    assert.equal(
      (await windowLedger.beginSend(windowClaim, windowEnd)).kind,
      'updated',
    );

    const eventAt = '2026-09-28T21:00:00.000Z';
    const eventIdentity = { ...identity, changeEventAt: eventAt };
    const eventFake = createTable();
    const eventLedger = createTableReminderDispatchLedgerStore(eventFake.table);
    await eventLedger.prepare({
      ...preparation(1, windowEnd),
      ...eventIdentity,
      deliveryWindowEndsAt: new Date('2026-09-28T23:00:00.000Z'),
    });
    assert.equal(await eventLedger.claim(eventIdentity, windowEnd), null);
    assert.equal((await eventLedger.get(eventIdentity))?.expiryReason, 'event');

    const packFake = createTable();
    const packLedger = createTableReminderDispatchLedgerStore(packFake.table);
    await packLedger.prepare({
      ...preparation(1, windowEnd),
      deliveryWindowEndsAt: new Date('2026-09-28T23:00:00.000Z'),
      packValidUntil: windowEnd,
    });
    const packClaim = await packLedger.claim(identity, windowEnd);
    assert.ok(packClaim);
    assert.equal(
      (await packLedger.beginSend(packClaim, windowEnd)).kind,
      'updated',
    );
    await packLedger.complete(
      packClaim,
      { kind: 'transient-failure' },
      windowEnd,
    );
    assert.equal(
      await packLedger.claim(identity, new Date(windowEnd.getTime() + 1)),
      null,
    );
    assert.equal((await packLedger.get(identity))?.expiryReason, 'pack');
  });

  it('does not overwrite a newer generation and can refine uncertain to accepted', async () => {
    const { table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    const now = new Date(window.startsAt);
    await ledger.prepare(preparation(1, now));
    const claim = await ledger.claim(identity, now);
    assert.ok(claim);
    assert.equal((await ledger.beginSend(claim, now)).kind, 'updated');
    const newer = await ledger.prepare(preparation(2, now));
    assert.equal(newer.status, 'uncertain');
    assert.equal(newer.attemptGeneration, 1);
    assert.equal(
      (
        await ledger.prepare({
          ...preparation(2, now),
          packValidUntil: new Date('2027-01-01T00:00:00.000Z'),
        })
      ).status,
      'uncertain',
    );

    const accepted = await ledger.complete(claim, { kind: 'accepted' }, now);
    assert.equal(accepted.kind, 'updated');
    assert.equal(accepted.record.status, 'accepted');
    assert.equal(
      (await ledger.prepare(preparation(2, now))).status,
      'accepted',
    );
  });

  it('makes obsolete prepared work resettable by a later generation', async () => {
    const { table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    const now = new Date(window.startsAt);
    await ledger.prepare(preparation(1, now));
    assert.equal(
      (await ledger.invalidate(identity, 1, now)).record?.status,
      'expired',
    );
    assert.equal((await ledger.prepare(preparation(2, now))).status, 'pending');
  });

  it('does not let late cleanup failure undo a resolved cleanup', async () => {
    const { table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    const now = new Date(window.startsAt);
    await ledger.prepare(preparation(1, now));
    const claim = await ledger.claim(identity, now);
    assert.ok(claim);
    assert.equal((await ledger.beginSend(claim, now)).kind, 'updated');
    await ledger.complete(
      claim,
      { kind: 'permanent-failure', invalidToken: true },
      now,
    );
    const removed = await ledger.updateCleanup(identity, 1, 'removed', now);
    assert.equal(removed.kind, 'updated');
    assert.equal(removed.record.cleanupStatus, 'removed');
    const lateFailure = await ledger.updateCleanup(identity, 1, 'failed', now);
    assert.equal(lateFailure.kind, 'updated');
    assert.equal(lateFailure.record.cleanupStatus, 'removed');
  });
});

const subscription: ReminderSubscriptionSnapshot = {
  attemptGeneration: 1,
  deviceToken: 'fcm-token:with_valid.characters-123',
  homeTimeZone: 'Australia/Sydney',
  installationId: identity.installationId,
  oneDayEnabled: true,
  oneWeekEnabled: true,
  platform: 'android',
};

function context(
  overrides: Partial<ReminderDispatchContext> = {},
): ReminderDispatchContext {
  return {
    activePackValidUntil: '2026-12-31T00:00:00.000Z',
    completeOperationDeadline: '2026-09-29T00:00:00.000Z',
    delivery: {
      changeDirection: 'forward',
      changeEventAt: identity.changeEventAt,
      deliveryWindow: window,
      homeTimeZone: identity.homeTimeZone,
      timing: identity.timing,
    },
    subscription,
    ...overrides,
  };
}

function operationFixture(
  initial: ReminderDispatchContext = context(),
  providerResult: () => Promise<ReminderDispatchProviderResult> = async () => ({
    kind: 'accepted',
  }),
  cleanup: (
    subscription: Pick<
      ReminderSubscriptionSnapshot,
      'deviceToken' | 'installationId'
    >,
    attemptGeneration: number,
    invalidatedAt?: Date,
  ) => Promise<'removed' | 'not-found' | 'token-replaced'> = async () =>
    'removed',
) {
  const { table } = createTable();
  const ledger = createTableReminderDispatchLedgerStore(table);
  let current = initial;
  let cleanupCalls = 0;
  let cleanupInvalidatedAt: Date | undefined;
  const sent: ReminderDispatchProviderRequest[] = [];
  const store = {
    getSubscriptionSnapshot: async () => current.subscription,
    removeIfDeviceTokenAndGenerationMatches: async (
      target,
      attemptGeneration,
      invalidatedAt,
    ) => {
      cleanupCalls += 1;
      cleanupInvalidatedAt = invalidatedAt;
      return cleanup(target, attemptGeneration, invalidatedAt);
    },
  } as Pick<
    ReminderSubscriptionStore,
    'getSubscriptionSnapshot' | 'removeIfDeviceTokenAndGenerationMatches'
  >;
  const operation = createReminderDispatchOperation({
    ledger,
    provider: {
      send: async (request) => {
        sent.push(request);
        return providerResult();
      },
    },
    readCurrentContext: async () => current,
    subscriptionStore: store,
    clock: () => new Date(window.startsAt),
  });
  return {
    getCleanupCalls: () => cleanupCalls,
    getCleanupInvalidatedAt: () => cleanupInvalidatedAt,
    getCurrent: () => current,
    ledger,
    operation,
    sent,
    setCurrent: (next: ReminderDispatchContext) => {
      current = next;
    },
  };
}

describe('reminder dispatch operation', () => {
  it('passes explicit provider expiry and bounded completion deadline', async () => {
    const fixture = operationFixture();
    const result = await fixture.operation.dispatch(context());
    assert.equal(result.kind, 'accepted');
    assert.equal(fixture.sent.length, 1);
    const request = fixture.sent[0];
    assert.ok(request);
    assert.equal(request.providerExpiresAt.toISOString(), window.endsAt);
    assert.equal(
      request.completeOperationDeadline.toISOString(),
      window.endsAt,
    );
  });

  it('keeps unknown provider acknowledgement terminal and does not replay', async () => {
    let calls = 0;
    const fixture = operationFixture(context(), async () => {
      calls += 1;
      throw new Error('acknowledgement lost');
    });
    assert.equal(
      (await fixture.operation.dispatch(context())).kind,
      'uncertain',
    );
    assert.equal(
      (await fixture.operation.dispatch(context())).kind,
      'uncertain',
    );
    assert.equal(calls, 1);
    assert.equal(fixture.sent.length, 1);
  });

  it('retries invalid-token cleanup independently without resending', async () => {
    let sends = 0;
    let cleanupAttempts = 0;
    const invalidatedAt = new Date('2026-09-27T07:30:00.000Z');
    const fixture = operationFixture(
      context(),
      async () => {
        sends += 1;
        return { kind: 'permanent-failure', invalidToken: true, invalidatedAt };
      },
      async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error('storage unavailable');
        return 'removed';
      },
    );
    const first = await fixture.operation.dispatch(context());
    assert.equal(first.kind, 'permanent-failure');
    assert.equal(first.cleanupStatus, 'failed');
    assert.deepEqual(
      (await fixture.ledger.get(identity))?.invalidatedAt,
      invalidatedAt,
    );
    const second = await fixture.operation.dispatch(context());
    assert.equal(second.kind, 'permanent-failure');
    assert.equal(second.cleanupStatus, 'removed');
    assert.equal(sends, 1);
    assert.equal(fixture.sent.length, 1);
    assert.equal(cleanupAttempts, 2);
    assert.deepEqual(fixture.getCleanupInvalidatedAt(), invalidatedAt);
  });

  it('retries persisted cleanup after the window without dispatch context', async () => {
    let now = new Date(window.startsAt);
    const { table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    let cleanupAttempts = 0;
    let sends = 0;
    const subscriptionStore: Pick<
      ReminderSubscriptionStore,
      'getSubscriptionSnapshot' | 'removeIfDeviceTokenAndGenerationMatches'
    > = {
      getSubscriptionSnapshot: async () => subscription,
      removeIfDeviceTokenAndGenerationMatches: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error('cleanup unavailable');
        return 'removed';
      },
    };
    const firstWorker = createReminderDispatchOperation({
      ledger,
      provider: {
        send: async () => {
          sends += 1;
          return { kind: 'permanent-failure', invalidToken: true } as const;
        },
      },
      readCurrentContext: async () => context(),
      subscriptionStore,
      clock: () => now,
    });
    const first = await firstWorker.dispatch(context());
    assert.equal(first.kind, 'permanent-failure');
    assert.equal(first.cleanupStatus, 'failed');

    now = new Date('2026-09-29T00:00:00.000Z');
    const restartedWorker = createReminderDispatchOperation({
      ledger,
      provider: {
        send: async () => {
          throw new Error('cleanup retry must not send');
        },
      },
      readCurrentContext: async () => {
        throw new Error('cleanup retry must not read dispatch context');
      },
      subscriptionStore,
      clock: () => now,
    });
    assert.equal(
      await restartedWorker.retryInvalidTokenCleanup(identity),
      'removed',
    );
    assert.equal(sends, 1);
    assert.equal(cleanupAttempts, 2);
  });

  it('does not perform cleanup when provider invalidation metadata is malformed', async () => {
    const fixture = operationFixture(context(), async () => ({
      kind: 'permanent-failure',
      invalidToken: true,
      invalidatedAt: 'not-a-date' as never,
    }));

    const result = await fixture.operation.dispatch(context());

    assert.equal(result.kind, 'permanent-failure');
    assert.equal(fixture.getCleanupCalls(), 0);
    assert.equal(
      (await fixture.ledger.get(identity))?.cleanupStatus,
      undefined,
    );
  });

  it('does not run cleanup for a generic permanent provider rejection', async () => {
    const fixture = operationFixture(context(), async () => ({
      kind: 'permanent-failure',
      invalidToken: false,
    }));
    assert.equal(
      (await fixture.operation.dispatch(context())).kind,
      'permanent-failure',
    );
    assert.equal(fixture.getCleanupCalls(), 0);
  });

  it('requires provider reauthorization after asynchronous preparation', async () => {
    const fixture = operationFixture();
    let releasePreparation!: () => void;
    let providerEntered!: () => void;
    const preparationComplete = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const providerStarted = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    let sends = 0;
    const operation = createReminderDispatchOperation({
      ledger: fixture.ledger,
      provider: {
        send: async (_request, authorize) => {
          providerEntered();
          await preparationComplete;
          if (!(await authorize())) return { kind: 'not-authorized' as const };
          sends += 1;
          return { kind: 'accepted' as const };
        },
      },
      readCurrentContext: async () => fixture.getCurrent(),
      subscriptionStore: {
        getSubscriptionSnapshot: async () => fixture.getCurrent().subscription,
        removeIfDeviceTokenAndGenerationMatches: async () => 'removed',
      },
      clock: () => new Date(window.startsAt),
    });
    const dispatch = operation.dispatch(context());
    await providerStarted;
    fixture.setCurrent(
      context({ subscription: { ...subscription, attemptGeneration: 2 } }),
    );
    releasePreparation();

    assert.equal((await dispatch).kind, 'stale');
    assert.equal(sends, 0);
    assert.equal((await fixture.ledger.get(identity))?.status, 'pending');
  });

  it('performs ownership reconciliation before the final authorization check', async () => {
    const fixture = operationFixture();
    let delayNextRead = false;
    let releaseLedgerRead!: () => void;
    let ledgerReadStarted!: () => void;
    const ledgerReadComplete = new Promise<void>((resolve) => {
      releaseLedgerRead = resolve;
    });
    const ledgerReadEntered = new Promise<void>((resolve) => {
      ledgerReadStarted = resolve;
    });
    const ledger = {
      ...fixture.ledger,
      get: async (target: ReminderDispatchIdentity) => {
        if (delayNextRead) {
          delayNextRead = false;
          ledgerReadStarted();
          await ledgerReadComplete;
        }
        return fixture.ledger.get(target);
      },
    };
    let now = new Date(window.startsAt);
    let sends = 0;
    const operation = createReminderDispatchOperation({
      ledger,
      provider: {
        send: async (_request, authorize) => {
          delayNextRead = true;
          if (!(await authorize())) return { kind: 'not-authorized' as const };
          sends += 1;
          return { kind: 'accepted' as const };
        },
      },
      readCurrentContext: async () => fixture.getCurrent(),
      subscriptionStore: {
        getSubscriptionSnapshot: async () => fixture.getCurrent().subscription,
        removeIfDeviceTokenAndGenerationMatches: async () => 'removed',
      },
      clock: () => now,
    });
    const dispatch = operation.dispatch(context());
    await ledgerReadEntered;
    fixture.setCurrent(
      context({ subscription: { ...subscription, attemptGeneration: 2 } }),
    );
    now = new Date('2026-09-28T21:00:00.001Z');
    releaseLedgerRead();

    assert.equal((await dispatch).kind, 'stale');
    assert.equal(sends, 0);
    assert.equal((await fixture.ledger.get(identity))?.status, 'pending');
  });

  it('abandons a claim when the post-intent context becomes stale', async () => {
    const fixture = operationFixture();
    let reads = 0;
    const newer = context({
      subscription: { ...subscription, attemptGeneration: 2 },
    });
    const operation = createReminderDispatchOperation({
      ledger: fixture.ledger,
      provider: { send: async () => ({ kind: 'accepted' as const }) },
      readCurrentContext: async () => {
        reads += 1;
        return reads === 1 ? context() : newer;
      },
      subscriptionStore: {
        getSubscriptionSnapshot: async () => newer.subscription,
        removeIfDeviceTokenAndGenerationMatches: async () => 'removed',
      },
      clock: () => new Date(window.startsAt),
    });
    assert.equal((await operation.dispatch(context())).kind, 'stale');
    assert.equal(reads, 2);
    assert.equal(fixture.sent.length, 0);
    assert.equal((await fixture.ledger.get(identity))?.status, 'pending');
  });

  it('does not catch up after the delivery window', async () => {
    const fixture = operationFixture();
    const late = new Date('2026-09-29T00:00:00.000Z');
    const operation = createReminderDispatchOperation({
      ledger: fixture.ledger,
      provider: { send: async () => ({ kind: 'accepted' as const }) },
      readCurrentContext: async () => context(),
      subscriptionStore: {
        getSubscriptionSnapshot: async () => subscription,
        removeIfDeviceTokenAndGenerationMatches: async () => 'removed',
      },
      clock: () => late,
    });
    assert.equal((await operation.dispatch(context())).kind, 'expired');
    assert.equal(fixture.sent.length, 0);
  });
});
