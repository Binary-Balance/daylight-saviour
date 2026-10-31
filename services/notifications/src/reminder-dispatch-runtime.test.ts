import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { InvocationContext } from '@azure/functions';
import { activateAustralianTimeZoneDataPack } from '@daylight-saviour/domain/node';

import type { ApnsHttpRequest } from './apns-change-reminder-sender.ts';
import {
  createTableReminderDispatchLedgerStore,
  type ReminderDispatchLedgerStore,
  type ReminderDispatchLedgerTable,
} from './reminder-dispatch-ledger.ts';
import {
  createActivePackReader,
  createReminderDispatchProvider,
  createReminderDispatchRunner,
  runReminderDispatch,
  type ReminderDispatchBoundaries,
} from './reminder-dispatch-runtime.ts';
import {
  createReminderDispatchTimerHandler,
  reminderDispatchTimerOptions,
} from './reminder-dispatch-timer.ts';
import type {
  ReminderDispatchProviderRequest,
  ReminderDispatchProviderResult,
} from './reminder-dispatch.ts';
import { createTableReminderSubscriptionStore } from './reminder-subscriptions.ts';

const changeEventAt = '2026-10-03T16:00:00.000Z';
const windowOpen = new Date('2026-09-26T23:00:00.000Z');
const during = new Date('2026-09-27T01:00:00.000Z');
const windowEnd = new Date('2026-09-27T11:00:00.000Z');
const afterWindow = new Date('2026-09-27T11:00:00.001Z');
const pageSize = 100;
const packFile = new URL(
  '../../../packages/time-zone-data/generated/australian-coverage.pack.json',
  import.meta.url,
);

function activePack() {
  return activateAustralianTimeZoneDataPack(
    JSON.parse(readFileSync(packFile, 'utf8')),
  );
}

// Fails a test whose awaited work never settles, instead of letting it hang:
// Seshat treats a hang as an unresolved mutant and withholds the score.
function settled<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new assert.AssertionError({ message: 'Work did not settle' })),
      5000,
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function azureError(statusCode: number) {
  return Object.assign(new Error(`Azure ${statusCode}`), { statusCode });
}

const pause = () => new Promise((resolve) => setImmediate(resolve));

function subscriptionRow(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attemptGeneration: 1,
    deviceToken: `sensitive-device-token-${name}`,
    etag: '1',
    homeTimeZone: 'Australia/Sydney',
    oneDayEnabled: true,
    oneWeekEnabled: true,
    partitionKey: 'subscriptions-v1',
    platform: 'android',
    rowKey: name.padEnd(43, 'a'),
    ...overrides,
  };
}

function memoryLedgerTable() {
  const rows = new Map<string, Record<string, unknown>>();
  const operations = { reads: 0, unsettledPages: 0, writes: 0 };
  let etag = 0;
  const key = (partitionKey: unknown, rowKey: unknown) =>
    `${String(partitionKey)}/${String(rowKey)}`;
  const table: ReminderDispatchLedgerTable = {
    async create(entity) {
      await pause();
      operations.writes += 1;
      const id = key(entity.partitionKey, entity.rowKey);
      if (rows.has(id)) throw azureError(409);
      rows.set(id, { ...entity, etag: String(++etag) });
    },
    delete: async () => undefined,
    async get(partitionKey, rowKey) {
      await pause();
      operations.reads += 1;
      const row = rows.get(key(partitionKey, rowKey));
      if (row === undefined) throw azureError(404);
      return { ...row };
    },
    async *listUnsettledPages() {
      operations.unsettledPages += 1;
      yield [...rows.values()].map((row) => ({ ...row }));
    },
    async *listUpdatedBefore() {
      // Dispatch never purges.
    },
    async replace(entity, expectedEtag) {
      await pause();
      operations.writes += 1;
      const id = key(entity.partitionKey, entity.rowKey);
      const row = rows.get(id);
      if (row === undefined) throw azureError(404);
      if (row.etag !== expectedEtag) throw azureError(412);
      rows.set(id, { ...entity, etag: String(++etag) });
    },
  };
  return { operations, rows, table };
}

function harness(
  rows: readonly Record<string, unknown>[],
  options: {
    readonly now?: Date;
    readonly outcome?: (
      request: ReminderDispatchProviderRequest,
    ) => Promise<ReminderDispatchProviderResult>;
    readonly prepare?: (
      request: ReminderDispatchProviderRequest,
    ) => Promise<void>;
  } = {},
) {
  const ledgerTable = memoryLedgerTable();
  const subscriptions = new Map(rows.map((row) => [String(row.rowKey), row]));
  const operations = {
    maxInFlight: 0,
    pages: 0,
    queriedZones: [] as string[],
    subscriptionReads: 0,
  };
  const state = {
    failRemoval: false,
    inFlight: 0,
    now: options.now ?? during,
  };
  const logs: string[] = [];
  const sent: ReminderDispatchProviderRequest[] = [];
  const pack = activePack();
  const store = createTableReminderSubscriptionStore(
    {
      create: async () => undefined,
      delete: async () => undefined,
      async get(_partitionKey, rowKey) {
        await pause();
        operations.subscriptionReads += 1;
        const row = subscriptions.get(rowKey);
        if (row === undefined) throw azureError(404);
        return row as never;
      },
      listRetiredExpired: async function* () {
        // Dispatch never purges.
      },
      async *listZonePages(homeTimeZone) {
        operations.queriedZones.push(homeTimeZone);
        const zone = [...subscriptions.values()].filter(
          (row) => row.homeTimeZone === homeTimeZone,
        );
        for (let start = 0; start < zone.length; start += pageSize) {
          operations.pages += 1;
          yield zone.slice(start, start + pageSize) as never;
        }
      },
      async replace(entity, expectedEtag) {
        if (state.failRemoval) throw azureError(503);
        const row = subscriptions.get(String(entity.rowKey));
        if (row?.etag !== expectedEtag) throw azureError(412);
        subscriptions.set(String(entity.rowKey), { ...row, ...entity });
        if (entity.state === 'retired') {
          subscriptions.delete(String(entity.rowKey));
        }
      },
    },
    {
      create: async () => undefined,
      delete: async () => undefined,
      get: async () => {
        throw azureError(404);
      },
      listExpired: async function* () {
        // Dispatch never purges.
      },
      replace: async () => undefined,
    },
    () => state.now,
  );
  const ledger = createTableReminderDispatchLedgerStore(ledgerTable.table);
  const dependencies = {
    clock: () => state.now,
    ledger,
    log: (event: string) => logs.push(event),
    provider: {
      async send(
        request: ReminderDispatchProviderRequest,
        authorize: () => Promise<boolean>,
      ) {
        state.inFlight += 1;
        operations.maxInFlight = Math.max(
          operations.maxInFlight,
          state.inFlight,
        );
        try {
          await pause();
          await options.prepare?.(request);
          if (!(await authorize())) return { kind: 'not-authorized' } as const;
          sent.push(request);
          return (await options.outcome?.(request)) ?? { kind: 'accepted' };
        } finally {
          state.inFlight -= 1;
        }
      },
    },
    readActivePack: async () => pack,
    subscriptions: store,
  };
  return {
    dependencies,
    ledger,
    ledgerOperations: ledgerTable.operations,
    ledgerRows: ledgerTable.rows,
    logs,
    operations,
    run: () => settled(runReminderDispatch(dependencies)),
    sent,
    state,
    subscriptions,
  };
}

function statuses(test: ReturnType<typeof harness>) {
  return [...test.ledgerRows.values()].map((row) => row.status);
}

const identity = (name: string) => ({
  changeEventAt,
  homeTimeZone: 'Australia/Sydney',
  installationId: name.padEnd(43, 'a'),
  timing: 'one-week' as const,
});

const preparation = (name: string, now: Date) => ({
  ...identity(name),
  attemptGeneration: 1,
  deliveryWindowEndsAt: windowEnd,
  deliveryWindowStartsAt: windowOpen,
  now,
  packValidUntil: new Date('2030-12-31T23:59:59.000Z'),
});

const manifestUrl = 'https://data.example.invalid/data/manifest.json';

function signedArtifacts(signWith?: Buffer) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const bytes = readFileSync(packFile);
  const parsed = JSON.parse(bytes.toString()) as {
    readonly packVersion: string;
    readonly schemaVersion: number;
  };
  const manifest = {
    manifestVersion: 1,
    pack: {
      byteLength: bytes.byteLength,
      packVersion: parsed.packVersion,
      path: `packs/${parsed.packVersion}.pack.json`,
      schemaVersion: parsed.schemaVersion,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    signature: {
      algorithm: 'Ed25519',
      keyId: 'test-key',
      value: sign(null, signWith ?? bytes, privateKey).toString('base64'),
    },
  };
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    bytes,
    manifest: JSON.stringify(manifest),
    packUrl: new URL(manifest.pack.path, manifestUrl).toString(),
    trustedKeys: { 'test-key': raw.toString('base64') },
  };
}

function fetchFrom(routes: Readonly<Record<string, Response>>) {
  const requested: string[] = [];
  const fetch = (async (input: string) => {
    requested.push(input);
    return routes[input] ?? new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, requested };
}

describe('reminder dispatch gate', () => {
  function context(logs: string[]) {
    return { log: (event: string) => logs.push(event) } as never;
  }

  for (const [name, environment] of [
    ['a missing', {}],
    ['an empty', { REMINDER_DISPATCH_ENABLED: '' }],
    ['a false', { REMINDER_DISPATCH_ENABLED: 'false' }],
    ['a capitalised', { REMINDER_DISPATCH_ENABLED: 'TRUE' }],
    ['a padded', { REMINDER_DISPATCH_ENABLED: ' true ' }],
    ['a numeric', { REMINDER_DISPATCH_ENABLED: '1' }],
  ] as const) {
    it(`suspends dispatch with ${name} value`, async () => {
      const logs: string[] = [];
      let loads = 0;
      await createReminderDispatchTimerHandler(environment, async () => {
        loads += 1;
        return async () => undefined;
      })({}, context(logs));

      assert.equal(loads, 0);
      assert.deepEqual(logs, ['reminder-dispatch-suspended']);
    });
  }

  it('runs when the value is exactly true, and reuses the runner', async () => {
    const logs: string[] = [];
    let loads = 0;
    let runs = 0;
    const handler = createReminderDispatchTimerHandler(
      { REMINDER_DISPATCH_ENABLED: 'true' },
      async () => {
        loads += 1;
        return async () => {
          runs += 1;
        };
      },
    );

    await handler({}, context(logs));
    await handler({}, context(logs));

    assert.equal(loads, 1);
    assert.equal(runs, 2);
    assert.deepEqual(logs, []);
  });

  it('logs a fixed event for a failure and retries the next run', async () => {
    const logs: string[] = [];
    let loads = 0;
    const handler = createReminderDispatchTimerHandler(
      { REMINDER_DISPATCH_ENABLED: 'true' },
      async () => {
        loads += 1;
        throw new Error('sensitive configuration detail');
      },
    );

    await handler({}, context(logs));
    await handler({}, context(logs));

    assert.equal(loads, 2);
    assert.deepEqual(logs, [
      'reminder-dispatch-unavailable',
      'reminder-dispatch-unavailable',
    ]);
  });

  it('runs every five minutes', () => {
    assert.equal(reminderDispatchTimerOptions.schedule, '0 */5 * * * *');
  });
});

describe('partitioned reminder dispatch', () => {
  it('queries only the zones whose Delivery Window is open', async () => {
    // 08:45 in Sydney, 09:15 on Lord Howe and 09:45 on Norfolk Island.
    const test = harness(
      [
        subscriptionRow('sydney'),
        subscriptionRow('lordhowe', { homeTimeZone: 'Australia/Lord_Howe' }),
      ],
      { now: new Date('2026-09-26T22:45:00.000Z') },
    );

    await test.run();

    assert.deepEqual(test.operations.queriedZones, [
      'Australia/Lord_Howe',
      'Pacific/Norfolk',
    ]);
    assert.deepEqual(
      test.sent.map((request) => request.homeTimeZone),
      ['Australia/Lord_Howe'],
    );
  });

  it('reports a run with no due Change Reminder and queries no zone', async () => {
    const test = harness([subscriptionRow('sydney')], {
      now: new Date('2026-08-01T01:00:00.000Z'),
    });

    await test.run();

    assert.deepEqual(test.operations.queriedZones, []);
    assert.deepEqual(test.logs, ['reminder-dispatch-no-event count=1']);
  });

  it('plans only the timings a subscription has enabled', async () => {
    const test = harness([
      subscriptionRow('oneweek'),
      subscriptionRow('oneday', { oneWeekEnabled: false }),
    ]);

    await test.run();

    assert.deepEqual(
      test.sent.map((request) => request.subscription.installationId),
      [identity('oneweek').installationId],
    );
  });

  it('bounds concurrent sends, and repeats no send in the next run', async () => {
    const rows = Array.from({ length: 250 }, (_value, index) =>
      subscriptionRow(`install${index}`, {
        platform: index % 2 === 0 ? 'android' : 'ios',
      }),
    );
    const test = harness(rows);

    await test.run();

    assert.equal(test.sent.length, 250);
    assert.equal(test.operations.maxInFlight, 8);
    assert.equal(test.operations.queriedZones.length, 8);
    assert.equal(test.operations.pages, 3);
    assert.deepEqual(test.ledgerOperations, {
      reads: 2_250,
      unsettledPages: 1,
      writes: 1_000,
    });
    assert.equal(test.operations.subscriptionReads, 750);
    assert.deepEqual(test.logs, ['reminder-dispatch-accepted count=250']);

    test.logs.length = 0;
    test.state.now = new Date(during.getTime() + 5 * 60 * 1000);
    await test.run();

    assert.equal(test.sent.length, 250);
    assert.equal(test.operations.pages, 6);
    assert.deepEqual(test.ledgerOperations, {
      reads: 2_500,
      unsettledPages: 2,
      writes: 1_000,
    });
    assert.equal(test.operations.subscriptionReads, 750);
    assert.deepEqual(test.logs, [
      'reminder-dispatch-already-recorded count=250',
    ]);
  });

  it('stops at the page limit and says so', async () => {
    const test = harness([]);
    test.dependencies.subscriptions = {
      ...test.dependencies.subscriptions,
      async *listZoneSubscriptionPages(zone) {
        if (zone !== 'Australia/Sydney') return;
        for (let page = 0; page < 60; page += 1) {
          test.operations.pages += 1;
          yield [];
        }
      },
    };

    await test.run();

    assert.equal(test.operations.pages, 50);
    assert.deepEqual(test.logs, [
      'reminder-dispatch-page-limit-reached count=1',
    ]);
  });

  it('sends once when invocations overlap', async () => {
    const rows = Array.from({ length: 20 }, (_value, index) =>
      subscriptionRow(`install${index}`),
    );
    const test = harness(rows);

    await settled(Promise.all([test.run(), test.run()]));

    assert.equal(test.sent.length, 20);
    assert.equal(
      new Set(test.sent.map((request) => request.subscription.installationId))
        .size,
      20,
    );
    assert.deepEqual([...new Set(statuses(test))], ['accepted']);
  });

  it('keeps the provider expiry and deadline within the Delivery Window', async () => {
    const test = harness([subscriptionRow('sydney')]);

    await test.run();

    assert.deepEqual(test.sent[0]?.providerExpiresAt, windowEnd);
    assert.deepEqual(test.sent[0]?.completeOperationDeadline, windowEnd);
    assert.deepEqual(test.sent[0]?.changeEventAt, new Date(changeEventAt));
    assert.equal(test.sent[0]?.changeDirection, 'forward');
  });

  describe('final authorization', () => {
    const row = () => subscriptionRow('changed');
    const key = String(row().rowKey);

    it('refuses a stale generation, then sends the current one', async () => {
      const test = harness([row()], {
        prepare: async () => {
          if (test.logs.length > 0 || test.sent.length > 0) return;
          test.subscriptions.set(key, { ...row(), attemptGeneration: 2 });
        },
      });

      await test.run();
      assert.equal(test.sent.length, 0);
      assert.deepEqual(test.logs, ['reminder-dispatch-stale count=1']);

      await test.run();
      assert.equal(test.sent[0]?.subscription.attemptGeneration, 2);
    });

    it('refuses a disabled timing', async () => {
      const test = harness([row()], {
        prepare: async () => {
          test.subscriptions.set(key, { ...row(), oneWeekEnabled: false });
        },
      });

      await test.run();

      assert.deepEqual(test.sent, []);
      assert.deepEqual(test.logs, ['reminder-dispatch-stale count=1']);
    });

    it('refuses a deleted subscription', async () => {
      const test = harness([row()], {
        prepare: async () => {
          test.subscriptions.delete(key);
        },
      });

      await test.run();

      assert.deepEqual(test.sent, []);
      assert.deepEqual(test.logs, ['reminder-dispatch-stale count=1']);
    });

    it('refuses a catch-up send after slow acquisition, and expires it', async () => {
      const test = harness([row()], {
        prepare: async () => {
          test.state.now = afterWindow;
        },
      });

      await test.run();

      assert.deepEqual(test.sent, []);
      assert.deepEqual(statuses(test), ['expired']);
      assert.deepEqual(test.logs, [
        'reminder-dispatch-stale count=1',
        'reminder-dispatch-expired count=1',
      ]);
    });
  });

  describe('recovery after an interrupted operation', () => {
    it('retries when a crash left a claim with no send intent', async () => {
      const crashedAt = new Date(during.getTime() - 5 * 60 * 1000);
      const test = harness([subscriptionRow('crashed')]);
      await test.ledger.prepare(preparation('crashed', crashedAt));
      await test.ledger.claim(identity('crashed'), crashedAt);

      await test.run();

      assert.equal(test.sent.length, 1);
      assert.deepEqual(statuses(test), ['accepted']);
    });

    it('never replays when a crash left a send intent', async () => {
      const crashedAt = new Date(during.getTime() - 5 * 60 * 1000);
      const test = harness([subscriptionRow('crashed')]);
      await test.ledger.prepare(preparation('crashed', crashedAt));
      const claim = await test.ledger.claim(identity('crashed'), crashedAt);
      assert.ok(claim);
      await test.ledger.beginSend(claim, crashedAt);

      await test.run();

      assert.deepEqual(test.sent, []);
      assert.deepEqual(statuses(test), ['uncertain']);
      assert.deepEqual(test.logs, ['reminder-dispatch-uncertain count=1']);
    });

    it('settles a send intent abandoned after its window closed', async () => {
      const crashedAt = new Date(windowEnd.getTime() - 1);
      const test = harness([subscriptionRow('crashed')], {
        now: new Date(windowEnd.getTime() + 2 * 60 * 1000),
      });
      await test.ledger.prepare(preparation('crashed', crashedAt));
      const claim = await test.ledger.claim(identity('crashed'), crashedAt);
      assert.ok(claim);
      await test.ledger.beginSend(claim, crashedAt);

      await test.run();

      assert.deepEqual(test.sent, []);
      assert.deepEqual(statuses(test), ['uncertain']);
      assert.deepEqual(test.logs, ['reminder-dispatch-uncertain count=1']);
    });
  });

  describe('outcomes', () => {
    for (const [name, outcome, status, event] of [
      ['acceptance', { kind: 'accepted' }, 'accepted', 'accepted'],
      ['a lost response', { kind: 'uncertain' }, 'uncertain', 'uncertain'],
      [
        'a permanent rejection',
        { invalidToken: false, kind: 'permanent-failure' },
        'permanent-failure',
        'permanent-failure',
      ],
      [
        'a transient rejection',
        { kind: 'transient-failure' },
        'transient-failure',
        'transient-failure',
      ],
    ] as const) {
      it(`records ${name} with its own event`, async () => {
        const test = harness([subscriptionRow('sydney')], {
          outcome: async () => outcome,
        });

        await test.run();

        assert.deepEqual(statuses(test), [status]);
        assert.deepEqual(test.logs, [`reminder-dispatch-${event} count=1`]);
      });
    }

    it('treats a provider error as uncertain and does not replay it', async () => {
      const test = harness([subscriptionRow('sydney')], {
        outcome: async () => {
          throw new Error('sensitive-provider-detail');
        },
      });

      await test.run();
      await test.run();

      assert.equal(test.sent.length, 1);
      assert.deepEqual(test.logs, [
        'reminder-dispatch-uncertain count=1',
        'reminder-dispatch-already-recorded count=1',
      ]);
    });

    it('retries a transient rejection in the next run', async () => {
      let attempts = 0;
      const test = harness([subscriptionRow('sydney')], {
        outcome: async () => ({
          kind: (attempts += 1) === 1 ? 'transient-failure' : 'accepted',
        }),
      });

      await test.run();
      await test.run();

      assert.equal(test.sent.length, 2);
      assert.deepEqual(statuses(test), ['accepted']);
    });

    it('removes a rejected token and sends to it no more', async () => {
      const test = harness([subscriptionRow('sydney')], {
        outcome: async () => ({
          invalidToken: true,
          kind: 'permanent-failure',
        }),
      });

      await test.run();
      await test.run();

      assert.equal(test.sent.length, 1);
      assert.equal(test.subscriptions.size, 0);
    });

    it('retries failed token cleanup without another send', async () => {
      const test = harness([subscriptionRow('sydney')], {
        outcome: async () => ({
          invalidToken: true,
          kind: 'permanent-failure',
        }),
      });
      test.state.failRemoval = true;

      await test.run();
      assert.deepEqual(test.logs, [
        'reminder-dispatch-permanent-failure count=1',
        'reminder-dispatch-invalid-token-cleanup-failed count=2',
        'reminder-dispatch-already-recorded count=1',
      ]);

      test.logs.length = 0;
      test.state.failRemoval = false;
      test.state.now = afterWindow;
      await test.run();

      assert.equal(test.sent.length, 1);
      assert.equal(test.subscriptions.size, 0);
      assert.deepEqual(test.logs, [
        'reminder-dispatch-already-recorded count=1',
      ]);
    });

    it('expires a retry left at the end of its window, once', async () => {
      const test = harness([subscriptionRow('sydney')], {
        outcome: async () => ({ kind: 'transient-failure' }),
      });
      await test.run();

      test.logs.length = 0;
      test.state.now = afterWindow;
      await test.run();
      assert.equal(test.sent.length, 1);
      assert.deepEqual(statuses(test), ['expired']);
      assert.deepEqual(test.logs, ['reminder-dispatch-expired count=1']);

      test.logs.length = 0;
      await test.run();
      assert.deepEqual(test.logs, []);
    });

    it('logs only fixed events and safe counts', async () => {
      const test = harness(
        [subscriptionRow('first'), subscriptionRow('second')],
        {
          outcome: async (request) => {
            if (request.subscription.deviceToken.endsWith('first')) {
              throw new Error(request.subscription.deviceToken);
            }
            return { invalidToken: true, kind: 'permanent-failure' };
          },
        },
      );
      test.state.failRemoval = true;

      await test.run();

      assert.ok(test.logs.length > 0);
      for (const line of test.logs) {
        assert.match(line, /^reminder-dispatch-[a-z-]+ count=\d+$/);
      }
    });
  });

  describe('a run that cannot plan', () => {
    it('sends nothing without an active pack, and still settles', async () => {
      const test = harness([subscriptionRow('sydney')], { now: afterWindow });
      await test.ledger.prepare(preparation('sydney', windowOpen));
      test.dependencies.readActivePack = async () => {
        throw new Error('sensitive storage detail');
      };

      await test.run();

      assert.deepEqual(test.operations.queriedZones, []);
      assert.deepEqual(test.logs, [
        'reminder-dispatch-pack-unavailable count=1',
        'reminder-dispatch-expired count=1',
      ]);
    });

    it('reports an invalid pack horizon separately', async () => {
      const test = harness([subscriptionRow('sydney')], {
        now: new Date('2031-01-01T00:00:00.000Z'),
      });

      await test.run();

      assert.deepEqual(test.sent, []);
      assert.deepEqual(test.operations.queriedZones, []);
      assert.deepEqual(test.logs, [
        'reminder-dispatch-pack-horizon-invalid count=1',
      ]);
    });
  });

  describe('storage failures', () => {
    it('keeps going when one dispatch fails', async () => {
      const test = harness([
        subscriptionRow('first'),
        subscriptionRow('second'),
      ]);
      const prepare = test.ledger.prepare;
      test.dependencies.ledger = {
        ...test.ledger,
        prepare: async (input) => {
          if (input.installationId.startsWith('first')) {
            throw new Error('sensitive storage detail');
          }
          return prepare(input);
        },
      } satisfies ReminderDispatchLedgerStore;

      await test.run();

      assert.equal(test.sent.length, 1);
      assert.deepEqual([...test.logs].sort(), [
        'reminder-dispatch-accepted count=1',
        'reminder-dispatch-operation-failed count=1',
      ]);
    });

    it('reports a failed query and still tries the other zones', async () => {
      const test = harness([
        subscriptionRow('sydney'),
        subscriptionRow('melbourne', { homeTimeZone: 'Australia/Melbourne' }),
      ]);
      const list = test.dependencies.subscriptions.listZoneSubscriptionPages;
      test.dependencies.subscriptions = {
        ...test.dependencies.subscriptions,
        async *listZoneSubscriptionPages(zone) {
          if (zone === 'Australia/Sydney') throw azureError(503);
          yield* list(zone);
        },
      };

      await test.run();

      assert.deepEqual(
        test.sent.map((request) => request.homeTimeZone),
        ['Australia/Melbourne'],
      );
      assert.deepEqual([...test.logs].sort(), [
        'reminder-dispatch-accepted count=1',
        'reminder-dispatch-operation-failed count=1',
      ]);
    });

    it('reports a failed settlement query', async () => {
      const test = harness([], { now: new Date('2026-08-01T01:00:00.000Z') });
      test.dependencies.ledger = {
        ...test.ledger,
        async *listUnsettledPages() {
          throw azureError(503);
        },
      };

      await test.run();

      assert.deepEqual(test.logs, [
        'reminder-dispatch-no-event count=1',
        'reminder-dispatch-operation-failed count=1',
      ]);
    });
  });
});

describe('reminder dispatch provider', () => {
  const request: ReminderDispatchProviderRequest = {
    changeDirection: 'forward',
    changeEventAt: new Date(changeEventAt),
    completeOperationDeadline: new Date(windowEnd),
    homeTimeZone: 'Australia/Sydney',
    providerExpiresAt: new Date(windowEnd),
    subscription: {
      attemptGeneration: 1,
      deviceToken: 'device-token',
      homeTimeZone: 'Australia/Sydney',
      installationId: 'a'.repeat(43),
      oneDayEnabled: true,
      oneWeekEnabled: true,
      platform: 'android',
    },
    timing: 'one-week',
  };
  const authorize = async () => true;
  const invalidatedAt = new Date(0);

  for (const [result, expected] of [
    [{ kind: 'accepted' }, { kind: 'accepted' }],
    [{ kind: 'not-authorized' }, { kind: 'not-authorized' }],
    [{ kind: 'uncertain' }, { kind: 'uncertain' }],
    [{ kind: 'malformed-response' }, { kind: 'uncertain' }],
    [{ kind: 'expired' }, { kind: 'transient-failure' }],
    [{ kind: 'transient-rejection' }, { kind: 'transient-failure' }],
    [
      { kind: 'permanent-rejection' },
      { invalidToken: false, kind: 'permanent-failure' },
    ],
    [
      { cleanupStatus: 'not-found', kind: 'permanent-invalid-token' },
      { invalidToken: true, kind: 'permanent-failure' },
    ],
    [
      {
        cleanupStatus: 'not-found',
        invalidatedAt,
        kind: 'permanent-invalid-token',
      },
      { invalidatedAt, invalidToken: true, kind: 'permanent-failure' },
    ],
  ] as const) {
    it(`maps ${result.kind} ${'invalidatedAt' in result ? 'with its invalidation time' : ''}`, async () => {
      const provider = createReminderDispatchProvider({
        android: { send: async () => result as never },
        ios: {
          send: async () => assert.fail('Sent through the wrong provider'),
        },
      });

      assert.deepEqual(await provider.send(request, authorize), expected);
    });
  }

  it('chooses the sender by platform and passes every bound', async () => {
    let received: unknown[] = [];
    const provider = createReminderDispatchProvider({
      android: {
        send: async () => assert.fail('Sent through the wrong provider'),
      },
      ios: {
        send: async (...args) => {
          received = args;
          return { kind: 'accepted' };
        },
      },
    });

    await provider.send(
      {
        ...request,
        subscription: { ...request.subscription, platform: 'ios' },
      },
      authorize,
    );

    assert.deepEqual(received, [
      { deviceToken: 'device-token', installationId: 'a'.repeat(43) },
      {
        changeDirection: 'forward',
        changeEventAt: new Date(changeEventAt),
        homeTimeZone: 'Australia/Sydney',
        timing: 'one-week',
      },
      { expiresAt: windowEnd, kind: 'until' },
      {
        authorizeBeforeExternalSend: authorize,
        completeOperationDeadline: windowEnd,
      },
    ]);
  });
});

describe('active Time-Zone Data Pack reader', () => {
  it('reads and verifies the signed pack on each run', async () => {
    const artifacts = signedArtifacts();
    const { fetch, requested } = fetchFrom({
      [manifestUrl]: new Response(artifacts.manifest),
      [artifacts.packUrl]: new Response(artifacts.bytes),
    });

    const pack = await createActivePackReader(
      manifestUrl,
      artifacts.trustedKeys,
      fetch,
    )();

    assert.equal(pack.zones.length, 18);
    assert.deepEqual(requested, [manifestUrl, artifacts.packUrl]);
  });

  it('rejects a pack with a bad signature', async () => {
    const artifacts = signedArtifacts(Buffer.from('other bytes'));
    const { fetch } = fetchFrom({
      [manifestUrl]: new Response(artifacts.manifest),
      [artifacts.packUrl]: new Response(artifacts.bytes),
    });

    await assert.rejects(
      createActivePackReader(manifestUrl, artifacts.trustedKeys, fetch)(),
      /signature mismatch/,
    );
  });

  it('rejects a missing manifest', async () => {
    const { fetch } = fetchFrom({});

    await assert.rejects(
      createActivePackReader(manifestUrl, {}, fetch)(),
      /Pack request failed/,
    );
  });

  it('rejects an oversized manifest', async () => {
    const { fetch } = fetchFrom({
      [manifestUrl]: new Response(new Uint8Array(64 * 1024 + 1)),
    });

    await assert.rejects(
      createActivePackReader(manifestUrl, {}, fetch)(),
      /too large/,
    );
  });

  it('accepts a manifest at the size limit before validating it', async () => {
    const { fetch } = fetchFrom({
      [manifestUrl]: new Response(new Uint8Array(64 * 1024)),
    });

    await assert.rejects(
      createActivePackReader(manifestUrl, {}, fetch)(),
      /expected UTF-8 JSON/,
    );
  });
});

describe('reminder dispatch composition', () => {
  const privateKey = () =>
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
  const environment = () => ({
    APNS_ENVIRONMENT: 'sandbox',
    APNS_KEY_ID: 'ABCDE12345',
    APNS_PRIVATE_KEY: privateKey(),
    APNS_TEAM_ID: 'ZYXWV98765',
    APNS_TOPIC: 'com.example.app',
    FCM_ENTRA_ASSERTION_AUDIENCE: 'api://portable-fcm-audience',
    FCM_PROJECT_ID: 'portable-project',
    FCM_SERVICE_ACCOUNT_EMAIL:
      'portable-fcm-sender@portable-project.iam.gserviceaccount.com',
    FCM_WORKLOAD_IDENTITY_PROVIDER:
      '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/portable-pool/providers/azure-runtime',
    REMINDER_MANAGED_IDENTITY_CLIENT_ID: '00000000-0000-4000-8000-000000000000',
    TIME_ZONE_DATA_MANIFEST_URL: 'https://data.example.invalid/manifest.json',
    TIME_ZONE_DATA_TRUSTED_KEYS_JSON: '{}',
  });
  const boundaries = (test: ReturnType<typeof harness>) =>
    ({
      createApnsTransport: () => ({
        post: async () => assert.fail('Unexpected APNs send'),
      }),
      createCredential: () => ({
        getToken: async () => assert.fail('Unexpected credential request'),
      }),
      createLedger: () => test.ledger,
      createStore: () => test.dependencies.subscriptions,
      fetch: (async () => {
        throw new Error('sensitive network detail');
      }) as typeof globalThis.fetch,
    }) satisfies ReminderDispatchBoundaries;

  it('sends through the real APNs sender with every bound', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: during.getTime() });
    const artifacts = signedArtifacts();
    const test = harness([
      subscriptionRow('apple', {
        deviceToken: 'a'.repeat(64),
        platform: 'ios',
      }),
    ]);
    const requests: ApnsHttpRequest[] = [];
    const logs: unknown[] = [];

    await settled(
      createReminderDispatchRunner(
        {
          ...environment(),
          TIME_ZONE_DATA_MANIFEST_URL: manifestUrl,
          TIME_ZONE_DATA_TRUSTED_KEYS_JSON: JSON.stringify(
            artifacts.trustedKeys,
          ),
        },
        {
          ...boundaries(test),
          createApnsTransport: () => ({
            post: async (request) => {
              requests.push(request);
              return { body: '', status: 200 };
            },
          }),
          fetch: fetchFrom({
            [manifestUrl]: new Response(artifacts.manifest),
            [artifacts.packUrl]: new Response(artifacts.bytes),
          }).fetch,
        },
      )(
        new InvocationContext({
          logHandler: (_level, ...args) => logs.push(...args),
        }),
      ),
    );

    assert.equal(requests.length, 1);
    assert.equal(
      requests[0]?.headers['apns-expiration'],
      String(windowEnd.getTime() / 1000),
    );
    assert.equal(
      requests[0]?.timeoutMs,
      windowEnd.getTime() - during.getTime(),
    );
    assert.deepEqual(statuses(test), ['accepted']);
    assert.deepEqual(logs, [
      'apns-change-reminder-accepted',
      'reminder-dispatch-accepted count=1',
    ]);
  });

  it('logs to the invocation it serves', async () => {
    const test = harness([]);
    const logs: unknown[] = [];

    await settled(
      createReminderDispatchRunner(
        environment(),
        boundaries(test),
      )(
        new InvocationContext({
          logHandler: (_level, ...args) => logs.push(...args),
        }),
      ),
    );

    assert.deepEqual(logs, ['reminder-dispatch-pack-unavailable count=1']);
  });

  for (const [name, change] of [
    ['a missing manifest URL', { TIME_ZONE_DATA_MANIFEST_URL: '' }],
    ['missing pack keys', { TIME_ZONE_DATA_TRUSTED_KEYS_JSON: '' }],
    ['invalid pack keys', { TIME_ZONE_DATA_TRUSTED_KEYS_JSON: '[]' }],
    ['missing APNs settings', { APNS_TOPIC: '' }],
    ['missing FCM settings', { FCM_PROJECT_ID: '' }],
  ] as const) {
    it(`refuses to compose with ${name}`, () => {
      assert.throws(() =>
        createReminderDispatchRunner(
          { ...environment(), ...change },
          boundaries(harness([])),
        ),
      );
    });
  }
});
