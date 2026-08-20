import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAzureReminderSubscriptionStore,
  createReminderSubscriptionHandler,
  createTableReminderSubscriptionStore,
  deriveInstallationId,
  hashOpaqueValue,
  normalizeClientAddress,
  registerReminderSubscription,
  updateReminderSubscription,
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
    authorization,
    contentLength,
    contentType = 'application/json',
    source = '198.51.100.7:43125',
  }: {
    readonly contentLength?: string;
    readonly contentType?: string;
    readonly authorization?: string | undefined;
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
  if (authorization !== undefined) {
    headers.set('authorization', authorization);
  }
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
    createSubscription: async () => 'accepted',
    getSubscription: async () => null,
    purgeExpiredThrottleRecords: async () => undefined,
    removeIfDeviceTokenMatches: async () => 'not-found',
    takeInstallationAllowance: async () => true,
    updateSubscription: async () => 'accepted',
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
    readonly delete: (
      partitionKey: string,
      rowKey: string,
      etag: string,
    ) => Promise<void>;
    readonly get: (
      partitionKey: string,
      rowKey: string,
    ) => Promise<{
      readonly attemptGeneration: number;
      readonly deviceToken: string;
      readonly etag: string;
      readonly partitionKey: string;
      readonly platform?: 'android' | 'ios';
      readonly registeredAt?: Date;
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
    delete: async () => undefined,
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
  it('returns a generic unavailable response when store construction fails', async () => {
    const handler = createReminderSubscriptionHandler(() => {
      throw new Error('sensitive managed identity detail');
    });

    const result = await handler({} as never);

    assert.deepEqual(result, {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { error: 'Registration unavailable' },
      status: 503,
    });
    assert.doesNotMatch(
      JSON.stringify(result),
      /identity|sensitive|REMINDER_MANAGED_IDENTITY_CLIENT_ID/i,
    );
  });

  it('stores a credential hash, never the returned credential, after strict validation', async () => {
    let saved: Record<string, unknown> | undefined;
    const now = new Date('2026-07-24T05:00:00.000Z');
    const result = await registerReminderSubscription(
      request(validRegistration),
      store({
        createSubscription: async (record) => {
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
          createSubscription: async () => {
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
        createSubscription: async () => {
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
      store({ createSubscription: async () => 'stale' }),
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
      createSubscription: async (record) => {
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

describe('reminder subscription updates', () => {
  const update = {
    attemptGeneration: 2,
    deviceToken: validRegistration.deviceToken,
    homeTimeZone: validRegistration.homeTimeZone,
    oneDayEnabled: true,
    oneWeekEnabled: true,
    platform: 'android' as const,
  };
  const installationId = 'i'.repeat(43);
  const credential = 'c'.repeat(43);

  it('accepts exact bearer-authenticated updates without returning secrets', async () => {
    let received:
      | { readonly credentialHash: string; readonly installationId: string }
      | undefined;
    const result = await updateReminderSubscription(
      request(update, { authorization: `Bearer ${credential}` }),
      store({
        updateSubscription: async (record, credentialHash) => {
          received = { credentialHash, installationId: record.installationId };
          return 'accepted';
        },
      }),
      installationId,
    );
    assert.equal(result.status, 204);
    assert.equal(new Headers(result.headers).get('Cache-Control'), 'no-store');
    assert.deepEqual(received, {
      credentialHash: hashOpaqueValue(credential),
      installationId,
    });
    assert.doesNotMatch(JSON.stringify(result), /credential|token/i);
  });

  for (const authorization of [
    undefined,
    'Bearer short',
    `Basic ${credential}`,
  ]) {
    it(`rejects ${String(authorization)} without calling persistence`, async () => {
      let updates = 0;
      const result = await updateReminderSubscription(
        request(update, { authorization }),
        store({ updateSubscription: async () => ((updates += 1), 'accepted') }),
        installationId,
      );
      assert.equal(result.status, 401);
      assert.deepEqual(result.jsonBody, { error: 'Unauthorized' });
      assert.equal(updates, 0);
    });
  }

  it('keeps stale and bad-credential responses secret-free', async () => {
    const stale = await updateReminderSubscription(
      request(update, { authorization: `Bearer ${credential}` }),
      store({ updateSubscription: async () => 'stale' }),
      installationId,
    );
    const unauthorized = await updateReminderSubscription(
      request(update, { authorization: `Bearer ${credential}` }),
      store({ updateSubscription: async () => 'unauthorized' }),
      installationId,
    );
    assert.equal(stale.status, 409);
    assert.equal(unauthorized.status, 401);
    assert.doesNotMatch(
      JSON.stringify([stale, unauthorized]),
      /c{43}|fcm-token/,
    );
  });

  it('throttles update source and installation attempts before credential lookup', async () => {
    let updates = 0;
    const sourceLimited = await updateReminderSubscription(
      request(update, { authorization: `Bearer ${credential}` }),
      store({
        takeSourceAllowance: async () => false,
        updateSubscription: async () => ((updates += 1), 'accepted'),
      }),
      installationId,
    );
    const installationLimited = await updateReminderSubscription(
      request(update, { authorization: `Bearer ${credential}` }),
      store({
        takeInstallationAllowance: async () => false,
        updateSubscription: async () => ((updates += 1), 'accepted'),
      }),
      installationId,
    );
    assert.equal(sourceLimited.status, 429);
    assert.equal(installationLimited.status, 429);
    assert.equal(updates, 0);
  });

  it('fails closed when an update has no trusted source address', async () => {
    const result = await updateReminderSubscription(
      request(update, { authorization: `Bearer ${credential}`, source: null }),
      store(),
      installationId,
    );
    assert.equal(result.status, 503);
    assert.deepEqual(result.jsonBody, { error: 'Registration unavailable' });
  });
});

describe('Azure Table mapping', () => {
  it('selects the configured UAMI and shares its credential across both Table clients', () => {
    const credential = {
      getToken: async () => ({
        expiresOnTimestamp: 0,
        token: 'test-token',
      }),
    };
    const selectedClientIds: string[] = [];
    const tableClients: {
      readonly credential: object;
      readonly endpoint: string;
      readonly tableName: string;
    }[] = [];

    createAzureReminderSubscriptionStore(
      {
        REMINDER_MANAGED_IDENTITY_CLIENT_ID: ' runtime-uami-client-id ',
        REMINDER_STORAGE_ACCOUNT_NAME: 'dlsvstorage',
      },
      {
        createCredential: (clientId) => {
          selectedClientIds.push(clientId);
          return credential;
        },
        createTableClient: (endpoint, tableName, selectedCredential) => {
          tableClients.push({
            credential: selectedCredential,
            endpoint,
            tableName,
          });
          return {} as never;
        },
      },
    );

    assert.deepEqual(selectedClientIds, ['runtime-uami-client-id']);
    assert.deepEqual(
      tableClients.map(({ endpoint, tableName }) => ({ endpoint, tableName })),
      [
        {
          endpoint: 'https://dlsvstorage.table.core.windows.net',
          tableName: 'ReminderSubscriptions',
        },
        {
          endpoint: 'https://dlsvstorage.table.core.windows.net',
          tableName: 'ReminderRegistrationThrottle',
        },
      ],
    );
    assert.ok(
      tableClients.every(
        (tableClient) => tableClient.credential === credential,
      ),
    );
  });

  it('fails before credential or Table client construction without an explicit UAMI', () => {
    for (const managedIdentityClientId of [undefined, '', '   ']) {
      let credentialConstructions = 0;
      let tableClientConstructions = 0;
      assert.throws(
        () =>
          createAzureReminderSubscriptionStore(
            {
              REMINDER_MANAGED_IDENTITY_CLIENT_ID: managedIdentityClientId,
              REMINDER_STORAGE_ACCOUNT_NAME: 'dlsvstorage',
            },
            {
              createCredential: () => {
                credentialConstructions += 1;
                return {
                  getToken: async () => ({
                    expiresOnTimestamp: 0,
                    token: 'test-token',
                  }),
                };
              },
              createTableClient: () => {
                tableClientConstructions += 1;
                return {} as never;
              },
            },
          ),
        /REMINDER_MANAGED_IDENTITY_CLIENT_ID is required/,
      );
      assert.equal(credentialConstructions, 0);
      assert.equal(tableClientConstructions, 0);
    }
  });

  it('uses a fixed subscription partition and retains canonical zone as data', async () => {
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
    await tableStore.createSubscription({
      ...validRegistration,
      credentialHash: 'credential-hash',
      installationId: 'installation-id',
      registeredAt: new Date('2026-07-24T05:00:00.000Z'),
    });

    assert.equal(entity?.partitionKey, 'subscriptions-v1');
    assert.doesNotMatch(String(entity?.partitionKey), /[\\/#?]/);
    assert.equal(entity?.homeTimeZone, 'Australia/Sydney');
    assert.equal(entity?.attemptGeneration, 1);
    assert.equal('registrationRequestId' in (entity ?? {}), false);
    assert.equal(entity?.rowKey, 'installation-id');
  });

  it('returns only the exact stored Android subscription', async () => {
    const tableStore = createTableReminderSubscriptionStore(
      subscriptionTable({
        get: async () => ({
          attemptGeneration: 1,
          deviceToken: validRegistration.deviceToken,
          etag: 'etag',
          partitionKey: 'subscriptions-v1',
          platform: 'android',
          rowKey: 'installation-id',
        }),
      }),
      unusedThrottleTable(),
    );

    assert.deepEqual(await tableStore.getSubscription('installation-id'), {
      deviceToken: validRegistration.deviceToken,
      installationId: 'installation-id',
    });
  });

  it('does not return a non-Android subscription', async () => {
    const tableStore = createTableReminderSubscriptionStore(
      subscriptionTable({
        get: async () => ({
          attemptGeneration: 1,
          deviceToken: validRegistration.deviceToken,
          etag: 'etag',
          partitionKey: 'subscriptions-v1',
          platform: 'ios',
          rowKey: 'installation-id',
        }),
      }),
      unusedThrottleTable(),
    );

    assert.equal(await tableStore.getSubscription('installation-id'), null);
  });

  it('maps a missing subscription to null', async () => {
    const tableStore = createTableReminderSubscriptionStore(
      subscriptionTable(),
      unusedThrottleTable(),
    );

    assert.equal(await tableStore.getSubscription('installation-id'), null);
  });

  it('preserves a non-404 subscription read failure', async () => {
    const tableStore = createTableReminderSubscriptionStore(
      subscriptionTable({
        get: async () => {
          throw azureError(500);
        },
      }),
      unusedThrottleTable(),
    );

    await assert.rejects(
      tableStore.getSubscription('installation-id'),
      /Azure 500/,
    );
  });

  it('uses Azure registeredAt to preserve a newer APNs registration', async () => {
    const deletions: {
      readonly etag: string | undefined;
      readonly partitionKey: string;
      readonly rowKey: string;
    }[] = [];
    const subscriptions = {
      deleteEntity: async (
        partitionKey: string,
        rowKey: string,
        options: { readonly etag?: string },
      ) => {
        deletions.push({
          etag: options.etag,
          partitionKey,
          rowKey,
        });
      },
      getEntity: async () =>
        ({
          attemptGeneration: 1,
          deviceToken: validRegistration.deviceToken,
          etag: 'matching-etag',
          registeredAt: new Date('2026-07-24T05:00:02.000Z'),
        }) as never,
    };
    const tableStore = createAzureReminderSubscriptionStore(
      {
        REMINDER_MANAGED_IDENTITY_CLIENT_ID: 'runtime-uami-client-id',
        REMINDER_STORAGE_ACCOUNT_NAME: 'dlsvstorage',
      },
      {
        createCredential: () => ({
          getToken: async () => ({ expiresOnTimestamp: 0, token: 'test' }),
        }),
        createTableClient: (_endpoint, tableName) =>
          tableName === 'ReminderSubscriptions'
            ? (subscriptions as never)
            : ({} as never),
      },
    );

    assert.equal(
      await tableStore.removeIfDeviceTokenMatches(
        {
          deviceToken: validRegistration.deviceToken,
          installationId: 'installation-id',
        },
        new Date('2026-07-24T05:00:01.000Z'),
      ),
      'token-replaced',
    );
    assert.deepEqual(deletions, []);
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
    let beforeDelete: (() => Promise<void>) | undefined;
    const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
    return {
      create: async (entity: Record<string, unknown>) => {
        await pause();
        const key = `${String(entity.partitionKey)}/${String(entity.rowKey)}`;
        if (rows.has(key)) throw azureError(409);
        rows.set(key, { ...entity, etag: String(++nextEtag) });
      },
      delete: async (
        partitionKey: string,
        rowKey: string,
        expectedEtag: string,
      ) => {
        await pause();
        await beforeDelete?.();
        const key = `${partitionKey}/${rowKey}`;
        const row = rows.get(key);
        if (row === undefined) throw azureError(404);
        if (row.etag !== expectedEtag) throw azureError(412);
        rows.delete(key);
      },
      get: async (partitionKey: string, rowKey: string) => {
        await pause();
        const row = rows.get(`${partitionKey}/${rowKey}`);
        if (row === undefined) throw azureError(404);
        return {
          attemptGeneration: Number(row.attemptGeneration),
          credentialHash: String(row.credentialHash),
          deviceToken: String(row.deviceToken),
          etag: String(row.etag),
          homeTimeZone: String(row.homeTimeZone),
          oneDayEnabled: Boolean(row.oneDayEnabled),
          oneWeekEnabled: Boolean(row.oneWeekEnabled),
          partitionKey,
          platform: row.platform as 'android' | 'ios',
          registeredAt:
            row.registeredAt instanceof Date ? row.registeredAt : undefined,
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
      setBeforeDelete: (callback: (() => Promise<void>) | undefined) => {
        beforeDelete = callback;
      },
    };
  }

  function onlyRow(rows: Map<string, Record<string, unknown>>) {
    assert.equal(rows.size, 1);
    const row = [...rows.values()][0];
    assert.ok(row);
    return row;
  }

  function updateSubscription(
    registrationStore: ReturnType<typeof createTableReminderSubscriptionStore>,
    next: ReturnType<typeof record>,
    credentialHash: string,
  ) {
    const { credentialHash: _ignored, ...update } = next;
    return registrationStore.updateSubscription(update, credentialHash);
  }

  it('replays only an unchanged initial registration while rotating its credential hash', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    await registrationStore.createSubscription(record(1, 'credential-old'));
    assert.equal(
      await registrationStore.createSubscription({
        ...record(1, 'credential-new'),
        attemptGeneration: 2,
      }),
      'accepted',
    );
    assert.equal(onlyRow(subscriptions.rows).attemptGeneration, 2);
    assert.equal(onlyRow(subscriptions.rows).credentialHash, 'credential-new');
    assert.equal(
      await registrationStore.createSubscription({
        ...record(3, 'credential-attacker'),
        deviceToken: 'different-token',
      }),
      'conflict',
    );
    assert.equal(
      onlyRow(subscriptions.rows).deviceToken,
      record(1).deviceToken,
    );
  });

  it('does not let a delayed older attempt overwrite a newer generation', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );

    assert.equal(
      await registrationStore.createSubscription(record(2)),
      'accepted',
    );
    assert.equal(
      await updateSubscription(registrationStore, record(1), 'credential-2'),
      'stale',
    );
    const stored = onlyRow(subscriptions.rows);
    assert.equal(stored.attemptGeneration, 2);
    assert.equal(stored.credentialHash, 'credential-2');
    assert.equal(stored.deviceToken, `${validRegistration.deviceToken}-2`);
  });

  it('updates one stable row when a higher generation changes zone', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );

    assert.equal(
      await registrationStore.createSubscription(record(1)),
      'accepted',
    );
    assert.equal(
      await updateSubscription(
        registrationStore,
        {
          ...record(2),
          homeTimeZone: 'Australia/Brisbane' as never,
        },
        'credential-1',
      ),
      'accepted',
    );

    const stored = onlyRow(subscriptions.rows);
    assert.equal(stored.attemptGeneration, 2);
    assert.equal(stored.homeTimeZone, 'Australia/Brisbane');
    assert.equal(stored.partitionKey, 'subscriptions-v1');
  });

  it('accepts one of concurrent equal attempts and keeps one row', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    await registrationStore.createSubscription(record(1, 'credential-left'));
    const results = await Promise.all([
      updateSubscription(registrationStore, record(2), 'credential-left'),
      updateSubscription(registrationStore, record(2), 'credential-left'),
    ]);

    assert.deepEqual(results.sort(), ['accepted', 'stale']);
    assert.equal(onlyRow(subscriptions.rows).attemptGeneration, 2);
  });

  it('converges concurrent different generations on the higher attempt', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    await registrationStore.createSubscription(record(1));
    await Promise.all([
      updateSubscription(registrationStore, record(2), 'credential-1'),
      updateSubscription(registrationStore, record(3), 'credential-1'),
    ]);

    assert.equal(onlyRow(subscriptions.rows).attemptGeneration, 3);
    assert.equal(onlyRow(subscriptions.rows).credentialHash, 'credential-1');
  });

  it('keeps FCM one-argument cleanup unchanged', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const current = record(1);
    await registrationStore.createSubscription(current);

    assert.equal(
      await registrationStore.removeIfDeviceTokenMatches({
        deviceToken: current.deviceToken,
        installationId: current.installationId,
      }),
      'removed',
    );
    assert.equal(subscriptions.rows.size, 0);
  });

  it('removes an older matching registration after APNs invalidation', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const current = record(1);
    await registrationStore.createSubscription(current);

    assert.equal(
      await registrationStore.removeIfDeviceTokenMatches(
        {
          deviceToken: current.deviceToken,
          installationId: current.installationId,
        },
        new Date('2026-07-24T05:00:02.000Z'),
      ),
      'removed',
    );
    assert.equal(subscriptions.rows.size, 0);
  });

  it('preserves a newer same-token registration after APNs invalidation', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const original = record(1);
    await registrationStore.createSubscription(original);
    await updateSubscription(
      registrationStore,
      { ...record(2), deviceToken: original.deviceToken },
      'credential-1',
    );

    assert.equal(
      await registrationStore.removeIfDeviceTokenMatches(
        {
          deviceToken: original.deviceToken,
          installationId: original.installationId,
        },
        new Date('2026-07-24T05:00:01.500Z'),
      ),
      'token-replaced',
    );
    assert.equal(onlyRow(subscriptions.rows).deviceToken, original.deviceToken);
  });

  for (const [name, registeredAt] of [
    ['missing', undefined],
    ['invalid', new Date('invalid')],
  ] as const) {
    it(`preserves a ${name} APNs registration timestamp`, async () => {
      let deletions = 0;
      const registrationStore = createTableReminderSubscriptionStore(
        subscriptionTable({
          delete: async () => {
            deletions += 1;
          },
          get: async () => ({
            attemptGeneration: 1,
            deviceToken: validRegistration.deviceToken,
            etag: 'etag',
            partitionKey: 'subscriptions-v1',
            ...(registeredAt === undefined ? {} : { registeredAt }),
            rowKey: 'installation-id',
          }),
        }),
        unusedThrottleTable(),
      );

      assert.equal(
        await registrationStore.removeIfDeviceTokenMatches(
          {
            deviceToken: validRegistration.deviceToken,
            installationId: 'installation-id',
          },
          new Date('2026-07-24T05:00:02.000Z'),
        ),
        'token-replaced',
      );
      assert.equal(deletions, 0);
    });
  }

  it('reports missing and rotated subscriptions without deleting them', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const older = record(1);
    const replacement = record(2);

    assert.equal(
      await registrationStore.removeIfDeviceTokenMatches({
        deviceToken: older.deviceToken,
        installationId: older.installationId,
      }),
      'not-found',
    );
    await registrationStore.createSubscription(older);
    await updateSubscription(registrationStore, replacement, 'credential-1');
    assert.equal(
      await registrationStore.removeIfDeviceTokenMatches({
        deviceToken: older.deviceToken,
        installationId: older.installationId,
      }),
      'token-replaced',
    );
    assert.equal(
      onlyRow(subscriptions.rows).deviceToken,
      replacement.deviceToken,
    );
  });

  it('preserves a token rotated between lookup and conditional deletion', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const older = record(1);
    const replacement = record(2);
    await registrationStore.createSubscription(older);
    subscriptions.setBeforeDelete(async () => {
      subscriptions.setBeforeDelete(undefined);
      await updateSubscription(registrationStore, replacement, 'credential-1');
    });

    assert.equal(
      await registrationStore.removeIfDeviceTokenMatches({
        deviceToken: older.deviceToken,
        installationId: older.installationId,
      }),
      'token-replaced',
    );
    assert.equal(
      onlyRow(subscriptions.rows).deviceToken,
      replacement.deviceToken,
    );
  });

  it('bounds conditional deletion contention', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const current = record(1);
    await registrationStore.createSubscription(current);
    let deleteAttempts = 0;
    subscriptions.setBeforeDelete(async () => {
      deleteAttempts += 1;
      throw azureError(412);
    });

    await assert.rejects(
      registrationStore.removeIfDeviceTokenMatches({
        deviceToken: current.deviceToken,
        installationId: current.installationId,
      }),
      /Subscription removal contention exceeded retry limit/,
    );
    assert.equal(deleteAttempts, 12);
    assert.equal(onlyRow(subscriptions.rows).deviceToken, current.deviceToken);
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
