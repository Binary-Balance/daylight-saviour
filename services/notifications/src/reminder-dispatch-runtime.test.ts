import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { InvocationContext } from '@azure/functions';
import { activateAustralianTimeZoneDataPack } from '@daylight-saviour/domain/node';

import type { ApnsHttpRequest } from './apns-change-reminder-sender.ts';
import { fcmSendEndpoint } from './fcm-change-reminder-sender.ts';
import {
  createTableReminderDispatchLedgerStore,
  type ReminderDispatchLedgerStore,
  type ReminderDispatchLedgerTable,
} from './reminder-dispatch-ledger.ts';
import {
  createActivePackReader,
  createReminderDispatchProvider,
  createReminderDispatchRunner,
  processPages,
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
// Sydney's one-day window is 09:00 to 21:00 local the day before the event.
const oneDayDuring = new Date('2026-10-03T01:00:00.000Z');
const oneDayEnd = new Date('2026-10-03T11:00:00.000Z');
const pageSize = 100;
const sydney = 'zone=Australia/Sydney';
// How long a run may start work after it begins, for the zone sweeps and then
// for settlement. Pinned here so a change shows in these tests and the README.
const budgetMs = 8 * 60 * 1000;
// Zones with a one-week window open at `during`, in the order the pack lists them.
const dueZones = [
  'Australia/Sydney',
  'Australia/Broken_Hill',
  'Australia/Melbourne',
  'Australia/Hobart',
  'Australia/Adelaide',
  'Australia/Lord_Howe',
  'Antarctica/Macquarie',
  'Pacific/Norfolk',
];
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
function settled<T>(work: Promise<T>, limitMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new assert.AssertionError({ message: 'Work did not settle' })),
      limitMs,
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
      // As the table filter does, this leaves out sweep markers: no status.
      yield [...rows.values()]
        .filter((row) => row.status !== undefined)
        .map((row) => ({ ...row }));
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
    // Empty pages the store returns before each page of rows, as Azure does
    // when a scan finds nothing yet and hands back a continuation token.
    readonly emptyPagesBefore?: number;
    readonly now?: Date;
    // Runs as the store hands out a page, so time can pass between pages.
    readonly onPage?: () => void;
    readonly outcome?: (
      request: ReminderDispatchProviderRequest,
    ) => Promise<ReminderDispatchProviderResult>;
    readonly prepare?: (
      request: ReminderDispatchProviderRequest,
    ) => Promise<void>;
    readonly rowsPerPage?: number;
    // How long each send takes on the injected clock.
    readonly sendMs?: number;
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
        const rowsPerPage = options.rowsPerPage ?? pageSize;
        for (let start = 0; start < zone.length; start += rowsPerPage) {
          for (
            let empty = 0;
            empty < (options.emptyPagesBefore ?? 0);
            empty++
          ) {
            operations.pages += 1;
            options.onPage?.();
            yield [] as never;
          }
          operations.pages += 1;
          options.onPage?.();
          yield zone.slice(start, start + rowsPerPage) as never;
        }
      },
      merge: async () => {
        // Dispatch never checks in.
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
          state.now = new Date(state.now.getTime() + (options.sendMs ?? 0));
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
    run: (limitMs?: number) =>
      settled(runReminderDispatch(dependencies), limitMs),
    sent,
    state,
    subscriptions,
  };
}

function statuses(test: ReturnType<typeof harness>) {
  return [...test.ledgerRows.values()].flatMap((row) => row.status ?? []);
}

function sweepStates(test: ReturnType<typeof harness>) {
  return [...test.ledgerRows.values()].flatMap((row) => row.sweep ?? []);
}

function advance(test: ReturnType<typeof harness>, ms: number) {
  test.state.now = new Date(test.state.now.getTime() + ms);
}

// Rows ask for the one-week reminder only, the one window open at `during`.
// Planning dominates the cost of a row, and it costs less with one timing.
function zoneRows(zone: string, count: number) {
  const name = zone.slice(zone.indexOf('/') + 1).toLowerCase();
  return Array.from({ length: count }, (_value, index) =>
    subscriptionRow(`${name}${index}`, {
      homeTimeZone: zone,
      oneDayEnabled: false,
    }),
  );
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

  for (const [name, environment, event] of [
    ['a false', { REMINDER_DISPATCH_ENABLED: 'false' }, 'suspended'],
    ['a missing', {}, 'gate-invalid'],
    ['an empty', { REMINDER_DISPATCH_ENABLED: '' }, 'gate-invalid'],
    ['a capitalised', { REMINDER_DISPATCH_ENABLED: 'TRUE' }, 'gate-invalid'],
    ['a padded', { REMINDER_DISPATCH_ENABLED: ' true ' }, 'gate-invalid'],
    ['a numeric', { REMINDER_DISPATCH_ENABLED: '1' }, 'gate-invalid'],
  ] as const) {
    it(`stops dispatch with ${name} value`, async () => {
      const logs: string[] = [];
      let loads = 0;
      await createReminderDispatchTimerHandler(environment, async () => {
        loads += 1;
        return async () => undefined;
      })({}, context(logs));

      assert.equal(loads, 0);
      assert.deepEqual(logs, [`reminder-dispatch-${event}`]);
    });
  }

  it('stops a warm runner, and resumes only on an explicit true', async () => {
    const logs: string[] = [];
    const environment: NodeJS.ProcessEnv = {
      REMINDER_DISPATCH_ENABLED: 'true',
    };
    let runs = 0;
    const handler = createReminderDispatchTimerHandler(
      environment,
      async () => async () => {
        runs += 1;
      },
    );

    await handler({}, context(logs));
    environment.REMINDER_DISPATCH_ENABLED = 'false';
    await handler({}, context(logs));
    delete environment.REMINDER_DISPATCH_ENABLED;
    await handler({}, context(logs));
    assert.equal(runs, 1);

    environment.REMINDER_DISPATCH_ENABLED = 'true';
    await handler({}, context(logs));
    assert.equal(runs, 2);
    assert.deepEqual(logs, [
      'reminder-dispatch-suspended',
      'reminder-dispatch-gate-invalid',
    ]);
  });

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

  it('sends a one-day reminder in its own window', async () => {
    const test = harness([subscriptionRow('sydney')], { now: oneDayDuring });

    await test.run();

    assert.deepEqual(
      test.sent.map((request) => request.timing),
      ['one-day'],
    );
    assert.deepEqual(statuses(test), ['accepted']);
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
      reads: 2_258,
      unsettledPages: 1,
      writes: 1_008,
    });
    assert.equal(test.operations.subscriptionReads, 750);
    assert.deepEqual(test.logs, [
      `reminder-dispatch-accepted ${sydney} count=250`,
    ]);

    test.logs.length = 0;
    test.state.now = new Date(during.getTime() + 5 * 60 * 1000);
    await test.run();

    assert.equal(test.sent.length, 250);
    assert.equal(test.operations.pages, 6);
    assert.deepEqual(test.ledgerOperations, {
      reads: 2_516,
      unsettledPages: 2,
      writes: 1_008,
    });
    assert.equal(test.operations.subscriptionReads, 750);
    assert.deepEqual(test.logs, [
      `reminder-dispatch-already-recorded ${sydney} count=250`,
    ]);
  });

  describe('time budget', () => {
    const minute = 60 * 1000;
    const budgetLine = (zone: string) =>
      `reminder-dispatch-time-budget-reached zone=${zone} count=1`;
    const budgetLines = (test: ReturnType<typeof harness>) =>
      test.logs.filter((line) => line.includes('time-budget-reached'));
    const installationIds = (test: ReturnType<typeof harness>) =>
      test.sent.map((request) => request.subscription.installationId);
    // Assumes a run every ten minutes while runs use their budget.
    const startRun = (test: ReturnType<typeof harness>, run: number) => {
      test.logs.length = 0;
      test.state.now = new Date(during.getTime() + run * 10 * minute);
    };

    it('does not report a page cut short as finished if the clock steps back', async () => {
      // Clear before the query and for the first row, spent for the second,
      // then clear again once the clock has stepped back.
      const readings = [false, false, true];
      const events: string[] = [];
      async function* pages() {
        yield [1, 2, 3];
      }

      const reachedLastPage = await processPages(
        pages(),
        async () => ({ kind: 'accepted' }),
        (event) => events.push(event),
        () => readings.shift() ?? false,
      );

      assert.equal(reachedLastPage, false);
      assert.ok(events.includes('reminder-dispatch-time-budget-reached'));
    });

    it('reaches a zone past the old 5,000-row limit over two runs, sending each once', async () => {
      // 51 pages of 100. At 180 ms a send, a run starts 2,667 sends before its
      // 8 minutes are spent, so the second run has the rest to finish.
      const test = harness(zoneRows('Australia/Sydney', 5_100), {
        sendMs: 180,
      });

      startRun(test, 0);
      await test.run(30_000);
      const first = test.sent.length;
      // The sends in flight when the budget ended finish, and none start.
      assert.ok(first >= 2_667 && first <= 2_667 + 7, `${first} sends`);
      assert.deepEqual(test.operations.queriedZones, ['Australia/Sydney']);
      assert.deepEqual(statuses(test), Array(first).fill('accepted'));
      assert.deepEqual(sweepStates(test), Array(8).fill('incomplete'));
      assert.deepEqual(test.logs, [
        `reminder-dispatch-accepted ${sydney} count=${first}`,
        ...dueZones.map(budgetLine),
      ]);

      startRun(test, 1);
      await test.run(30_000);
      assert.equal(test.sent.length, 5_100);
      assert.equal(new Set(installationIds(test)).size, 5_100);
      assert.deepEqual(statuses(test), Array(5_100).fill('accepted'));
      assert.deepEqual(sweepStates(test), Array(8).fill('complete'));
      assert.deepEqual(test.logs, [
        `reminder-dispatch-already-recorded ${sydney} count=${first}`,
        `reminder-dispatch-accepted ${sydney} count=${5_100 - first}`,
      ]);

      // A sweep finished the zone, so its window closes with nothing to report.
      test.logs.length = 0;
      test.state.now = new Date(windowEnd.getTime() + 120 * minute);
      await test.run();
      assert.deepEqual(
        test.logs.filter((line) => line.includes('-window-')),
        [],
      );
    });

    it('stops inside one zone, leaves the zones after it, and finishes them over later runs', async () => {
      // At 2.4 s a send, a run starts 200 sends before its 8 minutes are spent:
      // the first zone's 150 and 50 of the second's.
      const zones = [
        'Australia/Sydney',
        'Australia/Melbourne',
        'Australia/Hobart',
      ];
      const test = harness(
        zones.flatMap((zone) => zoneRows(zone, 150)),
        { sendMs: 2_400 },
      );

      startRun(test, 0);
      await test.run();
      // A spent budget starts no query: Hobart and the rest are not read.
      assert.deepEqual(test.operations.queriedZones, [
        'Australia/Sydney',
        'Australia/Broken_Hill',
        'Australia/Melbourne',
      ]);
      assert.deepEqual(budgetLines(test), dueZones.slice(2).map(budgetLine));

      startRun(test, 1);
      await test.run();
      assert.deepEqual(budgetLines(test), dueZones.slice(3).map(budgetLine));

      startRun(test, 2);
      await test.run();
      assert.deepEqual(budgetLines(test), []);
      assert.equal(test.sent.length, 450);
      assert.equal(new Set(installationIds(test)).size, 450);
      assert.deepEqual(statuses(test), Array(450).fill('accepted'));
      assert.deepEqual(sweepStates(test), Array(8).fill('complete'));
    });

    it('reads on past empty pages, as Azure returns them with a continuation token', async () => {
      // 60 empty pages come before each of the 3 pages of rows, so the first
      // row is past the 50 pages a run once read.
      const test = harness(zoneRows('Australia/Sydney', 250), {
        emptyPagesBefore: 60,
      });

      await test.run();

      assert.equal(test.operations.pages, 3 * 61);
      assert.equal(test.sent.length, 250);
      assert.deepEqual(test.logs, [
        `reminder-dispatch-accepted ${sydney} count=250`,
      ]);
    });

    it('ends a scan of empty pages when the budget is spent', async () => {
      const test = harness(zoneRows('Australia/Sydney', 250), {
        emptyPagesBefore: 60,
        onPage: () => advance(test, budgetMs / 10),
      });

      await test.run();

      assert.equal(test.operations.pages, 10);
      assert.deepEqual(test.sent, []);
      assert.deepEqual(budgetLines(test), dueZones.map(budgetLine));
    });

    for (const [action, name, elapsed, pages, lines] of [
      [
        'carries on',
        'one millisecond short of the budget',
        budgetMs - 1,
        2,
        [],
      ],
      ['stops', 'exactly at the budget', budgetMs, 1, dueZones.map(budgetLine)],
    ] as const) {
      it(`${action} ${name}`, async () => {
        const test = harness(zoneRows('Australia/Sydney', 2), {
          // The first send ends with the clock at the elapsed time.
          outcome: async () => {
            test.state.now = new Date(during.getTime() + elapsed);
            return { kind: 'accepted' };
          },
          rowsPerPage: 1,
        });

        await test.run();

        assert.equal(test.operations.pages, pages);
        assert.deepEqual(budgetLines(test), lines);
      });
    }

    it('cannot finish a zone whose pages take the whole budget to read, and says so', async () => {
      // 30 pages of 5 rows arrive in the time a run has, and the zone has 60.
      // The 30th arrives as the budget ends, so only 29 are worked.
      const test = harness(zoneRows('Australia/Sydney', 300), {
        onPage: () => advance(test, budgetMs / 30),
        rowsPerPage: 5,
      });

      await test.run();
      startRun(test, 1);
      await test.run();

      assert.equal(test.sent.length, 145);
      assert.ok(
        test.logs.includes(
          `reminder-dispatch-already-recorded ${sydney} count=145`,
        ),
      );
      test.logs.length = 0;
      test.state.now = new Date(windowEnd.getTime() + 120 * minute);
      await test.run();
      assert.ok(
        test.logs.includes(
          'reminder-dispatch-window-sweep-incomplete zone=Australia/Sydney timing=one-week count=1',
        ),
      );
    });

    it('still checks closed windows and settles when the sweeps spent the budget', async () => {
      // Sydney's window has closed, and nothing swept Norfolk's an hour ago.
      // Broken Hill's and Adelaide's stay open for another half hour.
      const test = harness(zoneRows('Australia/Broken_Hill', 10), {
        now: afterWindow,
        onPage: () => advance(test, budgetMs),
      });
      await test.ledger.prepare(preparation('sydney', windowOpen));

      await test.run();

      assert.deepEqual(test.logs, [
        budgetLine('Australia/Broken_Hill'),
        budgetLine('Australia/Adelaide'),
        'reminder-dispatch-window-not-swept zone=Pacific/Norfolk timing=one-week count=1',
        'reminder-dispatch-expired count=1',
      ]);
      assert.deepEqual(statuses(test), ['expired']);
    });

    it('stops settlement at a budget of its own', async () => {
      const test = harness([]);
      let pagesRead = 0;
      test.dependencies.ledger = {
        ...test.ledger,
        async *listUnsettledPages() {
          for (let page = 0; page < 30; page += 1) {
            pagesRead += 1;
            advance(test, budgetMs / 10);
            yield [];
          }
        },
      };

      await test.run();

      assert.equal(pagesRead, 10);
      assert.deepEqual(test.logs, [
        'reminder-dispatch-time-budget-reached count=1',
      ]);
    });
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
      assert.deepEqual(test.logs, [
        `reminder-dispatch-stale ${sydney} count=1`,
      ]);

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
      assert.deepEqual(test.logs, [
        `reminder-dispatch-stale ${sydney} count=1`,
      ]);
    });

    it('refuses a deleted subscription, with no false expiry later', async () => {
      const test = harness([row()], {
        prepare: async () => {
          test.subscriptions.delete(key);
        },
      });

      await test.run();

      assert.deepEqual(test.sent, []);
      assert.deepEqual(test.logs, [
        `reminder-dispatch-stale ${sydney} count=1`,
      ]);

      test.logs.length = 0;
      test.state.now = afterWindow;
      await test.run();

      assert.deepEqual(test.logs, []);
    });

    it('refuses a catch-up send after slow acquisition, and expires it', async () => {
      // Half a minute from the end of the window, inside the claim lease.
      const test = harness([row()], {
        now: new Date(windowEnd.getTime() - 30_000),
        prepare: async () => {
          test.state.now = afterWindow;
        },
      });

      await test.run();

      assert.deepEqual(test.sent, []);
      assert.deepEqual(statuses(test), ['expired']);
      assert.deepEqual(test.logs, [
        `reminder-dispatch-expired ${sydney} count=1`,
      ]);
    });

    it('retries a send refused because its lease lapsed', async () => {
      const lapsed = new Date(during.getTime() + 61_000);
      const test = harness([row()], {
        prepare: async () => {
          if (test.logs.length === 0) test.state.now = lapsed;
        },
      });

      await test.run();
      assert.deepEqual(test.sent, []);
      assert.deepEqual(test.logs, [
        `reminder-dispatch-transient-failure ${sydney} count=1`,
      ]);

      await test.run();
      assert.equal(test.sent.length, 1);
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
      assert.deepEqual(test.logs, [
        `reminder-dispatch-uncertain ${sydney} count=1`,
      ]);
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
      assert.deepEqual(test.logs, [
        'reminder-dispatch-window-not-swept zone=Pacific/Norfolk timing=one-week count=1',
        'reminder-dispatch-uncertain count=1',
      ]);
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
        assert.deepEqual(test.logs, [
          `reminder-dispatch-${event} ${sydney} count=1`,
        ]);
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
        `reminder-dispatch-uncertain ${sydney} count=1`,
        `reminder-dispatch-already-recorded ${sydney} count=1`,
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
        `reminder-dispatch-permanent-failure ${sydney} count=1`,
        `reminder-dispatch-invalid-token-cleanup-failed ${sydney} count=1`,
        'reminder-dispatch-already-recorded count=1',
        'reminder-dispatch-invalid-token-cleanup-failed count=1',
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
        assert.match(
          line,
          /^reminder-dispatch-[a-z-]+ (zone=[\w/]+ )?count=\d+$/,
        );
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
        `reminder-dispatch-accepted ${sydney} count=1`,
        `reminder-dispatch-operation-failed ${sydney} count=1`,
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
      assert.deepEqual(test.logs, [
        `reminder-dispatch-operation-failed ${sydney} count=1`,
        'reminder-dispatch-accepted zone=Australia/Melbourne count=1',
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

    it('skips a row it cannot read and settles the rest', async () => {
      const test = harness([], { now: afterWindow });
      test.ledgerRows.set('invalid', { status: 'pending' });
      await test.ledger.prepare(preparation('sydney', windowOpen));

      await test.run();

      assert.deepEqual(test.logs.slice(-2), [
        'reminder-dispatch-ledger-row-invalid count=1',
        'reminder-dispatch-expired count=1',
      ]);
    });
  });

  describe('counts', () => {
    it('logs each zone when it finishes', async () => {
      const test = harness([
        subscriptionRow('sydney'),
        subscriptionRow('melbourne', { homeTimeZone: 'Australia/Melbourne' }),
      ]);

      await test.run();

      assert.deepEqual(test.logs, [
        `reminder-dispatch-accepted ${sydney} count=1`,
        'reminder-dispatch-accepted zone=Australia/Melbourne count=1',
      ]);
    });

    it('logs each page of settlement when it finishes', async () => {
      const test = harness([], { now: afterWindow });
      await test.ledger.prepare(preparation('first', windowOpen));
      await test.ledger.prepare(preparation('second', windowOpen));
      const first = await test.ledger.get(identity('first'));
      const second = await test.ledger.get(identity('second'));
      assert.ok(first && second);
      test.dependencies.ledger = {
        ...test.ledger,
        async *listUnsettledPages() {
          yield [first];
          yield [second];
        },
      };

      await test.run();

      assert.deepEqual(test.logs.slice(-2), [
        'reminder-dispatch-expired count=1',
        'reminder-dispatch-expired count=1',
      ]);
    });
  });

  describe('closed Delivery Windows', () => {
    // Every zone that observes daylight saving has this one-week window open
    // at `during`, and it has closed in all of them an hour or more later.
    const swept = [
      'Antarctica/Macquarie',
      'Australia/Adelaide',
      'Australia/Broken_Hill',
      'Australia/Hobart',
      'Australia/Lord_Howe',
      'Australia/Melbourne',
      'Australia/Sydney',
      'Pacific/Norfolk',
    ];
    const hour = 60 * 60 * 1000;
    const checked = new Date(windowEnd.getTime() + 2 * hour);
    const events = (event: string, timing = 'one-week') =>
      swept.map(
        (zone) =>
          `reminder-dispatch-window-${event} zone=${zone} timing=${timing} count=1`,
      );

    const windowLogs = (test: ReturnType<typeof harness>) =>
      test.logs.filter((line) => line.includes('-window-')).sort();

    // Each query takes the whole budget to answer, so no sweep reaches its last
    // page.
    function limitedQueries(test: ReturnType<typeof harness>) {
      test.dependencies.subscriptions = {
        ...test.dependencies.subscriptions,
        async *listZoneSubscriptionPages() {
          advance(test, budgetMs);
          yield [];
        },
      };
      return test;
    }

    it('reports a window no run swept, once', async () => {
      const test = harness([], { now: checked });

      await test.run();
      assert.equal(test.logs[0], 'reminder-dispatch-no-event count=1');
      assert.deepEqual(windowLogs(test), events('not-swept'));

      test.logs.length = 0;
      await test.run();
      assert.deepEqual(windowLogs(test), []);
    });

    it('never replays a window that closed while dispatch was stopped', async () => {
      const test = harness([subscriptionRow('sydney')], { now: checked });

      await test.run();

      assert.deepEqual(test.sent, []);
      assert.deepEqual(statuses(test), []);
      assert.deepEqual(windowLogs(test), events('not-swept'));
    });

    it('reports a one-day window no run swept', async () => {
      const test = harness([], {
        now: new Date(oneDayEnd.getTime() + 2 * hour),
      });

      await test.run();

      assert.deepEqual(windowLogs(test), events('not-swept', 'one-day'));
    });

    it('reports a window whose sweeps ran out of budget, once', async () => {
      const test = limitedQueries(harness([]));

      await test.run();
      test.logs.length = 0;
      test.state.now = checked;
      await test.run();
      assert.deepEqual(windowLogs(test), events('sweep-incomplete'));

      test.logs.length = 0;
      await test.run();
      assert.deepEqual(windowLogs(test), []);
    });

    it('reports a window whose query failed in every sweep', async () => {
      const test = harness([]);
      test.dependencies.subscriptions = {
        ...test.dependencies.subscriptions,
        async *listZoneSubscriptionPages() {
          throw azureError(503);
        },
      };

      await test.run();
      test.logs.length = 0;
      test.state.now = checked;
      await test.run();

      assert.deepEqual(windowLogs(test), events('sweep-incomplete'));
    });

    it('says nothing for a window one sweep finished', async () => {
      const test = limitedQueries(harness([]));
      const limited = test.dependencies.subscriptions;
      const { subscriptions } = harness([]).dependencies;

      await test.run();
      test.dependencies.subscriptions = subscriptions;
      test.state.now = new Date(during.getTime() + 5 * 60 * 1000);
      await test.run();
      test.dependencies.subscriptions = limited;
      test.state.now = new Date(during.getTime() + 10 * 60 * 1000);
      await test.run();
      test.logs.length = 0;
      test.state.now = checked;
      await test.run();

      assert.deepEqual(windowLogs(test), []);
    });

    it('reports once when invocations overlap', async () => {
      const test = harness([], { now: checked });
      await settled(Promise.all([test.run(), test.run()]));
      assert.deepEqual(windowLogs(test), events('not-swept'));
      assert.ok(!test.logs.some((line) => line.includes('operation-failed')));

      const limited = limitedQueries(harness([]));
      await limited.run();
      limited.logs.length = 0;
      limited.state.now = checked;
      await settled(Promise.all([limited.run(), limited.run()]));
      assert.deepEqual(windowLogs(limited), events('sweep-incomplete'));
      assert.ok(
        !limited.logs.some((line) => line.includes('operation-failed')),
      );
    });

    for (const [name, now] of [
      ['less than an hour after it closed', new Date(windowEnd.getTime() + 1)],
      [
        'more than 13 hours after it closed',
        new Date(windowEnd.getTime() + 13 * hour + 1),
      ],
    ] as const) {
      it(`leaves a window ${name}`, async () => {
        const test = harness([], { now });

        await test.run();

        assert.ok(!test.logs.some((line) => line.includes('Sydney')));
      });
    }

    it('checks at the last run of the lookback', async () => {
      const test = harness([], {
        now: new Date(windowEnd.getTime() + 13 * hour),
      });

      await test.run();

      assert.ok(test.logs.some((line) => line.includes('Sydney')));
    });

    it('cannot check without a pack, and catches up when it returns', async () => {
      const test = harness([], { now: checked });
      const { readActivePack } = test.dependencies;
      test.dependencies.readActivePack = async () => {
        throw new Error('sensitive storage detail');
      };

      await test.run();
      assert.deepEqual(test.logs, [
        'reminder-dispatch-pack-unavailable count=1',
      ]);

      test.dependencies.readActivePack = readActivePack;
      await test.run();
      assert.deepEqual(windowLogs(test), events('not-swept'));
    });

    it('reports a failed sweep write and still settles', async () => {
      const test = harness([subscriptionRow('sydney')]);
      test.dependencies.ledger = {
        ...test.ledger,
        recordSweep: async () => {
          throw azureError(503);
        },
      };

      await test.run();

      assert.deepEqual(test.logs.slice(0, 2), [
        `reminder-dispatch-accepted ${sydney} count=1`,
        `reminder-dispatch-operation-failed ${sydney} count=1`,
      ]);
      assert.equal(test.ledgerOperations.unsettledPages, 1);
    });

    it('reports a failed check and still settles', async () => {
      const test = harness([], { now: checked });
      test.dependencies.ledger = {
        ...test.ledger,
        reportClosedWindow: async () => {
          throw azureError(503);
        },
      };

      await test.run();

      assert.deepEqual(test.logs, [
        'reminder-dispatch-no-event count=1',
        'reminder-dispatch-operation-failed count=1',
      ]);
      assert.equal(test.ledgerOperations.unsettledPages, 1);
    });
  });
});

describe('reminder dispatch warning', () => {
  const day = 24 * 60 * 60 * 1000;
  // `during` is when the run is planned.
  const daysBefore = (days: number) => new Date(during.getTime() - days * day);
  const sydneyKey = identity('sydney').installationId;

  for (const [name, row, warned] of [
    [
      'a contact a millisecond short of 365 days ago',
      { lastContactAt: new Date(daysBefore(365).getTime() + 1) },
      false,
    ],
    [
      'a contact exactly 365 days ago',
      { lastContactAt: daysBefore(365) },
      true,
    ],
    ['a contact two years ago', { lastContactAt: daysBefore(730) }, true],
    ['a contact just now', { lastContactAt: during }, false],
    [
      'a contact in the future',
      { lastContactAt: new Date(during.getTime() + day) },
      false,
    ],
    [
      'an old registration after a recent contact',
      { lastContactAt: daysBefore(1), registeredAt: daysBefore(800) },
      false,
    ],
    [
      'a row saved before last contact existed, registered 400 days ago',
      { registeredAt: daysBefore(400) },
      true,
    ],
    [
      'a row saved before last contact existed, registered yesterday',
      { registeredAt: daysBefore(1) },
      false,
    ],
    ['a row with no readable time', {}, false],
    [
      'a last contact that is not a date',
      { lastContactAt: new Date('invalid') },
      false,
    ],
  ] as const) {
    it(`${warned ? 'warns' : 'does not warn'} for ${name}`, async () => {
      const test = harness([subscriptionRow('sydney', row)]);

      await test.run();

      assert.deepEqual(
        test.sent.map((request) => request.warned),
        [warned],
      );
    });
  }

  it('compares with the time the run was planned, not the time of the send', async () => {
    // Short of 365 days when the run was planned, and past it by the send.
    const test = harness([
      subscriptionRow('sydney', {
        lastContactAt: new Date(daysBefore(365).getTime() + 15_000),
      }),
    ]);
    const read = test.dependencies.subscriptions.getSubscriptionSnapshot;
    test.dependencies.subscriptions = {
      ...test.dependencies.subscriptions,
      async getSubscriptionSnapshot(installationId) {
        test.state.now = new Date(during.getTime() + 30_000);
        return read(installationId);
      },
    };

    await test.run();

    assert.deepEqual(
      test.sent.map((request) => request.warned),
      [false],
    );
  });

  for (const [name, madeContact, expected] of [
    ['stops warning once the installation makes contact', true, [true, false]],
    ['warns again while the installation stays silent', false, [true, true]],
  ] as const) {
    it(`a retry of the same delivery ${name}`, async () => {
      let attempts = 0;
      const test = harness(
        [subscriptionRow('sydney', { lastContactAt: daysBefore(365) })],
        {
          outcome: async () => ({
            kind: (attempts += 1) === 1 ? 'transient-failure' : 'accepted',
          }),
        },
      );
      await test.run();

      if (madeContact) {
        test.subscriptions.set(sydneyKey, {
          ...test.subscriptions.get(sydneyKey),
          lastContactAt: during,
        });
      }
      test.state.now = new Date(during.getTime() + 5 * 60 * 1000);
      await test.run();

      assert.deepEqual(
        test.sent.map((request) => request.warned),
        expected,
      );
      // The warning is not part of the delivery's identity: one record serves
      // both sends.
      assert.deepEqual(statuses(test), ['accepted']);
    });
  }
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
    warned: false,
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
        warned: false,
      },
      { expiresAt: windowEnd, kind: 'until' },
      {
        authorizeBeforeExternalSend: authorize,
        completeOperationDeadline: windowEnd,
      },
    ]);
  });

  for (const platform of ['android', 'ios'] as const) {
    it(`tells the ${platform} sender when the reminder is warned`, async () => {
      let facts: unknown;
      const sender = {
        async send(_subscription: unknown, reviewedFacts: unknown) {
          facts = reviewedFacts;
          return { kind: 'accepted' } as const;
        },
      };
      const provider = createReminderDispatchProvider({
        android: sender,
        ios: sender,
      });

      await provider.send(
        {
          ...request,
          subscription: { ...request.subscription, platform },
          warned: true,
        },
        authorize,
      );

      assert.deepEqual(facts, {
        changeDirection: 'forward',
        changeEventAt: new Date(changeEventAt),
        homeTimeZone: 'Australia/Sydney',
        timing: 'one-week',
        warned: true,
      });
    });
  }
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

  // Runs the composed runner on a signed pack and returns the invocation log.
  // `routes` answer any other fetch.
  async function runComposed(
    test: ReturnType<typeof harness>,
    overrides: Partial<ReminderDispatchBoundaries>,
    routes: Readonly<Record<string, Response>> = {},
  ) {
    const artifacts = signedArtifacts();
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
          fetch: fetchFrom({
            [manifestUrl]: new Response(artifacts.manifest),
            [artifacts.packUrl]: new Response(artifacts.bytes),
            ...routes,
          }).fetch,
          ...overrides,
        },
      )(
        new InvocationContext({
          logHandler: (_level, ...args) => logs.push(...args),
        }),
      ),
    );
    return logs;
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  it('sends through the real APNs sender with every bound', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: during.getTime() });
    const test = harness([
      subscriptionRow('apple', {
        deviceToken: 'a'.repeat(64),
        platform: 'ios',
      }),
    ]);
    const requests: ApnsHttpRequest[] = [];

    const logs = await runComposed(test, {
      createApnsTransport: () => ({
        post: async (request) => {
          requests.push(request);
          return { body: '', status: 200 };
        },
      }),
    });

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
      `reminder-dispatch-accepted ${sydney} count=1`,
    ]);
  });

  it('warns through the real APNs sender after a year of silence', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: during.getTime() });
    const test = harness([
      subscriptionRow('apple', {
        deviceToken: 'a'.repeat(64),
        lastContactAt: new Date(during.getTime() - 365 * 24 * 60 * 60 * 1000),
        platform: 'ios',
      }),
    ]);
    const requests: ApnsHttpRequest[] = [];

    await runComposed(test, {
      createApnsTransport: () => ({
        post: async (request) => {
          requests.push(request);
          return { body: '', status: 200 };
        },
      }),
    });

    assert.equal(
      requests[0]?.payload.aps.alert.body,
      'Your Home Time Zone changes soon. Tap to keep Change Reminders on.',
    );
  });

  // A sender that removed the token itself would leave the dispatcher's fenced
  // removal nothing to do, so the ledger would record `not-found`, not `removed`.
  it('leaves removing a rejected FCM token to the dispatcher', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: during.getTime() });
    const test = harness([subscriptionRow('android')]);
    const expiresAt = new Date(during.getTime() + 30 * 60 * 1000);
    const serviceAccount = encodeURIComponent(
      environment().FCM_SERVICE_ACCOUNT_EMAIL,
    );

    const logs = await runComposed(
      test,
      {
        createCredential: () => ({
          getToken: async () => ({
            expiresOnTimestamp: expiresAt.getTime(),
            token: 'entra-assertion',
          }),
        }),
      },
      {
        'https://sts.googleapis.com/v1/token': json({
          access_token: 'federated-token',
          expires_in: 1800,
          issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          token_type: 'Bearer',
        }),
        [`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`]:
          json({
            accessToken: 'fcm-access-token',
            expireTime: expiresAt.toISOString(),
          }),
        [fcmSendEndpoint('portable-project').toString()]: json(
          {
            error: {
              code: 404,
              details: [
                {
                  '@type':
                    'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                  errorCode: 'UNREGISTERED',
                },
              ],
              message: 'Rejected',
              status: 'NOT_FOUND',
            },
          },
          404,
        ),
      },
    );

    assert.equal(test.subscriptions.size, 0);
    assert.equal(
      (await test.ledger.get(identity('android')))?.cleanupStatus,
      'removed',
    );
    assert.deepEqual(logs, [
      'fcm-credential-ready',
      'fcm-change-reminder-permanent-invalid-token',
      `reminder-dispatch-permanent-failure ${sydney} count=1`,
    ]);
  });

  it('leaves removing a rejected APNs token to the dispatcher', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: during.getTime() });
    // APNs reports when it invalidated the token. The dispatcher keeps a
    // registration newer than that, so this one must predate it.
    const test = harness([
      subscriptionRow('apple', {
        deviceToken: 'a'.repeat(64),
        platform: 'ios',
        registeredAt: new Date(during.getTime() - 60 * 1000),
      }),
    ]);

    const logs = await runComposed(test, {
      createApnsTransport: () => ({
        post: async () => ({
          body: JSON.stringify({
            reason: 'Unregistered',
            timestamp: during.getTime(),
          }),
          status: 410,
        }),
      }),
    });

    assert.equal(test.subscriptions.size, 0);
    assert.equal(
      (await test.ledger.get(identity('apple')))?.cleanupStatus,
      'removed',
    );
    assert.deepEqual(logs, [
      'apns-change-reminder-permanent-invalid-token',
      `reminder-dispatch-permanent-failure ${sydney} count=1`,
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
