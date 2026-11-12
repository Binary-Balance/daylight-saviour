import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { InvocationContext } from '@azure/functions';

import {
  controlledReminderSmokeOptions,
  createControlledReminderSmokeHandler,
  createControlledReminderSmokeRuntime,
  invocationLogger,
  required,
  type ControlledReminderSmokeBoundaries,
} from './controlled-reminder-smoke.ts';
import type {
  ApnsChangeReminderResult,
  ApnsChangeReminderSubscription,
} from './apns-change-reminder-sender.ts';
import type {
  FcmChangeReminderResult,
  FcmChangeReminderSubscription,
  ChangeReminderLifetime,
  ReviewedChangeReminderFacts,
} from './fcm-change-reminder-sender.ts';

const installationId = 'a'.repeat(43);
const sentAt = new Date('2026-07-26T00:00:00.000Z');
const fifteenMinutesAfterSend = {
  expiresAt: new Date('2026-07-26T00:15:00.000Z'),
  kind: 'until',
} as const;
const deviceToken = 'fcm-token:with_valid.characters-123';
const facts = {
  changeDirection: 'forward',
  changeEventAt: '2026-10-04T16:00:00.000Z',
  homeTimeZone: 'Australia/Sydney',
  installationId,
  timing: 'one-week',
} as const;

function rawRequest(
  bytes: Uint8Array,
  options: {
    readonly contentLength?: string;
    readonly contentType?: string;
  } = {},
) {
  const headers = new Headers({
    'content-type': options.contentType ?? 'application/json',
  });
  if (options.contentLength !== undefined) {
    headers.set('content-length', options.contentLength);
  }
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

function streamRequest(body: ReadableStream<Uint8Array>) {
  return {
    body,
    headers: new Headers({ 'content-type': 'application/json' }),
  } as never;
}

function request(
  body: unknown,
  options: {
    readonly contentLength?: string;
    readonly contentType?: string;
  } = {},
) {
  return rawRequest(new TextEncoder().encode(JSON.stringify(body)), options);
}

const entraAssertion = 'sensitive-entra-assertion';
const federatedToken = 'sensitive-federated-token';
const fcmAccessToken = 'sensitive-fcm-access-token';
const providerDetail = 'sensitive provider detail';
const apnsPrivateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();
const fcmEnvironment = {
  FCM_ENTRA_ASSERTION_AUDIENCE: 'api://portable-fcm-audience',
  FCM_PROJECT_ID: 'portable-project',
  FCM_RUNTIME_ENABLED: 'true',
  FCM_SERVICE_ACCOUNT_EMAIL:
    'portable-fcm-sender@portable-project.iam.gserviceaccount.com',
  FCM_TEST_SEND_ENABLED: 'true',
  FCM_WORKLOAD_IDENTITY_PROVIDER:
    '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/portable-pool/providers/azure-runtime',
  REMINDER_MANAGED_IDENTITY_CLIENT_ID: '00000000-0000-4000-8000-000000000000',
};

function fcmAccepted() {
  return Response.json({ name: 'projects/portable-project/messages/1' });
}

function fcmError(
  status: number,
  providerStatus: string,
  details: readonly unknown[] = [],
) {
  return Response.json(
    {
      error: {
        code: status,
        details,
        message: providerDetail,
        status: providerStatus,
      },
    },
    { status },
  );
}

/** Boundaries for the real composition: storage, Entra, Google and APNs. */
function boundaries(
  options: {
    readonly fcmSend?: () => Promise<Response>;
    readonly getToken?: () => Promise<{
      readonly expiresOnTimestamp: number;
      readonly token: string;
    }>;
    readonly platform?: 'android' | 'ios';
    readonly remove?: () => Promise<'removed' | 'not-found' | 'token-replaced'>;
  } = {},
): ControlledReminderSmokeBoundaries {
  return {
    createApnsTransport: () => ({
      post: async () => ({ body: '', status: 200 }),
    }),
    createCredential: () => ({
      getToken:
        options.getToken ??
        (async () => ({
          expiresOnTimestamp: Date.now() + 60 * 60 * 1000,
          token: entraAssertion,
        })),
    }),
    createStore: () => ({
      getSubscription: async () => ({
        deviceToken: options.platform === 'ios' ? 'a'.repeat(64) : deviceToken,
        installationId,
        platform: options.platform ?? 'android',
      }),
      removeIfDeviceTokenMatches: options.remove ?? (async () => 'removed'),
    }),
    fetch: async (input) => {
      const url = String(input);
      if (url.startsWith('https://sts.googleapis.com/')) {
        return Response.json({
          access_token: federatedToken,
          expires_in: 3600,
          issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          token_type: 'Bearer',
        });
      }
      if (url.startsWith('https://iamcredentials.googleapis.com/')) {
        return Response.json({
          accessToken: fcmAccessToken,
          expireTime: new Date(Date.now() + 50 * 60 * 1000).toISOString(),
        });
      }
      return (options.fcmSend ?? (async () => fcmAccepted()))();
    },
  };
}

// Fails a test whose awaited work never settles, instead of letting it hang.
// Seshat treats a hang as an unresolved mutant and withholds the score.
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

function context(events: unknown[] = []) {
  return new InvocationContext({
    logHandler: (_level, ...args) => {
      events.push(...args);
    },
  });
}

function runtime(
  overrides: {
    readonly apnsRuntimeEnabled?: boolean;
    readonly apnsSend?: (
      subscription: ApnsChangeReminderSubscription,
      facts: ReviewedChangeReminderFacts,
      lifetime: ChangeReminderLifetime,
    ) => Promise<ApnsChangeReminderResult>;
    readonly runtimeEnabled?: boolean;
    readonly testSendEnabled?: boolean;
    readonly getSubscription?: (id: string) => Promise<{
      readonly deviceToken: string;
      readonly installationId: string;
      readonly platform: 'android' | 'ios';
    } | null>;
    readonly send?: (
      subscription: FcmChangeReminderSubscription,
      facts: ReviewedChangeReminderFacts,
      lifetime: ChangeReminderLifetime,
    ) => Promise<FcmChangeReminderResult>;
  } = {},
) {
  return () => ({
    apnsRuntimeEnabled: overrides.apnsRuntimeEnabled ?? false,
    ...(overrides.apnsSend === undefined
      ? {}
      : { apnsSender: { send: overrides.apnsSend } }),
    runtimeEnabled: overrides.runtimeEnabled ?? true,
    sender: {
      send: overrides.send ?? (async () => ({ kind: 'accepted' as const })),
    },
    store: {
      getSubscription:
        overrides.getSubscription ??
        (async () => ({ deviceToken, installationId, platform: 'android' })),
    },
    testSendEnabled: overrides.testSendEnabled ?? true,
  });
}

describe('controlled Change Reminder smoke handler', () => {
  it('is a function-key-protected, isolated POST route', () => {
    assert.equal(controlledReminderSmokeOptions.authLevel, 'function');
    assert.deepEqual(controlledReminderSmokeOptions.methods, ['POST']);
    assert.equal(
      controlledReminderSmokeOptions.route,
      'internal/controlled-change-reminder-smoke',
    );
  });

  it('refuses disabled FCM runtime before accessing a subscription', async () => {
    let lookups = 0;
    const result = await createControlledReminderSmokeHandler(
      runtime({
        getSubscription: async () => {
          lookups += 1;
          return null;
        },
        runtimeEnabled: false,
      }),
    )(request(facts), context());

    assert.deepEqual(result, {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { outcome: 'unavailable' },
      status: 503,
    });
    assert.equal(lookups, 0);
  });

  it('refuses a disabled test-send gate before accessing a subscription', async () => {
    let lookups = 0;
    const result = await createControlledReminderSmokeHandler(
      runtime({
        getSubscription: async () => {
          lookups += 1;
          return null;
        },
        testSendEnabled: false,
      }),
    )(request(facts), context());

    assert.deepEqual(result, {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { outcome: 'unavailable' },
      status: 503,
    });
    assert.equal(lookups, 0);
  });

  it('does not activate APNs when the existing test-send gate is disabled', async () => {
    let lookups = 0;
    const result = await createControlledReminderSmokeHandler(
      runtime({
        apnsRuntimeEnabled: true,
        apnsSend: async () => ({ kind: 'accepted' }),
        getSubscription: async () => {
          lookups += 1;
          return null;
        },
        runtimeEnabled: false,
        testSendEnabled: false,
      }),
    )(request(facts), context());

    assert.equal(result.status, 503);
    assert.equal(lookups, 0);
  });

  for (const [name, input, options] of [
    ['extra device token', { ...facts, deviceToken }, {}],
    ['invalid installation ID', { ...facts, installationId: 'bad' }, {}],
    [
      '42-character installation ID',
      { ...facts, installationId: 'a'.repeat(42) },
      {},
    ],
    [
      '44-character installation ID',
      { ...facts, installationId: 'a'.repeat(44) },
      {},
    ],
    ['invalid event instant', { ...facts, changeEventAt: 'not-a-date' }, {}],
    [
      'event instant without milliseconds',
      { ...facts, changeEventAt: '2026-10-04T16:00:00Z' },
      {},
    ],
    [
      'event instant with an offset',
      { ...facts, changeEventAt: '2026-10-04T16:00:00.000+00:00' },
      {},
    ],
    ['unknown change direction', { ...facts, changeDirection: 'sideways' }, {}],
    ['unknown timing', { ...facts, timing: 'one-month' }, {}],
    [
      'time zone outside Australia',
      { ...facts, homeTimeZone: 'Europe/London' },
      {},
    ],
    ['oversized declared body', facts, { contentLength: '1025' }],
    ['negative declared body length', facts, { contentLength: '-1' }],
    ['fractional declared body length', facts, { contentLength: '1.5' }],
    ['non-numeric declared body length', facts, { contentLength: 'abc' }],
  ] as const) {
    it(`rejects ${name} without dispatch`, async () => {
      let sends = 0;
      const result = await createControlledReminderSmokeHandler(
        runtime({
          send: async () => {
            sends += 1;
            return { kind: 'accepted' };
          },
        }),
      )(request(input, options), context());

      assert.equal(result.status, 400);
      assert.equal(sends, 0);
      assert.deepEqual(result.jsonBody, { outcome: 'unavailable' });
    });
  }

  it('returns a fixed outcome when the requested Android registration is absent', async () => {
    const result = await createControlledReminderSmokeHandler(
      runtime({ getSubscription: async () => null }),
    )(request(facts), context());

    assert.deepEqual(result, {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { outcome: 'unavailable' },
      status: 404,
    });
  });

  it('sends reviewed facts to the exact stored Android subscription', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: sentAt });
    let actual:
      | {
          readonly facts: unknown;
          readonly lifetime: unknown;
          readonly subscription: unknown;
        }
      | undefined;
    const result = await createControlledReminderSmokeHandler(
      runtime({
        send: async (subscription, reviewedFacts, lifetime) => {
          actual = { facts: reviewedFacts, lifetime, subscription };
          return { kind: 'accepted' };
        },
      }),
    )(request(facts), context());

    assert.deepEqual(result, {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { outcome: 'accepted' },
      status: 202,
    });
    assert.deepEqual(actual, {
      facts: {
        changeDirection: 'forward',
        changeEventAt: new Date('2026-10-04T16:00:00.000Z'),
        homeTimeZone: 'Australia/Sydney',
        timing: 'one-week',
      },
      lifetime: fifteenMinutesAfterSend,
      subscription: { deviceToken, installationId },
    });
  });

  it('maps a non-accepted sender result to a fixed unavailable outcome', async () => {
    const result = await createControlledReminderSmokeHandler(
      runtime({ send: async () => ({ kind: 'transient-rejection' }) }),
    )(request(facts), context());

    assert.deepEqual(result, {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { outcome: 'unavailable' },
      status: 503,
    });
  });

  it('reuses one successfully composed runtime in a warm worker', async () => {
    let compositions = 0;
    let sends = 0;
    const handler = createControlledReminderSmokeHandler(() => {
      compositions += 1;
      return runtime({
        send: async () => {
          sends += 1;
          return { kind: 'accepted' };
        },
      })();
    });

    assert.equal((await handler(request(facts), context())).status, 202);
    assert.equal((await handler(request(facts), context())).status, 202);
    assert.equal(compositions, 1);
    assert.equal(sends, 2);
  });

  it('routes a stored iOS subscription through the explicitly enabled APNs sender', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: sentAt });
    let sent: unknown;
    const result = await createControlledReminderSmokeHandler(
      runtime({
        apnsRuntimeEnabled: true,
        apnsSend: async (subscription, _facts, lifetime) => {
          sent = { lifetime, subscription };
          return { kind: 'accepted' };
        },
        getSubscription: async () => ({
          deviceToken: 'b'.repeat(64),
          installationId,
          platform: 'ios',
        }),
      }),
    )(request(facts), context());

    assert.equal(result.status, 202);
    assert.deepEqual(sent, {
      lifetime: fifteenMinutesAfterSend,
      subscription: { deviceToken: 'b'.repeat(64), installationId },
    });
  });

  it('reports only a removed APNs Unregistered token with a fixed outcome', async () => {
    const result = await createControlledReminderSmokeHandler(
      runtime({
        apnsRuntimeEnabled: true,
        apnsSend: async () => ({
          cleanupStatus: 'removed',
          invalidatedAt: new Date(0),
          invalidTokenReason: 'unregistered',
          kind: 'permanent-invalid-token',
        }),
        getSubscription: async () => ({
          deviceToken: 'b'.repeat(64),
          installationId,
          platform: 'ios',
        }),
      }),
    )(request(facts), context());

    assert.deepEqual(result, {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { outcome: 'apns-unregistered-token-removed' },
      status: 410,
    });
  });

  it('keeps every other APNs sender result coarse', async () => {
    for (const apnsResult of [
      {
        cleanupStatus: 'token-replaced' as const,
        invalidatedAt: new Date(0),
        invalidTokenReason: 'unregistered' as const,
        kind: 'permanent-invalid-token' as const,
      },
      {
        cleanupStatus: 'failed' as const,
        invalidatedAt: new Date(0),
        invalidTokenReason: 'unregistered' as const,
        kind: 'permanent-invalid-token' as const,
      },
      {
        cleanupStatus: 'removed' as const,
        invalidatedAt: new Date(0),
        kind: 'permanent-invalid-token' as const,
      },
      { kind: 'transient-rejection' as const },
      { kind: 'uncertain' as const },
      { kind: 'malformed-response' as const },
      { kind: 'permanent-rejection' as const },
    ]) {
      const result = await createControlledReminderSmokeHandler(
        runtime({
          apnsRuntimeEnabled: true,
          apnsSend: async () => apnsResult,
          getSubscription: async () => ({
            deviceToken: 'b'.repeat(64),
            installationId,
            platform: 'ios',
          }),
        }),
      )(request(facts), context());

      assert.deepEqual(result, {
        headers: { 'Cache-Control': 'no-store' },
        jsonBody: { outcome: 'unavailable' },
        status: 503,
      });
    }
  });

  it('does not read APNs settings while the APNs gate is disabled', async () => {
    const environment = new Proxy(
      {
        APNS_RUNTIME_ENABLED: 'false',
        FCM_RUNTIME_ENABLED: 'false',
        FCM_TEST_SEND_ENABLED: 'true',
      },
      {
        get(target, key, receiver) {
          if (
            key !== 'APNS_RUNTIME_ENABLED' &&
            String(key).startsWith('APNS_')
          ) {
            throw new Error('APNs setting read while disabled');
          }
          return Reflect.get(target, key, receiver);
        },
      },
    ) as NodeJS.ProcessEnv;
    const result = await createControlledReminderSmokeHandler(() =>
      createControlledReminderSmokeRuntime(environment),
    )(request(facts), context());

    assert.deepEqual(result, {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { outcome: 'unavailable' },
      status: 503,
    });
  });

  it('fails closed for incomplete or invalid enabled APNs configuration', async () => {
    const baseEnvironment = {
      APNS_RUNTIME_ENABLED: 'true',
      FCM_RUNTIME_ENABLED: 'false',
      FCM_TEST_SEND_ENABLED: 'true',
      REMINDER_MANAGED_IDENTITY_CLIENT_ID:
        '00000000-0000-4000-8000-000000000000',
      REMINDER_STORAGE_ACCOUNT_NAME: 'smoketeststore',
    };
    for (const environment of [
      baseEnvironment,
      {
        ...baseEnvironment,
        APNS_ENVIRONMENT: 'sandbox',
        APNS_KEY_ID: 'ABCDE12345',
        APNS_PRIVATE_KEY: 'synthetic-apns-private-key',
        APNS_TEAM_ID: 'ZYXWV98765',
        APNS_TOPIC: 'com.example.app',
      },
    ]) {
      const result = await createControlledReminderSmokeHandler(() =>
        createControlledReminderSmokeRuntime(environment),
      )(request(facts), context());

      assert.deepEqual(result, {
        headers: { 'Cache-Control': 'no-store' },
        jsonBody: { outcome: 'unavailable' },
        status: 503,
      });
      assert.doesNotMatch(
        JSON.stringify(result),
        /APNS|synthetic-apns-private-key/i,
      );
    }
  });

  it('does not expose provider details when delivery fails', async () => {
    const credential = 'short-lived-credential-value';
    const responseBody = 'provider response body';
    const result = await createControlledReminderSmokeHandler(
      runtime({
        send: async () => {
          throw new Error(`${credential}: ${responseBody}`);
        },
      }),
    )(request(facts), context());

    assert.equal(result.status, 503);
    assert.deepEqual(result.jsonBody, { outcome: 'unavailable' });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(credential));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(responseBody));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(deviceToken));
  });

  it('logs a failed invalid-token cleanup without tokens or credentials', async () => {
    const events: unknown[] = [];
    const cleanupDetail = 'sensitive cleanup detail';
    const result = await createControlledReminderSmokeHandler(() =>
      createControlledReminderSmokeRuntime(
        fcmEnvironment,
        boundaries({
          fcmSend: async () =>
            fcmError(404, 'NOT_FOUND', [
              {
                '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                errorCode: 'UNREGISTERED',
              },
            ]),
          remove: async () => {
            throw new Error(cleanupDetail);
          },
        }),
      ),
    )(request(facts), context(events));

    assert.deepEqual(result, {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { outcome: 'unavailable' },
      status: 503,
    });
    assert.deepEqual(events, [
      'fcm-credential-ready',
      'fcm-change-reminder-permanent-invalid-token',
      'fcm-change-reminder-invalid-token-cleanup-failed',
    ]);
    const serialisedEvents = JSON.stringify(events);
    for (const secret of [
      deviceToken,
      installationId,
      entraAssertion,
      federatedToken,
      fcmAccessToken,
      providerDetail,
      cleanupDetail,
    ]) {
      assert.doesNotMatch(serialisedEvents, new RegExp(secret));
    }
  });

  it('distinguishes a credential exchange failure from a provider rejection', async () => {
    const events: unknown[] = [];
    const result = await createControlledReminderSmokeHandler(() =>
      createControlledReminderSmokeRuntime(
        fcmEnvironment,
        boundaries({
          getToken: async () => {
            throw new Error(entraAssertion);
          },
        }),
      ),
    )(request(facts), context(events));

    assert.equal(result.status, 503);
    assert.deepEqual(events, [
      'fcm-credential-entra-denied',
      'fcm-change-reminder-transient-rejection',
    ]);
  });

  it('keeps the delivery result when the invocation logger fails', async () => {
    const result = await createControlledReminderSmokeHandler(() =>
      createControlledReminderSmokeRuntime(fcmEnvironment, boundaries()),
    )(
      request(facts),
      new InvocationContext({
        logHandler: () => {
          throw new Error('logging unavailable');
        },
      }),
    );

    assert.deepEqual(result, {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { outcome: 'accepted' },
      status: 202,
    });
  });

  it('logs APNs sender events to the invocation', async () => {
    const privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    const events: unknown[] = [];
    const result = await createControlledReminderSmokeHandler(() =>
      createControlledReminderSmokeRuntime(
        {
          APNS_ENVIRONMENT: 'sandbox',
          APNS_KEY_ID: 'ABCDE12345',
          APNS_PRIVATE_KEY: privateKey,
          APNS_RUNTIME_ENABLED: 'true',
          APNS_TEAM_ID: 'ZYXWV98765',
          APNS_TOPIC: 'com.example.app',
          FCM_TEST_SEND_ENABLED: 'true',
        },
        boundaries({ platform: 'ios' }),
      ),
    )(request(facts), context(events));

    assert.equal(result.status, 202);
    assert.deepEqual(events, ['apns-change-reminder-accepted']);
  });

  it('logs each overlapping invocation of a warm runtime to its own context', async () => {
    let releaseFirst = () => {};
    let firstReachedFcm = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstAtFcm = new Promise<void>((resolve) => {
      firstReachedFcm = resolve;
    });
    let sends = 0;
    const handler = createControlledReminderSmokeHandler(() =>
      createControlledReminderSmokeRuntime(
        fcmEnvironment,
        boundaries({
          fcmSend: async () => {
            sends += 1;
            if (sends > 1) return fcmAccepted();
            firstReachedFcm();
            await firstHeld;
            return fcmError(503, 'UNAVAILABLE');
          },
        }),
      ),
    );
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];

    const first = handler(request(facts), context(firstEvents));
    await settled(firstAtFcm);
    const second = await settled(
      handler(request(facts), context(secondEvents)),
    );
    releaseFirst();

    assert.equal((await settled(first)).status, 503);
    assert.equal(second.status, 202);
    assert.deepEqual(firstEvents, [
      'fcm-credential-ready',
      'fcm-change-reminder-transient-rejection',
    ]);
    assert.deepEqual(secondEvents, [
      'fcm-credential-ready',
      'fcm-change-reminder-accepted',
    ]);
  });

  // The declared length is only range-checked. The bytes read have their own
  // limit, below.
  for (const contentLength of ['0', '1024']) {
    it(`accepts a declared body length of ${contentLength}`, async () => {
      const result = await createControlledReminderSmokeHandler(runtime())(
        request(facts, { contentLength }),
        context(),
      );

      assert.equal(result.status, 202);
    });
  }

  it('accepts a body of exactly 1 KiB', async () => {
    // JSON allows trailing whitespace, so padding keeps the body valid.
    const bytes = new TextEncoder().encode(JSON.stringify(facts).padEnd(1024));
    assert.equal(bytes.byteLength, 1024);

    const result = await createControlledReminderSmokeHandler(runtime())(
      rawRequest(bytes),
      context(),
    );

    assert.equal(result.status, 202);
  });

  it('cancels and releases the stream of a body over 1 KiB', async () => {
    let cancelled = false;
    // Never closes, so a body that went unchecked would wait for more data.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1025));
      },
      cancel() {
        cancelled = true;
      },
    });

    const result = await settled(
      createControlledReminderSmokeHandler(runtime())(
        streamRequest(body),
        context(),
      ),
    );

    assert.equal(result.status, 400);
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  });

  it('reads a body that arrives in several chunks', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(facts));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 40));
        controller.enqueue(bytes.slice(40, 90));
        controller.enqueue(bytes.slice(90));
        controller.close();
      },
    });
    let sent: unknown;

    const result = await createControlledReminderSmokeHandler(
      runtime({
        send: async (_subscription, reviewedFacts) => {
          sent = reviewedFacts;
          return { kind: 'accepted' };
        },
      }),
    )(streamRequest(body), context());

    assert.equal(result.status, 202);
    assert.deepEqual(sent, {
      changeDirection: 'forward',
      changeEventAt: new Date('2026-10-04T16:00:00.000Z'),
      homeTimeZone: 'Australia/Sydney',
      timing: 'one-week',
    });
  });

  it('rejects a body that is not valid UTF-8', async () => {
    // JSON keeps the last of two duplicate keys. Lossy decoding would swap the
    // bad byte for a replacement character and still read a valid request, so
    // only strict decoding rejects this one.
    const bytes = Buffer.concat([
      Buffer.from('{"installationId":"'),
      Buffer.from([0xff]),
      Buffer.from(`",${JSON.stringify(facts).slice(1)}`),
    ]);
    let sends = 0;

    const result = await createControlledReminderSmokeHandler(
      runtime({
        send: async () => {
          sends += 1;
          return { kind: 'accepted' };
        },
      }),
    )(rawRequest(bytes), context());

    assert.equal(result.status, 400);
    assert.equal(sends, 0);
  });

  for (const [name, change] of [
    ['a backward change', { changeDirection: 'backward' }],
    ['one-day timing', { timing: 'one-day' }],
  ] as const) {
    it(`sends the reviewed facts for ${name}`, async () => {
      let sent: unknown;
      const result = await createControlledReminderSmokeHandler(
        runtime({
          send: async (_subscription, reviewedFacts) => {
            sent = reviewedFacts;
            return { kind: 'accepted' };
          },
        }),
      )(request({ ...facts, ...change }), context());

      assert.equal(result.status, 202);
      assert.deepEqual(sent, {
        changeDirection: 'forward',
        changeEventAt: new Date('2026-10-04T16:00:00.000Z'),
        homeTimeZone: 'Australia/Sydney',
        timing: 'one-week',
        ...change,
      });
    });
  }

  it('does not send to Android when only the APNs runtime is enabled', async () => {
    let sends = 0;
    const result = await createControlledReminderSmokeHandler(
      runtime({
        apnsRuntimeEnabled: true,
        apnsSend: async () => ({ kind: 'accepted' }),
        runtimeEnabled: false,
        send: async () => {
          sends += 1;
          return { kind: 'accepted' };
        },
      }),
    )(request(facts), context());

    assert.equal(result.status, 503);
    assert.equal(sends, 0);
  });

  it('does not send to iOS when only the FCM runtime is enabled', async () => {
    let sends = 0;
    const result = await createControlledReminderSmokeHandler(
      runtime({
        apnsSend: async () => {
          sends += 1;
          return { kind: 'accepted' };
        },
        getSubscription: async () => ({
          deviceToken: 'b'.repeat(64),
          installationId,
          platform: 'ios',
        }),
      }),
    )(request(facts), context());

    assert.equal(result.status, 503);
    assert.equal(sends, 0);
  });

  it('reports a failed iOS send as unavailable', async () => {
    const result = await createControlledReminderSmokeHandler(
      runtime({
        apnsRuntimeEnabled: true,
        apnsSend: async () => {
          throw new Error('Stored token unusable');
        },
        getSubscription: async () => ({
          deviceToken: 'b'.repeat(64),
          installationId,
          platform: 'ios',
        }),
      }),
    )(request(facts), context());

    assert.equal(result.status, 503);
  });

  it('refuses an iOS registration when no APNs sender was composed', async () => {
    const result = await createControlledReminderSmokeHandler(
      runtime({
        apnsRuntimeEnabled: true,
        getSubscription: async () => ({
          deviceToken: 'b'.repeat(64),
          installationId,
          platform: 'ios',
        }),
      }),
    )(request(facts), context());

    assert.equal(result.status, 503);
  });

  describe('APNs environment', () => {
    function apnsSettings(environment: string) {
      return {
        APNS_ENVIRONMENT: environment,
        APNS_KEY_ID: 'ABCDE12345',
        APNS_PRIVATE_KEY: apnsPrivateKey,
        APNS_RUNTIME_ENABLED: 'true',
        APNS_TEAM_ID: 'ZYXWV98765',
        APNS_TOPIC: 'com.example.app',
        FCM_TEST_SEND_ENABLED: 'true',
      };
    }

    function iosBoundaries(
      origins: string[],
    ): ControlledReminderSmokeBoundaries {
      return {
        ...boundaries({ platform: 'ios' }),
        createApnsTransport: () => ({
          post: async (apnsRequest) => {
            origins.push(apnsRequest.endpoint.origin);
            return { body: '', status: 200 };
          },
        }),
      };
    }

    for (const [environment, origin] of [
      ['production', 'https://api.push.apple.com'],
      ['sandbox', 'https://api.sandbox.push.apple.com'],
    ] as const) {
      it(`sends to the ${environment} APNs host`, async () => {
        const origins: string[] = [];

        const result = await createControlledReminderSmokeHandler(() =>
          createControlledReminderSmokeRuntime(
            apnsSettings(environment),
            iosBoundaries(origins),
          ),
        )(request(facts), context());

        assert.equal(result.status, 202);
        assert.deepEqual(origins, [origin]);
      });
    }

    it('refuses an unknown environment without sending', async () => {
      const origins: string[] = [];

      const result = await createControlledReminderSmokeHandler(() =>
        createControlledReminderSmokeRuntime(
          apnsSettings('staging'),
          iosBoundaries(origins),
        ),
      )(request(facts), context());

      assert.equal(result.status, 503);
      assert.deepEqual(origins, []);
    });
  });

  it('creates no store while a platform lacks the test-send gate', () => {
    let stores = 0;

    const smokeRuntime = createControlledReminderSmokeRuntime(
      { APNS_RUNTIME_ENABLED: 'true', FCM_RUNTIME_ENABLED: 'true' },
      {
        ...boundaries(),
        createStore: () => {
          stores += 1;
          throw new Error('store created');
        },
      },
    );

    assert.deepEqual(smokeRuntime, {
      apnsRuntimeEnabled: true,
      runtimeEnabled: true,
      testSendEnabled: false,
    });
    assert.equal(stores, 0);
  });

  it('drops a log event written outside an invocation', () => {
    assert.doesNotThrow(() => invocationLogger.write('fcm-credential-ready'));
  });

  it('trims a required setting', () => {
    assert.equal(required({ SETTING: '  value ' }, 'SETTING'), 'value');
  });

  for (const [name, environment] of [
    ['missing', {}],
    ['empty', { SETTING: '' }],
    ['blank', { SETTING: '   ' }],
  ] as const) {
    it(`rejects a ${name} required setting`, () => {
      assert.throws(() => required(environment, 'SETTING'), {
        message: 'Missing configuration',
      });
    });
  }
});
