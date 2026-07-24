import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createTableReminderSubscriptionStore,
  deriveInstallationId,
  hashOpaqueValue,
  homeTimeZonePartitionKey,
  normalizeClientAddress,
  registerReminderSubscription,
  type ReminderSubscriptionStore,
} from './reminder-subscriptions.js';

const validRegistration = {
  attemptGeneration: 1,
  deviceToken: 'fcm-token:with_valid.characters-123',
  homeTimeZone: 'Australia/Sydney',
  oneDayEnabled: true,
  oneWeekEnabled: true,
  platform: 'android' as const,
  registrationRequestId: 'a'.repeat(64),
} as const;

function request(
  body: unknown,
  {
    contentLength,
    contentType = 'application/json',
    source = '198.51.100.7:43125',
  }: {
    readonly contentLength?: string;
    readonly contentType?: string;
    readonly source?: string | null;
  } = {},
) {
  const bytes =
    body instanceof Uint8Array
      ? body
      : new TextEncoder().encode(
          typeof body === 'string' ? body : JSON.stringify(body),
        );
  const headers = new Headers({ 'content-type': contentType });
  if (contentLength !== undefined) headers.set('content-length', contentLength);
  if (source !== null) headers.set('client-ip', source);
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    headers,
  } as never;
}

function store(
  overrides: Partial<ReminderSubscriptionStore> = {},
): ReminderSubscriptionStore {
  return {
    purgeExpiredThrottleRecords: async () => undefined,
    saveSubscription: async () => 'accepted',
    takeSourceAllowance: async () => true,
    ...overrides,
  };
}

function azureError(statusCode: number) {
  return Object.assign(new Error(`Azure ${statusCode}`), { statusCode });
}

function subscriptionTable(
  overrides: Partial<{
    readonly create: (entity: Record<string, unknown>) => Promise<void>;
    readonly get: (
      partitionKey: string,
      rowKey: string,
    ) => Promise<{
      readonly attemptGeneration: number;
      readonly etag: string;
      readonly partitionKey: string;
      readonly rowKey: string;
    }>;
    readonly replace: (
      entity: Record<string, unknown>,
      etag: string,
    ) => Promise<void>;
  }> = {},
) {
  return {
    create: async () => undefined,
    get: async () => {
      throw azureError(404);
    },
    replace: async () => undefined,
    ...overrides,
  };
}

function unusedThrottleTable() {
  return {
    create: async () => undefined,
    delete: async () => undefined,
    get: async () => {
      throw azureError(404);
    },
    listExpired: () =>
      (async function* () {
        // Subscription-only tests never enumerate throttle rows.
      })(),
    replace: async () => undefined,
  };
}

describe('reminder subscription registration', () => {
  it('stores a credential hash, never the returned credential, after strict validation', async () => {
    let saved: Record<string, unknown> | undefined;
    const now = new Date('2026-07-24T05:00:00.000Z');
    const result = await registerReminderSubscription(
      request(validRegistration),
      store({
        saveSubscription: async (record) => {
          saved = { ...record };
          return 'accepted';
        },
      }),
      now,
    );
    assert.equal(result.status, 201);
    const body = result.jsonBody as {
      credential: string;
      installationId: string;
    };
    assert.notEqual(saved?.credentialHash, body.credential);
    assert.equal(saved?.deviceToken, validRegistration.deviceToken);
    assert.equal(saved?.registeredAt, now);
    assert.equal(saved?.attemptGeneration, 1);
    assert.equal('registrationRequestId' in (saved ?? {}), false);
    assert.equal(new Headers(result.headers).get('Cache-Control'), 'no-store');
  });

  for (const [name, input, options, status] of [
    [
      'JSON prefix media type',
      validRegistration,
      { contentType: 'application/jsonp' },
      415,
    ],
    [
      'JSON media type parameters',
      validRegistration,
      { contentType: 'application/json; charset=utf-8' },
      415,
    ],
    ['malformed JSON', '{', {}, 400],
    ['arbitrary fields', { ...validRegistration, arbitrary: true }, {}, 400],
    [
      'noncanonical zone alias',
      { ...validRegistration, homeTimeZone: 'Australia/ACT' },
      {},
      400,
    ],
    [
      'invalid platform token',
      { ...validRegistration, deviceToken: ' '.repeat(32) },
      {},
      400,
    ],
    [
      'oversized declared body',
      validRegistration,
      { contentLength: '8193' },
      413,
    ],
    [
      'invalid declared body length',
      validRegistration,
      { contentLength: 'unknown' },
      400,
    ],
  ] as const) {
    it(`rejects ${name}`, async () => {
      let saves = 0;
      const result = await registerReminderSubscription(
        request(input, options),
        store({
          saveSubscription: async () => {
            saves += 1;
            return 'accepted';
          },
        }),
      );
      assert.equal(result.status, status);
      assert.equal(saves, 0);
    });
  }

  it('stops reading an oversized chunked request at the byte limit', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8_192));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await registerReminderSubscription(
      {
        body,
        headers: new Headers({
          'client-ip': '198.51.100.7',
          'content-type': 'application/json',
        }),
      } as never,
      store(),
    );
    assert.equal(result.status, 413);
    assert.equal(cancelled, true);
  });

  it('returns generic availability errors for throttle and storage failures', async () => {
    const throttleFailure = await registerReminderSubscription(
      request(validRegistration),
      store({
        takeSourceAllowance: async () => {
          throw azureError(401);
        },
      }),
    );
    assert.equal(throttleFailure.status, 503);
    assert.deepEqual(throttleFailure.jsonBody, {
      error: 'Registration unavailable',
    });

    const storageFailure = await registerReminderSubscription(
      request(validRegistration),
      store({
        saveSubscription: async () => {
          throw azureError(500);
        },
      }),
    );
    assert.equal(storageFailure.status, 503);
    assert.deepEqual(storageFailure.jsonBody, {
      error: 'Registration unavailable',
    });
  });

  it('returns no secret when an attempt is superseded', async () => {
    const result = await registerReminderSubscription(
      request(validRegistration),
      store({ saveSubscription: async () => 'stale' }),
    );
    assert.equal(result.status, 409);
    assert.deepEqual(result.jsonBody, {
      error: 'Registration attempt superseded',
    });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /fcm-token/);
    assert.doesNotMatch(
      serialized,
      new RegExp(validRegistration.registrationRequestId),
    );
    assert.equal('credential' in (result.jsonBody as object), false);
  });

  it('derives one stable row while issuing fresh accepted credentials', async () => {
    const saved: Record<string, unknown>[] = [];
    const registrationStore = store({
      saveSubscription: async (record) => {
        saved.push({ ...record });
        return 'accepted';
      },
    });
    const first = await registerReminderSubscription(
      request(validRegistration),
      registrationStore,
    );
    const second = await registerReminderSubscription(
      request({ ...validRegistration, attemptGeneration: 2 }),
      registrationStore,
    );
    const firstBody = first.jsonBody as {
      readonly credential: string;
      readonly installationId: string;
    };
    const secondBody = second.jsonBody as {
      readonly credential: string;
      readonly installationId: string;
    };
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(firstBody.installationId, secondBody.installationId);
    assert.equal(
      firstBody.installationId,
      deriveInstallationId(validRegistration.registrationRequestId),
    );
    assert.notEqual(firstBody.credential, secondBody.credential);
    assert.notEqual(saved[0]?.credentialHash, firstBody.credential);
    assert.notEqual(saved[1]?.credentialHash, secondBody.credential);
  });

  it('fails closed before throttling when trusted client address is unavailable', async () => {
    let allowanceChecks = 0;
    for (const source of [null, 'spoofed, 198.51.100.7', 'not-an-ip']) {
      const result = await registerReminderSubscription(
        request(validRegistration, { source }),
        store({
          takeSourceAllowance: async () => {
            allowanceChecks += 1;
            return true;
          },
        }),
      );
      assert.equal(result.status, 503);
      assert.deepEqual(result.jsonBody, {
        error: 'Registration unavailable',
      });
    }
    assert.equal(allowanceChecks, 0);
  });

  it('returns retry guidance without exposing request values when throttled', async () => {
    const result = await registerReminderSubscription(
      request(validRegistration),
      store({ takeSourceAllowance: async () => false }),
    );
    assert.equal(result.status, 429);
    assert.deepEqual(result.jsonBody, { error: 'Try again later' });
    assert.equal(new Headers(result.headers).get('Retry-After'), '600');
    assert.doesNotMatch(JSON.stringify(result), /fcm-token/);
  });
});

describe('Azure Table mapping', () => {
  it('uses a deterministic Table-safe zone partition and retains canonical zone', async () => {
    let entity: Record<string, unknown> | undefined;
    const tableStore = createTableReminderSubscriptionStore(
      subscriptionTable({
        create: async (candidate) => {
          entity = candidate;
        },
      }),
      {
        create: async () => undefined,
        delete: async () => undefined,
        get: async () => {
          throw azureError(404);
        },
        listExpired: () =>
          (async function* () {
            // No expired rows.
          })(),
        replace: async () => undefined,
      },
    );
    await tableStore.saveSubscription({
      ...validRegistration,
      credentialHash: 'credential-hash',
      installationId: 'installation-id',
      registeredAt: new Date('2026-07-24T05:00:00.000Z'),
    });

    assert.equal(
      entity?.partitionKey,
      homeTimeZonePartitionKey('Australia/Sydney'),
    );
    assert.doesNotMatch(String(entity?.partitionKey), /[\\/#?]/);
    assert.equal(entity?.homeTimeZone, 'Australia/Sydney');
    assert.equal(entity?.attemptGeneration, 1);
    assert.equal('registrationRequestId' in (entity ?? {}), false);
    assert.equal(entity?.rowKey, 'installation-id');
  });
});

describe('source address normalization', () => {
  for (const [input, expected] of [
    ['198.51.100.7:43125', '198.51.100.7'],
    ['::ffff:198.51.100.7', '198.51.100.7'],
    ['[::ffff:198.51.100.7]:43125', '198.51.100.7'],
    ['[2001:0db8:0:0:0:0:0:1]:443', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['spoofed, 198.51.100.7', null],
    [null, null],
  ] as const) {
    it(`normalizes ${String(input)}`, () => {
      assert.equal(normalizeClientAddress(input), expected);
    });
  }

  it('hashes normalized addresses without retaining raw values', () => {
    const normalized = normalizeClientAddress('198.51.100.7:43125');
    assert.notEqual(normalized, null);
    if (normalized === null) assert.fail('expected valid client address');
    assert.equal(hashOpaqueValue(normalized), hashOpaqueValue('198.51.100.7'));
  });
});

describe('generation-ordered subscription persistence', () => {
  function record(
    attemptGeneration: number,
    credentialHash = `credential-${attemptGeneration}`,
  ) {
    return {
      attemptGeneration,
      credentialHash,
      deviceToken: `${validRegistration.deviceToken}-${attemptGeneration}`,
      homeTimeZone: validRegistration.homeTimeZone,
      installationId: deriveInstallationId(
        validRegistration.registrationRequestId,
      ),
      oneDayEnabled: true,
      oneWeekEnabled: true,
      platform: validRegistration.platform,
      registeredAt: new Date(`2026-07-24T05:00:0${attemptGeneration}.000Z`),
    };
  }

  function concurrentSubscriptionTable() {
    const rows = new Map<string, Record<string, unknown>>();
    let nextEtag = 0;
    const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
    return {
      create: async (entity: Record<string, unknown>) => {
        await pause();
        const key = `${String(entity.partitionKey)}/${String(entity.rowKey)}`;
        if (rows.has(key)) throw azureError(409);
        rows.set(key, { ...entity, etag: String(++nextEtag) });
      },
      get: async (partitionKey: string, rowKey: string) => {
        await pause();
        const row = rows.get(`${partitionKey}/${rowKey}`);
        if (row === undefined) throw azureError(404);
        return {
          attemptGeneration: Number(row.attemptGeneration),
          etag: String(row.etag),
          partitionKey,
          rowKey,
        };
      },
      replace: async (
        entity: Record<string, unknown>,
        expectedEtag: string,
      ) => {
        await pause();
        const key = `${String(entity.partitionKey)}/${String(entity.rowKey)}`;
        const row = rows.get(key);
        if (row === undefined) throw azureError(404);
        if (row.etag !== expectedEtag) throw azureError(412);
        rows.set(key, { ...entity, etag: String(++nextEtag) });
      },
      rows,
    };
  }

  function onlyRow(rows: Map<string, Record<string, unknown>>) {
    assert.equal(rows.size, 1);
    const row = [...rows.values()][0];
    assert.ok(row);
    return row;
  }

  it('does not let a delayed older attempt overwrite a newer generation', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );

    assert.equal(
      await registrationStore.saveSubscription(record(2)),
      'accepted',
    );
    assert.equal(await registrationStore.saveSubscription(record(1)), 'stale');
    const stored = onlyRow(subscriptions.rows);
    assert.equal(stored.attemptGeneration, 2);
    assert.equal(stored.credentialHash, 'credential-2');
    assert.equal(stored.deviceToken, `${validRegistration.deviceToken}-2`);
  });

  it('accepts one of concurrent equal attempts and keeps one row', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const results = await Promise.all([
      registrationStore.saveSubscription(record(1, 'credential-left')),
      registrationStore.saveSubscription(record(1, 'credential-right')),
    ]);

    assert.deepEqual(results.sort(), ['accepted', 'stale']);
    assert.equal(onlyRow(subscriptions.rows).attemptGeneration, 1);
  });

  it('converges concurrent different generations on the higher attempt', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    await Promise.all([
      registrationStore.saveSubscription(record(1)),
      registrationStore.saveSubscription(record(2)),
    ]);

    assert.equal(onlyRow(subscriptions.rows).attemptGeneration, 2);
    assert.equal(onlyRow(subscriptions.rows).credentialHash, 'credential-2');
  });
});

describe('durable throttle', () => {
  function createConcurrentTable() {
    const rows = new Map<
      string,
      { count: number; etag: string; expiresAt: Date }
    >();
    let etag = 0;
    const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
    return {
      create: async (entity: Record<string, unknown>) => {
        await pause();
        const key = `${String(entity.partitionKey)}/${String(entity.rowKey)}`;
        if (rows.has(key)) throw azureError(409);
        rows.set(key, {
          count: Number(entity.count),
          etag: String(++etag),
          expiresAt: entity.expiresAt as Date,
        });
      },
      delete: async (partitionKey: string, rowKey: string) => {
        rows.delete(`${partitionKey}/${rowKey}`);
      },
      get: async (partitionKey: string, rowKey: string) => {
        await pause();
        const row = rows.get(`${partitionKey}/${rowKey}`);
        if (row === undefined) throw azureError(404);
        return {
          count: row.count,
          etag: row.etag,
          partitionKey,
          rowKey,
        };
      },
      listExpired: (_now: Date) =>
        (async function* () {
          // Retention behavior has a focused test below.
        })(),
      replace: async (
        entity: Record<string, unknown>,
        expectedEtag: string,
      ) => {
        await pause();
        const key = `${String(entity.partitionKey)}/${String(entity.rowKey)}`;
        const row = rows.get(key);
        if (row === undefined) throw azureError(404);
        if (row.etag !== expectedEtag) throw azureError(412);
        rows.set(key, {
          count: Number(entity.count),
          etag: String(++etag),
          expiresAt: entity.expiresAt as Date,
        });
      },
      rows,
    };
  }

  it('permits only the fixed-window limit under concurrent requests', async () => {
    const throttles = createConcurrentTable();
    const tableStore = createTableReminderSubscriptionStore(
      subscriptionTable(),
      throttles,
    );
    const now = new Date('2026-07-24T05:00:00.000Z');
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        tableStore.takeSourceAllowance('source-hash', now),
      ),
    );
    assert.equal(results.filter(Boolean).length, 5);
    assert.equal(results.filter((allowed) => !allowed).length, 5);
  });

  it('distinguishes missing rows, races, and Azure service errors', async () => {
    const readFailure = createTableReminderSubscriptionStore(
      subscriptionTable(),
      {
        ...createConcurrentTable(),
        get: async () => {
          throw azureError(401);
        },
      },
    );
    await assert.rejects(
      readFailure.takeSourceAllowance('source', new Date()),
      /Azure 401/,
    );

    const createFailure = createTableReminderSubscriptionStore(
      subscriptionTable(),
      {
        ...createConcurrentTable(),
        create: async () => {
          throw azureError(500);
        },
        get: async () => {
          throw azureError(404);
        },
      },
    );
    await assert.rejects(
      createFailure.takeSourceAllowance('source', new Date()),
      /Azure 500/,
    );

    const updateFailure = createTableReminderSubscriptionStore(
      subscriptionTable(),
      {
        ...createConcurrentTable(),
        get: async () => ({
          count: 1,
          etag: 'etag',
          partitionKey: 'source',
          rowKey: 'window',
        }),
        replace: async () => {
          throw azureError(500);
        },
      },
    );
    await assert.rejects(
      updateFailure.takeSourceAllowance('source', new Date()),
      /Azure 500/,
    );
  });

  it('purges expired throttle rows and tolerates already-deleted races', async () => {
    const deleted: string[] = [];
    const tableStore = createTableReminderSubscriptionStore(
      subscriptionTable(),
      {
        create: async () => undefined,
        delete: async (partitionKey, rowKey) => {
          deleted.push(`${partitionKey}/${rowKey}`);
          if (rowKey === 'already-gone') throw azureError(404);
        },
        get: async () => {
          throw azureError(404);
        },
        listExpired: () =>
          (async function* () {
            yield {
              count: 1,
              etag: 'one',
              partitionKey: 'source-a',
              rowKey: 'expired',
            };
            yield {
              count: 1,
              etag: 'two',
              partitionKey: 'source-b',
              rowKey: 'already-gone',
            };
          })(),
        replace: async () => undefined,
      },
    );
    await tableStore.purgeExpiredThrottleRecords(new Date());
    assert.deepEqual(deleted, ['source-a/expired', 'source-b/already-gone']);
  });
});
