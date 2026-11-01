import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAzureReminderDispatchLedgerStore,
  createTableReminderDispatchLedgerStore,
  type ReminderDispatchClaim,
  type ReminderDispatchCleanupStatus,
  type ReminderDispatchCompletionOutcome,
  type ReminderDispatchIdentity,
  type ReminderDispatchLedgerTable,
  type ReminderDispatchPreparation,
  type ReminderDispatchStatus,
} from './reminder-dispatch-ledger.ts';

type Row = Record<string, unknown>;
type Ledger = ReturnType<typeof createTableReminderDispatchLedgerStore>;

const identity: ReminderDispatchIdentity = {
  changeEventAt: '2026-10-04T16:00:00.000Z',
  homeTimeZone: 'Australia/Sydney',
  installationId: 'i'.repeat(43),
  timing: 'one-week',
};
const windowStartsAt = new Date('2026-09-28T09:00:00.000Z');
const windowEndsAt = new Date('2026-09-28T21:00:00.000Z');
const packValidUntil = new Date('2026-12-31T00:00:00.000Z');
const start = windowStartsAt;
const defaultLeaseMs = 60_000;
const retryLimit = 12;

const msAfter = (milliseconds: number, from = start) =>
  new Date(from.getTime() + milliseconds);
const later = msAfter(1_000);
const afterWindow = msAfter(1, windowEndsAt);

function azureError(statusCode: number) {
  return Object.assign(new Error(`Azure ${statusCode}`), { statusCode });
}

// A write is a precondition (the ETag), an effect, and an acknowledgement. A
// fault can happen before the effect, instead of it, or between the effect and
// the acknowledgement, which is the lost acknowledgement the ledger reconciles.
type Intercept<T = void> = (call: number, run: () => Promise<T>) => Promise<T>;

interface Faults {
  readonly create?: Intercept;
  readonly get?: Intercept<Row>;
  readonly replace?: Intercept;
}

const passThrough: Intercept = (_call, run) => run();
const passThroughRead: Intercept<Row> = (_call, run) => run();

const fails =
  <T = void>(error: unknown): Intercept<T> =>
  async () => {
    throw error;
  };
const loseAcknowledgement: Intercept = async (_call, run) => {
  await run();
  throw azureError(503);
};
const sameError = (expected: unknown) => (actual: unknown) =>
  actual === expected;

function createTable() {
  const rows = new Map<string, Row>();
  const writes: {
    kind: 'create' | 'replace';
    etag?: string;
    status: unknown;
  }[] = [];
  // Every call the ledger makes to the table, in order.
  const log: string[] = [];
  let calls = { create: 0, get: 0, replace: 0 };
  let faults: Faults = {};
  let etag = 0;
  const key = (partitionKey: unknown, rowKey: unknown) =>
    `${String(partitionKey)}/${String(rowKey)}`;
  const onlyRow = () => {
    assert.equal(rows.size, 1);
    return [...rows.entries()][0]!;
  };
  const table: ReminderDispatchLedgerTable = {
    async create(entity) {
      log.push('create');
      writes.push({ kind: 'create', status: entity.status });
      await (faults.create ?? passThrough)(++calls.create, async () => {
        const id = key(entity.partitionKey, entity.rowKey);
        if (rows.has(id)) throw azureError(409);
        rows.set(id, { ...entity, etag: String(++etag) });
      });
    },
    delete: async () => undefined,
    async get(partitionKey, rowKey) {
      log.push('get');
      return (faults.get ?? passThroughRead)(++calls.get, async () => {
        const row = rows.get(key(partitionKey, rowKey));
        if (row === undefined) throw azureError(404);
        return { ...row };
      });
    },
    async *listUnsettledPages() {
      // These tests drive the claim lifecycle, not settlement.
    },
    async *listUpdatedBefore() {
      // Nor do they purge.
    },
    async replace(entity, expectedEtag) {
      log.push('replace');
      writes.push({
        kind: 'replace',
        etag: expectedEtag,
        status: entity.status,
      });
      await (faults.replace ?? passThrough)(++calls.replace, async () => {
        const id = key(entity.partitionKey, entity.rowKey);
        const row = rows.get(id);
        if (row === undefined) throw azureError(404);
        if (row.etag !== expectedEtag) throw azureError(412);
        rows.set(id, { ...entity, etag: String(++etag) });
      });
    },
  };
  return {
    /** Counts writes afresh and installs the faults for the next operation. */
    begin(next: Faults = {}) {
      log.length = 0;
      writes.length = 0;
      calls = { create: 0, get: 0, replace: 0 };
      faults = next;
    },
    /** Another worker's write: changes the one row and so its ETag. */
    mutate(change: (row: Row) => Row) {
      const [id, row] = onlyRow();
      rows.set(id, { ...change(row), etag: String(++etag) });
    },
    log,
    rows,
    /** The one stored row, as a worker would see it, without ETag and keys. */
    stored(): Row {
      const {
        etag: _etag,
        partitionKey: _partitionKey,
        rowKey: _rowKey,
        ...fields
      } = onlyRow()[1];
      return fields;
    },
    table,
    writes,
  };
}

function setup() {
  const fake = createTable();
  return { fake, ledger: createTableReminderDispatchLedgerStore(fake.table) };
}

function preparation(
  overrides: Partial<ReminderDispatchPreparation> = {},
): ReminderDispatchPreparation {
  return {
    ...identity,
    attemptGeneration: 1,
    deliveryWindowEndsAt: windowEndsAt,
    deliveryWindowStartsAt: windowStartsAt,
    now: start,
    packValidUntil,
    ...overrides,
  };
}

const pendingRow: Row = {
  attemptGeneration: 1,
  changeEventAt: identity.changeEventAt,
  createdAt: start,
  deliveryWindowEndsAt: windowEndsAt,
  deliveryWindowStartsAt: windowStartsAt,
  homeTimeZone: identity.homeTimeZone,
  installationId: identity.installationId,
  packValidUntil,
  status: 'pending',
  timing: identity.timing,
  updatedAt: start,
};
const rowWith = (changes: Row): Row => ({ ...pendingRow, ...changes });

// A delivery taken to a known state through the ledger itself. Each stage
// returns the claim it went through, which is stale once the claim is
// released, and the row the ledger should have stored.
interface Stage {
  readonly claim: ReminderDispatchClaim;
  readonly row: Row;
}
type Setup = (ledger: Ledger) => Promise<Stage>;

// A claim that was never issued, for deliveries that do not exist.
const unissuedClaim: ReminderDispatchClaim = {
  ...identity,
  attemptGeneration: 1,
  claimExpiresAt: start,
  claimId: 'unissued',
};

async function claimed(ledger: Ledger, leaseMs = defaultLeaseMs) {
  await ledger.prepare(preparation());
  const claim = await ledger.claim(identity, start, leaseMs);
  assert.ok(claim);
  return {
    claim,
    row: rowWith({
      claimExpiresAt: msAfter(leaseMs),
      claimId: claim.claimId,
      status: 'claimed',
    }),
  };
}

const sending: Setup = async (ledger) => {
  const { claim, row } = await claimed(ledger);
  assert.equal((await ledger.beginSend(claim, start)).kind, 'updated');
  return { claim, row: { ...row, sendStartedAt: start } };
};

function finished(
  outcome: ReminderDispatchCompletionOutcome,
  changes: (claim: ReminderDispatchClaim) => Row,
): Setup {
  return async (ledger) => {
    const { claim } = await sending(ledger);
    assert.equal(
      (await ledger.complete(claim, outcome, start)).kind,
      'updated',
    );
    return { claim, row: rowWith(changes(claim)) };
  };
}

// Runs `then` with the claim of a delivery that was released and so is pending.
function afterRelease(
  then: (ledger: Ledger, claim: ReminderDispatchClaim) => Promise<Row>,
): Setup {
  return async (ledger) => {
    const { claim } = await claimed(ledger);
    await ledger.release(claim, start);
    return { claim, row: await then(ledger, claim) };
  };
}

const stages = {
  pending: afterRelease(async () => rowWith({})),
  claimed: (ledger: Ledger) => claimed(ledger),
  sending,
  accepted: finished({ kind: 'accepted' }, () => ({ status: 'accepted' })),
  uncertain: finished({ kind: 'uncertain' }, (claim) => ({
    lastClaimId: claim.claimId,
    status: 'uncertain',
  })),
  rejected: finished({ kind: 'permanent-failure', invalidToken: true }, () => ({
    cleanupStatus: 'pending',
    status: 'permanent-failure',
  })),
  rejectedNoToken: finished(
    { kind: 'permanent-failure', invalidToken: false },
    () => ({ status: 'permanent-failure' }),
  ),
  transient: finished({ kind: 'transient-failure' }, () => ({
    status: 'transient-failure',
  })),
  expired: afterRelease(async (ledger) => {
    assert.equal(await ledger.claim(identity, afterWindow), null);
    return rowWith({
      expiryReason: 'window',
      status: 'expired',
      updatedAt: afterWindow,
    });
  }),
  superseded: afterRelease(async (ledger) => {
    await ledger.invalidate(identity, 1, start);
    return rowWith({ expiryReason: 'superseded', status: 'expired' });
  }),
};

describe('reminder dispatch ledger reads', () => {
  it('finds nothing for a delivery that was never prepared', async () => {
    const { ledger } = setup();
    assert.equal(await ledger.get(identity), null);
  });

  it('returns what it stored, with the ETag of that write', async () => {
    const { fake, ledger } = setup();
    await ledger.prepare(preparation());
    assert.deepEqual(await ledger.get(identity), {
      ...pendingRow,
      etag: '1',
    });
    assert.deepEqual(fake.stored(), pendingRow);
  });

  it('keeps the delivery apart from other installations, zones, events and timings', async () => {
    const { fake, ledger } = setup();
    await ledger.prepare(preparation());
    for (const other of [
      { installationId: 'j'.repeat(43) },
      { homeTimeZone: 'Australia/Perth' },
      { changeEventAt: '2026-10-05T16:00:00.000Z' },
      { timing: 'one-day' as const },
    ]) {
      assert.equal(await ledger.get({ ...identity, ...other }), null);
    }
    assert.equal(fake.rows.size, 1);
  });

  for (const [name, change, message] of [
    ['a blank installation ID', { installationId: '' }, /installation ID/],
    [
      'an installation ID with spaces',
      { installationId: 'a b' },
      /installation ID/,
    ],
    [
      'an installation ID that is not text',
      { installationId: 42 },
      /installation ID/,
    ],
    [
      'a missing installation ID',
      { installationId: undefined },
      /installation ID/,
    ],
    [
      'an overlong installation ID',
      { installationId: 'i'.repeat(129) },
      /installation ID/,
    ],
    [
      'a zone that is not canonical',
      { homeTimeZone: 'Australia/Nowhere' },
      /Home Time Zone/,
    ],
    [
      'an unparsable Change Event',
      { changeEventAt: 'not-an-instant' },
      /Change Event instant/,
    ],
    [
      'a Change Event that is not in canonical form',
      { changeEventAt: '2026-10-04T16:00:00Z' },
      /Change Event instant/,
    ],
    ['an unknown timing', { timing: 'one-month' }, /timing/],
  ] as const) {
    it(`rejects ${name}`, async () => {
      const { ledger } = setup();
      await assert.rejects(
        () => ledger.get({ ...identity, ...change } as never),
        message,
      );
    });
  }

  it('reads storage failures as failures, not as an absent record', async () => {
    const { fake, ledger } = setup();
    // The kinds of rejection a storage client can raise that are not an error
    // carrying a 404: an unknown thing thrown, or a status that is not a number.
    for (const rejection of [null, 'unavailable', {}, { statusCode: '404' }]) {
      fake.begin({ get: fails(rejection) });
      await assert.rejects(() => ledger.get(identity), sameError(rejection));
    }
    fake.begin({ get: fails({ statusCode: 404 }) });
    assert.equal(await ledger.get(identity), null);
  });

  // Each case damages one field of a stored row, as a bad write or a manual
  // edit might. Reading must refuse it rather than act on it.
  for (const [field, damage, message] of [
    ['changeEventAt', 'not-an-instant', /Change Event instant/],
    ['changeEventAt', '2026-10-04T16:00:00Z', /Change Event instant/],
    ['changeEventAt', '', /Change Event instant/],
    ['homeTimeZone', '', /Home Time Zone/],
    ['homeTimeZone', 'Australia/Nowhere', /Home Time Zone/],
    ['installationId', '', /installation ID/],
    ['installationId', 'a b', /installation ID/],
    ['installationId', 42, /installation ID/],
    ['timing', 'one-month', /timing/],
    ['timing', undefined, /timing/],
    ['status', 'bogus', /status/],
    ['status', undefined, /status/],
    ['attemptGeneration', 0, /generation/],
    ['attemptGeneration', -1, /generation/],
    ['attemptGeneration', 1.5, /generation/],
    ['attemptGeneration', Number.NaN, /generation/],
    ['attemptGeneration', Number.MAX_SAFE_INTEGER + 1, /generation/],
    ['attemptGeneration', '1', /generation/],
    ['attemptGeneration', undefined, /generation/],
    ['createdAt', 'not a date', /createdAt/],
    ['createdAt', new Date(Number.NaN), /createdAt/],
    ['createdAt', undefined, /createdAt/],
    ['createdAt', 1_790_000_000_000, /createdAt/],
    ['deliveryWindowStartsAt', 'not a date', /delivery window start/],
    ['deliveryWindowEndsAt', 'not a date', /delivery window end/],
    ['packValidUntil', 'not a date', /pack Validity Horizon/],
    ['updatedAt', 'not a date', /updatedAt/],
    ['deliveryWindowEndsAt', msAfter(-1, windowStartsAt), /delivery window/],
    ['claimExpiresAt', 'not a date', /claim expiry/],
    ['claimId', '', /claim ID/],
    ['claimId', 42, /claim ID/],
    ['cleanupStatus', 'bogus', /cleanup status/],
    ['expiryReason', 'bogus', /expiry reason/],
    ['invalidatedAt', 'not a date', /provider invalidation/],
    ['lastClaimId', '', /last claim ID/],
    ['sendStartedAt', 'not a date', /send start/],
  ] as const) {
    it(`rejects a stored ${field} of ${String(damage)}`, async () => {
      const { fake, ledger } = setup();
      await ledger.prepare(preparation());
      fake.mutate((row) => ({ ...row, [field]: damage }));
      await assert.rejects(() => ledger.get(identity), message);
    });
  }

  it('rejects a stored row with no ETag', async () => {
    const { fake, ledger } = setup();
    await ledger.prepare(preparation());
    fake.begin({
      get: async (_call, run) => ({ ...(await run()), etag: '' }),
    });
    await assert.rejects(() => ledger.get(identity), /ETag/);
  });

  it('accepts a window that ends as it starts', async () => {
    const { fake, ledger } = setup();
    await ledger.prepare(preparation());
    fake.mutate((row) => ({ ...row, deliveryWindowEndsAt: windowStartsAt }));
    assert.deepEqual(
      (await ledger.get(identity))?.deliveryWindowEndsAt,
      windowStartsAt,
    );
  });

  it('reads dates written as ISO text', async () => {
    const { fake, ledger } = setup();
    await ledger.prepare(preparation());
    fake.mutate((row) => ({
      ...row,
      createdAt: start.toISOString(),
      updatedAt: later.toISOString(),
    }));
    const record = await ledger.get(identity);
    assert.deepEqual(record?.createdAt, start);
    assert.deepEqual(record?.updatedAt, later);
  });

  // The row sits under this delivery's key, so a different identity inside it
  // means the row is not what the key says. Acting on it could close or send
  // another installation's reminder.
  for (const [field, other] of [
    ['installationId', 'j'.repeat(43)],
    ['homeTimeZone', 'Australia/Perth'],
    ['changeEventAt', '2026-10-05T16:00:00.000Z'],
    ['timing', 'one-day'],
  ] as const) {
    it(`rejects a row whose ${field} is another delivery's`, async () => {
      const { fake, ledger } = setup();
      await ledger.prepare(preparation());
      fake.mutate((row) => ({ ...row, [field]: other }));
      await assert.rejects(
        () => ledger.get(identity),
        /Reminder dispatch ledger identity mismatch/,
      );
    });
  }

  for (const [field, valid] of [
    [
      'status',
      [
        'pending',
        'claimed',
        'accepted',
        'transient-failure',
        'permanent-failure',
        'expired',
        'uncertain',
      ],
    ],
    [
      'cleanupStatus',
      ['failed', 'not-found', 'pending', 'removed', 'token-replaced'],
    ],
    ['expiryReason', ['event', 'pack', 'superseded', 'window']],
  ] as const) {
    for (const value of valid) {
      it(`reads a ${field} of ${value}`, async () => {
        const { fake, ledger } = setup();
        await ledger.prepare(preparation());
        fake.mutate((row) => ({ ...row, [field]: value }));
        assert.equal((await ledger.get(identity))?.[field], value);
      });
    }
  }

  it('reads the optional fields it stored', async () => {
    const { fake, ledger } = setup();
    await ledger.prepare(preparation());
    const optional = {
      claimExpiresAt: later,
      claimId: 'claim',
      cleanupStatus: 'pending',
      expiryReason: 'window',
      invalidatedAt: start,
      lastClaimId: 'last',
      sendStartedAt: start,
    };
    fake.mutate((row) => ({ ...row, ...optional }));
    assert.deepEqual(await ledger.get(identity), {
      ...pendingRow,
      ...optional,
      etag: '2',
    });
  });
});

describe('reminder dispatch ledger preparation', () => {
  const nextPackValidUntil = new Date('2027-01-01T00:00:00.000Z');
  const refreshed = {
    deliveryWindowEndsAt: msAfter(3_600_000, windowEndsAt),
    now: later,
    packValidUntil: nextPackValidUntil,
  };
  const reset = { attemptGeneration: 2, now: later };
  // After a reset the delivery starts over from the preparation: it keeps
  // nothing of the claim, the failure or the expiry it replaces.
  const restarted = rowWith({
    attemptGeneration: 2,
    createdAt: later,
    updatedAt: later,
  });

  async function packExpired(ledger: Ledger): Promise<Stage> {
    await ledger.prepare(preparation({ packValidUntil: msAfter(10) }));
    assert.equal(await ledger.claim(identity, msAfter(11)), null);
    return {
      claim: unissuedClaim,
      row: rowWith({
        expiryReason: 'pack',
        packValidUntil: msAfter(10),
        status: 'expired',
        updatedAt: msAfter(11),
      }),
    };
  }
  async function newerGeneration(ledger: Ledger): Promise<Stage> {
    await ledger.prepare(preparation({ attemptGeneration: 2 }));
    return { claim: unissuedClaim, row: rowWith({ attemptGeneration: 2 }) };
  }

  it('creates a pending record for a new delivery', async () => {
    const { fake, ledger } = setup();
    const record = await ledger.prepare(preparation());
    assert.deepEqual(record, { ...pendingRow, etag: '1' });
    assert.deepEqual(fake.stored(), pendingRow);
    assert.deepEqual(fake.writes, [{ kind: 'create', status: 'pending' }]);
  });

  it('records the instants it was given, not the objects', async () => {
    const { fake, ledger } = setup();
    const given = preparation({ now: new Date(start) });
    await ledger.prepare(given);
    given.now.setTime(0);
    assert.deepEqual(fake.stored().createdAt, start);
  });

  it('accepts a window that ends as it starts', async () => {
    const { fake, ledger } = setup();
    await ledger.prepare(preparation({ deliveryWindowEndsAt: windowStartsAt }));
    assert.deepEqual(fake.stored().deliveryWindowEndsAt, windowStartsAt);
  });

  for (const [name, overrides, message] of [
    ['a zero generation', { attemptGeneration: 0 }, /preparation/],
    ['a negative generation', { attemptGeneration: -1 }, /preparation/],
    ['a fractional generation', { attemptGeneration: 1.5 }, /preparation/],
    [
      'a generation that is not a number',
      { attemptGeneration: Number.NaN },
      /preparation/,
    ],
    [
      'a window that ends before it starts',
      { deliveryWindowEndsAt: msAfter(-1, windowStartsAt) },
      /preparation/,
    ],
    ['an invalid clock', { now: new Date(Number.NaN) }, /clock/],
    [
      'an invalid window start',
      { deliveryWindowStartsAt: new Date(Number.NaN) },
      /clock/,
    ],
    [
      'an invalid window end',
      { deliveryWindowEndsAt: new Date(Number.NaN) },
      /clock/,
    ],
    [
      'an invalid pack horizon',
      { packValidUntil: new Date(Number.NaN) },
      /clock/,
    ],
    [
      'an identity that is not valid',
      { installationId: 'a b' },
      /installation ID/,
    ],
  ] as const) {
    it(`refuses ${name} without storing anything`, async () => {
      const { fake, ledger } = setup();
      await assert.rejects(
        () => ledger.prepare(preparation(overrides)),
        message,
      );
      assert.equal(fake.rows.size, 0);
    });
  }

  for (const [title, stage, incoming, expected] of [
    [
      'refreshes a pending record, keeping when it was created',
      stages.pending,
      refreshed,
      () =>
        rowWith({
          deliveryWindowEndsAt: refreshed.deliveryWindowEndsAt,
          packValidUntil: nextPackValidUntil,
          updatedAt: later,
        }),
    ],
    [
      'makes a transient failure pending again',
      stages.transient,
      { now: later },
      () => rowWith({ updatedAt: later }),
    ],
    [
      'makes a superseded expiry pending again',
      stages.superseded,
      { now: later },
      () => rowWith({ updatedAt: later }),
    ],
    [
      'makes a pack expiry pending again once the pack covers the time',
      packExpired,
      { now: later, packValidUntil: later },
      () => rowWith({ packValidUntil: later, updatedAt: later }),
    ],
    [
      'leaves a pack expiry when the pack ends before the time',
      packExpired,
      { now: later, packValidUntil: msAfter(999) },
      null,
    ],
    ['leaves a claimed record', stages.claimed, { now: later }, null],
    [
      'leaves a record with a send intent',
      stages.sending,
      { now: later },
      null,
    ],
    ['leaves an accepted record', stages.accepted, { now: later }, null],
    ['leaves an uncertain record', stages.uncertain, { now: later }, null],
    ['leaves a rejected record', stages.rejected, { now: later }, null],
    [
      'leaves an expiry that no new pack or generation reverses',
      stages.expired,
      { now: later },
      null,
    ],
    ['leaves a newer generation', newerGeneration, { now: later }, null],
    [
      'restarts a pending record for a newer generation',
      stages.pending,
      reset,
      () => restarted,
    ],
    [
      'restarts a claimed record for a newer generation, dropping the claim',
      stages.claimed,
      reset,
      () => restarted,
    ],
    [
      'restarts a transient failure for a newer generation',
      stages.transient,
      reset,
      () => restarted,
    ],
    [
      'restarts a rejected record for a newer generation',
      stages.rejected,
      reset,
      () => restarted,
    ],
    [
      'restarts a superseded expiry for a newer generation',
      stages.superseded,
      reset,
      () => restarted,
    ],
    [
      'restarts a pack expiry for a newer generation',
      packExpired,
      reset,
      () => restarted,
    ],
    [
      'makes a record with a send intent uncertain, not a newer generation',
      stages.sending,
      reset,
      (stage: Stage) =>
        rowWith({
          lastClaimId: stage.claim.claimId,
          status: 'uncertain',
          updatedAt: later,
        }),
    ],
    [
      'leaves an accepted record whatever the generation',
      stages.accepted,
      reset,
      null,
    ],
    [
      'leaves an uncertain record whatever the generation',
      stages.uncertain,
      reset,
      null,
    ],
    [
      'leaves an expiry that no new generation reverses',
      stages.expired,
      reset,
      null,
    ],
  ] as readonly (readonly [
    string,
    Setup,
    Partial<ReminderDispatchPreparation>,
    ((stage: Stage) => Row) | null,
  ])[]) {
    it(title, async () => {
      const { fake, ledger } = setup();
      const before = await stage(ledger);
      assert.deepEqual(fake.stored(), before.row);
      fake.begin();

      const record = await ledger.prepare(preparation(incoming));

      if (expected === null) {
        assert.deepEqual(fake.stored(), before.row);
        assert.deepEqual(fake.writes, []);
      } else {
        assert.deepEqual(fake.stored(), expected(before));
        assert.deepEqual(
          fake.writes.map((write) => write.kind),
          ['replace'],
        );
      }
      assert.deepEqual(record, await ledger.get(identity));
    });
  }

  it('adopts the record another worker created first', async () => {
    const { fake, ledger } = setup();
    const rival = createTableReminderDispatchLedgerStore(fake.table);
    fake.begin({
      create: async (call, run) => {
        if (call === 1) await rival.prepare(preparation());
        await run();
      },
    });

    const record = await ledger.prepare(preparation({ now: later }));

    assert.deepEqual(
      fake.writes.map((write) => write.kind),
      ['create', 'create', 'replace'],
    );
    assert.deepEqual(fake.stored(), rowWith({ updatedAt: later }));
    assert.deepEqual(record, await ledger.get(identity));
  });

  it('creates the record again when it vanished after the create', async () => {
    const { fake, ledger } = setup();
    fake.begin({
      create: async (call, run) => {
        await run();
        if (call === 1) fake.rows.clear();
      },
    });
    const record = await ledger.prepare(preparation());
    assert.deepEqual(record, { ...pendingRow, etag: '2' });
    assert.equal(fake.writes.length, 2);
  });

  it('finds its own create when the acknowledgement was lost', async () => {
    const { fake, ledger } = setup();
    fake.begin({ create: loseAcknowledgement });
    const record = await ledger.prepare(preparation());
    assert.deepEqual(record, { ...pendingRow, etag: '1' });
    assert.equal(fake.writes.length, 1);
  });

  it('reports a failed create that stored nothing', async () => {
    const { fake, ledger } = setup();
    const failure = azureError(503);
    fake.begin({ create: fails(failure) });
    await assert.rejects(
      () => ledger.prepare(preparation()),
      sameError(failure),
    );
    assert.equal(fake.rows.size, 0);
    assert.equal(fake.writes.length, 1);
  });

  it('reports the create failure, not the failure of the read that checked it', async () => {
    const { fake, ledger } = setup();
    const failure = azureError(503);
    fake.begin({
      create: fails(failure),
      get: (call, run) =>
        call === 1 ? run() : Promise.reject(azureError(500)),
    });
    await assert.rejects(
      () => ledger.prepare(preparation()),
      sameError(failure),
    );
  });

  it('gives up after repeated create conflicts', async () => {
    const { fake, ledger } = setup();
    fake.begin({ create: fails(azureError(409)) });
    await assert.rejects(() => ledger.prepare(preparation()), {
      message: 'Reminder dispatch preparation contention exceeded retry limit',
    });
    assert.equal(fake.writes.length, retryLimit);
  });
});

describe('reminder dispatch ledger claims', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  // The instant a claim granted at `start` with the default lease runs out.
  const leaseEnds = msAfter(defaultLeaseMs);

  it('claims nothing for a delivery that was never prepared', async () => {
    const { fake, ledger } = setup();
    assert.equal(await ledger.claim(identity, start), null);
    assert.deepEqual(fake.writes, []);
  });

  it('claims a pending delivery for the lease it asks for', async () => {
    const { fake, ledger } = setup();
    await ledger.prepare(preparation());
    fake.begin();

    const claim = await ledger.claim(identity, later, 5_000);

    assert.ok(claim);
    assert.deepEqual(claim, {
      ...identity,
      attemptGeneration: 1,
      claimExpiresAt: msAfter(5_000, later),
      claimId: claim.claimId,
    });
    assert.deepEqual(
      fake.stored(),
      rowWith({
        claimExpiresAt: msAfter(5_000, later),
        claimId: claim.claimId,
        status: 'claimed',
        updatedAt: later,
      }),
    );
    // The write names the ETag of the record it read.
    assert.deepEqual(fake.writes, [
      { kind: 'replace', etag: '1', status: 'claimed' },
    ]);
  });

  it('claims a transient failure again', async () => {
    const { ledger } = setup();
    const { claim: first } = await stages.transient(ledger);
    const second = await ledger.claim(identity, later);
    assert.ok(second);
    assert.notEqual(second.claimId, first.claimId);
  });

  for (const leaseMs of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    3_600_001,
  ]) {
    it(`refuses a lease of ${leaseMs} ms`, async () => {
      const { fake, ledger } = setup();
      await ledger.prepare(preparation());
      fake.begin();
      await assert.rejects(
        () => ledger.claim(identity, start, leaseMs),
        /Invalid reminder dispatch claim lease/,
      );
      assert.deepEqual(fake.writes, []);
    });
  }

  for (const leaseMs of [1, 3_600_000]) {
    it(`allows a lease of ${leaseMs} ms`, async () => {
      const { ledger } = setup();
      await ledger.prepare(preparation());
      const claim = await ledger.claim(identity, start, leaseMs);
      assert.deepEqual(claim?.claimExpiresAt, msAfter(leaseMs));
    });
  }

  it('refuses an invalid clock', async () => {
    const { ledger } = setup();
    await assert.rejects(
      () => ledger.claim(identity, new Date(Number.NaN)),
      /Invalid reminder dispatch clock/,
    );
  });

  for (const name of [
    'accepted',
    'uncertain',
    'rejected',
    'rejectedNoToken',
    'expired',
    'superseded',
  ] as const) {
    it(`does not claim a delivery that is ${name}`, async () => {
      const { fake, ledger } = setup();
      const before = await stages[name](ledger);
      fake.begin();
      assert.equal(await ledger.claim(identity, later), null);
      assert.deepEqual(fake.stored(), before.row);
      assert.deepEqual(fake.writes, []);
    });
  }

  for (const name of ['claimed', 'sending'] as const) {
    it(`does not claim a delivery while the ${name} lease is live`, async () => {
      const { fake, ledger } = setup();
      const before = await stages[name](ledger);
      fake.begin();
      assert.equal(
        await ledger.claim(identity, msAfter(defaultLeaseMs - 1)),
        null,
      );
      assert.deepEqual(fake.stored(), before.row);
      assert.deepEqual(fake.writes, []);
    });
  }

  it('opens the delivery window at its start', async () => {
    const { fake, ledger } = setup();
    await ledger.prepare(preparation());
    fake.begin();
    assert.equal(await ledger.claim(identity, msAfter(-1)), null);
    assert.deepEqual(fake.writes, []);
    assert.ok(await ledger.claim(identity, start));
  });

  for (const [title, at] of [
    ['the moment its lease ends', leaseEnds],
    ['after its lease ended', msAfter(1, leaseEnds)],
  ] as const) {
    it(`claims again over an unused claim ${title}`, async () => {
      const { fake, ledger } = setup();
      const before = await stages.claimed(ledger);
      fake.begin();

      const claim = await ledger.claim(identity, at);

      assert.ok(claim);
      assert.notEqual(claim.claimId, before.claim.claimId);
      assert.deepEqual(
        fake.stored(),
        rowWith({
          claimExpiresAt: msAfter(defaultLeaseMs, at),
          claimId: claim.claimId,
          status: 'claimed',
          updatedAt: at,
        }),
      );
      // The old claim is first returned to pending, then claimed anew.
      assert.deepEqual(
        fake.writes.map((write) => write.status),
        ['pending', 'claimed'],
      );
    });

    it(`marks a claim with a send intent uncertain ${title}`, async () => {
      const { fake, ledger } = setup();
      const before = await stages.sending(ledger);
      fake.begin();

      assert.equal(await ledger.claim(identity, at), null);

      assert.deepEqual(
        fake.stored(),
        rowWith({
          lastClaimId: before.claim.claimId,
          status: 'uncertain',
          updatedAt: at,
        }),
      );
      assert.deepEqual(
        fake.writes.map((write) => write.status),
        ['uncertain'],
      );
    });
  }

  it('treats a claim with no lease as lapsed', async () => {
    const { fake, ledger } = setup();
    const before = await stages.claimed(ledger);
    fake.mutate(({ claimExpiresAt: _lease, ...row }) => row);
    const claim = await ledger.claim(identity, later);
    assert.ok(claim);
    assert.notEqual(claim.claimId, before.claim.claimId);
    assert.equal(fake.stored().claimId, claim.claimId);
  });

  const eventAt = msAfter(10_000);
  for (const [reason, overrides, target, lastLive, firstExpired] of [
    ['window', {}, identity, windowEndsAt, afterWindow],
    [
      'event',
      {
        changeEventAt: eventAt.toISOString(),
        deliveryWindowEndsAt: msAfter(3_600_000),
      },
      { ...identity, changeEventAt: eventAt.toISOString() },
      msAfter(9_999),
      eventAt,
    ],
    [
      'pack',
      { packValidUntil: msAfter(10) },
      identity,
      msAfter(10),
      msAfter(11),
    ],
  ] as const) {
    it(`claims up to the end of the ${reason} but not after`, async () => {
      const live = setup();
      await live.ledger.prepare(preparation(overrides));
      assert.ok(await live.ledger.claim(target, lastLive));

      const { fake, ledger } = setup();
      await ledger.prepare(preparation(overrides));
      fake.begin();
      assert.equal(await ledger.claim(target, firstExpired), null);
      assert.deepEqual(
        fake.stored(),
        rowWith({
          ...overrides,
          expiryReason: reason,
          status: 'expired',
          updatedAt: firstExpired,
        }),
      );
      assert.deepEqual(
        fake.writes.map((write) => write.status),
        ['expired'],
      );
    });
  }

  // Each case needs a write before the claim itself can be decided.
  for (const [title, setupStage, at, claims, statusesAfterRace] of [
    [
      'a lapsed claim',
      (ledger: Ledger) => claimed(ledger, 1),
      msAfter(2),
      true,
      ['pending', 'pending', 'claimed'],
    ],
    [
      'a lapsed send intent',
      stages.sending,
      leaseEnds,
      false,
      ['uncertain', 'uncertain'],
    ],
    ['an expiry', stages.pending, afterWindow, false, ['expired', 'expired']],
  ] as const) {
    it(`reports a failed write that settles ${title}`, async () => {
      const { fake, ledger } = setup();
      const before = await setupStage(ledger);
      const failure = azureError(503);
      fake.begin({ replace: fails(failure) });
      await assert.rejects(
        () => ledger.claim(identity, at),
        sameError(failure),
      );
      assert.deepEqual(fake.stored(), before.row);
      assert.equal(fake.writes.length, 1);
    });

    it(`reads again when another worker wrote while it settled ${title}`, async () => {
      const { fake, ledger } = setup();
      await setupStage(ledger);
      fake.begin({
        replace: async (call, run) => {
          if (call === 1) fake.mutate((row) => row);
          await run();
        },
      });
      const claim = await ledger.claim(identity, at);
      assert.equal(claim !== null, claims);
      assert.deepEqual(
        fake.writes.map((write) => write.status),
        statusesAfterRace,
      );
    });
  }

  it('does not hand out a claim another worker took over before it read it back', async () => {
    const { fake, ledger } = setup();
    await ledger.prepare(preparation());
    fake.begin({
      replace: async (_call, run) => {
        await run();
        fake.mutate((row) => ({
          ...row,
          claimId: 'rival',
          claimExpiresAt: msAfter(defaultLeaseMs),
        }));
      },
    });
    assert.equal(await ledger.claim(identity, start), null);
    assert.equal(fake.stored().claimId, 'rival');
  });

  it('claims the newer generation when the record was prepared again before it read back', async () => {
    const { fake, ledger } = setup();
    await ledger.prepare(preparation());
    fake.begin({
      replace: async (call, run) => {
        await run();
        if (call === 1) {
          await ledger.prepare(
            preparation({ attemptGeneration: 2, now: later }),
          );
        }
      },
    });

    const claim = await ledger.claim(identity, later);

    assert.equal(claim?.attemptGeneration, 2);
    assert.equal(fake.stored().attemptGeneration, 2);
    assert.equal(fake.stored().claimId, claim?.claimId);
  });

  it('finds no claim when the record vanished before it read back', async () => {
    const { fake, ledger } = setup();
    await ledger.prepare(preparation());
    fake.begin({
      replace: async (_call, run) => {
        await run();
        fake.rows.clear();
      },
    });
    assert.equal(await ledger.claim(identity, start), null);
  });

  it('reports the failure when the record vanished and the write did not commit', async () => {
    const { fake, ledger } = setup();
    await ledger.prepare(preparation());
    const failure = azureError(503);
    fake.begin({
      replace: async () => {
        fake.rows.clear();
        throw failure;
      },
    });
    await assert.rejects(
      () => ledger.claim(identity, start),
      sameError(failure),
    );
  });

  it("keeps another worker's claim when its own write failed", async () => {
    const { fake, ledger } = setup();
    await ledger.prepare(preparation());
    const failure = azureError(503);
    fake.begin({
      replace: async () => {
        fake.mutate((row) => ({
          ...row,
          claimId: 'rival',
          claimExpiresAt: msAfter(defaultLeaseMs),
          status: 'claimed',
        }));
        throw failure;
      },
    });
    await assert.rejects(
      () => ledger.claim(identity, start),
      sameError(failure),
    );
    assert.equal(fake.stored().claimId, 'rival');
  });

  it('admits one of two claims racing for the same delivery', async () => {
    const { fake, ledger } = setup();
    await ledger.prepare(preparation());
    fake.begin({
      get: async (_call, run) => {
        await tick();
        return run();
      },
      replace: async (_call, run) => {
        await tick();
        await run();
      },
    });

    const claims = await Promise.all([
      ledger.claim(identity, start),
      ledger.claim(identity, start),
    ]);

    const winners = claims.filter((claim) => claim !== null);
    assert.equal(winners.length, 1);
    assert.equal(fake.stored().claimId, winners[0]?.claimId);
  });
});

describe('reminder dispatch ledger claim holders', () => {
  const leaseEnds = msAfter(defaultLeaseMs);
  // The operations that act for the worker holding a claim.
  const operations = {
    beginSend: (ledger: Ledger, claim: ReminderDispatchClaim, now: Date) =>
      ledger.beginSend(claim, now),
    cancelBeforeProvider: (
      ledger: Ledger,
      claim: ReminderDispatchClaim,
      now: Date,
    ) => ledger.cancelBeforeProvider(claim, now),
    release: (ledger: Ledger, claim: ReminderDispatchClaim, now: Date) =>
      ledger.release(claim, now),
  };

  for (const [name, operate] of Object.entries(operations)) {
    for (const [title, stage, holder] of [
      ['for a delivery that was never prepared', null, () => unissuedClaim],
      [
        'when another worker holds the claim',
        stages.claimed,
        (claim: ReminderDispatchClaim) => ({ ...claim, claimId: 'other' }),
      ],
      [
        'when the claim is for another generation',
        stages.claimed,
        (claim: ReminderDispatchClaim) => ({ ...claim, attemptGeneration: 2 }),
      ],
      [
        'once the claim was released',
        stages.pending,
        (claim: ReminderDispatchClaim) => claim,
      ],
      [
        'once the delivery was settled',
        stages.accepted,
        (claim: ReminderDispatchClaim) => claim,
      ],
    ] as const) {
      it(`${name} reports stale ${title}`, async () => {
        const { fake, ledger } = setup();
        const before = stage === null ? undefined : await stage(ledger);
        fake.begin();

        const result = await operate(
          ledger,
          holder(before?.claim ?? unissuedClaim),
          later,
        );

        assert.deepEqual(result, {
          kind: 'stale',
          record: (await ledger.get(identity)) ?? undefined,
        });
        assert.deepEqual(fake.writes, []);
        if (before !== undefined) assert.deepEqual(fake.stored(), before.row);
      });
    }
  }

  describe('beginSend', () => {
    it('saves the send intent', async () => {
      const { fake, ledger } = setup();
      const before = await stages.claimed(ledger);
      fake.begin();

      const result = await ledger.beginSend(
        before.claim,
        msAfter(defaultLeaseMs - 1),
      );

      const now = msAfter(defaultLeaseMs - 1);
      assert.deepEqual(fake.stored(), {
        ...before.row,
        sendStartedAt: now,
        updatedAt: now,
      });
      assert.deepEqual(result, {
        kind: 'updated',
        record: await ledger.get(identity),
      });
      assert.deepEqual(fake.writes, [
        { kind: 'replace', etag: '2', status: 'claimed' },
      ]);
    });

    it('accepts the intent again without writing', async () => {
      const { fake, ledger } = setup();
      const before = await stages.sending(ledger);
      fake.begin();

      const result = await ledger.beginSend(before.claim, later);

      assert.deepEqual(result, {
        kind: 'updated',
        record: await ledger.get(identity),
      });
      assert.deepEqual(fake.stored(), before.row);
      assert.deepEqual(fake.writes, []);
    });

    it('refuses an invalid clock', async () => {
      const { ledger } = setup();
      await assert.rejects(
        () => ledger.beginSend(unissuedClaim, new Date(Number.NaN)),
        /Invalid reminder dispatch clock/,
      );
    });

    // The lease ended, so another worker may already hold the delivery. This
    // worker must not send, and must leave the record safe to claim again.
    it('abandons a claim whose lease ended, freeing it', async () => {
      const { fake, ledger } = setup();
      const before = await stages.claimed(ledger);
      fake.begin();

      const result = await ledger.beginSend(before.claim, leaseEnds);

      assert.deepEqual(result, { kind: 'stale' });
      assert.deepEqual(fake.stored(), rowWith({ updatedAt: leaseEnds }));
      assert.deepEqual(
        fake.writes.map((write) => write.status),
        ['pending'],
      );
    });

    it('abandons a claim whose lease ended after a send intent, as uncertain', async () => {
      const { fake, ledger } = setup();
      const before = await stages.sending(ledger);
      fake.begin();

      const result = await ledger.beginSend(before.claim, leaseEnds);

      assert.deepEqual(result, { kind: 'stale' });
      assert.deepEqual(
        fake.stored(),
        rowWith({
          lastClaimId: before.claim.claimId,
          status: 'uncertain',
          updatedAt: leaseEnds,
        }),
      );
    });

    it('abandons a claim that has no lease', async () => {
      const { fake, ledger } = setup();
      const before = await stages.claimed(ledger);
      fake.mutate(({ claimExpiresAt: _lease, ...row }) => row);

      assert.deepEqual(await ledger.beginSend(before.claim, later), {
        kind: 'stale',
      });
      assert.deepEqual(fake.stored(), rowWith({ updatedAt: later }));
    });

    it('returns a claim to pending when the clock is before the window', async () => {
      const { fake, ledger } = setup();
      const before = await stages.claimed(ledger);
      fake.begin();

      const result = await ledger.beginSend(before.claim, msAfter(-1));

      assert.deepEqual(fake.stored(), rowWith({ updatedAt: msAfter(-1) }));
      assert.deepEqual(result, {
        kind: 'updated',
        record: await ledger.get(identity),
      });
      assert.deepEqual(
        fake.writes.map((write) => write.status),
        ['pending'],
      );
    });

    const eventAt = msAfter(10_000);
    for (const [reason, overrides, target, lastLive, firstExpired] of [
      [
        'window',
        { deliveryWindowEndsAt: msAfter(10_000) },
        identity,
        msAfter(10_000),
        msAfter(10_001),
      ],
      [
        'event',
        {
          changeEventAt: eventAt.toISOString(),
          deliveryWindowEndsAt: msAfter(3_600_000),
        },
        { ...identity, changeEventAt: eventAt.toISOString() },
        msAfter(9_999),
        eventAt,
      ],
      [
        'pack',
        { packValidUntil: msAfter(10_000) },
        identity,
        msAfter(10_000),
        msAfter(10_001),
      ],
    ] as const) {
      it(`closes a delivery whose ${reason} ended, but not before`, async () => {
        const live = setup();
        await live.ledger.prepare(preparation(overrides));
        const liveClaim = await live.ledger.claim(target, start);
        assert.ok(liveClaim);
        const started = await live.ledger.beginSend(liveClaim, lastLive);
        assert.equal(started.kind, 'updated');
        assert.equal(started.record?.status, 'claimed');
        assert.deepEqual(started.record?.sendStartedAt, lastLive);

        const { fake, ledger } = setup();
        await ledger.prepare(preparation(overrides));
        const claim = await ledger.claim(target, start);
        assert.ok(claim);
        fake.begin();

        const result = await ledger.beginSend(claim, firstExpired);

        assert.deepEqual(
          fake.stored(),
          rowWith({
            ...overrides,
            expiryReason: reason,
            status: 'expired',
            updatedAt: firstExpired,
          }),
        );
        assert.deepEqual(result, {
          kind: 'updated',
          record: await ledger.get(target),
        });
        assert.deepEqual(
          fake.writes.map((write) => write.status),
          ['expired'],
        );
      });
    }

    // Each case needs a write before the send intent: it frees a lapsed claim
    // or closes a delivery that ended.
    for (const [title, overrides, at, kind, writesAfterRace] of [
      ['frees a lapsed claim', {}, leaseEnds, 'stale', ['pending', 'pending']],
      [
        'closes an ended delivery',
        { deliveryWindowEndsAt: msAfter(10_000) },
        msAfter(10_001),
        'updated',
        ['expired', 'expired'],
      ],
      [
        'restores a claim before the window',
        {},
        msAfter(-1),
        'updated',
        ['pending', 'pending'],
      ],
    ] as const) {
      it(`reports a failed write that ${title}`, async () => {
        const { fake, ledger } = setup();
        await ledger.prepare(preparation(overrides));
        const claim = await ledger.claim(identity, start);
        assert.ok(claim);
        const failure = azureError(503);
        fake.begin({ replace: fails(failure) });
        await assert.rejects(
          () => ledger.beginSend(claim, at),
          sameError(failure),
        );
        assert.equal(fake.writes.length, 1);
        assert.equal(fake.stored().status, 'claimed');
      });

      it(`reads again when another worker wrote while it ${title}`, async () => {
        const { fake, ledger } = setup();
        await ledger.prepare(preparation(overrides));
        const claim = await ledger.claim(identity, start);
        assert.ok(claim);
        fake.begin({
          replace: async (call, run) => {
            if (call === 1) fake.mutate((row) => row);
            await run();
          },
        });
        assert.equal((await ledger.beginSend(claim, at)).kind, kind);
        assert.deepEqual(
          fake.writes.map((write) => write.status),
          writesAfterRace,
        );
      });
    }

    it("does not take a rival's claim for its own after the write", async () => {
      const { fake, ledger } = setup();
      const before = await stages.claimed(ledger);
      fake.begin({
        replace: async (_call, run) => {
          await run();
          fake.mutate((row) => ({ ...row, claimId: 'rival' }));
        },
      });
      assert.deepEqual(await ledger.beginSend(before.claim, later), {
        kind: 'stale',
        record: await ledger.get(identity),
      });
      assert.equal(fake.stored().claimId, 'rival');
    });

    it('does not report an intent on a record that stopped being claimed', async () => {
      const { fake, ledger } = setup();
      const before = await stages.claimed(ledger);
      fake.begin({
        replace: async (_call, run) => {
          await run();
          fake.mutate((row) => ({ ...row, status: 'uncertain' }));
        },
      });
      const result = await ledger.beginSend(before.claim, later);
      assert.equal(result.kind, 'stale');
      assert.equal(result.record?.status, 'uncertain');
    });

    it('reports stale when the record vanished after the write', async () => {
      const { fake, ledger } = setup();
      const before = await stages.claimed(ledger);
      fake.begin({
        replace: async (_call, run) => {
          await run();
          fake.rows.clear();
        },
      });
      assert.deepEqual(await ledger.beginSend(before.claim, later), {
        kind: 'stale',
        record: undefined,
      });
    });

    it('finds its own intent when the acknowledgement was lost', async () => {
      const { fake, ledger } = setup();
      const before = await stages.claimed(ledger);
      fake.begin({ replace: loseAcknowledgement });

      const result = await ledger.beginSend(before.claim, later);

      assert.deepEqual(result, {
        kind: 'updated',
        record: await ledger.get(identity),
      });
      assert.deepEqual(fake.stored().sendStartedAt, later);
      assert.equal(fake.writes.length, 1);
    });

    // After a failed write the row is read again, and only a stored intent of
    // this very claim proves the write landed. Anything else would let a
    // worker send on an intent that was never saved.
    for (const [title, change] of [
      ['it still has no send intent', (row: Row) => row],
      [
        'a rival holds the claim with its own send intent',
        (row: Row) => ({ ...row, claimId: 'rival', sendStartedAt: later }),
      ],
      [
        'a newer generation carries this claim ID and an intent',
        (row: Row) => ({ ...row, attemptGeneration: 2, sendStartedAt: later }),
      ],
      [
        'the claim became uncertain',
        (row: Row) => ({ ...row, status: 'uncertain', sendStartedAt: later }),
      ],
    ] as const) {
      it(`reports a failed write when ${title}`, async () => {
        const { fake, ledger } = setup();
        const before = await stages.claimed(ledger);
        const failure = azureError(503);
        fake.begin({
          replace: async () => {
            fake.mutate(change);
            throw failure;
          },
        });
        await assert.rejects(
          () => ledger.beginSend(before.claim, later),
          sameError(failure),
        );
        assert.equal(fake.writes.length, 1);
      });
    }

    it('reports the write failure when the read that checked it also failed', async () => {
      const { fake, ledger } = setup();
      const before = await stages.claimed(ledger);
      const failure = azureError(503);
      fake.begin({
        get: (call, run) =>
          call === 1 ? run() : Promise.reject(azureError(500)),
        replace: fails(failure),
      });
      await assert.rejects(
        () => ledger.beginSend(before.claim, later),
        sameError(failure),
      );
    });
  });

  describe('release', () => {
    for (const [title, setupStage, at, expected] of [
      [
        'returns an unused claim to pending',
        stages.claimed,
        later,
        () => rowWith({ updatedAt: later }),
      ],
      [
        'returns a claim with a send intent to uncertain',
        stages.sending,
        later,
        (stage: Stage) =>
          rowWith({
            lastClaimId: stage.claim.claimId,
            status: 'uncertain',
            updatedAt: later,
          }),
      ],
      [
        'releases a claim whose lease ended',
        stages.claimed,
        msAfter(defaultLeaseMs + 1),
        () => rowWith({ updatedAt: msAfter(defaultLeaseMs + 1) }),
      ],
    ] as const) {
      it(title, async () => {
        const { fake, ledger } = setup();
        const before = await setupStage(ledger);
        fake.begin();

        const result = await ledger.release(before.claim, at);

        assert.deepEqual(fake.stored(), expected(before));
        assert.deepEqual(result, {
          kind: 'updated',
          record: await ledger.get(identity),
        });
        assert.equal(fake.writes.length, 1);
      });
    }

    it('refuses an invalid clock', async () => {
      const { ledger } = setup();
      await assert.rejects(
        () => ledger.release(unissuedClaim, new Date(Number.NaN)),
        /Invalid reminder dispatch clock/,
      );
    });
  });

  describe('cancelBeforeProvider', () => {
    for (const [title, setupStage] of [
      ['withdraws a send intent', stages.sending],
      ['returns an unused claim to pending', stages.claimed],
    ] as const) {
      it(title, async () => {
        const { fake, ledger } = setup();
        const before = await setupStage(ledger);
        fake.begin();

        const result = await ledger.cancelBeforeProvider(before.claim, later);

        // Unlike release, nothing is left to show a send might have started.
        assert.deepEqual(fake.stored(), rowWith({ updatedAt: later }));
        assert.deepEqual(result, {
          kind: 'updated',
          record: await ledger.get(identity),
        });
        assert.equal(fake.writes.length, 1);
      });
    }

    it('refuses an invalid clock', async () => {
      const { ledger } = setup();
      await assert.rejects(
        () => ledger.cancelBeforeProvider(unissuedClaim, new Date(Number.NaN)),
        /Invalid reminder dispatch clock/,
      );
    });
  });
});

describe('reminder dispatch ledger completion', () => {
  const invalidatedAt = new Date('2026-09-28T07:30:00.000Z');
  const eventAt = msAfter(10_000);

  async function sendingWith(
    ledger: Ledger,
    overrides: Partial<ReminderDispatchPreparation> = {},
    target: ReminderDispatchIdentity = identity,
  ) {
    await ledger.prepare(preparation(overrides));
    const claim = await ledger.claim(target, start);
    assert.ok(claim);
    assert.equal((await ledger.beginSend(claim, start)).kind, 'updated');
    return claim;
  }

  // What each outcome leaves in the record when the claim is still held.
  const outcomes: readonly (readonly [
    string,
    ReminderDispatchCompletionOutcome,
    (claim: ReminderDispatchClaim) => Row,
  ])[] = [
    ['accepted', { kind: 'accepted' }, () => ({ status: 'accepted' })],
    [
      'uncertain',
      { kind: 'uncertain' },
      (claim) => ({ lastClaimId: claim.claimId, status: 'uncertain' }),
    ],
    [
      'a transient failure',
      { kind: 'transient-failure' },
      () => ({ status: 'transient-failure' }),
    ],
    [
      'a permanent failure',
      { kind: 'permanent-failure', invalidToken: false },
      () => ({ status: 'permanent-failure' }),
    ],
    [
      'a permanent failure for an invalid token',
      { kind: 'permanent-failure', invalidToken: true },
      () => ({ cleanupStatus: 'pending', status: 'permanent-failure' }),
    ],
    [
      'a permanent failure for a token the provider invalidated',
      { kind: 'permanent-failure', invalidToken: true, invalidatedAt },
      () => ({
        cleanupStatus: 'pending',
        invalidatedAt,
        status: 'permanent-failure',
      }),
    ],
    [
      'a permanent failure that is not about the token, whatever the provider says',
      { kind: 'permanent-failure', invalidToken: false, invalidatedAt },
      () => ({ status: 'permanent-failure' }),
    ],
  ];

  for (const [title, outcome, changes] of outcomes) {
    it(`records ${title}`, async () => {
      const { fake, ledger } = setup();
      const before = await stages.sending(ledger);
      fake.begin();

      const result = await ledger.complete(before.claim, outcome, later);

      assert.deepEqual(
        fake.stored(),
        rowWith({ ...changes(before.claim), updatedAt: later }),
      );
      assert.deepEqual(result, {
        kind: 'updated',
        record: await ledger.get(identity),
      });
      assert.deepEqual(fake.writes, [
        { kind: 'replace', etag: '3', status: fake.stored().status },
      ]);
    });
  }

  // A provider acceptance, rejection or uncertainty is a fact about the send,
  // so an ended window does not change it. Only a failure that may be retried
  // is overtaken by the end of the window, the event or the pack.
  for (const [title, outcome, changes] of outcomes.filter(
    ([, outcome]) => outcome.kind !== 'transient-failure',
  )) {
    it(`keeps ${title} after the window ended`, async () => {
      const { fake, ledger } = setup();
      const before = await stages.sending(ledger);
      await ledger.complete(before.claim, outcome, afterWindow);
      assert.deepEqual(
        fake.stored(),
        rowWith({ ...changes(before.claim), updatedAt: afterWindow }),
      );
    });
  }

  for (const [reason, overrides, target, lastLive, firstExpired] of [
    ['window', {}, identity, windowEndsAt, afterWindow],
    [
      'event',
      {
        changeEventAt: eventAt.toISOString(),
        deliveryWindowEndsAt: msAfter(3_600_000),
      },
      { ...identity, changeEventAt: eventAt.toISOString() },
      msAfter(9_999),
      eventAt,
    ],
    [
      'pack',
      { packValidUntil: msAfter(10) },
      identity,
      msAfter(10),
      msAfter(11),
    ],
  ] as const) {
    it(`expires a transient failure once the ${reason} ended, not before`, async () => {
      const live = setup();
      const liveClaim = await sendingWith(live.ledger, overrides, target);
      await live.ledger.complete(
        liveClaim,
        { kind: 'transient-failure' },
        lastLive,
      );
      assert.equal(live.fake.stored().status, 'transient-failure');
      assert.equal(live.fake.stored().expiryReason, undefined);

      const { fake, ledger } = setup();
      const claim = await sendingWith(ledger, overrides, target);
      const result = await ledger.complete(
        claim,
        { kind: 'transient-failure' },
        firstExpired,
      );
      assert.deepEqual(
        fake.stored(),
        rowWith({
          ...overrides,
          expiryReason: reason,
          status: 'expired',
          updatedAt: firstExpired,
        }),
      );
      assert.deepEqual(result, {
        kind: 'updated',
        record: await ledger.get(target),
      });
    });
  }

  it('refuses an invalidation time that is not a date', async () => {
    const { fake, ledger } = setup();
    const before = await stages.sending(ledger);
    fake.begin();
    await assert.rejects(
      () =>
        ledger.complete(
          before.claim,
          {
            kind: 'permanent-failure',
            invalidToken: true,
            invalidatedAt: 'yesterday' as never,
          },
          later,
        ),
      /Invalid reminder dispatch provider invalidation/,
    );
    await assert.rejects(
      () =>
        ledger.complete(
          before.claim,
          {
            kind: 'permanent-failure',
            invalidToken: true,
            invalidatedAt: new Date(Number.NaN),
          },
          later,
        ),
      /Invalid reminder dispatch clock/,
    );
    assert.deepEqual(fake.stored(), before.row);
    assert.deepEqual(fake.writes, []);
  });

  it('refuses an invalid clock', async () => {
    const { ledger } = setup();
    await assert.rejects(
      () =>
        ledger.complete(
          unissuedClaim,
          { kind: 'accepted' },
          new Date(Number.NaN),
        ),
      /Invalid reminder dispatch clock/,
    );
  });

  describe('for a claim it does not hold', () => {
    it('reports stale, with no record, for a delivery never prepared', async () => {
      const { fake, ledger } = setup();
      assert.deepEqual(
        await ledger.complete(unissuedClaim, { kind: 'accepted' }, later),
        { kind: 'stale' },
      );
      assert.deepEqual(fake.writes, []);
    });

    for (const [title, stage, holder] of [
      [
        'another worker holds the claim',
        stages.sending,
        (claim: ReminderDispatchClaim) => ({ ...claim, claimId: 'other' }),
      ],
      [
        'the claim is for another generation',
        stages.sending,
        (claim: ReminderDispatchClaim) => ({ ...claim, attemptGeneration: 2 }),
      ],
      [
        'the claim was released',
        stages.pending,
        (claim: ReminderDispatchClaim) => claim,
      ],
      [
        'the delivery was accepted',
        stages.accepted,
        (claim: ReminderDispatchClaim) => claim,
      ],
      [
        'the delivery failed for good',
        stages.rejected,
        (claim: ReminderDispatchClaim) => claim,
      ],
      [
        'the failure was recorded already',
        stages.transient,
        (claim: ReminderDispatchClaim) => claim,
      ],
    ] as const) {
      for (const outcome of [
        { kind: 'accepted' },
        { kind: 'permanent-failure', invalidToken: false },
      ] as const) {
        it(`reports stale with the record when ${title}: ${outcome.kind}`, async () => {
          const { fake, ledger } = setup();
          const before = await stage(ledger);
          fake.begin();

          const result = await ledger.complete(
            holder(before.claim),
            outcome,
            later,
          );

          assert.deepEqual(result, {
            kind: 'stale',
            record: await ledger.get(identity),
          });
          assert.deepEqual(fake.stored(), before.row);
          assert.deepEqual(fake.writes, []);
        });
      }
    }
  });

  // A worker that was cut off may still learn what the provider said. When
  // the record went uncertain under this very claim, a definite answer can
  // settle it. Nothing else may overwrite an uncertain record.
  describe('after the delivery became uncertain under the claim', () => {
    const lateAccepted = (claim: ReminderDispatchClaim) =>
      rowWith({
        lastClaimId: claim.claimId,
        status: 'accepted',
        updatedAt: later,
      });
    for (const [title, outcome, holder, expected] of [
      [
        'accepts a late acceptance',
        { kind: 'accepted' },
        (claim: ReminderDispatchClaim) => claim,
        lateAccepted,
      ],
      [
        'records a late permanent failure',
        { kind: 'permanent-failure', invalidToken: false },
        (claim: ReminderDispatchClaim) => claim,
        (claim: ReminderDispatchClaim) =>
          rowWith({
            lastClaimId: claim.claimId,
            status: 'permanent-failure',
            updatedAt: later,
          }),
      ],
      [
        'queues token cleanup for a late invalid-token failure',
        { kind: 'permanent-failure', invalidToken: true, invalidatedAt },
        (claim: ReminderDispatchClaim) => claim,
        (claim: ReminderDispatchClaim) =>
          rowWith({
            cleanupStatus: 'pending',
            invalidatedAt,
            lastClaimId: claim.claimId,
            status: 'permanent-failure',
            updatedAt: later,
          }),
      ],
      [
        'ignores a late uncertain result',
        { kind: 'uncertain' },
        (claim: ReminderDispatchClaim) => claim,
        null,
      ],
      [
        'ignores a late transient failure',
        { kind: 'transient-failure' },
        (claim: ReminderDispatchClaim) => claim,
        null,
      ],
      [
        'ignores a late acceptance by another claim',
        { kind: 'accepted' },
        (claim: ReminderDispatchClaim) => ({ ...claim, claimId: 'other' }),
        null,
      ],
      [
        'ignores a late permanent failure by another claim',
        { kind: 'permanent-failure', invalidToken: false },
        (claim: ReminderDispatchClaim) => ({ ...claim, claimId: 'other' }),
        null,
      ],
    ] as readonly (readonly [
      string,
      ReminderDispatchCompletionOutcome,
      (claim: ReminderDispatchClaim) => ReminderDispatchClaim,
      ((claim: ReminderDispatchClaim) => Row) | null,
    ])[]) {
      it(title, async () => {
        const { fake, ledger } = setup();
        const before = await stages.uncertain(ledger);
        fake.begin();

        const result = await ledger.complete(
          holder(before.claim),
          outcome,
          later,
        );

        if (expected === null) {
          assert.deepEqual(result, {
            kind: 'stale',
            record: await ledger.get(identity),
          });
          assert.deepEqual(fake.stored(), before.row);
          assert.deepEqual(fake.writes, []);
        } else {
          assert.deepEqual(result, {
            kind: 'updated',
            record: await ledger.get(identity),
          });
          assert.deepEqual(fake.stored(), expected(before.claim));
        }
      });
    }

    it('accepts a late result after the lease lapsed on a send intent', async () => {
      const { fake, ledger } = setup();
      const before = await stages.sending(ledger);
      assert.equal(await ledger.claim(identity, msAfter(defaultLeaseMs)), null);

      const result = await ledger.complete(
        before.claim,
        { kind: 'accepted' },
        later,
      );

      assert.equal(result.kind, 'updated');
      assert.equal(fake.stored().status, 'accepted');
    });

    it('does not let a late permanent failure overwrite an acceptance', async () => {
      const { fake, ledger } = setup();
      const before = await stages.uncertain(ledger);
      await ledger.complete(before.claim, { kind: 'accepted' }, later);
      fake.begin();

      const result = await ledger.complete(
        before.claim,
        { kind: 'permanent-failure', invalidToken: false },
        msAfter(2_000),
      );

      assert.deepEqual(result, {
        kind: 'stale',
        record: await ledger.get(identity),
      });
      assert.deepEqual(fake.stored(), lateAccepted(before.claim));
      assert.deepEqual(fake.writes, []);
    });
  });

  // After a failed write, the record is read again. Only a status this very
  // outcome would have written shows that the write landed.
  const written = {
    accepted: ['accepted'],
    'permanent-failure': ['permanent-failure'],
    'transient-failure': ['transient-failure', 'expired'],
    uncertain: ['uncertain'],
  } as const;
  const everyStatus: readonly ReminderDispatchStatus[] = [
    'pending',
    'claimed',
    'accepted',
    'transient-failure',
    'permanent-failure',
    'expired',
    'uncertain',
  ];
  for (const outcome of [
    { kind: 'accepted' },
    { kind: 'uncertain' },
    { kind: 'transient-failure' },
    { kind: 'permanent-failure', invalidToken: false },
  ] as const) {
    for (const status of everyStatus) {
      const landed = (written[outcome.kind] as readonly string[]).includes(
        status,
      );
      it(`${landed ? 'recognises' : 'does not recognise'} a ${outcome.kind} write on a record that became ${status}`, async () => {
        const { fake, ledger } = setup();
        const before = await stages.sending(ledger);
        const failure = azureError(503);
        fake.begin({
          replace: async () => {
            fake.mutate((row) => ({ ...row, status }));
            throw failure;
          },
        });

        const completing = () => ledger.complete(before.claim, outcome, later);

        if (landed) {
          const result = await completing();
          assert.equal(result.kind, 'updated');
          assert.equal(result.record.status, status);
        } else {
          await assert.rejects(completing, sameError(failure));
        }
        assert.equal(fake.writes.length, 1);
      });
    }
  }

  it('reports the failure when the record vanished and the write did not commit', async () => {
    const { fake, ledger } = setup();
    const before = await stages.sending(ledger);
    const failure = azureError(503);
    fake.begin({
      replace: async () => {
        fake.rows.clear();
        throw failure;
      },
    });
    await assert.rejects(
      () => ledger.complete(before.claim, { kind: 'accepted' }, later),
      sameError(failure),
    );
  });

  for (const [title, outcome, at, status] of [
    ['accepted', { kind: 'accepted' }, later, 'accepted'],
    ['uncertain', { kind: 'uncertain' }, later, 'uncertain'],
    [
      'a transient failure',
      { kind: 'transient-failure' },
      later,
      'transient-failure',
    ],
    [
      'a transient failure past the window',
      { kind: 'transient-failure' },
      afterWindow,
      'expired',
    ],
    [
      'a permanent failure',
      { kind: 'permanent-failure', invalidToken: false },
      later,
      'permanent-failure',
    ],
  ] as readonly (readonly [
    string,
    ReminderDispatchCompletionOutcome,
    Date,
    string,
  ])[]) {
    it(`finds its own write of ${title} when the acknowledgement was lost`, async () => {
      const { fake, ledger } = setup();
      const before = await stages.sending(ledger);
      fake.begin({ replace: loseAcknowledgement });

      const result = await ledger.complete(before.claim, outcome, at);

      assert.equal(result.kind, 'updated');
      assert.equal(result.record.status, status);
      assert.deepEqual(result.record, await ledger.get(identity));
      assert.equal(fake.writes.length, 1);
    });
  }
});

describe('reminder dispatch ledger invalidation', () => {
  it('reports stale, with no record, for a delivery never prepared', async () => {
    const { ledger } = setup();
    assert.deepEqual(await ledger.invalidate(identity, 1, later), {
      kind: 'stale',
    });
  });

  it('reports stale with the record for another generation', async () => {
    const { fake, ledger } = setup();
    const before = await stages.pending(ledger);
    fake.begin();
    assert.deepEqual(await ledger.invalidate(identity, 2, later), {
      kind: 'stale',
      record: await ledger.get(identity),
    });
    assert.deepEqual(fake.stored(), before.row);
    assert.deepEqual(fake.writes, []);
  });

  for (const generation of [0, -1, 1.5, Number.NaN]) {
    it(`refuses generation ${generation}`, async () => {
      const { ledger } = setup();
      await assert.rejects(
        () => ledger.invalidate(identity, generation, later),
        /Invalid reminder dispatch generation/,
      );
    });
  }

  it('refuses an invalid clock', async () => {
    const { ledger } = setup();
    await assert.rejects(
      () => ledger.invalidate(identity, 1, new Date(Number.NaN)),
      /Invalid reminder dispatch clock/,
    );
  });

  const superseded = rowWith({
    expiryReason: 'superseded',
    status: 'expired',
    updatedAt: later,
  });
  for (const [title, stage, expected] of [
    [
      'expires a pending record as superseded',
      stages.pending,
      () => superseded,
    ],
    [
      'expires a claim as superseded, dropping the claim',
      stages.claimed,
      () => superseded,
    ],
    [
      'expires a transient failure as superseded',
      stages.transient,
      () => superseded,
    ],
    [
      'makes a record with a send intent uncertain',
      stages.sending,
      (stage: Stage) =>
        rowWith({
          lastClaimId: stage.claim.claimId,
          status: 'uncertain',
          updatedAt: later,
        }),
    ],
    ['stamps a superseded expiry again', stages.superseded, () => superseded],
    ['leaves an accepted record', stages.accepted, null],
    ['leaves an uncertain record', stages.uncertain, null],
    ['leaves a rejected record', stages.rejected, null],
    [
      'leaves a rejection that is not about the token',
      stages.rejectedNoToken,
      null,
    ],
    ['leaves an expiry that is not superseded', stages.expired, null],
  ] as readonly (readonly [string, Setup, ((stage: Stage) => Row) | null])[]) {
    it(title, async () => {
      const { fake, ledger } = setup();
      const before = await stage(ledger);
      fake.begin();

      const result = await ledger.invalidate(before.claim, 1, later);

      assert.deepEqual(result, {
        kind: 'updated',
        record: await ledger.get(identity),
      });
      if (expected === null) {
        assert.deepEqual(fake.stored(), before.row);
        assert.deepEqual(fake.writes, []);
      } else {
        assert.deepEqual(fake.stored(), expected(before));
        assert.equal(fake.writes.length, 1);
      }
    });
  }
});

describe('reminder dispatch ledger cleanup progress', () => {
  const settled: readonly ReminderDispatchCleanupStatus[] = [
    'removed',
    'not-found',
    'token-replaced',
  ];

  it('reports stale, with no record, for a delivery never prepared', async () => {
    const { ledger } = setup();
    assert.deepEqual(
      await ledger.updateCleanup(identity, 1, 'removed', later),
      {
        kind: 'stale',
        record: undefined,
      },
    );
  });

  for (const [title, stage, generation] of [
    ['for another generation', stages.rejected, 2],
    ['for a delivery that has not failed for good', stages.pending, 1],
    ['for an accepted delivery', stages.accepted, 1],
  ] as const) {
    it(`reports stale with the record ${title}`, async () => {
      const { fake, ledger } = setup();
      const before = await stage(ledger);
      fake.begin();
      assert.deepEqual(
        await ledger.updateCleanup(identity, generation, 'removed', later),
        { kind: 'stale', record: await ledger.get(identity) },
      );
      assert.deepEqual(fake.stored(), before.row);
      assert.deepEqual(fake.writes, []);
    });
  }

  for (const [from, to] of [
    ['pending', 'failed'],
    ['pending', 'removed'],
    ['pending', 'not-found'],
    ['pending', 'token-replaced'],
    ['failed', 'removed'],
    ['failed', 'pending'],
  ] as const) {
    it(`moves cleanup from ${from} to ${to}`, async () => {
      const { fake, ledger } = setup();
      await stages.rejected(ledger);
      if (from === 'failed') {
        await ledger.updateCleanup(identity, 1, 'failed', start);
      }
      const stored = fake.stored();
      fake.begin();

      const result = await ledger.updateCleanup(identity, 1, to, later);

      assert.deepEqual(fake.stored(), {
        ...stored,
        cleanupStatus: to,
        updatedAt: later,
      });
      assert.deepEqual(result, {
        kind: 'updated',
        record: await ledger.get(identity),
      });
      assert.equal(fake.writes.length, 1);
    });
  }

  it('records cleanup for a rejection that had none', async () => {
    const { fake, ledger } = setup();
    const before = await stages.rejectedNoToken(ledger);
    await ledger.updateCleanup(identity, 1, 'pending', later);
    assert.deepEqual(fake.stored(), {
      ...before.row,
      cleanupStatus: 'pending',
      updatedAt: later,
    });
  });

  for (const resolved of settled) {
    for (const requested of [
      'failed',
      'pending',
      'removed',
      'not-found',
    ] as const) {
      it(`keeps cleanup ${resolved} when asked for ${requested}`, async () => {
        const { fake, ledger } = setup();
        await stages.rejected(ledger);
        await ledger.updateCleanup(identity, 1, resolved, start);
        const stored = fake.stored();
        fake.begin();

        const result = await ledger.updateCleanup(
          identity,
          1,
          requested,
          later,
        );

        assert.deepEqual(result, {
          kind: 'updated',
          record: await ledger.get(identity),
        });
        assert.equal(result.record?.cleanupStatus, resolved);
        assert.deepEqual(fake.stored(), stored);
        assert.deepEqual(fake.writes, []);
      });
    }
  }

  for (const same of ['pending', 'failed'] as const) {
    it(`leaves cleanup ${same} when asked for ${same}`, async () => {
      const { fake, ledger } = setup();
      await stages.rejected(ledger);
      await ledger.updateCleanup(identity, 1, same, start);
      const stored = fake.stored();
      fake.begin();

      const result = await ledger.updateCleanup(identity, 1, same, later);

      assert.equal(result.kind, 'updated');
      assert.deepEqual(fake.stored(), stored);
      assert.deepEqual(fake.writes, []);
    });
  }

  it('refuses an invalid clock', async () => {
    const { ledger } = setup();
    await assert.rejects(
      () => ledger.updateCleanup(identity, 1, 'removed', new Date(Number.NaN)),
      /Invalid reminder dispatch clock/,
    );
  });

  // A failed write may still have landed. Only the requested cleanup status
  // in the stored record shows that it did.
  for (const [title, status, landed] of [
    ['finds its own write', 'removed', true],
    ['does not take another status for its own', 'failed', false],
  ] as const) {
    it(`${title} after a failed write`, async () => {
      const { fake, ledger } = setup();
      await stages.rejected(ledger);
      const failure = azureError(503);
      fake.begin({
        replace: async () => {
          fake.mutate((row) => ({ ...row, cleanupStatus: status }));
          throw failure;
        },
      });
      const updating = () =>
        ledger.updateCleanup(identity, 1, 'removed', later);
      if (landed) {
        assert.equal((await updating()).kind, 'updated');
      } else {
        await assert.rejects(updating, sameError(failure));
      }
    });
  }

  it('reports the failure when the record vanished and the write did not commit', async () => {
    const { fake, ledger } = setup();
    await stages.rejected(ledger);
    const failure = azureError(503);
    fake.begin({
      replace: async () => {
        fake.rows.clear();
        throw failure;
      },
    });
    await assert.rejects(
      () => ledger.updateCleanup(identity, 1, 'removed', later),
      sameError(failure),
    );
  });

  it('finds its own write when the acknowledgement was lost', async () => {
    const { fake, ledger } = setup();
    await stages.rejected(ledger);
    fake.begin({ replace: loseAcknowledgement });

    const result = await ledger.updateCleanup(identity, 1, 'removed', later);

    assert.equal(result.kind, 'updated');
    assert.equal(result.record?.cleanupStatus, 'removed');
    assert.equal(fake.writes.length, 1);
  });
});

// Every operation that writes with an ETag reads again and retries when
// another worker wrote first, up to a limit, and stops at any other failure.
describe('reminder dispatch ledger write conflicts', () => {
  interface Operation {
    readonly name: string;
    readonly setup: Setup;
    readonly run: (ledger: Ledger, stage: Stage) => Promise<unknown>;
    // What the error says went wrong once the retries ran out.
    readonly contention: string;
    // The status stored once the operation succeeds.
    readonly status: string;
    // The calls it makes to the table after losing one race. claim and
    // beginSend also read the record to see whether their write landed.
    readonly raced: string;
    // What it reports when the record vanished right after its write: it
    // reads again, and never reports an update with no record to show.
    readonly vanished: (result: unknown) => void;
  }
  const plain = 'get replace get replace get';
  const reconciled = 'get replace get get replace get';
  const recreated = (result: unknown) =>
    assert.equal((result as { status: string }).status, 'pending');
  const staleWithNoRecord = (result: unknown) =>
    assert.deepEqual(result, { kind: 'stale', record: undefined });
  const staleBare = (result: unknown) =>
    assert.deepEqual(result, { kind: 'stale' });
  const operations: readonly Operation[] = [
    {
      name: 'prepare',
      setup: stages.pending,
      run: (ledger) => ledger.prepare(preparation({ now: later })),
      contention: 'preparation',
      status: 'pending',
      raced: plain,
      vanished: recreated,
    },
    {
      name: 'prepare for a newer generation',
      setup: stages.pending,
      run: (ledger) =>
        ledger.prepare(preparation({ attemptGeneration: 2, now: later })),
      contention: 'preparation',
      status: 'pending',
      raced: plain,
      vanished: recreated,
    },
    {
      name: 'prepare for a record with a send intent',
      setup: stages.sending,
      run: (ledger) =>
        ledger.prepare(preparation({ attemptGeneration: 2, now: later })),
      contention: 'preparation',
      status: 'uncertain',
      raced: plain,
      vanished: recreated,
    },
    {
      name: 'claim',
      setup: stages.pending,
      run: (ledger) => ledger.claim(identity, later),
      contention: 'claim',
      status: 'claimed',
      raced: reconciled,
      vanished: (result) => assert.equal(result, null),
    },
    {
      name: 'beginSend',
      setup: stages.claimed,
      run: (ledger, { claim }) => ledger.beginSend(claim, later),
      contention: 'send intent',
      status: 'claimed',
      raced: reconciled,
      vanished: staleWithNoRecord,
    },
    {
      name: 'release',
      setup: stages.claimed,
      run: (ledger, { claim }) => ledger.release(claim, later),
      contention: 'claim release',
      status: 'pending',
      raced: plain,
      vanished: staleWithNoRecord,
    },
    {
      name: 'cancelBeforeProvider',
      setup: stages.sending,
      run: (ledger, { claim }) => ledger.cancelBeforeProvider(claim, later),
      contention: 'pre-provider cancellation',
      status: 'pending',
      raced: plain,
      vanished: staleWithNoRecord,
    },
    {
      name: 'complete',
      setup: stages.sending,
      run: (ledger, { claim }) =>
        ledger.complete(claim, { kind: 'accepted' }, later),
      contention: 'completion',
      status: 'accepted',
      raced: plain,
      vanished: staleBare,
    },
    {
      name: 'invalidate',
      setup: stages.claimed,
      run: (ledger) => ledger.invalidate(identity, 1, later),
      contention: 'invalidation',
      status: 'expired',
      raced: plain,
      vanished: staleBare,
    },
    {
      name: 'updateCleanup',
      setup: stages.rejected,
      run: (ledger) => ledger.updateCleanup(identity, 1, 'removed', later),
      contention: 'cleanup',
      status: 'permanent-failure',
      raced: plain,
      vanished: staleWithNoRecord,
    },
  ];

  for (const operation of operations) {
    it(`${operation.name} reads again and uses the new ETag after losing a race`, async () => {
      const { fake, ledger } = setup();
      const stage = await operation.setup(ledger);
      fake.begin({
        replace: async (call, run) => {
          // Another worker's write lands first, so the ETag in hand is stale.
          if (call === 1) fake.mutate((row) => row);
          await run();
        },
      });

      await operation.run(ledger, stage);

      assert.equal(fake.writes.length, 2);
      assert.notEqual(fake.writes[0]?.etag, fake.writes[1]?.etag);
      assert.equal(fake.stored().status, operation.status);
      assert.equal(fake.log.join(' '), operation.raced);
    });

    it(`${operation.name} writes with the ETag it read, then reads the record back`, async () => {
      const { fake, ledger } = setup();
      const stage = await operation.setup(ledger);
      const etag = (await ledger.get(identity))?.etag;
      fake.begin();

      await operation.run(ledger, stage);

      assert.equal(fake.log.join(' '), 'get replace get');
      assert.equal(fake.writes[0]?.etag, etag);
      assert.equal(fake.stored().status, operation.status);
    });

    it(`${operation.name} reports a failure that is not a conflict at once`, async () => {
      const { fake, ledger } = setup();
      const stage = await operation.setup(ledger);
      const failure = azureError(503);
      fake.begin({ replace: fails(failure) });

      await assert.rejects(
        () => operation.run(ledger, stage),
        sameError(failure),
      );

      assert.equal(fake.writes.length, 1);
      assert.deepEqual(fake.stored(), stage.row);
    });

    it(`${operation.name} reads again when the record vanished after its write`, async () => {
      const { fake, ledger } = setup();
      const stage = await operation.setup(ledger);
      fake.begin({
        replace: async (_call, run) => {
          await run();
          fake.rows.clear();
        },
      });

      operation.vanished(await operation.run(ledger, stage));
    });

    for (const conflictStatus of [409, 412]) {
      it(`${operation.name} gives up after ${retryLimit} conflicts of ${conflictStatus}`, async () => {
        const { fake, ledger } = setup();
        const stage = await operation.setup(ledger);
        fake.begin({ replace: fails(azureError(conflictStatus)) });

        await assert.rejects(() => operation.run(ledger, stage), {
          message: `Reminder dispatch ${operation.contention} contention exceeded retry limit`,
        });

        assert.equal(fake.writes.length, retryLimit);
        assert.deepEqual(fake.stored(), stage.row);
      });
    }
  }
});

describe('Azure reminder dispatch ledger store', () => {
  const environment = {
    REMINDER_MANAGED_IDENTITY_CLIENT_ID: 'runtime-uami-client-id',
    REMINDER_STORAGE_ACCOUNT_NAME: 'dlsvstorage',
  };
  const credential = {
    getToken: async () => ({ expiresOnTimestamp: 0, token: 'test' }),
  };

  for (const [name, value] of [
    ['REMINDER_STORAGE_ACCOUNT_NAME', undefined],
    ['REMINDER_STORAGE_ACCOUNT_NAME', ''],
    ['REMINDER_STORAGE_ACCOUNT_NAME', '  '],
    ['REMINDER_MANAGED_IDENTITY_CLIENT_ID', undefined],
    ['REMINDER_MANAGED_IDENTITY_CLIENT_ID', ''],
    ['REMINDER_MANAGED_IDENTITY_CLIENT_ID', '  '],
  ] as const) {
    it(`requires ${name}, not ${JSON.stringify(value)}`, () => {
      assert.throws(
        () =>
          createAzureReminderDispatchLedgerStore(
            { ...environment, [name]: value },
            {
              createCredential: () => credential,
              createTableClient: () => ({}) as never,
            },
          ),
        new RegExp(`${name} is required`),
      );
    });
  }

  it('works through the table with the ETag of each record', async () => {
    const fake = createTable();
    const calls: unknown[] = [];
    const store = createAzureReminderDispatchLedgerStore(
      {
        REMINDER_MANAGED_IDENTITY_CLIENT_ID: ' client ',
        REMINDER_STORAGE_ACCOUNT_NAME: ' dlsvstorage ',
      },
      {
        createCredential: (clientId) => {
          calls.push(['credential', clientId]);
          return credential;
        },
        createTableClient: (endpoint, tableName) => {
          calls.push(['table', endpoint, tableName]);
          return {
            createEntity: (entity: Row) => fake.table.create(entity),
            getEntity: (partitionKey: string, rowKey: string) =>
              fake.table.get(partitionKey, rowKey),
            updateEntity: (
              entity: Row,
              mode: string,
              options: { readonly etag: string },
            ) => {
              calls.push(['update', mode]);
              return fake.table.replace(entity, options.etag);
            },
          } as never;
        },
      },
    );

    await store.prepare(preparation());
    const claim = await store.claim(identity, start);

    assert.ok(claim);
    assert.deepEqual(calls, [
      ['credential', 'client'],
      [
        'table',
        'https://dlsvstorage.table.core.windows.net',
        'ReminderDispatchLedger',
      ],
      ['update', 'Replace'],
    ]);
    assert.equal((await store.get(identity))?.status, 'claimed');
  });
});
