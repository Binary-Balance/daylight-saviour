import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TableClient } from '@azure/data-tables';
import { ManagedIdentityCredential } from '@azure/identity';

import {
  checkInReminderSubscription,
  createAzureReminderSubscriptionStore,
  createReminderSubscriptionCheckInHandler,
  createReminderSubscriptionDeleteHandler,
  createReminderSubscriptionHandler,
  createReminderSubscriptionUpdateHandler,
  createTableReminderSubscriptionStore,
  deleteReminderSubscription,
  deriveInstallationId,
  hashOpaqueValue,
  normalizeClientAddress,
  registerReminderSubscription,
  reminderSubscriptionCheckInOptions,
  reminderSubscriptionDeleteOptions,
  reminderSubscriptionOptions,
  reminderSubscriptionUpdateOptions,
  updateReminderSubscription,
  type ReminderSubscriptionStore,
} from './reminder-subscriptions.ts';

const validRegistration = {
  attemptGeneration: 1,
  deviceToken: 'fcm-token:with_valid.characters-123',
  homeTimeZone: 'Australia/Sydney',
  oneDayEnabled: true,
  oneWeekEnabled: true,
  platform: 'android' as const,
  registrationRequestId: `v2.${String(Date.now()).padStart(13, '0')}.${'a'.repeat(64)}`,
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
    readonly contentType?: string | null;
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
  const headers = new Headers();
  if (contentType !== null) headers.set('content-type', contentType);
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
    checkInSubscription: async () => 'accepted',
    createSubscription: async () => 'accepted',
    deleteSubscription: async () => 'deleted',
    getSubscription: async () => null,
    getSubscriptionSnapshot: async () => null,
    listZoneSubscriptionPages: async function* () {
      // Handler tests never list a zone.
    },
    purgeExpiredRetiredSubscriptions: async () => undefined,
    purgeExpiredThrottleRecords: async () => undefined,
    removeIfDeviceTokenMatches: async () => 'not-found',
    removeIfDeviceTokenAndGenerationMatches: async () => 'not-found',
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
      readonly deviceToken?: string;
      readonly etag: string;
      readonly homeTimeZone?: string;
      readonly lastContactAt?: Date;
      readonly oneDayEnabled?: boolean;
      readonly oneWeekEnabled?: boolean;
      readonly partitionKey: string;
      readonly platform?: 'android' | 'ios';
      readonly registeredAt?: Date;
      readonly retiredAt?: Date;
      readonly rowKey: string;
      readonly state?: 'retired';
    }>;
    readonly listRetiredExpired: (now: Date) => AsyncIterable<{
      readonly attemptGeneration: number;
      readonly etag: string;
      readonly partitionKey: string;
      readonly retiredAt?: Date;
      readonly rowKey: string;
      readonly state?: 'retired';
    }>;
    readonly merge: (
      entity: Record<string, unknown>,
      etag: string,
    ) => Promise<void>;
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
    listRetiredExpired: () =>
      (async function* () {
        // Subscription-only tests never enumerate retired rows.
      })(),
    listZonePages: async function* () {
      // Subscription-only tests never list a zone.
    },
    merge: async () => undefined,
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
    assert.equal(saved?.lastContactAt, now);
    assert.equal(saved?.attemptGeneration, 1);
    assert.equal('registrationRequestId' in (saved ?? {}), false);
    assert.equal(new Headers(result.headers).get('Cache-Control'), 'no-store');
  });

  for (const [name, input, options, status, message] of [
    [
      'JSON prefix media type',
      validRegistration,
      { contentType: 'application/jsonp' },
      415,
      'Expected application/json',
    ],
    [
      'JSON media type parameters',
      validRegistration,
      { contentType: 'application/json; charset=utf-8' },
      415,
      'Expected application/json',
    ],
    [
      'a missing media type',
      validRegistration,
      { contentType: null },
      415,
      'Expected application/json',
    ],
    ['malformed JSON', '{', {}, 400, 'Invalid registration request'],
    [
      'arbitrary fields',
      { ...validRegistration, arbitrary: true },
      {},
      400,
      'Invalid registration request',
    ],
    [
      'noncanonical zone alias',
      { ...validRegistration, homeTimeZone: 'Australia/ACT' },
      {},
      400,
      'Invalid registration request',
    ],
    [
      'invalid platform token',
      { ...validRegistration, deviceToken: ' '.repeat(32) },
      {},
      400,
      'Invalid registration request',
    ],
    [
      'oversized declared body',
      validRegistration,
      { contentLength: '8193' },
      413,
      'Request too large',
    ],
    [
      'invalid declared body length',
      validRegistration,
      { contentLength: 'unknown' },
      400,
      'Invalid Content-Length',
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
      assert.deepEqual(result.jsonBody, { error: message });
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

  // Trailing whitespace is valid JSON, so padding reaches the limit exactly.
  for (const [name, options] of [
    ['declares', { contentLength: '8192' }],
    ['streams', {}],
  ] as const) {
    it(`accepts a body that ${name} exactly the byte limit`, async () => {
      const result = await registerReminderSubscription(
        request(JSON.stringify(validRegistration).padEnd(8192), options),
        store(),
      );
      assert.equal(result.status, 201);
    });
  }

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

  it('returns definitive expiry for an absent or retired request identity', async () => {
    const result = await registerReminderSubscription(
      request(validRegistration),
      store({ createSubscription: async () => 'expired' }),
    );
    assert.equal(result.status, 410);
    assert.deepEqual(result.jsonBody, {
      error: 'Registration request expired',
    });
  });

  it('reports a conflicting registration as unavailable', async () => {
    const result = await registerReminderSubscription(
      request(validRegistration),
      store({ createSubscription: async () => 'conflict' }),
    );
    assert.equal(result.status, 409);
    assert.deepEqual(result.jsonBody, { error: 'Registration unavailable' });
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

  it('stores the update it read from the request', async () => {
    const now = new Date('2026-07-24T05:00:00.000Z');
    let received:
      | Parameters<ReminderSubscriptionStore['updateSubscription']>[0]
      | undefined;
    await updateReminderSubscription(
      request(update, { authorization: `Bearer ${credential}` }),
      store({
        updateSubscription: async (record) => {
          received = record;
          return 'accepted';
        },
      }),
      installationId,
      now,
    );

    assert.equal(received?.attemptGeneration, update.attemptGeneration);
    assert.equal(received?.deviceToken, update.deviceToken);
    assert.equal(received?.homeTimeZone, update.homeTimeZone);
    assert.equal(received?.oneDayEnabled, update.oneDayEnabled);
    assert.equal(received?.oneWeekEnabled, update.oneWeekEnabled);
    assert.equal(received?.platform, update.platform);
    assert.equal(received?.lastContactAt, now);
  });

  it('rejects an update that is not JSON or not a supported zone', async () => {
    const authorization = `Bearer ${credential}`;

    assert.equal(
      (
        await updateReminderSubscription(
          request(update, { authorization, contentType: 'text/plain' }),
          store(),
          installationId,
        )
      ).status,
      415,
    );
    for (const body of ['not json', { ...update, homeTimeZone: 'Mars/Base' }]) {
      assert.equal(
        (
          await updateReminderSubscription(
            request(body, { authorization }),
            store(),
            installationId,
          )
        ).status,
        400,
      );
    }
  });

  it('rejects an update with no media type', async () => {
    const result = await updateReminderSubscription(
      request(update, {
        authorization: `Bearer ${credential}`,
        contentType: null,
      }),
      store(),
      installationId,
    );
    assert.equal(result.status, 415);
    assert.deepEqual(result.jsonBody, { error: 'Expected application/json' });
  });

  it('routes an update through its handler to the requested installation', async () => {
    let target: string | undefined;
    const result = await createReminderSubscriptionUpdateHandler(() =>
      store({
        updateSubscription: async (record) => {
          target = record.installationId;
          return 'accepted';
        },
      }),
    )(
      Object.assign(
        request(update, { authorization: `Bearer ${credential}` }),
        { params: { installationId } },
      ),
    );

    assert.equal(result.status, 204);
    assert.equal(target, installationId);
  });

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

describe('reminder subscription deletion', () => {
  const installationId = 'i'.repeat(43);
  const credential = 'c'.repeat(43);

  it('accepts an authenticated empty-body delete without returning secrets', async () => {
    let received:
      | { readonly credentialHash: string; readonly installationId: string }
      | undefined;
    const result = await deleteReminderSubscription(
      request('', { authorization: `Bearer ${credential}` }),
      store({
        deleteSubscription: async (target, credentialHash) => {
          received = { credentialHash, installationId: target };
          return 'deleted';
        },
      }),
      installationId,
    );
    assert.equal(result.status, 204);
    assert.deepEqual(received, {
      credentialHash: hashOpaqueValue(credential),
      installationId,
    });
    assert.doesNotMatch(JSON.stringify(result), /credential|token/i);
  });

  it('rejects a non-empty deletion body before persistence', async () => {
    let deletions = 0;
    const result = await deleteReminderSubscription(
      request({ unexpected: true }, { authorization: `Bearer ${credential}` }),
      store({ deleteSubscription: async () => ((deletions += 1), 'deleted') }),
      installationId,
    );
    assert.equal(result.status, 400);
    assert.equal(deletions, 0);
  });

  for (const outcome of ['not-found', 'unauthorized'] as const) {
    it(`returns the same empty response for ${outcome} deletion`, async () => {
      const result = await deleteReminderSubscription(
        request('', { authorization: `Bearer ${credential}` }),
        store({ deleteSubscription: async () => outcome }),
        installationId,
      );
      assert.equal(result.status, 204);
      assert.equal(result.jsonBody, undefined);
    });
  }

  for (const authorization of [
    undefined,
    'Bearer short',
    `Basic ${credential}`,
  ]) {
    it(`rejects malformed deletion authorization ${String(authorization)}`, async () => {
      let deletions = 0;
      const result = await deleteReminderSubscription(
        request('', { authorization }),
        store({
          deleteSubscription: async () => ((deletions += 1), 'deleted'),
        }),
        installationId,
      );
      assert.equal(result.status, 401);
      assert.equal(deletions, 0);
    });
  }

  it('retires the installation at the time of the request', async () => {
    const now = new Date('2026-07-24T05:00:00.000Z');
    let retiredAt: Date | undefined;
    await deleteReminderSubscription(
      request('', { authorization: `Bearer ${credential}` }),
      store({
        deleteSubscription: async (_target, _credentialHash, at) => {
          retiredAt = at;
          return 'deleted';
        },
      }),
      installationId,
      now,
    );
    assert.equal(retiredAt, now);
  });

  // A client with nothing to send may declare no length, a zero length, or
  // give the runtime no body to read.
  const authorization = `Bearer ${credential}`;
  for (const [name, makeRequest] of [
    [
      'declares an empty body',
      () => request('', { authorization, contentLength: '0' }),
    ],
    [
      'has no body at all',
      () => Object.assign(request('', { authorization }), { body: null }),
    ],
  ] as const) {
    it(`accepts a deletion that ${name}`, async () => {
      const result = await deleteReminderSubscription(
        makeRequest(),
        store(),
        installationId,
      );
      assert.equal(result.status, 204);
    });
  }

  it('reports a coarse failure when the store fails', async () => {
    const result = await deleteReminderSubscription(
      request('', { authorization: `Bearer ${credential}` }),
      store({
        deleteSubscription: async () => {
          throw azureError(500);
        },
      }),
      installationId,
    );
    assert.equal(result.status, 503);
    assert.deepEqual(result.jsonBody, { error: 'Registration unavailable' });
  });

  for (const [name, overrides] of [
    ['source', { takeSourceAllowance: async () => false }],
    ['installation', { takeInstallationAllowance: async () => false }],
  ] as const) {
    it(`throttles a deletion by ${name} before touching the subscription`, async () => {
      let deletions = 0;
      const result = await deleteReminderSubscription(
        request('', { authorization: `Bearer ${credential}` }),
        store({
          ...overrides,
          deleteSubscription: async () => ((deletions += 1), 'deleted'),
        }),
        installationId,
      );
      assert.equal(result.status, 429);
      assert.deepEqual(result.jsonBody, { error: 'Try again later' });
      assert.equal(new Headers(result.headers).get('Retry-After'), '600');
      assert.equal(deletions, 0);
    });
  }
});

describe('request body handling', () => {
  const installationId = 'i'.repeat(43);
  const authorization = `Bearer ${'c'.repeat(43)}`;
  const endpoints = [
    [
      'registration',
      (candidate: never) => registerReminderSubscription(candidate, store()),
    ],
    [
      'update',
      (candidate: never) =>
        updateReminderSubscription(candidate, store(), installationId),
    ],
    [
      'deletion',
      (candidate: never) =>
        deleteReminderSubscription(candidate, store(), installationId),
    ],
  ] as const;
  // Every endpoint reads its body the same way, so each fault is sent to all
  // three. The default store would accept a request that got past the check.
  const faults = [
    [
      'a negative declared length',
      () => request('', { authorization, contentLength: '-1' }),
      400,
      'Invalid Content-Length',
    ],
    [
      'an unparseable declared length',
      () => request('', { authorization, contentLength: 'unknown' }),
      400,
      'Invalid Content-Length',
    ],
    [
      'an oversized declared length',
      () => request('', { authorization, contentLength: '8193' }),
      413,
      'Request too large',
    ],
    [
      'an oversized stream',
      () => request(new Uint8Array(8193), { authorization }),
      413,
      'Request too large',
    ],
    [
      'bytes that are not UTF-8',
      () => request(new Uint8Array([0xff]), { authorization }),
      400,
      'Invalid request body',
    ],
    [
      'a chunk that is not bytes',
      () =>
        Object.assign(request('', { authorization }), {
          body: new ReadableStream({
            start(controller) {
              controller.enqueue('text');
              controller.close();
            },
          }),
        }),
      400,
      'Invalid request body',
    ],
  ] as const;

  for (const [endpoint, send] of endpoints) {
    for (const [fault, makeRequest, status, message] of faults) {
      it(`${endpoint} rejects ${fault}`, async () => {
        const result = await send(makeRequest());
        assert.equal(result.status, status);
        assert.deepEqual(result.jsonBody, { error: message });
      });
    }
  }
});

describe('reminder subscription delete handler', () => {
  const installationId = 'i'.repeat(43);
  const deletion = () =>
    Object.assign(request('', { authorization: `Bearer ${'c'.repeat(43)}` }), {
      params: { installationId },
    });

  it('routes a deletion to the requested installation', async () => {
    let target: string | undefined;
    const result = await createReminderSubscriptionDeleteHandler(() =>
      store({
        deleteSubscription: async (selectedInstallationId) => {
          target = selectedInstallationId;
          return 'deleted';
        },
      }),
    )(deletion());

    assert.equal(result.status, 204);
    assert.equal(target, installationId);
  });

  it('reports a coarse failure when its store is unavailable', async () => {
    const result = await createReminderSubscriptionDeleteHandler(() => {
      throw new Error('store unavailable');
    })(deletion());

    assert.equal(result.status, 503);
  });
});

describe('reminder subscription check-in', () => {
  const installationId = 'i'.repeat(43);
  const credential = 'c'.repeat(43);
  const authorization = `Bearer ${credential}`;
  const now = new Date('2026-07-24T05:00:00.000Z');

  it('records contact for the authenticated installation without returning secrets', async () => {
    let received:
      | {
          readonly contactAt: Date;
          readonly credentialHash: string;
          readonly installationId: string;
        }
      | undefined;
    const result = await checkInReminderSubscription(
      request('', { authorization }),
      store({
        checkInSubscription: async (target, credentialHash, contactAt) => {
          received = { contactAt, credentialHash, installationId: target };
          return 'accepted';
        },
      }),
      installationId,
      now,
    );
    assert.equal(result.status, 204);
    assert.equal(result.jsonBody, undefined);
    assert.equal(new Headers(result.headers).get('Cache-Control'), 'no-store');
    assert.deepEqual(received, {
      contactAt: now,
      credentialHash: hashOpaqueValue(credential),
      installationId,
    });
    assert.doesNotMatch(JSON.stringify(result), /credential|token/i);
  });

  it('reads nothing from the request body', async () => {
    let checkIns = 0;
    const result = await checkInReminderSubscription(
      request(
        { homeTimeZone: 'Australia/Perth' },
        { authorization, contentType: 'text/plain' },
      ),
      store({ checkInSubscription: async () => ((checkIns += 1), 'accepted') }),
      installationId,
      now,
    );
    assert.equal(result.status, 204);
    assert.equal(checkIns, 1);
  });

  for (const unusable of [
    undefined,
    'Bearer short',
    `Basic ${credential}`,
  ] as const) {
    it(`rejects ${String(unusable)} without recording contact`, async () => {
      let checkIns = 0;
      const result = await checkInReminderSubscription(
        request('', { authorization: unusable }),
        store({
          checkInSubscription: async () => ((checkIns += 1), 'accepted'),
        }),
        installationId,
        now,
      );
      assert.equal(result.status, 401);
      assert.deepEqual(result.jsonBody, { error: 'Unauthorized' });
      assert.equal(checkIns, 0);
    });
  }

  for (const target of [undefined, 'short', `${'i'.repeat(42)}!`] as const) {
    it(`rejects installation ${String(target)} without recording contact`, async () => {
      let checkIns = 0;
      const result = await checkInReminderSubscription(
        request('', { authorization }),
        store({
          checkInSubscription: async () => ((checkIns += 1), 'accepted'),
        }),
        target,
        now,
      );
      assert.equal(result.status, 401);
      assert.equal(checkIns, 0);
    });
  }

  it('reports a wrong credential as unauthorized, without secrets', async () => {
    const result = await checkInReminderSubscription(
      request('', { authorization }),
      store({ checkInSubscription: async () => 'unauthorized' }),
      installationId,
      now,
    );
    assert.equal(result.status, 401);
    assert.deepEqual(result.jsonBody, { error: 'Unauthorized' });
    assert.doesNotMatch(JSON.stringify(result), /c{43}/);
  });

  // The app clears its registration only on this exact response.
  it('reports a removed installation as unavailable', async () => {
    const result = await checkInReminderSubscription(
      request('', { authorization }),
      store({ checkInSubscription: async () => 'not-found' }),
      installationId,
      now,
    );
    assert.equal(result.status, 404);
    assert.deepEqual(result.jsonBody, { error: 'Registration unavailable' });
    assert.equal(new Headers(result.headers).get('Cache-Control'), 'no-store');
  });

  it('takes the source and installation allowances before checking the credential', async () => {
    const calls: unknown[] = [];
    await checkInReminderSubscription(
      request('', { authorization }),
      store({
        checkInSubscription: async () => {
          calls.push('check-in');
          return 'accepted';
        },
        takeInstallationAllowance: async (target, at) => {
          calls.push(['installation', target, at]);
          return true;
        },
        takeSourceAllowance: async (sourceHash, at) => {
          calls.push(['source', sourceHash, at]);
          return true;
        },
      }),
      installationId,
      now,
    );
    assert.deepEqual(calls, [
      ['source', hashOpaqueValue('198.51.100.7'), now],
      ['installation', installationId, now],
      'check-in',
    ]);
  });

  it('throttles check-in source and installation attempts before credential lookup', async () => {
    let checkIns = 0;
    const checkInSubscription = async () => {
      checkIns += 1;
      return 'accepted' as const;
    };
    const sourceLimited = await checkInReminderSubscription(
      request('', { authorization }),
      store({ checkInSubscription, takeSourceAllowance: async () => false }),
      installationId,
      now,
    );
    const installationLimited = await checkInReminderSubscription(
      request('', { authorization }),
      store({
        checkInSubscription,
        takeInstallationAllowance: async () => false,
      }),
      installationId,
      now,
    );
    for (const limited of [sourceLimited, installationLimited]) {
      assert.equal(limited.status, 429);
      assert.deepEqual(limited.jsonBody, { error: 'Try again later' });
      assert.equal(new Headers(limited.headers).get('Retry-After'), '600');
    }
    assert.equal(checkIns, 0);
  });

  it('does not spend the installation allowance when the source is refused', async () => {
    let installationAllowances = 0;
    await checkInReminderSubscription(
      request('', { authorization }),
      store({
        takeInstallationAllowance: async () => (
          (installationAllowances += 1),
          true
        ),
        takeSourceAllowance: async () => false,
      }),
      installationId,
      now,
    );
    assert.equal(installationAllowances, 0);
  });

  it('fails closed when a check-in has no trusted source address', async () => {
    let checkIns = 0;
    const result = await checkInReminderSubscription(
      request('', { authorization, source: null }),
      store({ checkInSubscription: async () => ((checkIns += 1), 'accepted') }),
      installationId,
      now,
    );
    assert.equal(result.status, 503);
    assert.deepEqual(result.jsonBody, { error: 'Registration unavailable' });
    assert.equal(checkIns, 0);
  });

  it('keeps a storage failure coarse', async () => {
    const result = await checkInReminderSubscription(
      request('', { authorization }),
      store({
        checkInSubscription: async () => {
          throw azureError(500);
        },
      }),
      installationId,
      now,
    );
    assert.equal(result.status, 503);
    assert.deepEqual(result.jsonBody, { error: 'Registration unavailable' });
  });
});

describe('reminder subscription check-in handler', () => {
  const installationId = 'i'.repeat(43);
  const checkIn = () =>
    Object.assign(request('', { authorization: `Bearer ${'c'.repeat(43)}` }), {
      params: { installationId },
    });

  it('routes a check-in to the requested installation', async () => {
    let target: string | undefined;
    const result = await createReminderSubscriptionCheckInHandler(() =>
      store({
        checkInSubscription: async (selectedInstallationId) => {
          target = selectedInstallationId;
          return 'accepted';
        },
      }),
    )(checkIn());

    assert.equal(result.status, 204);
    assert.equal(target, installationId);
  });

  it('reports a coarse failure when its store is unavailable', async () => {
    const result = await createReminderSubscriptionCheckInHandler(() => {
      throw new Error('store unavailable');
    })(checkIn());

    assert.equal(result.status, 503);
    assert.deepEqual(result.jsonBody, { error: 'Registration unavailable' });
  });
});

describe('reminder subscription routes', () => {
  // The app builds these URLs, so a change here is a change to the contract.
  it('puts check-in beside update and delete under the installation', () => {
    assert.deepEqual(
      [
        reminderSubscriptionOptions,
        reminderSubscriptionUpdateOptions,
        reminderSubscriptionDeleteOptions,
        reminderSubscriptionCheckInOptions,
      ].map(({ authLevel, methods, route }) => [authLevel, methods, route]),
      [
        ['anonymous', ['POST'], 'reminder-subscriptions'],
        ['anonymous', ['PUT'], 'reminder-subscriptions/{installationId}'],
        ['anonymous', ['DELETE'], 'reminder-subscriptions/{installationId}'],
        [
          'anonymous',
          ['POST'],
          'reminder-subscriptions/{installationId}/check-in',
        ],
      ],
    );
  });
});

describe('Azure Table mapping', () => {
  it('uses real clients with the managed identity by default', async (t) => {
    const clients: TableClient[] = [];
    // Keeps the real client from reaching the network.
    const offline = async function (this: TableClient) {
      clients.push(this);
      throw new Error('no network in tests');
    };
    t.mock.method(TableClient.prototype, 'getEntity', offline);
    t.mock.method(TableClient.prototype, 'createEntity', offline);

    await assert.rejects(
      createAzureReminderSubscriptionStore({
        REMINDER_MANAGED_IDENTITY_CLIENT_ID: 'runtime-uami-client-id',
        REMINDER_STORAGE_ACCOUNT_NAME: 'dlsvstorage',
      }).takeSourceAllowance(hashOpaqueValue('source'), new Date()),
      /no network in tests/,
    );

    const [client] = clients;
    assert.ok(client);
    assert.equal(client.tableName, 'ReminderRegistrationThrottle');
    assert.equal(client.url, 'https://dlsvstorage.table.core.windows.net');
    const credential = Reflect.get(client, 'credential');
    assert.ok(credential instanceof ManagedIdentityCredential);
    assert.equal(Reflect.get(credential, 'clientId'), 'runtime-uami-client-id');
  });

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

  it('queries retired markers only after the 30-day operational retention window', async () => {
    let retiredFilter = '';
    const subscriptions = {
      deleteEntity: async () => undefined,
      getEntity: async () => {
        throw azureError(404);
      },
      listEntities: (options: {
        readonly queryOptions?: { readonly filter?: unknown };
      }) => {
        retiredFilter = String(options.queryOptions?.filter);
        return (async function* () {
          // No expired rows.
        })();
      },
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
    await tableStore.purgeExpiredRetiredSubscriptions(
      new Date('2026-09-07T02:00:00.000Z'),
    );
    assert.match(retiredFilter, /state eq 'retired'/);
    assert.match(retiredFilter, /2026-08-08/);
  });

  it('lists a zone as pages of valid snapshots, without its retired rows', async () => {
    const zone = 'Australia/Sydney';
    const row = {
      attemptGeneration: 3,
      credentialHash: 'hash',
      deviceToken: 'device-token',
      etag: 'etag',
      homeTimeZone: zone,
      lastContactAt: new Date('2026-08-02T00:00:00.000Z'),
      oneDayEnabled: true,
      oneWeekEnabled: false,
      partitionKey: 'subscriptions-v1',
      platform: 'ios',
      registeredAt: new Date('2026-08-01T00:00:00.000Z'),
      rowKey: 'first',
    };
    let filter = '';
    let pageSize: number | undefined;
    const azureStore = createAzureReminderSubscriptionStore(
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
                    yield [
                      row,
                      { ...row, oneDayEnabled: 'yes', rowKey: 'bad' },
                    ];
                    yield [];
                  })();
                },
              };
            },
          }) as never,
      },
    );

    const pages = [];
    for await (const page of azureStore.listZoneSubscriptionPages(zone)) {
      pages.push(page);
    }

    assert.deepEqual(pages, [
      [
        {
          attemptGeneration: 3,
          deviceToken: 'device-token',
          homeTimeZone: zone,
          installationId: 'first',
          lastContactAt: row.lastContactAt,
          oneDayEnabled: true,
          oneWeekEnabled: false,
          platform: 'ios',
          registeredAt: row.registeredAt,
        },
      ],
      [],
    ]);
    assert.equal(
      filter,
      "PartitionKey eq 'subscriptions-v1' and homeTimeZone eq 'Australia/Sydney'",
    );
    assert.equal(pageSize, 100);
  });

  // Dispatch warns on last contact, so a value it cannot read must not reach
  // it as a time.
  it('leaves last contact out of a snapshot when the row has no readable time', async () => {
    const row = {
      attemptGeneration: 3,
      credentialHash: 'hash',
      deviceToken: 'device-token',
      etag: 'etag',
      homeTimeZone: 'Australia/Sydney',
      oneDayEnabled: true,
      oneWeekEnabled: true,
      partitionKey: 'subscriptions-v1',
      platform: 'ios',
    };
    const azureStore = createAzureReminderSubscriptionStore(
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
            listEntities: () => ({
              byPage: () =>
                (async function* () {
                  yield [
                    { ...row, lastContactAt: 'yesterday', rowKey: 'text' },
                    {
                      ...row,
                      lastContactAt: 1_785_000_000_000,
                      rowKey: 'number',
                    },
                    { ...row, rowKey: 'absent' },
                  ];
                })(),
            }),
          }) as never,
      },
    );

    const snapshots = [];
    for await (const page of azureStore.listZoneSubscriptionPages(
      'Australia/Sydney',
    )) {
      snapshots.push(...page);
    }

    assert.deepEqual(
      snapshots.map((snapshot) => [
        snapshot.installationId,
        'lastContactAt' in snapshot,
      ]),
      [
        ['text', false],
        ['number', false],
        ['absent', false],
      ],
    );
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
    await tableStore.createSubscription(
      {
        ...validRegistration,
        credentialHash: 'credential-hash',
        installationId: 'installation-id',
        lastContactAt: new Date('2026-07-24T05:00:00.000Z'),
        registeredAt: new Date('2026-07-24T05:00:00.000Z'),
      },
      validRegistration.registrationRequestId,
    );

    assert.equal(entity?.partitionKey, 'subscriptions-v1');
    assert.doesNotMatch(String(entity?.partitionKey), /[\\/#?]/);
    assert.equal(entity?.homeTimeZone, 'Australia/Sydney');
    assert.deepEqual(
      entity?.lastContactAt,
      new Date('2026-07-24T05:00:00.000Z'),
    );
    assert.equal(entity?.attemptGeneration, 1);
    assert.equal('registrationRequestId' in (entity ?? {}), false);
    assert.equal(entity?.rowKey, 'installation-id');
  });

  it('returns the exact stored Android subscription with its platform', async () => {
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
      platform: 'android',
    });
  });

  it('returns the exact stored iOS subscription with its platform', async () => {
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

    assert.deepEqual(await tableStore.getSubscription('installation-id'), {
      deviceToken: validRegistration.deviceToken,
      installationId: 'installation-id',
      platform: 'ios',
    });
  });

  it('maps a missing subscription to null', async () => {
    const tableStore = createTableReminderSubscriptionStore(
      subscriptionTable(),
      unusedThrottleTable(),
    );

    assert.equal(await tableStore.getSubscription('installation-id'), null);
    assert.equal(
      await tableStore.getSubscriptionSnapshot('installation-id'),
      null,
    );
  });

  it('returns a validated snapshot with dispatch fields', async () => {
    const registeredAt = new Date('2026-07-24T05:00:00.000Z');
    const lastContactAt = new Date('2026-08-24T05:00:00.000Z');
    const tableStore = createTableReminderSubscriptionStore(
      subscriptionTable({
        get: async () => ({
          attemptGeneration: 7,
          deviceToken: validRegistration.deviceToken,
          etag: 'etag',
          homeTimeZone: 'Australia/Sydney',
          lastContactAt,
          oneDayEnabled: true,
          oneWeekEnabled: false,
          partitionKey: 'subscriptions-v1',
          platform: 'android',
          registeredAt,
          rowKey: 'installation-id',
        }),
      }),
      unusedThrottleTable(),
    );

    assert.deepEqual(
      await tableStore.getSubscriptionSnapshot('installation-id'),
      {
        attemptGeneration: 7,
        deviceToken: validRegistration.deviceToken,
        homeTimeZone: 'Australia/Sydney',
        installationId: 'installation-id',
        lastContactAt,
        oneDayEnabled: true,
        oneWeekEnabled: false,
        platform: 'android',
        registeredAt,
      },
    );
  });

  const validSnapshotEntity = {
    attemptGeneration: 7,
    deviceToken: validRegistration.deviceToken,
    etag: 'etag',
    homeTimeZone: 'Australia/Sydney',
    oneDayEnabled: true,
    oneWeekEnabled: true,
    partitionKey: 'subscriptions-v1',
    platform: 'android' as const,
    rowKey: 'installation-id',
  };
  for (const [name, entity] of [
    ['zero generation', { ...validSnapshotEntity, attemptGeneration: 0 }],
    [
      'fractional generation',
      { ...validSnapshotEntity, attemptGeneration: 1.5 },
    ],
    ['invalid platform', { ...validSnapshotEntity, platform: 'web' as never }],
    [
      'noncanonical zone',
      { ...validSnapshotEntity, homeTimeZone: 'Australia/ACT' },
    ],
    [
      'non-boolean preference',
      { ...validSnapshotEntity, oneDayEnabled: 'yes' as never },
    ],
    [
      'both timings disabled',
      { ...validSnapshotEntity, oneDayEnabled: false, oneWeekEnabled: false },
    ],
  ] as const) {
    it(`rejects a snapshot with ${name}`, async () => {
      const tableStore = createTableReminderSubscriptionStore(
        subscriptionTable({ get: async () => entity as never }),
        unusedThrottleTable(),
      );

      assert.equal(
        await tableStore.getSubscriptionSnapshot('installation-id'),
        null,
      );
    });
  }

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

  // Replace mode would drop every column the entity omits, including ones this
  // code does not know about.
  it('checks in by merging only last contact into the row', async () => {
    const writes: unknown[][] = [];
    const subscriptions = {
      getEntity: async () => ({
        attemptGeneration: 1,
        credentialHash: hashOpaqueValue('credential-current'),
        deviceToken: validRegistration.deviceToken,
        etag: 'matching-etag',
      }),
      updateEntity: async (...args: unknown[]) => {
        writes.push(args);
      },
    };
    const azureStore = createAzureReminderSubscriptionStore(
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
    const contactAt = new Date('2026-09-01T00:00:00.000Z');

    assert.equal(
      await azureStore.checkInSubscription(
        'installation-id',
        hashOpaqueValue('credential-current'),
        contactAt,
      ),
      'accepted',
    );
    assert.deepEqual(writes, [
      [
        {
          lastContactAt: contactAt,
          partitionKey: 'subscriptions-v1',
          rowKey: 'installation-id',
        },
        'Merge',
        { etag: 'matching-etag' },
      ],
    ]);
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
    registrationRequestId: string = validRegistration.registrationRequestId,
  ) {
    return {
      attemptGeneration,
      credentialHash,
      deviceToken: `${validRegistration.deviceToken}-${attemptGeneration}`,
      homeTimeZone: validRegistration.homeTimeZone,
      installationId: deriveInstallationId(registrationRequestId),
      // Later than registeredAt, so a store that derived one from the other
      // would be caught.
      lastContactAt: new Date(`2026-07-24T06:00:0${attemptGeneration}.000Z`),
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
    let beforeReplace: (() => Promise<void>) | undefined;
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
          credentialHash:
            typeof row.credentialHash === 'string'
              ? row.credentialHash
              : undefined,
          deviceToken:
            typeof row.deviceToken === 'string' ? row.deviceToken : undefined,
          etag: String(row.etag),
          homeTimeZone:
            typeof row.homeTimeZone === 'string' ? row.homeTimeZone : undefined,
          lastContactAt:
            row.lastContactAt instanceof Date ? row.lastContactAt : undefined,
          oneDayEnabled:
            typeof row.oneDayEnabled === 'boolean'
              ? row.oneDayEnabled
              : undefined,
          oneWeekEnabled:
            typeof row.oneWeekEnabled === 'boolean'
              ? row.oneWeekEnabled
              : undefined,
          partitionKey,
          platform:
            row.platform === 'android' || row.platform === 'ios'
              ? (row.platform as 'android' | 'ios')
              : undefined,
          registeredAt:
            row.registeredAt instanceof Date ? row.registeredAt : undefined,
          retiredAt: row.retiredAt instanceof Date ? row.retiredAt : undefined,
          rowKey,
          state: row.state === 'retired' ? ('retired' as const) : undefined,
        };
      },
      // Azure's Merge mode: columns the entity omits keep their values.
      merge: async (entity: Record<string, unknown>, expectedEtag: string) => {
        await pause();
        // A merge is a write like a replace, so tests race both the same way.
        await beforeReplace?.();
        const key = `${String(entity.partitionKey)}/${String(entity.rowKey)}`;
        const row = rows.get(key);
        if (row === undefined) throw azureError(404);
        if (row.etag !== expectedEtag) throw azureError(412);
        rows.set(key, { ...row, ...entity, etag: String(++nextEtag) });
      },
      replace: async (
        entity: Record<string, unknown>,
        expectedEtag: string,
      ) => {
        await pause();
        await beforeReplace?.();
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
      setBeforeReplace: (callback: (() => Promise<void>) | undefined) => {
        beforeReplace = callback;
      },
      listZonePages: async function* () {
        // Persistence tests never list a zone.
      },
      listRetiredExpired: async function* (now: Date) {
        for (const row of rows.values()) {
          if (
            row.state === 'retired' &&
            row.retiredAt instanceof Date &&
            row.retiredAt < now
          ) {
            yield {
              attemptGeneration: Number(row.attemptGeneration),
              etag: String(row.etag),
              partitionKey: String(row.partitionKey),
              retiredAt: row.retiredAt,
              rowKey: String(row.rowKey),
              state: 'retired' as const,
            };
          }
        }
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
    await registrationStore.createSubscription(
      record(1, 'credential-old'),
      validRegistration.registrationRequestId,
    );
    assert.equal(
      await registrationStore.createSubscription(
        {
          ...record(1, 'credential-new'),
          attemptGeneration: 2,
        },
        validRegistration.registrationRequestId,
      ),
      'accepted',
    );
    assert.equal(onlyRow(subscriptions.rows).attemptGeneration, 2);
    assert.equal(onlyRow(subscriptions.rows).credentialHash, 'credential-new');
    assert.equal(
      await registrationStore.createSubscription(
        {
          ...record(3, 'credential-attacker'),
          deviceToken: 'different-token',
        },
        validRegistration.registrationRequestId,
      ),
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
      await registrationStore.createSubscription(
        record(2),
        validRegistration.registrationRequestId,
      ),
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
      await registrationStore.createSubscription(
        record(1),
        validRegistration.registrationRequestId,
      ),
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
    await registrationStore.createSubscription(
      record(1, 'credential-left'),
      validRegistration.registrationRequestId,
    );
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
    await registrationStore.createSubscription(
      record(1),
      validRegistration.registrationRequestId,
    );
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
    await registrationStore.createSubscription(
      current,
      validRegistration.registrationRequestId,
    );

    assert.equal(
      await registrationStore.removeIfDeviceTokenMatches({
        deviceToken: current.deviceToken,
        installationId: current.installationId,
      }),
      'removed',
    );
    const retired = onlyRow(subscriptions.rows);
    assert.equal(retired.state, 'retired');
    assert.equal('credentialHash' in retired, false);
    assert.equal('deviceToken' in retired, false);
    assert.equal(
      await registrationStore.createSubscription(
        { ...current, attemptGeneration: 2 },
        validRegistration.registrationRequestId,
      ),
      'stale',
    );
  });

  it('deletes only the installation authorised by its current credential', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const current = record(1, 'credential-current');
    await registrationStore.createSubscription(
      current,
      validRegistration.registrationRequestId,
    );

    assert.equal(
      await registrationStore.deleteSubscription(
        current.installationId,
        'credential-stale',
      ),
      'unauthorized',
    );
    assert.equal(subscriptions.rows.size, 1);
    assert.equal(
      await registrationStore.deleteSubscription(
        current.installationId,
        'credential-current',
      ),
      'deleted',
    );
    const retired = onlyRow(subscriptions.rows);
    assert.equal(retired.attemptGeneration, 1);
    assert.equal(retired.partitionKey, 'subscriptions-v1');
    assert.equal(retired.rowKey, current.installationId);
    assert.equal(retired.state, 'retired');
    assert.ok(retired.retiredAt instanceof Date);
    assert.equal('credentialHash' in retired, false);
    assert.equal('deviceToken' in retired, false);
  });

  it('rechecks the credential after a concurrent replacement before deleting', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const current = record(1, 'credential-current');
    await registrationStore.createSubscription(
      current,
      validRegistration.registrationRequestId,
    );
    subscriptions.setBeforeReplace(async () => {
      subscriptions.setBeforeReplace(undefined);
      assert.equal(
        await updateSubscription(
          registrationStore,
          {
            ...record(2, 'credential-current'),
            deviceToken: current.deviceToken,
          },
          'credential-current',
        ),
        'accepted',
      );
    });

    assert.equal(
      await registrationStore.deleteSubscription(
        current.installationId,
        'credential-current',
      ),
      'deleted',
    );
    assert.equal(onlyRow(subscriptions.rows).state, 'retired');
  });

  it('fences a delayed initial POST after deletion with a retired marker', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const current = record(2, 'credential-current');
    await registrationStore.createSubscription(
      current,
      validRegistration.registrationRequestId,
    );
    assert.equal(
      await registrationStore.deleteSubscription(
        current.installationId,
        'credential-current',
        new Date('2026-09-07T02:00:00.000Z'),
      ),
      'deleted',
    );

    assert.equal(
      await registrationStore.createSubscription(
        record(1, 'credential-old'),
        validRegistration.registrationRequestId,
      ),
      'stale',
    );
    const retired = onlyRow(subscriptions.rows);
    assert.equal(retired.state, 'retired');
    assert.equal('credentialHash' in retired, false);
    assert.equal('deviceToken' in retired, false);
  });

  it('rejects expired versioned requests after their marker is purged', async () => {
    const requestId = `v2.1750000000000.${'b'.repeat(64)}`;
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
      () => new Date('2026-09-07T02:00:00.000Z'),
    );
    const current = record(1, 'credential-current', requestId);
    await subscriptions.create({
      ...current,
      partitionKey: 'subscriptions-v1',
      rowKey: current.installationId,
    });
    assert.equal(
      await registrationStore.deleteSubscription(
        current.installationId,
        'credential-current',
        new Date('2026-08-01T00:00:00.000Z'),
      ),
      'deleted',
    );
    await registrationStore.purgeExpiredRetiredSubscriptions(
      new Date('2026-08-15T00:00:00.000Z'),
    );
    assert.equal(subscriptions.rows.size, 1);
    await registrationStore.purgeExpiredRetiredSubscriptions(
      new Date('2026-09-01T00:00:00.000Z'),
    );
    assert.equal(subscriptions.rows.size, 0);
    assert.equal(
      await registrationStore.createSubscription(current, requestId),
      'expired',
    );
  });

  it('purges a marker only once it is more than thirty days old', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const cutoff = Date.parse('2026-08-08T02:00:00.000Z');
    for (const [rowKey, retiredAt] of [
      ['older', cutoff - 1],
      ['exactly-thirty-days', cutoff],
      ['newer', cutoff + 1],
    ] as const) {
      await subscriptions.create({
        attemptGeneration: 1,
        partitionKey: 'subscriptions-v1',
        retiredAt: new Date(retiredAt),
        rowKey,
        state: 'retired',
      });
    }

    await registrationStore.purgeExpiredRetiredSubscriptions(
      new Date('2026-09-07T02:00:00.000Z'),
    );

    assert.deepEqual(
      [...subscriptions.rows.keys()],
      ['subscriptions-v1/exactly-thirty-days', 'subscriptions-v1/newer'],
    );
  });

  it('asks for markers retired before exactly thirty days ago', async () => {
    let cutoff: Date | undefined;
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptionTable({
        listRetiredExpired: (at) => {
          cutoff = at;
          return (async function* () {
            // No markers.
          })();
        },
      }),
      unusedThrottleTable(),
    );

    await registrationStore.purgeExpiredRetiredSubscriptions(
      new Date('2026-09-07T02:00:00.123Z'),
    );

    assert.deepEqual(cutoff, new Date('2026-08-08T02:00:00.123Z'));
  });

  describe('when a marker cannot be deleted', () => {
    // The second of three markers fails to delete with `failure`.
    function purgeWith(failure: unknown) {
      const deletions: (readonly string[])[] = [];
      const registrationStore = createTableReminderSubscriptionStore(
        subscriptionTable({
          delete: async (partitionKey, rowKey, etag) => {
            deletions.push([partitionKey, rowKey, etag]);
            if (rowKey === 'second') throw failure;
          },
          listRetiredExpired: () =>
            (async function* () {
              for (const rowKey of ['first', 'second', 'third']) {
                yield {
                  attemptGeneration: 1,
                  etag: `etag-${rowKey}`,
                  partitionKey: 'subscriptions-v1',
                  retiredAt: new Date('2026-08-01T00:00:00.000Z'),
                  rowKey,
                  state: 'retired' as const,
                };
              }
            })(),
        }),
        unusedThrottleTable(),
      );
      return {
        deletions,
        purge: () =>
          registrationStore.purgeExpiredRetiredSubscriptions(
            new Date('2026-09-07T02:00:00.000Z'),
          ),
      };
    }

    // Gone, changed or no longer matching since it was listed: the next
    // run or another worker has dealt with it.
    for (const status of [404, 409, 412]) {
      it(`goes on to the next marker after a ${status}`, async () => {
        const { deletions, purge } = purgeWith(azureError(status));

        await purge();

        assert.deepEqual(deletions, [
          ['subscriptions-v1', 'first', 'etag-first'],
          ['subscriptions-v1', 'second', 'etag-second'],
          ['subscriptions-v1', 'third', 'etag-third'],
        ]);
      });
    }

    for (const [name, failure] of [
      ['a server error', azureError(500)],
      ['an error with no status', new Error('unreachable')],
    ] as const) {
      it(`stops at ${name}`, async () => {
        const { deletions, purge } = purgeWith(failure);

        await assert.rejects(purge, (error) => error === failure);

        assert.deepEqual(
          deletions.map(([, rowKey]) => rowKey),
          ['first', 'second'],
        );
      });
    }
  });

  it('recovers an active legacy row but never creates an absent legacy row', async () => {
    const legacyRequestId = 'c'.repeat(64);
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const legacy = record(1, 'credential-legacy', legacyRequestId);
    assert.equal(
      await registrationStore.createSubscription(legacy, legacyRequestId),
      'expired',
    );
    await subscriptions.create({
      ...legacy,
      partitionKey: 'subscriptions-v1',
      rowKey: legacy.installationId,
    });
    assert.equal(
      await registrationStore.createSubscription(
        { ...legacy, attemptGeneration: 2 },
        legacyRequestId,
      ),
      'accepted',
    );
    assert.notEqual(
      deriveInstallationId(legacyRequestId),
      deriveInstallationId(validRegistration.registrationRequestId),
    );
  });

  // A versioned request ID carries its issue time. An absent row is created
  // only for an ID issued within the last day, or up to five minutes ahead of
  // this clock to allow for skew.
  const requestClock = new Date('2026-09-07T02:00:00.000Z');
  for (const [name, age, outcome] of [
    ['issued five minutes and a millisecond ahead', -300_001, 'expired'],
    ['issued exactly five minutes ahead', -300_000, 'accepted'],
    ['issued just now', 0, 'accepted'],
    ['issued an hour ago', 3_600_000, 'accepted'],
    ['issued exactly a day ago', 86_400_000, 'accepted'],
    ['issued a day and a millisecond ago', 86_400_001, 'expired'],
  ] as const) {
    it(`${outcome === 'accepted' ? 'creates a row for' : 'will not create a row for'} a request ${name}`, async () => {
      const requestId = `v2.${String(requestClock.getTime() - age).padStart(13, '0')}.${'d'.repeat(64)}`;
      const subscriptions = concurrentSubscriptionTable();
      const registrationStore = createTableReminderSubscriptionStore(
        subscriptions,
        unusedThrottleTable(),
        () => requestClock,
      );

      assert.equal(
        await registrationStore.createSubscription(
          record(1, 'credential-1', requestId),
          requestId,
        ),
        outcome,
      );
      assert.equal(subscriptions.rows.size, outcome === 'accepted' ? 1 : 0);
    });
  }

  // A missing issue time must not be read as zero, which a clock at the epoch
  // would make look fresh.
  for (const [name, at] of [
    ['now', requestClock],
    ['the epoch', new Date(0)],
  ] as const) {
    it(`will not create a row for an unversioned request at ${name}`, async () => {
      const requestId = 'c'.repeat(64);
      const subscriptions = concurrentSubscriptionTable();
      const registrationStore = createTableReminderSubscriptionStore(
        subscriptions,
        unusedThrottleTable(),
        () => at,
      );

      assert.equal(
        await registrationStore.createSubscription(
          record(1, 'credential-1', requestId),
          requestId,
        ),
        'expired',
      );
      assert.equal(subscriptions.rows.size, 0);
    });
  }

  it('stamps last contact when a subscription is registered, replayed and updated', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    await registrationStore.createSubscription(
      record(1),
      validRegistration.registrationRequestId,
    );
    assert.deepEqual(
      onlyRow(subscriptions.rows).lastContactAt,
      record(1).lastContactAt,
    );

    const replay = {
      ...record(1),
      attemptGeneration: 2,
      lastContactAt: new Date('2026-07-25T00:00:00.000Z'),
    };
    assert.equal(
      await registrationStore.createSubscription(
        replay,
        validRegistration.registrationRequestId,
      ),
      'accepted',
    );
    assert.deepEqual(
      onlyRow(subscriptions.rows).lastContactAt,
      replay.lastContactAt,
    );

    assert.equal(
      await updateSubscription(registrationStore, record(3), 'credential-1'),
      'accepted',
    );
    assert.deepEqual(
      onlyRow(subscriptions.rows).lastContactAt,
      record(3).lastContactAt,
    );
  });

  // What a check-in must leave alone: the row's version tag changes on every
  // write, and the contact time is the one thing it may change.
  function withoutContact(row: Record<string, unknown>) {
    const { etag: _etag, lastContactAt: _lastContactAt, ...rest } = row;
    return rest;
  }

  it('checks in by changing only last contact', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const current = record(2, 'credential-current');
    await registrationStore.createSubscription(
      current,
      validRegistration.registrationRequestId,
    );
    const before = { ...onlyRow(subscriptions.rows) };
    const snapshotBefore = await registrationStore.getSubscriptionSnapshot(
      current.installationId,
    );
    const contactAt = new Date('2026-09-01T00:00:00.000Z');

    assert.equal(
      await registrationStore.checkInSubscription(
        current.installationId,
        'credential-current',
        contactAt,
      ),
      'accepted',
    );

    const after = onlyRow(subscriptions.rows);
    assert.deepEqual(withoutContact(after), withoutContact(before));
    assert.deepEqual(after.lastContactAt, contactAt);
    assert.notEqual(after.lastContactAt, before.lastContactAt);
    // Dispatch reads the row too. It sees the new contact time and the same
    // subscription otherwise.
    assert.deepEqual(
      await registrationStore.getSubscriptionSnapshot(current.installationId),
      { ...snapshotBefore, lastContactAt: contactAt },
    );
  });

  it('gives a row written before last contact existed its first contact time', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const { lastContactAt: _absent, ...legacy } = record(1, 'credential-old');
    await subscriptions.create({
      ...legacy,
      partitionKey: 'subscriptions-v1',
      rowKey: legacy.installationId,
    });
    const before = { ...onlyRow(subscriptions.rows) };
    const snapshotBefore = await registrationStore.getSubscriptionSnapshot(
      legacy.installationId,
    );
    assert.equal('lastContactAt' in before, false);
    assert.notEqual(snapshotBefore, null);
    const contactAt = new Date('2026-09-01T00:00:00.000Z');

    assert.equal(
      await registrationStore.checkInSubscription(
        legacy.installationId,
        'credential-old',
        contactAt,
      ),
      'accepted',
    );

    const after = onlyRow(subscriptions.rows);
    assert.deepEqual(withoutContact(after), withoutContact(before));
    assert.deepEqual(after.lastContactAt, contactAt);
    assert.deepEqual(
      await registrationStore.getSubscriptionSnapshot(legacy.installationId),
      { ...snapshotBefore, lastContactAt: contactAt },
    );
  });

  it('rejects a check-in with the wrong credential and leaves the row alone', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const current = record(1, 'credential-current');
    await registrationStore.createSubscription(
      current,
      validRegistration.registrationRequestId,
    );
    const before = { ...onlyRow(subscriptions.rows) };

    assert.equal(
      await registrationStore.checkInSubscription(
        current.installationId,
        'credential-stale',
        new Date('2026-09-01T00:00:00.000Z'),
      ),
      'unauthorized',
    );
    assert.deepEqual(onlyRow(subscriptions.rows), before);
  });

  it('reports a check-in for an absent installation as not found, creating nothing', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );

    assert.equal(
      await registrationStore.checkInSubscription(
        record(1).installationId,
        'credential-1',
        new Date('2026-09-01T00:00:00.000Z'),
      ),
      'not-found',
    );
    assert.equal(subscriptions.rows.size, 0);
  });

  it('reports a retired installation as not found, leaving its marker alone', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const current = record(1, 'credential-current');
    await registrationStore.createSubscription(
      current,
      validRegistration.registrationRequestId,
    );
    await registrationStore.deleteSubscription(
      current.installationId,
      'credential-current',
    );
    const marker = { ...onlyRow(subscriptions.rows) };
    assert.equal(marker.state, 'retired');

    assert.equal(
      await registrationStore.checkInSubscription(
        current.installationId,
        'credential-current',
        new Date('2026-09-01T00:00:00.000Z'),
      ),
      'not-found',
    );
    assert.equal(
      await registrationStore.updateSubscription(
        record(2, 'credential-current'),
        'credential-current',
      ),
      'not-found',
    );
    assert.deepEqual(onlyRow(subscriptions.rows), marker);
  });

  it('keeps a concurrent update when a check-in loses the race to it', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const current = record(1, 'credential-current');
    await registrationStore.createSubscription(
      current,
      validRegistration.registrationRequestId,
    );
    const contactAt = new Date('2026-09-01T00:00:00.000Z');
    subscriptions.setBeforeReplace(async () => {
      subscriptions.setBeforeReplace(undefined);
      assert.equal(
        await updateSubscription(
          registrationStore,
          record(2, 'credential-current'),
          'credential-current',
        ),
        'accepted',
      );
    });

    assert.equal(
      await registrationStore.checkInSubscription(
        current.installationId,
        'credential-current',
        contactAt,
      ),
      'accepted',
    );

    const stored = onlyRow(subscriptions.rows);
    assert.equal(stored.attemptGeneration, 2);
    assert.equal(stored.deviceToken, record(2).deviceToken);
    assert.deepEqual(stored.lastContactAt, contactAt);
  });

  it('bounds check-in contention', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const current = record(1, 'credential-current');
    await registrationStore.createSubscription(
      current,
      validRegistration.registrationRequestId,
    );
    const before = { ...onlyRow(subscriptions.rows) };
    let attempts = 0;
    subscriptions.setBeforeReplace(async () => {
      attempts += 1;
      // Retries that lose their bound must fail this test, not hang it.
      if (attempts > 20) throw new Error('check-in retried without a bound');
      throw azureError(412);
    });

    await assert.rejects(
      registrationStore.checkInSubscription(
        current.installationId,
        'credential-current',
        new Date('2026-09-01T00:00:00.000Z'),
      ),
      /Subscription update contention exceeded retry limit/,
    );
    assert.equal(attempts, 12);
    assert.deepEqual(onlyRow(subscriptions.rows), before);
  });

  it('removes an exact token and generation with conditional cleanup', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const current = record(1);
    await registrationStore.createSubscription(
      current,
      validRegistration.registrationRequestId,
    );

    assert.equal(
      await registrationStore.removeIfDeviceTokenAndGenerationMatches(
        {
          deviceToken: current.deviceToken,
          installationId: current.installationId,
        },
        current.attemptGeneration,
      ),
      'removed',
    );
    const retired = onlyRow(subscriptions.rows);
    assert.equal(retired.state, 'retired');
    assert.equal('credentialHash' in retired, false);
    assert.equal('deviceToken' in retired, false);
    assert.equal(
      await registrationStore.createSubscription(
        { ...current, attemptGeneration: 2 },
        validRegistration.registrationRequestId,
      ),
      'stale',
    );
  });

  it('preserves a newer same-token generation during conditional cleanup', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const original = record(1);
    const replacement = { ...record(2), deviceToken: original.deviceToken };
    await registrationStore.createSubscription(
      original,
      validRegistration.registrationRequestId,
    );
    await updateSubscription(registrationStore, replacement, 'credential-1');

    assert.equal(
      await registrationStore.removeIfDeviceTokenAndGenerationMatches(
        {
          deviceToken: original.deviceToken,
          installationId: original.installationId,
        },
        original.attemptGeneration,
      ),
      'token-replaced',
    );
    assert.equal(onlyRow(subscriptions.rows).attemptGeneration, 2);
  });

  it('preserves a newer same-token generation after a storage CAS race', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const original = record(1);
    const replacement = { ...record(2), deviceToken: original.deviceToken };
    await registrationStore.createSubscription(
      original,
      validRegistration.registrationRequestId,
    );
    subscriptions.setBeforeReplace(async () => {
      subscriptions.setBeforeReplace(undefined);
      assert.equal(
        await updateSubscription(
          registrationStore,
          replacement,
          'credential-1',
        ),
        'accepted',
      );
    });

    assert.equal(
      await registrationStore.removeIfDeviceTokenAndGenerationMatches(
        {
          deviceToken: original.deviceToken,
          installationId: original.installationId,
        },
        original.attemptGeneration,
      ),
      'token-replaced',
    );
    assert.equal(onlyRow(subscriptions.rows).attemptGeneration, 2);
  });

  it('removes an older matching registration after APNs invalidation', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const current = record(1);
    await registrationStore.createSubscription(
      current,
      validRegistration.registrationRequestId,
    );

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
    const retired = onlyRow(subscriptions.rows);
    assert.equal(retired.state, 'retired');
    assert.equal('credentialHash' in retired, false);
    assert.equal('deviceToken' in retired, false);
    assert.equal(
      await registrationStore.createSubscription(
        { ...current, attemptGeneration: 2 },
        validRegistration.registrationRequestId,
      ),
      'stale',
    );
  });

  it('preserves a newer same-token registration after APNs invalidation', async () => {
    const subscriptions = concurrentSubscriptionTable();
    const registrationStore = createTableReminderSubscriptionStore(
      subscriptions,
      unusedThrottleTable(),
    );
    const original = record(1);
    await registrationStore.createSubscription(
      original,
      validRegistration.registrationRequestId,
    );
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
    await registrationStore.createSubscription(
      older,
      validRegistration.registrationRequestId,
    );
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
    await registrationStore.createSubscription(
      older,
      validRegistration.registrationRequestId,
    );
    subscriptions.setBeforeReplace(async () => {
      subscriptions.setBeforeReplace(undefined);
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
    await registrationStore.createSubscription(
      current,
      validRegistration.registrationRequestId,
    );
    let deleteAttempts = 0;
    subscriptions.setBeforeReplace(async () => {
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

  // The first five requests fill a window, from any moment in it to its first
  // and last millisecond. The sixth waits for the next window. A row is kept
  // for thirty days from when its window opened, however late in the window it
  // was made.
  it('counts each ten-minute window apart and expires its row thirty days after the window opens', async () => {
    const throttles = createConcurrentTable();
    const tableStore = createTableReminderSubscriptionStore(
      subscriptionTable(),
      throttles,
    );
    const windowMs = 10 * 60 * 1000;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const windowStart = Date.parse('2026-07-24T05:00:00.000Z');

    const allowed = [];
    for (const offset of [
      123_456,
      0,
      299_999,
      599_998,
      599_999,
      599_999,
      windowMs,
    ]) {
      allowed.push(
        await tableStore.takeSourceAllowance(
          'source-hash',
          new Date(windowStart + offset),
        ),
      );
    }

    assert.deepEqual(allowed, [true, true, true, true, true, false, true]);
    const subject = hashOpaqueValue(
      'daylight-saviour:reminder-source:v1:source-hash',
    );
    const window = windowStart / windowMs;
    assert.deepEqual(
      [...throttles.rows].map(([key, { count, expiresAt }]) => [
        key,
        count,
        expiresAt,
      ]),
      [
        [`${subject}/${window}`, 5, new Date(windowStart + thirtyDaysMs)],
        [
          `${subject}/${window + 1}`,
          1,
          new Date(windowStart + windowMs + thirtyDaysMs),
        ],
      ],
    );
  });

  it('counts a source and an installation apart even when their values match', async () => {
    const throttles = createConcurrentTable();
    const tableStore = createTableReminderSubscriptionStore(
      subscriptionTable(),
      throttles,
    );
    const now = new Date('2026-07-24T05:00:00.000Z');

    await tableStore.takeSourceAllowance('same-value', now);
    await tableStore.takeInstallationAllowance('same-value', now);

    const window = now.getTime() / (10 * 60 * 1000);
    assert.deepEqual(
      [...throttles.rows.keys()],
      [
        `${hashOpaqueValue('daylight-saviour:reminder-source:v1:same-value')}/${window}`,
        `${hashOpaqueValue('daylight-saviour:reminder-installation:v1:same-value')}/${window}`,
      ],
    );
  });

  // Retries that lose their bound must fail these tests, not hang them.
  it('gives up after twelve attempts to create a window that others create first', async () => {
    let reads = 0;
    const throttles = createConcurrentTable();
    const tableStore = createTableReminderSubscriptionStore(
      subscriptionTable(),
      {
        ...throttles,
        create: async () => {
          throw azureError(409);
        },
        get: async (partitionKey, rowKey) => {
          reads += 1;
          if (reads > 20) throw new Error('retried without a bound');
          return throttles.get(partitionKey, rowKey);
        },
      },
    );

    await assert.rejects(
      () =>
        tableStore.takeSourceAllowance(
          'source-hash',
          new Date('2026-07-24T05:00:00.000Z'),
        ),
      /Throttle update contention exceeded retry limit/,
    );
    assert.equal(reads, 12);
  });

  it('gives up after twelve attempts to count a window that others count first', async () => {
    const now = new Date('2026-07-24T05:00:00.000Z');
    let reads = 0;
    const throttles = createConcurrentTable();
    const tableStore = createTableReminderSubscriptionStore(
      subscriptionTable(),
      {
        ...throttles,
        get: async (partitionKey, rowKey) => {
          reads += 1;
          if (reads > 20) throw new Error('retried without a bound');
          return throttles.get(partitionKey, rowKey);
        },
        replace: async () => {
          throw azureError(412);
        },
      },
    );
    await tableStore.takeSourceAllowance('source-hash', now);
    reads = 0;

    await assert.rejects(
      () => tableStore.takeSourceAllowance('source-hash', now),
      /Throttle update contention exceeded retry limit/,
    );
    assert.equal(reads, 12);
  });

  it('spends one installation allowance across updates and check-ins', async () => {
    const tableStore = createTableReminderSubscriptionStore(
      subscriptionTable(),
      createConcurrentTable(),
    );
    const installationId = 'i'.repeat(43);
    const authorization = `Bearer ${'c'.repeat(43)}`;
    const now = new Date('2026-07-24T05:00:00.000Z');
    const update = {
      attemptGeneration: 2,
      deviceToken: validRegistration.deviceToken,
      homeTimeZone: validRegistration.homeTimeZone,
      oneDayEnabled: true,
      oneWeekEnabled: true,
      platform: 'android',
    };

    const statuses: (number | undefined)[] = [];
    for (const [index, kind] of [
      'check-in',
      'update',
      'check-in',
      'update',
      'check-in',
      'check-in',
    ].entries()) {
      // Each request comes from its own address, so only the installation's
      // allowance runs out.
      const source = `198.51.100.${index + 1}`;
      const result =
        kind === 'update'
          ? await updateReminderSubscription(
              request(update, { authorization, source }),
              tableStore,
              installationId,
              now,
            )
          : await checkInReminderSubscription(
              request('', { authorization, source }),
              tableStore,
              installationId,
              now,
            );
      statuses.push(result.status);
    }

    // The table holds no subscription, so an allowed request is a 404.
    assert.deepEqual(statuses, [404, 404, 404, 404, 404, 429]);
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

  it('purges the rows that expired before the given time', async () => {
    let listedAt: Date | undefined;
    const tableStore = createTableReminderSubscriptionStore(
      subscriptionTable(),
      {
        ...createConcurrentTable(),
        listExpired: (at) => {
          listedAt = at;
          return (async function* () {
            // No expired rows.
          })();
        },
      },
    );
    const now = new Date('2026-09-07T02:00:00.123Z');

    await tableStore.purgeExpiredThrottleRecords(now);

    assert.equal(listedAt, now);
  });

  it('stops purging at a failure that is not an already-deleted row', async () => {
    const attempted: string[] = [];
    const failure = azureError(500);
    const tableStore = createTableReminderSubscriptionStore(
      subscriptionTable(),
      {
        ...createConcurrentTable(),
        delete: async (_partitionKey, rowKey) => {
          attempted.push(rowKey);
          if (rowKey === 'second') throw failure;
        },
        listExpired: () =>
          (async function* () {
            for (const rowKey of ['first', 'second', 'third']) {
              yield { count: 1, etag: 'etag', partitionKey: 'source', rowKey };
            }
          })(),
      },
    );

    await assert.rejects(
      () => tableStore.purgeExpiredThrottleRecords(new Date()),
      (error) => error === failure,
    );
    assert.deepEqual(attempted, ['first', 'second']);
  });
});
