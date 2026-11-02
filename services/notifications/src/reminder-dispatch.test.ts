import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAzureReminderDispatchLedgerStore,
  createTableReminderDispatchLedgerStore,
  type ReminderDispatchCleanupStatus,
  type ReminderDispatchIdentity,
  type ReminderDispatchLedgerRecord,
  type ReminderDispatchLedgerTable,
} from './reminder-dispatch-ledger.ts';
import {
  createReminderDispatchOperation,
  type ReminderDispatchContext,
  type ReminderDispatchOperationDependencies,
  type ReminderDispatchProviderRequest,
  type ReminderDispatchProviderResult,
} from './reminder-dispatch.ts';
import type {
  ReminderSubscriptionSnapshot,
  ReminderSubscriptionStore,
} from './reminder-subscriptions.ts';

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

// Fails a test whose awaited work never settles, instead of letting it hang.
// Seshat treats a hang, or node:test's own timeout, as an unresolved mutant
// and then withholds the mutation score.
function settled<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new assert.AssertionError({ message: 'Work did not settle' })),
      1000,
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

// Waits until a dispatch reaches a test barrier. A dispatch that settles
// first fails the test, rather than leaving its rejection unhandled: Seshat
// counts an unhandled rejection as an execution error and withholds the score.
function reached(barrier: Promise<void>, dispatch: Promise<unknown>) {
  return settled(
    Promise.race([
      barrier,
      dispatch.then(() => assert.fail('Dispatch settled before the barrier')),
    ]),
  );
}

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
  let deletes = 0;
  let failingDelete: number | undefined;
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
    async delete(partitionKey, rowKey, expectedEtag) {
      await pause();
      deletes += 1;
      if (deletes === failingDelete) throw azureError(503);
      const id = key(partitionKey, rowKey);
      const row = rows.get(id);
      if (row === undefined) throw azureError(404);
      if (row.etag !== expectedEtag) throw azureError(412);
      rows.delete(id);
    },
    async get(partitionKey, rowKey) {
      await pause();
      const row = rows.get(key(partitionKey, rowKey));
      if (row === undefined) throw azureError(404);
      return { ...row };
    },
    // Lists every row: the store must not trust the server-side filter.
    async *listUnsettledPages() {
      yield [...rows.values()].map((row) => ({ ...row }));
    },
    // Lists every row, not only old ones: the store must apply the retention
    // boundary itself rather than trust the server-side filter.
    async *listUpdatedBefore() {
      for (const row of [...rows.values()]) {
        await pause();
        yield { ...row };
      }
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
    failDelete: (call: number) => {
      failingDelete = deletes + call;
    },
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

  it('resets a pack expiry only for a pack that is still valid', async () => {
    const { table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    const now = new Date(window.startsAt);
    const later = new Date(now.getTime() + 1);
    await ledger.prepare({ ...preparation(1, now), packValidUntil: now });
    assert.equal(await ledger.claim(identity, later), null);
    assert.equal((await ledger.get(identity))?.expiryReason, 'pack');

    assert.equal(
      (
        await ledger.prepare({
          ...preparation(1, later),
          packValidUntil: now,
        })
      ).status,
      'expired',
    );
    assert.equal(
      (
        await ledger.prepare({
          ...preparation(1, later),
          packValidUntil: later,
        })
      ).status,
      'pending',
    );
  });

  it('lets a later generation reset a pack expiry', async () => {
    const { table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    const now = new Date(window.startsAt);
    const later = new Date(now.getTime() + 1);
    await ledger.prepare({ ...preparation(1, now), packValidUntil: now });
    assert.equal(await ledger.claim(identity, later), null);

    const reset = await ledger.prepare(preparation(2, later));

    assert.equal(reset.status, 'pending');
    assert.equal(reset.attemptGeneration, 2);
  });

  for (const outcome of [
    { kind: 'accepted' },
    { kind: 'permanent-failure', invalidToken: false },
    { kind: 'uncertain' },
  ] as const) {
    it(`keeps the ${outcome.kind} status when invalidated`, async () => {
      const { table } = createTable();
      const ledger = createTableReminderDispatchLedgerStore(table);
      const now = new Date(window.startsAt);
      await ledger.prepare(preparation(1, now));
      const claim = await ledger.claim(identity, now);
      assert.ok(claim);
      await ledger.beginSend(claim, now);
      await ledger.complete(claim, outcome, now);

      const result = await ledger.invalidate(identity, 1, now);

      assert.equal(result.kind, 'updated');
      assert.equal(result.record?.status, outcome.kind);
      assert.equal((await ledger.get(identity))?.status, outcome.kind);
    });
  }

  it('does not replace the reason on a true expiry when invalidated', async () => {
    const { table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    await ledger.prepare(preparation(1));
    const afterWindow = new Date('2026-09-28T21:00:00.001Z');
    assert.equal(await ledger.claim(identity, afterWindow), null);

    await ledger.invalidate(identity, 1, afterWindow);

    assert.equal((await ledger.get(identity))?.expiryReason, 'window');
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

describe('reminder dispatch ledger retention', () => {
  const day = 24 * 60 * 60 * 1000;
  const updatedAt = new Date(window.startsAt);
  const retentionEnds = new Date(updatedAt.getTime() + 30 * day);
  const purgedAt = new Date(retentionEnds.getTime() + 1);

  function installation(letter: string) {
    return { ...preparation(1, updatedAt), installationId: letter.repeat(43) };
  }

  it('keeps a record until more than 30 days after its last update', async () => {
    const { rows, table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    await ledger.prepare(preparation(1, updatedAt));
    await ledger.purgeExpired(retentionEnds);
    assert.equal(rows.size, 1);
    await ledger.purgeExpired(purgedAt);
    assert.equal(rows.size, 0);
  });

  it('measures retention from the last update, not creation', async () => {
    const { rows, table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    await ledger.prepare(preparation(1, updatedAt));
    const laterUpdate = new Date(updatedAt.getTime() + 5 * day);
    await ledger.invalidate(identity, 1, laterUpdate);
    await ledger.purgeExpired(purgedAt);
    assert.equal(rows.size, 1);
    await ledger.purgeExpired(new Date(laterUpdate.getTime() + 30 * day + 1));
    assert.equal(rows.size, 0);
  });

  it('keeps an old record until its Change Event', async () => {
    const { rows, table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    const changeEventAt = new Date(identity.changeEventAt);
    await ledger.prepare(
      preparation(1, new Date(changeEventAt.getTime() - 45 * day)),
    );
    await ledger.purgeExpired(new Date(changeEventAt.getTime() - 1));
    assert.equal(rows.size, 1);
    await ledger.purgeExpired(changeEventAt);
    assert.equal(rows.size, 0);
  });

  it('does not resend an accepted reminder after its record is purged', async () => {
    const { table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    await ledger.prepare(preparation(1, updatedAt));
    const claim = await ledger.claim(identity, updatedAt);
    assert.ok(claim);
    await ledger.beginSend(claim, updatedAt);
    await ledger.complete(claim, { kind: 'accepted' }, updatedAt);
    await ledger.purgeExpired(purgedAt);
    assert.equal(await ledger.get(identity), null);

    await ledger.prepare(preparation(1, purgedAt));
    assert.equal(await ledger.claim(identity, purgedAt), null);
    const record = await ledger.get(identity);
    assert.equal(record?.status, 'expired');
    assert.equal(record?.expiryReason, 'event');
  });

  it('keeps a record that a dispatch changes during the purge', async () => {
    const { rows, table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    await ledger.prepare(preparation(1, updatedAt));
    const racing = createTableReminderDispatchLedgerStore({
      ...table,
      async *listUpdatedBefore(cutoff) {
        for await (const entity of table.listUpdatedBefore(cutoff)) {
          await ledger.invalidate(identity, 1, purgedAt);
          yield entity;
        }
      },
    });
    await racing.purgeExpired(purgedAt);
    assert.equal(rows.size, 1);
    assert.deepEqual((await ledger.get(identity))?.updatedAt, purgedAt);
  });

  it('stops at a storage failure and resumes on the next run', async () => {
    const { failDelete, rows, table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    for (const letter of ['a', 'b', 'c']) {
      await ledger.prepare(installation(letter));
    }
    failDelete(2);
    await assert.rejects(ledger.purgeExpired(purgedAt), /Azure 503/);
    assert.equal(rows.size, 2);
    await ledger.purgeExpired(purgedAt);
    assert.equal(rows.size, 0);
  });

  it('skips and counts a row it cannot date, then purges the rest', async () => {
    const { rows, table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    await ledger.prepare(installation('a'));
    // Listed between the others, so a purge that stopped here would leave 'c'.
    rows.set('zone/unreadable', {
      etag: 'unreadable',
      partitionKey: 'zone',
      rowKey: 'unreadable',
      updatedAt: 'not an instant',
    });
    await ledger.prepare(installation('c'));

    assert.equal(await ledger.purgeExpired(purgedAt), 1);
    assert.deepEqual([...rows.keys()], ['zone/unreadable']);
  });

  it('purges an old row whose Change Event it cannot read', async () => {
    const { rows, table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    rows.set('zone/unreadable', {
      changeEventAt: 'not an instant',
      etag: 'unreadable',
      partitionKey: 'zone',
      rowKey: 'unreadable',
      updatedAt,
    });
    await ledger.prepare(installation('c'));

    assert.equal(await ledger.purgeExpired(purgedAt), 0);
    assert.equal(rows.size, 0);
  });

  it('lets overlapping runs finish without double deletion errors', async () => {
    const { rows, table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    for (const letter of ['a', 'b', 'c']) {
      await ledger.prepare(installation(letter));
    }
    await settled(
      Promise.all([
        ledger.purgeExpired(purgedAt),
        ledger.purgeExpired(purgedAt),
      ]),
    );
    assert.equal(rows.size, 0);
  });

  it('handles an empty ledger and leaves recent partitions alone', async () => {
    const { rows, table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    await ledger.purgeExpired(purgedAt);
    assert.equal(rows.size, 0);

    await ledger.prepare(preparation(1, updatedAt));
    await ledger.prepare({
      ...preparation(1, purgedAt),
      homeTimeZone: 'Australia/Perth',
    });
    await ledger.purgeExpired(purgedAt);
    assert.deepEqual(
      [...rows.values()].map((row) => row.homeTimeZone),
      ['Australia/Perth'],
    );
  });

  it('stores no push token or credential in ledger rows', async () => {
    const { rows, table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    await ledger.prepare(preparation(1, updatedAt));
    const [entity] = rows.values();
    assert.ok(entity);
    assert.deepEqual(
      Object.keys(entity).filter((name) => /token|credential/i.test(name)),
      [],
    );
  });

  it('queries Azure for old records and deletes them conditionally', async () => {
    let filter = '';
    const deleted: unknown[] = [];
    const ledger = createAzureReminderDispatchLedgerStore(
      {
        REMINDER_MANAGED_IDENTITY_CLIENT_ID: 'runtime-uami-client-id',
        REMINDER_STORAGE_ACCOUNT_NAME: 'dlsvstorage',
      },
      {
        createCredential: () => ({
          getToken: async () => ({ expiresOnTimestamp: 0, token: 'test' }),
        }),
        createTableClient: () =>
          ({
            deleteEntity: async (...args: unknown[]) => {
              deleted.push(args);
            },
            listEntities: (options: {
              readonly queryOptions?: { readonly filter?: unknown };
            }) => {
              filter = String(options.queryOptions?.filter);
              return (async function* () {
                yield {
                  changeEventAt: identity.changeEventAt,
                  etag: 'old',
                  partitionKey: 'zone',
                  rowKey: 'delivery',
                  updatedAt,
                };
              })();
            },
          }) as never,
      },
    );
    await ledger.purgeExpired(purgedAt);
    assert.equal(filter, "updatedAt lt datetime'2026-09-28T09:00:00.001Z'");
    assert.deepEqual(deleted, [['zone', 'delivery', { etag: 'old' }]]);
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
    warned: false,
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

describe('reminder dispatch sweep markers', () => {
  const sweptWindow = {
    changeEventAt: identity.changeEventAt,
    homeTimeZone: identity.homeTimeZone,
    timing: identity.timing,
  };
  const now = new Date(window.startsAt);
  const dayMilliseconds = 24 * 60 * 60 * 1000;

  it('stores no installation data', async () => {
    const { rows, table } = createTable();
    await createTableReminderDispatchLedgerStore(table).recordSweep(
      sweptWindow,
      true,
      now,
    );

    const {
      etag: _etag,
      partitionKey: _partition,
      rowKey: _row,
      ...fields
    } = [...rows.values()][0]!;
    assert.deepEqual(fields, {
      ...sweptWindow,
      sweep: 'complete',
      updatedAt: now,
    });
  });

  it('never shares a key with a delivery', async () => {
    const { rows, table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);

    await ledger.prepare(preparation());
    await ledger.recordSweep(sweptWindow, true, now);

    assert.equal(rows.size, 2);
  });

  it('keeps one marker for each zone, Change Event and timing', async () => {
    const { rows, table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);

    await ledger.recordSweep(sweptWindow, true, now);
    await ledger.recordSweep({ ...sweptWindow, timing: 'one-day' }, true, now);
    await ledger.recordSweep(
      { ...sweptWindow, homeTimeZone: 'Australia/Hobart' },
      true,
      now,
    );
    await ledger.recordSweep(
      { ...sweptWindow, changeEventAt: '2027-04-03T16:00:00.000Z' },
      true,
      now,
    );

    assert.equal(rows.size, 4);
  });

  it('writes nothing for a window already finished or reported', async () => {
    const { rows, table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);

    await ledger.recordSweep(sweptWindow, true, now);
    const [before] = [...rows.values()];
    await ledger.recordSweep(sweptWindow, false, now);
    await ledger.recordSweep(sweptWindow, true, now);

    assert.deepEqual([...rows.values()], [before]);
  });

  it('propagates a storage failure rather than reporting', async () => {
    const { table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore({
      ...table,
      create: async () => {
        throw azureError(503);
      },
      get: async () => {
        throw azureError(404);
      },
    });

    await assert.rejects(ledger.reportClosedWindow(sweptWindow, now));
    await assert.rejects(ledger.recordSweep(sweptWindow, true, now));
  });

  it('propagates a failed read', async () => {
    const { table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore({
      ...table,
      get: async () => {
        throw azureError(503);
      },
    });

    await assert.rejects(ledger.reportClosedWindow(sweptWindow, now));
  });

  it('is purged like any ledger row', async () => {
    const { rows, table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    await ledger.recordSweep(sweptWindow, true, now);

    await ledger.purgeExpired(new Date(now.getTime() + 29 * dayMilliseconds));
    assert.equal(rows.size, 1);

    await ledger.purgeExpired(new Date(now.getTime() + 31 * dayMilliseconds));
    assert.equal(rows.size, 0);
  });
});

describe('unsettled reminder dispatch records', () => {
  const closedAt = new Date(Date.parse(window.endsAt) + 1);

  async function unsettled(
    ledger: ReturnType<typeof createTableReminderDispatchLedgerStore>,
    now: Date,
  ) {
    const records = [];
    for await (const page of ledger.listUnsettledPages(now, () => undefined)) {
      records.push(...page);
    }
    return records;
  }

  it('skips a row it cannot read and keeps the rest of the page', async () => {
    const { rows, table } = createTable();
    const ledger = createTableReminderDispatchLedgerStore(table);
    rows.set('invalid', { status: 'pending' });
    await ledger.prepare(preparation());
    let invalid = 0;

    const pages = [];
    for await (const page of ledger.listUnsettledPages(closedAt, () => {
      invalid += 1;
    })) {
      pages.push(page.map((record) => record.installationId));
    }

    assert.deepEqual(pages, [[identity.installationId]]);
    assert.equal(invalid, 1);
  });

  for (const status of ['pending', 'claimed', 'transient-failure'] as const) {
    it(`lists a ${status} record only after its window closes`, async () => {
      const { rows, table } = createTable();
      const ledger = createTableReminderDispatchLedgerStore(table);
      await ledger.prepare(preparation());
      const row = [...rows.values()][0]!;
      row.status = status;

      assert.deepEqual(await unsettled(ledger, new Date(window.endsAt)), []);
      assert.equal((await unsettled(ledger, closedAt)).length, 1);
    });
  }

  for (const [cleanupStatus, listed] of [
    [undefined, 0],
    ['pending', 1],
    ['failed', 1],
    ['removed', 0],
    ['not-found', 0],
    ['token-replaced', 0],
  ] as const) {
    it(`lists a rejected token with cleanup ${cleanupStatus} ${listed} times`, async () => {
      const { rows, table } = createTable();
      const ledger = createTableReminderDispatchLedgerStore(table);
      await ledger.prepare(preparation());
      const row = [...rows.values()][0]!;
      row.status = 'permanent-failure';
      if (cleanupStatus !== undefined) row.cleanupStatus = cleanupStatus;

      assert.equal(
        (await unsettled(ledger, new Date(window.startsAt))).length,
        listed,
      );
    });
  }

  for (const status of ['accepted', 'expired', 'uncertain'] as const) {
    it(`does not list a ${status} record`, async () => {
      const { rows, table } = createTable();
      const ledger = createTableReminderDispatchLedgerStore(table);
      await ledger.prepare(preparation());
      [...rows.values()][0]!.status = status;

      assert.deepEqual(await unsettled(ledger, closedAt), []);
    });
  }

  it('asks Azure for bounded pages of unsettled records', async () => {
    let filter = '';
    let pageSize: number | undefined;
    const ledger = createAzureReminderDispatchLedgerStore(
      {
        REMINDER_MANAGED_IDENTITY_CLIENT_ID: 'runtime-uami-client-id',
        REMINDER_STORAGE_ACCOUNT_NAME: 'dlsvstorage',
      },
      {
        createCredential: () => ({
          getToken: async () => ({ expiresOnTimestamp: 0, token: 'test' }),
        }),
        createTableClient: () =>
          ({
            listEntities: (options: {
              readonly queryOptions: { readonly filter: string };
            }) => {
              filter = options.queryOptions.filter;
              return {
                byPage: (settings: { readonly maxPageSize: number }) => {
                  pageSize = settings.maxPageSize;
                  return (async function* () {
                    yield [];
                  })();
                },
              };
            },
          }) as never,
      },
    );

    await unsettled(ledger, closedAt);

    assert.equal(
      filter,
      "((status eq 'pending' or status eq 'claimed' or status eq 'transient-failure') and deliveryWindowEndsAt lt datetime'2026-09-28T21:00:00.001Z') or (status eq 'permanent-failure' and (cleanupStatus eq 'pending' or cleanupStatus eq 'failed'))",
    );
    assert.equal(pageSize, 100);
  });
});

const oneDay = context({
  delivery: { ...context().delivery, timing: 'one-day' },
});

// Changes to the registration, or to what identifies its delivery. A row that
// starts from another context says so, because the change must leave the
// delivered timing enabled.
const registrationChanges: readonly [
  string,
  ReminderDispatchContext,
  ReminderDispatchContext?,
][] = [
  [
    'registration',
    context({
      subscription: { ...subscription, deviceToken: 'fcm-token:rotated' },
    }),
  ],
  [
    'registration generation',
    context({ subscription: { ...subscription, attemptGeneration: 2 } }),
  ],
  ['platform', context({ subscription: { ...subscription, platform: 'ios' } })],
  [
    'registration time',
    context({
      subscription: {
        ...subscription,
        registeredAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    }),
  ],
  [
    'one-day preference',
    context({ subscription: { ...subscription, oneDayEnabled: false } }),
  ],
  [
    'one-week preference',
    { ...oneDay, subscription: { ...subscription, oneWeekEnabled: false } },
    oneDay,
  ],
  [
    'installation',
    context({
      subscription: { ...subscription, installationId: 'j'.repeat(43) },
    }),
  ],
  [
    'Home Time Zone',
    context({
      delivery: { ...context().delivery, homeTimeZone: 'Australia/Brisbane' },
      subscription: { ...subscription, homeTimeZone: 'Australia/Brisbane' },
    }),
  ],
  ['timing', oneDay],
  [
    'Change Event',
    context({
      delivery: {
        ...context().delivery,
        changeEventAt: '2026-10-05T16:00:00.000Z',
      },
    }),
  ],
];

// Changes to the plan that the provider's request depends on.
const planChanges: readonly [
  string,
  ReminderDispatchContext,
  ReminderDispatchContext?,
][] = [
  [
    'pack validity',
    context({ activePackValidUntil: '2027-01-01T00:00:00.000Z' }),
  ],
  [
    'operation deadline',
    context({ completeOperationDeadline: '2026-09-28T23:00:00.000Z' }),
  ],
  [
    'direction',
    context({
      delivery: { ...context().delivery, changeDirection: 'backward' },
    }),
  ],
  [
    'window start',
    context({
      delivery: {
        ...context().delivery,
        deliveryWindow: { ...window, startsAt: '2026-09-28T08:00:00.000Z' },
      },
    }),
  ],
  [
    'window end',
    context({
      delivery: {
        ...context().delivery,
        deliveryWindow: { ...window, endsAt: '2026-09-28T20:00:00.000Z' },
      },
    }),
  ],
];

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

  // A registration can make contact after the plan was read, and the send
  // follows the subscription as last read. That read is not a changed plan.
  for (const [name, planned, read] of [
    ['stops warning', true, false],
    ['starts warning', false, true],
  ] as const) {
    it(`${name} when the read before the send says so`, async () => {
      const fixture = operationFixture(context({ warned: read }));

      const result = await fixture.operation.dispatch(
        context({ warned: planned }),
      );

      assert.equal(result.kind, 'accepted');
      assert.equal(fixture.sent[0]?.warned, read);
    });
  }

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
    await reached(providerStarted, dispatch);
    fixture.setCurrent(
      context({ subscription: { ...subscription, attemptGeneration: 2 } }),
    );
    releasePreparation();

    assert.equal((await dispatch).kind, 'stale');
    assert.equal(sends, 0);
    assert.equal((await fixture.ledger.get(identity))?.status, 'pending');
  });

  it('rejects an old-zone dispatch after a newer registration is observed', async () => {
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
    await reached(providerStarted, dispatch);
    fixture.setCurrent(
      context({
        delivery: {
          ...context().delivery,
          homeTimeZone: 'Australia/Brisbane',
        },
        subscription: {
          ...subscription,
          attemptGeneration: 2,
          homeTimeZone: 'Australia/Brisbane',
        },
      }),
    );
    releasePreparation();

    assert.equal((await dispatch).kind, 'stale');
    assert.equal(sends, 0);
    assert.equal(
      (await fixture.ledger.get(identity))?.expiryReason,
      'superseded',
    );
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
    await reached(ledgerReadEntered, dispatch);
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

  describe('a plan that changes under a claim', () => {
    // The current context is read before the send intent, and again after it.
    async function dispatchChangedAtRead(
      changedRead: number,
      changed: ReminderDispatchContext | null,
    ) {
      const fixture = operationFixture();
      let reads = 0;
      const operation = createReminderDispatchOperation({
        ledger: fixture.ledger,
        provider: { send: async () => assert.fail('Sent a changed plan') },
        readCurrentContext: async () =>
          ++reads < changedRead ? context() : changed,
        subscriptionStore: {
          getSubscriptionSnapshot: async () => null,
          removeIfDeviceTokenAndGenerationMatches: async () => 'removed',
        },
        clock: () => new Date(window.startsAt),
      });
      assert.equal((await operation.dispatch(context())).kind, 'stale');
      return fixture.ledger.get(identity);
    }

    for (const [when, changedRead] of [
      ['before', 1],
      ['after', 2],
    ] as const) {
      it(`closes the record when the subscription is deleted ${when} the send intent`, async () => {
        const record = await dispatchChangedAtRead(changedRead, null);

        assert.equal(record?.status, 'expired');
        assert.equal(record?.expiryReason, 'superseded');
      });
    }

    it('keeps the record for a newer registration seen before the send intent', async () => {
      const newer = context({
        subscription: { ...subscription, attemptGeneration: 2 },
      });

      assert.equal((await dispatchChangedAtRead(1, newer))?.status, 'pending');
    });
  });

  for (const [given, sent] of [
    ['forward', 'forward'],
    ['Forward Change', 'forward'],
    ['backward', 'backward'],
    ['Backward Change', 'backward'],
  ] as const) {
    it(`sends the ${given} direction to the provider as ${sent}`, async () => {
      const delivery = { ...context().delivery, changeDirection: given };
      const fixture = operationFixture(context({ delivery }));

      await fixture.operation.dispatch(context({ delivery }));

      assert.equal(fixture.sent[0]?.changeDirection, sent);
    });
  }

  it('sends nothing for an unknown direction', async () => {
    const delivery = {
      ...context().delivery,
      changeDirection: 'sideways' as never,
    };
    const fixture = operationFixture(context({ delivery }));

    await fixture.operation.dispatch(context({ delivery }));

    assert.deepEqual(fixture.sent, []);
  });

  // Runs the final authorization at `at`, on a claim taken at `from`, after the
  // current context has become `next`.
  async function authorizedAfter(
    next: ReminderDispatchContext,
    initial = context(),
    from = window.startsAt,
    at = from,
  ) {
    const fixture = operationFixture(initial);
    let now = new Date(from);
    let authorized: boolean | undefined;
    const operation = createReminderDispatchOperation({
      ledger: fixture.ledger,
      provider: {
        send: async (_request, authorize) => {
          fixture.setCurrent(next);
          now = new Date(at);
          authorized = await authorize();
          return { kind: authorized ? 'accepted' : 'not-authorized' };
        },
      },
      readCurrentContext: async () => fixture.getCurrent(),
      subscriptionStore: {
        getSubscriptionSnapshot: async () => fixture.getCurrent().subscription,
        removeIfDeviceTokenAndGenerationMatches: async () => 'removed',
      },
      clock: () => now,
    });
    await operation.dispatch(initial);
    return authorized;
  }

  it('authorizes a send whose context has not changed', async () => {
    assert.equal(await authorizedAfter(context()), true);
  });

  // Dispatches, with the plan becoming `next` once the send intent is saved.
  async function dispatchChangedAfterIntent(next: ReminderDispatchContext) {
    const fixture = operationFixture();
    const operation = createReminderDispatchOperation({
      clock: () => new Date(window.startsAt),
      ledger: {
        ...fixture.ledger,
        beginSend: async (claim, at) => {
          const started = await fixture.ledger.beginSend(claim, at);
          fixture.setCurrent(next);
          return started;
        },
      },
      provider: {
        send: async () => {
          throw new Error('Must not reach the provider');
        },
      },
      readCurrentContext: async () => fixture.getCurrent(),
      subscriptionStore: {
        getSubscriptionSnapshot: async () => fixture.getCurrent().subscription,
        removeIfDeviceTokenAndGenerationMatches: async () => 'removed',
      },
    });
    const result = await operation.dispatch(context());
    return { record: await fixture.ledger.get(identity), result };
  }

  for (const [name, invalid] of [
    [
      'an unknown Home Time Zone',
      context({
        delivery: { ...context().delivery, homeTimeZone: 'Australia/Nowhere' },
      }),
    ],
    [
      'an invalid generation',
      context({ subscription: { ...subscription, attemptGeneration: 0 } }),
    ],
    [
      'a subscription in another zone',
      context({
        subscription: { ...subscription, homeTimeZone: 'Australia/Perth' },
      }),
    ],
  ] as const) {
    it(`refuses ${name} at final authorization, to retry later`, async () => {
      assert.equal(await authorizedAfter(invalid), false);

      const fixture = operationFixture();
      const operation = createReminderDispatchOperation({
        clock: () => new Date(window.startsAt),
        ledger: fixture.ledger,
        provider: {
          send: async (_request, authorize) => {
            fixture.setCurrent(invalid);
            return (await authorize())
              ? { kind: 'accepted' }
              : { kind: 'not-authorized' };
          },
        },
        readCurrentContext: async () => fixture.getCurrent(),
        subscriptionStore: {
          getSubscriptionSnapshot: async () =>
            fixture.getCurrent().subscription,
          removeIfDeviceTokenAndGenerationMatches: async () => 'removed',
        },
      });

      const result = await operation.dispatch(context());

      assert.equal(result.kind, 'transient-failure');
      assert.equal(
        (await fixture.ledger.get(identity))?.status,
        'transient-failure',
      );
    });
  }

  for (const [name, invalid] of [
    [
      'an unknown Home Time Zone',
      context({
        delivery: { ...context().delivery, homeTimeZone: 'Australia/Nowhere' },
      }),
    ],
    [
      'an invalid generation',
      context({ subscription: { ...subscription, attemptGeneration: 0 } }),
    ],
    [
      'an unknown direction',
      context({
        delivery: {
          ...context().delivery,
          changeDirection: 'sideways' as never,
        },
      }),
    ],
  ] as const) {
    it(`sends nothing for ${name} found after the send intent`, async () => {
      const { record, result } = await dispatchChangedAfterIntent(invalid);

      assert.equal(result.kind, 'transient-failure');
      assert.equal(record?.sendStartedAt, undefined);
      assert.notEqual(record?.status, 'uncertain');
    });
  }

  // A disabled timing is a valid plan that changed, not an unusable one, so
  // no later run can reach this delivery to finish it.
  it('closes a delivery whose timing is turned off after the send intent', async () => {
    const { result } = await dispatchChangedAfterIntent(
      context({ subscription: { ...subscription, oneWeekEnabled: false } }),
    );

    assert.equal(result.kind, 'stale');
  });

  for (const [change, next, initial] of [
    ...registrationChanges,
    ...planChanges,
  ]) {
    it(`refuses a send when the ${change} changed before it`, async () => {
      assert.equal(await authorizedAfter(next, initial), false);
    });
  }

  // Each row breaks one bound and keeps the others, so no check can hide
  // another. The default lease is 60 seconds.
  describe('final authorization bounds', () => {
    const later = (at: string, milliseconds: number) =>
      new Date(Date.parse(at) + milliseconds).toISOString();
    const lastSecond = later(window.endsAt, -1_000);
    const deadline = later(window.startsAt, 30_000);
    const early = context({ completeOperationDeadline: deadline });
    // The event and the pack end fall inside the first lease, so each row
    // breaks only the bound it names.
    const eventSoon = context({
      delivery: { ...context().delivery, changeEventAt: deadline },
    });
    const packSoon = context({ activePackValidUntil: deadline });

    for (const [name, current, from, at, expected] of [
      ['at the window end', context(), lastSecond, window.endsAt, true],
      [
        'past the window end, within the lease',
        context(),
        lastSecond,
        later(window.endsAt, 1),
        false,
      ],
      [
        'in the last moment of the lease',
        context(),
        window.startsAt,
        later(window.startsAt, 59_999),
        true,
      ],
      [
        'at the lease end, inside the window',
        context(),
        window.startsAt,
        later(window.startsAt, 60_000),
        false,
      ],
      [
        'before the deadline',
        early,
        window.startsAt,
        later(deadline, -1),
        true,
      ],
      [
        'at the deadline, inside the window',
        early,
        window.startsAt,
        deadline,
        false,
      ],
      [
        'before the window opens',
        context(),
        window.startsAt,
        later(window.startsAt, -1),
        false,
      ],
      [
        'before the Change Event',
        eventSoon,
        window.startsAt,
        later(deadline, -1),
        true,
      ],
      [
        'at the Change Event, inside the window',
        eventSoon,
        window.startsAt,
        deadline,
        false,
      ],
      ['at the pack end', packSoon, window.startsAt, deadline, true],
      [
        'past the pack end, inside the window',
        packSoon,
        window.startsAt,
        later(deadline, 1),
        false,
      ],
    ] as const) {
      it(`answers ${expected} ${name}`, async () => {
        assert.equal(
          await authorizedAfter(current, current, from, at),
          expected,
        );
      });
    }
  });

  describe('a send refused at final authorization', () => {
    // Refuses the send at `at`, once the context has become `next`.
    function refusedAt(
      at: Date,
      next: () => Promise<ReminderDispatchContext | null>,
    ) {
      const fixture = operationFixture();
      let now = new Date(window.startsAt);
      let refused = false;
      const operation = createReminderDispatchOperation({
        ledger: fixture.ledger,
        provider: {
          send: async () => {
            refused = true;
            now = at;
            return { kind: 'not-authorized' };
          },
        },
        readCurrentContext: async () => (refused ? next() : context()),
        subscriptionStore: {
          getSubscriptionSnapshot: async () => subscription,
          removeIfDeviceTokenAndGenerationMatches: async () => 'removed',
        },
        clock: () => now,
      });
      return { dispatch: () => operation.dispatch(context()), fixture };
    }

    const inWindow = new Date(window.startsAt);
    const closed = new Date(Date.parse(window.endsAt) + 1);

    it('closes the record when the subscription has gone', async () => {
      const { dispatch, fixture } = refusedAt(inWindow, async () => null);

      assert.equal((await dispatch()).kind, 'stale');

      const record = await fixture.ledger.get(identity);
      assert.equal(record?.status, 'expired');
      assert.equal(record?.expiryReason, 'superseded');
    });

    it('closes the record when the plan has changed', async () => {
      const { dispatch, fixture } = refusedAt(inWindow, async () =>
        context({
          delivery: { ...context().delivery, changeDirection: 'backward' },
        }),
      );

      assert.equal((await dispatch()).kind, 'stale');

      assert.equal(
        (await fixture.ledger.get(identity))?.expiryReason,
        'superseded',
      );
    });

    it('expires it, and only that, when the window has closed', async () => {
      const { dispatch, fixture } = refusedAt(closed, async () => context());

      assert.equal((await dispatch()).kind, 'expired');

      assert.equal(
        (await fixture.ledger.get(identity))?.expiryReason,
        'window',
      );
    });

    it('prefers a deleted subscription to a closed window', async () => {
      const { dispatch, fixture } = refusedAt(closed, async () => null);

      assert.equal((await dispatch()).kind, 'stale');

      assert.equal(
        (await fixture.ledger.get(identity))?.expiryReason,
        'superseded',
      );
    });

    it('keeps it open for a later run when nothing changed', async () => {
      const { dispatch, fixture } = refusedAt(inWindow, async () => context());

      assert.equal((await dispatch()).kind, 'transient-failure');

      assert.equal(
        (await fixture.ledger.get(identity))?.status,
        'transient-failure',
      );
    });

    it('keeps it open for a later run when the context is unreadable', async () => {
      const { dispatch, fixture } = refusedAt(inWindow, async () => {
        throw new Error('sensitive storage detail');
      });

      assert.equal((await dispatch()).kind, 'transient-failure');

      assert.equal(
        (await fixture.ledger.get(identity))?.status,
        'transient-failure',
      );
    });
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

// An operation over a fixture's ledger and plan, with any boundary replaced.
// Unless a test replaces the provider, it accepts and lists what it was sent.
function operationWith(
  fixture: ReturnType<typeof operationFixture>,
  boundaries: Partial<ReminderDispatchOperationDependencies> = {},
) {
  return createReminderDispatchOperation({
    ledger: fixture.ledger,
    provider: {
      send: async (request) => {
        fixture.sent.push(request);
        return { kind: 'accepted' };
      },
    },
    readCurrentContext: async () => fixture.getCurrent(),
    subscriptionStore: {
      getSubscriptionSnapshot: async () => fixture.getCurrent().subscription,
      removeIfDeviceTokenAndGenerationMatches: async () => 'removed',
    },
    clock: () => new Date(window.startsAt),
    ...boundaries,
  });
}

function instantAfter(at: string, milliseconds: number) {
  return new Date(Date.parse(at) + milliseconds).toISOString();
}

// Dispatches once and reports what the provider and ledger saw. The plan is
// read before the send intent (read 1) and again after it (read 2). A test can
// fail one read, change what the plan reads as from one read on, or move the
// clock to `jumpTo` as one is made. `prepared` is a delivery the ledger already
// holds.
async function dispatched({
  changedTo,
  changeRead,
  failRead,
  initial = context(),
  jumpTo,
  jumpRead = 1,
  prepared,
}: {
  readonly changedTo?: ReminderDispatchContext;
  readonly changeRead?: number;
  readonly failRead?: number;
  readonly initial?: ReminderDispatchContext | undefined;
  readonly jumpTo?: string;
  readonly jumpRead?: number;
  readonly prepared?: ReturnType<typeof preparation>;
}) {
  const fixture = operationFixture(initial);
  if (prepared !== undefined) await fixture.ledger.prepare(prepared);
  let now = new Date(window.startsAt);
  let reads = 0;
  let intents = 0;
  const operation = operationWith(fixture, {
    clock: () => now,
    ledger: {
      ...fixture.ledger,
      beginSend: async (claim, at) => {
        intents += 1;
        return fixture.ledger.beginSend(claim, at);
      },
    },
    readCurrentContext: async () => {
      reads += 1;
      if (reads === failRead) throw new Error('storage unavailable');
      if (reads === jumpRead && jumpTo !== undefined) now = new Date(jumpTo);
      if (reads === changeRead && changedTo !== undefined) {
        fixture.setCurrent(changedTo);
      }
      return fixture.getCurrent();
    },
  });
  const result = await operation.dispatch(initial);
  const record = await fixture.ledger.get({
    ...identity,
    changeEventAt: initial.delivery.changeEventAt,
  });
  return { intents, record, result, sends: fixture.sent.length };
}

describe('reminder dispatch of an invalid context', () => {
  const delivery = context().delivery;
  const rejections: readonly [string, ReminderDispatchContext, string][] = [
    [
      'a Home Time Zone that is not canonical',
      context({ delivery: { ...delivery, homeTimeZone: 'Sydney' } }),
      'Invalid reminder dispatch Home Time Zone',
    ],
    [
      'an unknown timing',
      context({ delivery: { ...delivery, timing: 'one-hour' as never } }),
      'Invalid reminder dispatch timing',
    ],
    [
      'a Change Event that is not an instant',
      context({ delivery: { ...delivery, changeEventAt: 'next Sunday' } }),
      'Invalid reminder dispatch Change Event instant',
    ],
    [
      'a Change Event that is not in canonical form',
      context({
        delivery: { ...delivery, changeEventAt: '2026-10-04T16:00:00Z' },
      }),
      'Invalid reminder dispatch Change Event instant',
    ],
    [
      'a Change Event that is not text',
      context({
        delivery: { ...delivery, changeEventAt: 1_791_129_600_000 as never },
      }),
      'Invalid reminder dispatch Change Event instant',
    ],
    [
      'an installation ID with other characters',
      context({ subscription: { ...subscription, installationId: 'a b' } }),
      'Invalid reminder dispatch installation ID',
    ],
    [
      'an empty installation ID',
      context({ subscription: { ...subscription, installationId: '' } }),
      'Invalid reminder dispatch installation ID',
    ],
    [
      'an installation ID that is too long',
      context({
        subscription: { ...subscription, installationId: 'i'.repeat(129) },
      }),
      'Invalid reminder dispatch installation ID',
    ],
    [
      'a registration generation of zero',
      context({ subscription: { ...subscription, attemptGeneration: 0 } }),
      'Invalid reminder dispatch generation',
    ],
    [
      'a negative registration generation',
      context({ subscription: { ...subscription, attemptGeneration: -1 } }),
      'Invalid reminder dispatch generation',
    ],
    [
      'a registration generation that is not whole',
      context({ subscription: { ...subscription, attemptGeneration: 1.5 } }),
      'Invalid reminder dispatch generation',
    ],
    [
      'a registration generation beyond the safe integers',
      context({
        subscription: { ...subscription, attemptGeneration: 2 ** 53 },
      }),
      'Invalid reminder dispatch generation',
    ],
    [
      'a registration for another zone than its plan',
      context({
        subscription: { ...subscription, homeTimeZone: 'Australia/Perth' },
      }),
      'Reminder dispatch subscription does not match its plan',
    ],
    [
      'a window that ends before it starts',
      context({
        delivery: {
          ...delivery,
          deliveryWindow: { endsAt: window.startsAt, startsAt: window.endsAt },
        },
      }),
      'Invalid reminder dispatch delivery window',
    ],
    [
      'a window start that is not an instant',
      context({
        delivery: {
          ...delivery,
          deliveryWindow: { ...window, startsAt: 'noon' },
        },
      }),
      'Invalid reminder dispatch delivery window start',
    ],
    [
      'a window end that is not an instant',
      context({
        delivery: {
          ...delivery,
          deliveryWindow: { ...window, endsAt: 'midnight' },
        },
      }),
      'Invalid reminder dispatch delivery window end',
    ],
    [
      'a pack Validity Horizon that is not an instant',
      context({ activePackValidUntil: 'never' }),
      'Invalid reminder dispatch pack Validity Horizon',
    ],
    [
      'an operation deadline that is not an instant',
      context({ completeOperationDeadline: 'soon' }),
      'Invalid reminder dispatch complete-operation deadline',
    ],
    [
      'a registration with no timing enabled',
      context({
        subscription: {
          ...subscription,
          oneDayEnabled: false,
          oneWeekEnabled: false,
        },
      }),
      'Reminder dispatch has no enabled timing',
    ],
    [
      'a one-week delivery for a registration that disabled it',
      context({ subscription: { ...subscription, oneWeekEnabled: false } }),
      'Reminder dispatch timing is disabled',
    ],
    [
      'a one-day delivery for a registration that disabled it',
      context({
        delivery: { ...delivery, timing: 'one-day' },
        subscription: { ...subscription, oneDayEnabled: false },
      }),
      'Reminder dispatch timing is disabled',
    ],
  ];

  // An operation that counts how often dispatch reaches the ledger. The
  // ledger checks some of these itself, so only a count shows that the
  // dispatcher stopped first.
  function countingPrepares(
    fixture: ReturnType<typeof operationFixture>,
    boundaries: Partial<ReminderDispatchOperationDependencies> = {},
  ) {
    const prepares = { count: 0 };
    const operation = operationWith(fixture, {
      ledger: {
        ...fixture.ledger,
        prepare: async (preparation) => {
          prepares.count += 1;
          return fixture.ledger.prepare(preparation);
        },
      },
      ...boundaries,
    });
    return { operation, prepares };
  }

  for (const [problem, invalid, message] of rejections) {
    it(`rejects ${problem} before touching the ledger or provider`, async () => {
      const fixture = operationFixture();
      const { operation, prepares } = countingPrepares(fixture);

      await assert.rejects(() => operation.dispatch(invalid), { message });

      assert.equal(prepares.count, 0);
      assert.deepEqual(fixture.sent, []);
    });
  }

  for (const [timing, oneDayEnabled, oneWeekEnabled] of [
    ['one-day', true, false],
    ['one-week', false, true],
  ] as const) {
    it(`sends a ${timing} reminder when it is the only timing enabled`, async () => {
      const initial = context({
        delivery: { ...delivery, timing },
        subscription: { ...subscription, oneDayEnabled, oneWeekEnabled },
      });
      const fixture = operationFixture(initial);

      assert.equal(
        (await fixture.operation.dispatch(initial)).kind,
        'accepted',
      );

      assert.equal(fixture.sent.length, 1);
    });
  }

  it('sends in a window that opens and closes at the same instant', async () => {
    const initial = context({
      delivery: {
        ...delivery,
        deliveryWindow: { endsAt: window.startsAt, startsAt: window.startsAt },
      },
    });
    const fixture = operationFixture(initial);

    assert.equal((await fixture.operation.dispatch(initial)).kind, 'accepted');

    assert.equal(fixture.sent.length, 1);
  });

  it('rejects a clock that is not a date before touching the ledger', async () => {
    const fixture = operationFixture();
    const { operation, prepares } = countingPrepares(fixture, {
      clock: () => new Date(Number.NaN),
    });

    await assert.rejects(() => operation.dispatch(context()), {
      message: 'Invalid reminder dispatch clock',
    });

    assert.equal(prepares.count, 0);
    assert.deepEqual(fixture.sent, []);
  });

  it('accepts the latest date a clock can report', async () => {
    const fixture = operationFixture();
    const operation = operationWith(fixture, {
      clock: () => new Date(8_640_000_000_000_000),
    });

    assert.equal((await operation.dispatch(context())).kind, 'expired');

    assert.deepEqual(fixture.sent, []);
  });
});

describe('reminder dispatch of a provider answer', () => {
  // Only a confirmed transient failure may be sent again. Anything the
  // dispatcher cannot read as an answer may have been sent, so it stays closed.
  const answers: readonly [
    string,
    () => Promise<ReminderDispatchProviderResult>,
    'accepted' | 'permanent-failure' | 'transient-failure' | 'uncertain',
    boolean,
  ][] = [
    ['acceptance', async () => ({ kind: 'accepted' }), 'accepted', false],
    ['uncertainty', async () => ({ kind: 'uncertain' }), 'uncertain', false],
    [
      'a permanent rejection',
      async () => ({ kind: 'permanent-failure', invalidToken: false }),
      'permanent-failure',
      false,
    ],
    [
      'a transient failure',
      async () => ({ kind: 'transient-failure' }),
      'transient-failure',
      true,
    ],
    [
      'an error',
      async () => {
        throw new Error('acknowledgement lost');
      },
      'uncertain',
      false,
    ],
    ['nothing', async () => undefined as never, 'uncertain', false],
    ['null', async () => null as never, 'uncertain', false],
    ['text', async () => 'accepted' as never, 'uncertain', false],
    [
      'an object of an unknown kind',
      async () => ({ kind: 'delivered' }) as never,
      'uncertain',
      false,
    ],
    [
      'an array that has a kind',
      async () => Object.assign([], { kind: 'accepted' }) as never,
      'uncertain',
      false,
    ],
    [
      'a function that has a kind',
      async () => Object.assign(() => undefined, { kind: 'accepted' }) as never,
      'uncertain',
      false,
    ],
  ];

  for (const [answer, send, kind, retried] of answers) {
    it(`${retried ? 'sends again after' : 'never sends again after'} ${answer}`, async () => {
      let sends = 0;
      const fixture = operationFixture(context(), async () => {
        sends += 1;
        return sends === 1 ? send() : { kind: 'accepted' };
      });

      const first = await fixture.operation.dispatch(context());
      const second = await fixture.operation.dispatch(context());

      assert.deepEqual(first, { kind });
      assert.deepEqual(
        second,
        retried ? { kind: 'accepted' } : { alreadyRecorded: true, kind },
      );
      assert.equal(sends, retried ? 2 : 1);
    });
  }

  // The ledger is read again only to clean up a token the provider called
  // invalid, so an unreadable ledger fails that cleanup and nothing else.
  for (const [rejection, invalidToken, cleanupStatus] of [
    ['an invalid token', true, 'failed'],
    ['no invalid token', false, undefined],
  ] as const) {
    it(`reports ${cleanupStatus === undefined ? 'no cleanup' : 'a failed cleanup'} for a rejection with ${rejection} when the ledger cannot be read`, async () => {
      const fixture = operationFixture();
      const operation = operationWith(fixture, {
        ledger: {
          ...fixture.ledger,
          get: async () => {
            throw azureError(503);
          },
        },
        provider: {
          send: async () => ({ kind: 'permanent-failure', invalidToken }),
        },
      });

      assert.deepEqual(
        await operation.dispatch(context()),
        cleanupStatus === undefined
          ? { kind: 'permanent-failure' }
          : { cleanupStatus, kind: 'permanent-failure' },
      );
    });
  }

  it('counts an expiry written by an earlier run as already recorded', async () => {
    const fixture = operationFixture();
    const late = new Date(instantAfter(window.endsAt, 1));
    const operation = operationWith(fixture, { clock: () => late });

    assert.deepEqual(await operation.dispatch(context()), { kind: 'expired' });
    assert.deepEqual(await operation.dispatch(context()), {
      alreadyRecorded: true,
      kind: 'expired',
    });

    assert.deepEqual(fixture.sent, []);
  });

  it('saves its send intent before calling the provider, and the answer after', async () => {
    const fixture = operationFixture();
    const seenBySend: (ReminderDispatchLedgerRecord | null)[] = [];
    const operation = operationWith(fixture, {
      provider: {
        send: async () => {
          seenBySend.push(await fixture.ledger.get(identity));
          return { kind: 'accepted' };
        },
      },
    });

    await operation.dispatch(context());

    assert.equal(seenBySend[0]?.status, 'claimed');
    assert.equal(seenBySend[0]?.sendStartedAt?.toISOString(), window.startsAt);
    assert.equal((await fixture.ledger.get(identity))?.status, 'accepted');
  });

  it('does not send again when the answer could not be recorded', async () => {
    const fixture = operationFixture();
    let now = new Date(window.startsAt);
    const operation = operationWith(fixture, {
      clock: () => now,
      ledger: {
        ...fixture.ledger,
        complete: async () => {
          throw azureError(503);
        },
      },
    });

    assert.deepEqual(await operation.dispatch(context()), {
      kind: 'uncertain',
    });

    // The lease lapses with the send intent still saved.
    now = new Date(instantAfter(window.startsAt, 61_000));
    assert.deepEqual(await operation.dispatch(context()), {
      kind: 'uncertain',
    });
    assert.equal(fixture.sent.length, 1);
  });
});

describe('reminder dispatch around the send intent', () => {
  for (const [when, failRead, intents] of [
    ['before', 1, 0],
    ['after', 2, 1],
  ] as const) {
    it(`retries later when the plan cannot be read ${when} the send intent`, async () => {
      const run = await dispatched({ failRead });

      assert.deepEqual(run.result, { kind: 'transient-failure' });
      assert.equal(run.sends, 0);
      assert.equal(run.intents, intents);
      assert.equal(run.record?.status, 'pending');
    });
  }

  for (const [read, intents] of [
    [1, 0],
    [2, 1],
  ] as const) {
    for (const [change, changedTo, initial] of registrationChanges) {
      it(`closes the delivery when the ${change} changed ${read === 1 ? 'before' : 'after'} the send intent`, async () => {
        const run = await dispatched({ changedTo, changeRead: read, initial });

        assert.deepEqual(run.result, { kind: 'stale' });
        assert.equal(run.sends, 0);
        assert.equal(run.intents, intents);
      });
    }

    it(`retries later when the plan moves the window start past the clock ${read === 1 ? 'before' : 'after'} the send intent`, async () => {
      const later = context({
        delivery: {
          ...context().delivery,
          deliveryWindow: {
            ...window,
            startsAt: instantAfter(window.startsAt, 30_000),
          },
        },
      });

      const run = await dispatched({ changedTo: later, changeRead: read });

      assert.deepEqual(run.result, { kind: 'transient-failure' });
      assert.equal(run.sends, 0);
      assert.equal(run.intents, intents);
      assert.equal(run.record?.status, 'pending');
    });
  }

  it('saves no send intent for a registration older than the ledger knows', async () => {
    const run = await dispatched({ prepared: preparation(2) });

    assert.deepEqual(run.result, { kind: 'stale' });
    assert.equal(run.sends, 0);
    assert.equal(run.intents, 0);
  });

  it('abandons a claim whose lease lapsed before the send intent', async () => {
    const run = await dispatched({
      jumpTo: instantAfter(window.startsAt, 61_000),
    });

    assert.deepEqual(run.result, { kind: 'stale' });
    assert.equal(run.sends, 0);
    assert.equal(run.record?.status, 'pending');
  });

  // Each row moves the clock, as the plan is read, to an instant that breaks
  // only the bound it names. The first row leaves time to send and the rest
  // must not send. A delivery stopped by its operation deadline is retried
  // later, and one whose window, pack or Change Event is over expires.
  const delivery = context().delivery;
  const soon = instantAfter(window.startsAt, 30_000);
  const gates: readonly [
    string,
    ReminderDispatchContext,
    string,
    'accepted' | 'expired' | 'transient-failure',
    'accepted' | 'expired' | 'pending',
    ('event' | 'pack' | 'window')?,
  ][] = [
    [
      'one millisecond before the operation deadline',
      context({ completeOperationDeadline: soon }),
      instantAfter(soon, -1),
      'accepted',
      'accepted',
    ],
    [
      'the operation deadline',
      context({ completeOperationDeadline: soon }),
      soon,
      'transient-failure',
      'pending',
    ],
    [
      'one millisecond after the window ends',
      context(),
      instantAfter(window.endsAt, 1),
      'expired',
      'expired',
      'window',
    ],
    [
      'the Change Event',
      context({ delivery: { ...delivery, changeEventAt: soon } }),
      soon,
      'expired',
      'expired',
      'event',
    ],
    [
      'one millisecond after the pack ends',
      context({ activePackValidUntil: soon }),
      instantAfter(soon, 1),
      'expired',
      'expired',
      'pack',
    ],
    [
      'the window end, which is also the operation deadline',
      context({ completeOperationDeadline: window.endsAt }),
      window.endsAt,
      'transient-failure',
      'pending',
    ],
    [
      'the pack end, which is also the operation deadline',
      context({ activePackValidUntil: soon, completeOperationDeadline: soon }),
      soon,
      'transient-failure',
      'pending',
    ],
  ];

  for (const [when, jumpRead, intentSaved] of [
    ['before', 1, false],
    ['after', 2, true],
  ] as const) {
    for (const [at, initial, jumpTo, kind, status, expiryReason] of gates) {
      it(`${kind === 'accepted' ? 'sends' : 'stops'} when the clock reads ${at}, ${when} the send intent`, async () => {
        const run = await dispatched({ initial, jumpRead, jumpTo });

        assert.deepEqual(run.result, { kind });
        assert.equal(run.record?.status, status);
        assert.equal(run.record?.expiryReason, expiryReason);
        assert.equal(run.sends, kind === 'accepted' ? 1 : 0);
        // A delivery that cannot be sent never saves an intent it must undo.
        assert.equal(run.intents, kind === 'accepted' || intentSaved ? 1 : 0);
      });
    }
  }
});

describe('reminder dispatch of a send intent the ledger changed', () => {
  const changes: readonly [
    string,
    (record: ReminderDispatchLedgerRecord) => ReminderDispatchLedgerRecord,
    'claimed' | 'expired',
  ][] = [
    [
      'the record is no longer claimed',
      (record) => ({ ...record, status: 'expired' }),
      'expired',
    ],
    [
      'the claim belongs to another worker',
      (record) => ({ ...record, claimId: 'another-claim' }),
      'claimed',
    ],
    [
      'the claim is for another generation',
      (record) => ({
        ...record,
        attemptGeneration: record.attemptGeneration + 1,
      }),
      'claimed',
    ],
    [
      'the record shows no send intent',
      ({ sendStartedAt: _intent, ...record }) => record,
      'claimed',
    ],
  ];

  for (const [change, changed, kind] of changes) {
    it(`sends nothing when ${change}`, async () => {
      const fixture = operationFixture();
      const operation = operationWith(fixture, {
        ledger: {
          ...fixture.ledger,
          beginSend: async (claim, at) => {
            const started = await fixture.ledger.beginSend(claim, at);
            return started.kind === 'updated'
              ? { kind: 'updated', record: changed(started.record) }
              : started;
          },
        },
      });

      assert.deepEqual(await operation.dispatch(context()), { kind });

      assert.deepEqual(fixture.sent, []);
    });
  }
});

describe('final authorization of a send', () => {
  // Answers what the provider's final authorization says once the ledger
  // record or the plan it reads has changed.
  async function answered(change: {
    readonly plan?: () => Promise<ReminderDispatchContext | null>;
    readonly record?: (
      record: ReminderDispatchLedgerRecord,
    ) => ReminderDispatchLedgerRecord | null;
  }) {
    const fixture = operationFixture();
    const answers: boolean[] = [];
    let authorizing = false;
    const operation = operationWith(fixture, {
      ledger: {
        ...fixture.ledger,
        get: async (target) => {
          const record = await fixture.ledger.get(target);
          return authorizing && record !== null && change.record
            ? change.record(record)
            : record;
        },
      },
      provider: {
        send: async (_request, authorize) => {
          authorizing = true;
          const authorized = await authorize();
          authorizing = false;
          answers.push(authorized);
          return { kind: authorized ? 'accepted' : 'not-authorized' };
        },
      },
      readCurrentContext: async () =>
        authorizing && change.plan ? change.plan() : fixture.getCurrent(),
    });
    await operation.dispatch(context());
    return answers;
  }

  it('authorizes a send when the record and plan are as they were', async () => {
    assert.deepEqual(await answered({}), [true]);
  });

  const refusals: readonly [string, Parameters<typeof answered>[0]][] = [
    [
      'the ledger cannot be read',
      {
        record: () => {
          throw azureError(503);
        },
      },
    ],
    ['the record has gone', { record: () => null }],
    [
      'another worker marked the send uncertain',
      { record: (record) => ({ ...record, status: 'uncertain' }) },
    ],
    [
      'the claim belongs to another worker',
      { record: (record) => ({ ...record, claimId: 'another-claim' }) },
    ],
    [
      'the claim is for another generation',
      {
        record: (record) => ({
          ...record,
          attemptGeneration: record.attemptGeneration + 1,
        }),
      },
    ],
    [
      'the record shows no send intent',
      { record: ({ sendStartedAt: _intent, ...record }) => record },
    ],
    [
      'the claim has no expiry',
      { record: ({ claimExpiresAt: _expiry, ...record }) => record },
    ],
    [
      'the plan cannot be read',
      {
        plan: async () => {
          throw new Error('storage unavailable');
        },
      },
    ],
    ['the registration has gone', { plan: async () => null }],
  ];

  for (const [reason, change] of refusals) {
    it(`refuses a send when ${reason}`, async () => {
      assert.deepEqual(await answered(change), [false]);
    });
  }
});

describe('invalid-token cleanup of a delivery', () => {
  // A ledger holding a permanent rejection of this registration, with its
  // cleanup still to do.
  async function rejected() {
    const fixture = operationFixture();
    const start = new Date(window.startsAt);
    await fixture.ledger.prepare(preparation(1, start));
    const claim = await fixture.ledger.claim(identity, start);
    assert.ok(claim);
    await fixture.ledger.beginSend(claim, start);
    await fixture.ledger.complete(
      claim,
      { kind: 'permanent-failure', invalidToken: true },
      start,
    );
    return fixture;
  }

  // The dispatcher meets a rejection recorded earlier, and reads the record
  // again before it removes anything. A rejection that is not this one leaves
  // the token alone and reports the cleanup status the record carried.
  const rereads: readonly [
    string,
    (
      record: ReminderDispatchLedgerRecord,
    ) => ReminderDispatchLedgerRecord | null,
    ReminderDispatchCleanupStatus,
    number,
  ][] = [
    ['the record has gone', () => null, 'pending', 0],
    [
      'the record is no longer a permanent rejection',
      (record) => ({ ...record, status: 'uncertain' }),
      'pending',
      0,
    ],
    [
      'the record is for another generation',
      (record) => ({ ...record, attemptGeneration: 2 }),
      'pending',
      0,
    ],
    ['the record is still this rejection', (record) => record, 'removed', 1],
  ];

  for (const [change, reread, cleanupStatus, removals] of rereads) {
    it(`removes ${removals === 0 ? 'no token' : 'the token'} when ${change}`, async () => {
      const fixture = await rejected();
      let removed = 0;
      const operation = operationWith(fixture, {
        ledger: {
          ...fixture.ledger,
          get: async (target) => {
            const record = await fixture.ledger.get(target);
            return record === null ? null : reread(record);
          },
        },
        subscriptionStore: {
          getSubscriptionSnapshot: async () => subscription,
          removeIfDeviceTokenAndGenerationMatches: async () => {
            removed += 1;
            return 'removed';
          },
        },
      });

      assert.deepEqual(await operation.dispatch(context()), {
        alreadyRecorded: true,
        cleanupStatus,
        kind: 'permanent-failure',
      });

      assert.equal(removed, removals);
    });
  }

  it('finds nothing to clean up for a delivery with no record', async () => {
    const fixture = operationFixture();

    assert.equal(
      await fixture.operation.retryInvalidTokenCleanup(identity),
      undefined,
    );
    assert.equal(fixture.getCleanupCalls(), 0);
  });

  it('finds nothing to clean up after an accepted send', async () => {
    const fixture = operationFixture();
    await fixture.operation.dispatch(context());

    assert.equal(
      await fixture.operation.retryInvalidTokenCleanup(identity),
      undefined,
    );
    assert.equal(fixture.getCleanupCalls(), 0);
  });

  it('reports a failed cleanup when the ledger cannot be read', async () => {
    const fixture = operationFixture();
    const operation = operationWith(fixture, {
      ledger: {
        ...fixture.ledger,
        get: async () => {
          throw azureError(503);
        },
      },
    });

    assert.equal(await operation.retryInvalidTokenCleanup(identity), 'failed');
  });
});
