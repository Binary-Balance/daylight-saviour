import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createFcmProofHandler,
  fcmProofOptions,
  type FcmRuntimeDependencies,
  type FcmRuntimeLogEvent,
} from './fcm-runtime.js';
import type { ReminderSubscriptionStore } from './reminder-subscriptions.js';

const environment = {
  FCM_ENTRA_ASSERTION_AUDIENCE: 'api://portable-google-federation',
  FCM_PROJECT_ID: 'portable-project',
  FCM_PROOF_ENABLED: 'true',
  FCM_PROOF_INSTALLATION_ID: 'a'.repeat(43),
  FCM_RUNTIME_ENABLED: 'true',
  FCM_SERVICE_ACCOUNT_EMAIL:
    'portable-fcm-sender@portable-project.iam.gserviceaccount.com',
  FCM_WORKLOAD_IDENTITY_PROVIDER:
    '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/portable-pool/providers/azure-runtime',
  REMINDER_MANAGED_IDENTITY_CLIENT_ID: '11111111-2222-4333-8444-555555555555',
  REMINDER_STORAGE_ACCOUNT_NAME: 'portablestorage',
} as const;
const now = new Date('2026-07-28T01:00:00.000Z');
const storedDeviceToken = 'fcm-token:stored-registration-value-123';

function store(
  overrides: Partial<ReminderSubscriptionStore> = {},
): ReminderSubscriptionStore {
  return {
    createSubscription: async () => 'accepted',
    getFcmProofSubscription: async () => ({
      deviceToken: storedDeviceToken,
      homeTimeZone: 'Australia/Sydney',
      installationId: environment.FCM_PROOF_INSTALLATION_ID,
      oneDayEnabled: true,
      oneWeekEnabled: true,
    }),
    purgeExpiredThrottleRecords: async () => undefined,
    removeIfDeviceTokenMatches: async () => 'not-found',
    takeInstallationAllowance: async () => true,
    takeSourceAllowance: async () => true,
    updateSubscription: async () => 'accepted',
    ...overrides,
  };
}

function dependencies(
  events: FcmRuntimeLogEvent[],
  requests: {
    readonly body: string | undefined;
    readonly input: string;
  }[],
  subscriptionStore = store(),
): FcmRuntimeDependencies {
  return {
    clock: () => now,
    createCredential: () => ({
      getToken: async () => ({
        expiresOnTimestamp: now.getTime() + 30 * 60 * 1000,
        token: 'sensitive-entra-assertion',
      }),
    }),
    createStore: () => subscriptionStore,
    fetch: async (input, init) => {
      requests.push({ body: init.body, input });
      if (input === 'https://sts.googleapis.com/v1/token') {
        return {
          status: 200,
          text: async () =>
            JSON.stringify({
              access_token: 'sensitive-federated-token',
              expires_in: 1800,
              issued_token_type:
                'urn:ietf:params:oauth:token-type:access_token',
              token_type: 'Bearer',
            }),
        };
      }
      if (input.startsWith('https://iamcredentials.googleapis.com/')) {
        return {
          status: 200,
          text: async () =>
            JSON.stringify({
              accessToken: 'sensitive-fcm-access-token',
              expireTime: '2026-07-28T01:30:00.000Z',
            }),
        };
      }
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            name: 'projects/portable-project/messages/proof-1',
          }),
      };
    },
    logger: { write: (event) => events.push(event) },
  };
}

describe('FCM runtime composition', () => {
  it('sends one environment-fixed proof through the stored Android registration', async () => {
    const events: FcmRuntimeLogEvent[] = [];
    const requests: { body: string | undefined; input: string }[] = [];
    const handler = createFcmProofHandler(
      environment,
      dependencies(events, requests),
    );
    const maliciousCallerInput = {
      body: JSON.stringify({
        copy: 'caller-controlled copy',
        deviceToken: 'caller-controlled-token',
        projectId: 'caller-project',
      }),
    };

    const result = await handler(maliciousCallerInput as never);

    assert.deepEqual(result, {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { outcome: 'accepted' },
      status: 200,
    });
    assert.equal(requests.length, 3);
    assert.equal(
      requests[2]?.input,
      'https://fcm.googleapis.com/v1/projects/portable-project/messages:send',
    );
    const fcmRequest = JSON.parse(requests[2]?.body ?? '') as {
      readonly message: {
        readonly data: Record<string, string>;
        readonly notification: Record<string, string>;
        readonly token: string;
      };
    };
    assert.equal(fcmRequest.message.token, storedDeviceToken);
    assert.deepEqual(fcmRequest.message.data, {
      homeTimeZone: 'Australia/Sydney',
      notificationKind: 'fcm-transport-proof',
    });
    assert.deepEqual(fcmRequest.message.notification, {
      body: 'Test only. No Change Reminder is due.',
      title: 'FCM transport test',
    });
    assert.doesNotMatch(requests[2]?.body ?? '', /caller-controlled/);
    assert.deepEqual(events, [
      'fcm-credential-ready',
      'fcm-transport-proof-accepted',
    ]);
  });

  it('is function-key gated and fails closed while proof is disabled', async () => {
    assert.equal(fcmProofOptions.authLevel, 'function');
    assert.deepEqual(fcmProofOptions.methods, ['POST']);
    assert.equal(fcmProofOptions.route, 'internal/fcm-proof');

    let constructions = 0;
    const handler = createFcmProofHandler(
      { ...environment, FCM_PROOF_ENABLED: 'false' },
      {
        ...dependencies([], []),
        createStore: () => {
          constructions += 1;
          return store();
        },
      },
    );

    const result = await handler({} as never);

    assert.equal(constructions, 0);
    assert.deepEqual(result, {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { error: 'Not found' },
      status: 404,
    });
  });

  it('returns secret-free outcomes for missing registrations and provider denial', async () => {
    const missingHandler = createFcmProofHandler(
      environment,
      dependencies(
        [],
        [],
        store({ getFcmProofSubscription: async () => null }),
      ),
    );
    assert.deepEqual(await missingHandler({} as never), {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { error: 'Registration unavailable' },
      status: 404,
    });

    const sensitiveFailure = 'sensitive-storage-failure';
    const deniedHandler = createFcmProofHandler(
      environment,
      dependencies(
        [],
        [],
        store({
          getFcmProofSubscription: async () => {
            throw new Error(sensitiveFailure);
          },
        }),
      ),
    );
    const denied = await deniedHandler({} as never);
    assert.deepEqual(denied, {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { error: 'Proof unavailable' },
      status: 503,
    });
    assert.doesNotMatch(JSON.stringify(denied), new RegExp(sensitiveFailure));
  });

  it('exposes token-cleanup failure classification without sensitive details', async () => {
    const events: FcmRuntimeLogEvent[] = [];
    const requests: { body: string | undefined; input: string }[] = [];
    const base = dependencies(
      events,
      requests,
      store({
        removeIfDeviceTokenMatches: async () => {
          throw new Error(`sensitive cleanup ${storedDeviceToken}`);
        },
      }),
    );
    const handler = createFcmProofHandler(environment, {
      ...base,
      fetch: async (input, init) => {
        if (input.startsWith('https://fcm.googleapis.com/')) {
          return {
            status: 404,
            text: async () =>
              JSON.stringify({
                error: {
                  code: 404,
                  details: [
                    {
                      '@type':
                        'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                      errorCode: 'UNREGISTERED',
                    },
                  ],
                  message: `sensitive provider ${storedDeviceToken}`,
                  status: 'NOT_FOUND',
                },
              }),
          };
        }
        return base.fetch!(input, init);
      },
    });

    const result = await handler({} as never);

    assert.deepEqual(result, {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: {
        cleanupStatus: 'failed',
        outcome: 'permanent-invalid-token',
      },
      status: 502,
    });
    assert.deepEqual(events, [
      'fcm-credential-ready',
      'fcm-transport-proof-permanent-invalid-token',
      'fcm-transport-proof-invalid-token-cleanup-failed',
    ]);
    assert.doesNotMatch(JSON.stringify(events), new RegExp(storedDeviceToken));
  });

  it('bounds FCM delivery and classifies timeout as transient', async () => {
    const events: FcmRuntimeLogEvent[] = [];
    const requests: { body: string | undefined; input: string }[] = [];
    const base = dependencies(events, requests);
    const handler = createFcmProofHandler(environment, {
      ...base,
      fetch: async (input, init) => {
        if (input.startsWith('https://fcm.googleapis.com/')) {
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new Error(`sensitive timeout ${storedDeviceToken}`)),
            );
          });
        }
        return base.fetch!(input, init);
      },
      timeoutMs: 1,
    });

    const result = await handler({} as never);

    assert.deepEqual(result, {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { outcome: 'transient-rejection' },
      status: 502,
    });
    assert.deepEqual(events, [
      'fcm-credential-ready',
      'fcm-transport-proof-transient-rejection',
    ]);
    assert.doesNotMatch(JSON.stringify(events), new RegExp(storedDeviceToken));
  });
});
