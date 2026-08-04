import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createFcmChangeReminderSender,
  createFetchFcmHttpTransport,
  fcmSendEndpoint,
  type FcmChangeReminderLogEvent,
  type FcmHttpRequest,
  type FcmHttpResponse,
  type FcmChangeReminderSubscription,
  type FcmSubscriptionRemovalResult,
} from './fcm-change-reminder-sender.js';

const now = new Date('2026-07-26T00:00:00.000Z');
const fullDeviceToken = 'fcm-token:with_valid.characters-123';
const fullCredential = 'short-lived-credential-value-that-must-not-log';
const sensitiveProviderResponse = 'provider detail that must not log';

const subscription = {
  deviceToken: fullDeviceToken,
  installationId: 'a'.repeat(43),
} as const;

const facts = {
  changeDirection: 'forward' as const,
  changeEventAt: new Date('2026-10-04T16:00:00.000Z'),
  homeTimeZone: 'Australia/Sydney',
  timing: 'one-week' as const,
};

const unregisteredDetails = [
  {
    '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
    errorCode: 'UNREGISTERED',
  },
] as const;

function fcmError(
  status: number,
  providerStatus: string,
  details: readonly unknown[] = [],
) {
  return JSON.stringify({
    error: {
      code: status,
      details,
      message: sensitiveProviderResponse,
      status: providerStatus,
    },
  });
}

function response(status: number, body: string): FcmHttpResponse {
  return { body, status };
}

function sender(
  providerResponse: FcmHttpResponse,
  options: {
    readonly accessToken?: () => Promise<{
      readonly expiresAt: Date;
      readonly value: string;
    }>;
    readonly removeIfDeviceTokenMatches?: () => Promise<FcmSubscriptionRemovalResult>;
    readonly post?: (request: FcmHttpRequest) => Promise<FcmHttpResponse>;
  } = {},
) {
  const logs: FcmChangeReminderLogEvent[] = [];
  const requests: FcmHttpRequest[] = [];
  const removalRequests: FcmChangeReminderSubscription[] = [];
  const instance = createFcmChangeReminderSender('portable-project', {
    accessTokenProvider: {
      getAccessToken:
        options.accessToken ??
        (async () => ({
          expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
          value: fullCredential,
        })),
    },
    clock: () => now,
    logger: { write: (event) => logs.push(event) },
    subscriptionRemover: {
      removeIfDeviceTokenMatches: async (matchingSubscription) => {
        removalRequests.push(matchingSubscription);
        return (await options.removeIfDeviceTokenMatches?.()) ?? 'removed';
      },
    },
    transport: {
      post: async (request) => {
        requests.push(request);
        return options.post === undefined
          ? providerResponse
          : options.post(request);
      },
    },
  });
  return { instance, logs, removalRequests, requests };
}

describe('FCM Change Reminder sender', () => {
  it('sends a fixed Change Reminder payload from reviewed facts', async () => {
    const test = sender(
      response(
        200,
        JSON.stringify({ name: 'projects/portable-project/messages/1' }),
      ),
    );

    const result = await test.instance.send(subscription, facts);

    assert.deepEqual(result, { kind: 'accepted' });
    assert.deepEqual(test.requests, [
      {
        accessToken: fullCredential,
        endpoint: new URL(
          'https://fcm.googleapis.com/v1/projects/portable-project/messages:send',
        ),
        payload: {
          message: {
            android: {
              notification: {
                channel_id: 'change-reminders',
                sound: 'default',
              },
              priority: 'HIGH',
            },
            data: {
              changeDirection: 'forward',
              changeEventAt: '2026-10-04T16:00:00.000Z',
              homeTimeZone: 'Australia/Sydney',
              reminderKind: 'change-reminder',
              reminderTiming: 'one-week',
            },
            notification: {
              body: 'Your Home Time Zone changes soon.',
              title: 'Change Reminder',
            },
            token: fullDeviceToken,
          },
        },
      },
    ]);
    assert.deepEqual(test.logs, ['fcm-change-reminder-accepted']);
    assert.deepEqual(test.removalRequests, []);
  });

  it('sends source-controlled transport proof without calendar facts', async () => {
    const test = sender(
      response(
        200,
        JSON.stringify({ name: 'projects/portable-project/messages/proof-1' }),
      ),
    );

    const result = await test.instance.sendTransportProof(
      subscription,
      'Australia/Sydney',
    );

    assert.deepEqual(result, { kind: 'accepted' });
    assert.deepEqual(test.requests[0]?.payload.message.data, {
      homeTimeZone: 'Australia/Sydney',
      notificationKind: 'fcm-transport-proof',
    });
    assert.deepEqual(test.requests[0]?.payload.message.notification, {
      body: 'Test only. No Change Reminder is due.',
      title: 'FCM transport test',
    });
    assert.doesNotMatch(
      JSON.stringify(test.requests[0]?.payload),
      /changeEventAt|changeDirection|reminderTiming/,
    );
    assert.deepEqual(test.logs, ['fcm-transport-proof-accepted']);
  });

  it('uses injected fetch for the FCM HTTP v1 request', async () => {
    let input: string | undefined;
    let init:
      | {
          readonly body: string;
          readonly headers: Readonly<Record<string, string>>;
          readonly method: 'POST';
        }
      | undefined;
    const transport = createFetchFcmHttpTransport(
      async (nextInput, nextInit) => {
        input = nextInput;
        init = nextInit;
        return {
          status: 200,
          text: async () =>
            JSON.stringify({ name: 'projects/portable-project/messages/1' }),
        };
      },
    );

    const result = await transport.post({
      accessToken: fullCredential,
      endpoint: fcmSendEndpoint('portable-project'),
      payload: {
        message: {
          android: {
            notification: { channel_id: 'change-reminders', sound: 'default' },
            priority: 'HIGH',
          },
          data: {
            changeDirection: 'forward',
            changeEventAt: '2026-10-04T16:00:00.000Z',
            homeTimeZone: 'Australia/Sydney',
            reminderKind: 'change-reminder',
            reminderTiming: 'one-week',
          },
          notification: {
            body: 'Your Home Time Zone changes soon.',
            title: 'Change Reminder',
          },
          token: fullDeviceToken,
        },
      },
    });

    assert.equal(
      input,
      'https://fcm.googleapis.com/v1/projects/portable-project/messages:send',
    );
    assert.deepEqual(init, {
      body: JSON.stringify({
        message: {
          android: {
            notification: { channel_id: 'change-reminders', sound: 'default' },
            priority: 'HIGH',
          },
          data: {
            changeDirection: 'forward',
            changeEventAt: '2026-10-04T16:00:00.000Z',
            homeTimeZone: 'Australia/Sydney',
            reminderKind: 'change-reminder',
            reminderTiming: 'one-week',
          },
          notification: {
            body: 'Your Home Time Zone changes soon.',
            title: 'Change Reminder',
          },
          token: fullDeviceToken,
        },
      }),
      headers: {
        Authorization: `Bearer ${fullCredential}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      method: 'POST',
    });
    assert.deepEqual(result, {
      body: JSON.stringify({ name: 'projects/portable-project/messages/1' }),
      status: 200,
    });
  });

  it('classifies a transient provider rejection without removing a subscription', async () => {
    const test = sender(response(503, fcmError(503, 'UNAVAILABLE')));

    const result = await test.instance.send(subscription, facts);

    assert.deepEqual(result, { kind: 'transient-rejection' });
    assert.deepEqual(test.removalRequests, []);
    assert.deepEqual(test.logs, ['fcm-change-reminder-transient-rejection']);
  });

  it('removes only the provider-rejected matching subscription', async () => {
    const test = sender(
      response(404, fcmError(404, 'NOT_FOUND', unregisteredDetails)),
    );

    const result = await test.instance.send(subscription, facts);

    assert.deepEqual(result, {
      kind: 'permanent-invalid-token',
      cleanupStatus: 'removed',
    });
    assert.deepEqual(test.removalRequests, [subscription]);
    assert.deepEqual(test.logs, [
      'fcm-change-reminder-permanent-invalid-token',
    ]);
  });

  it('keeps a subscription when a provider response is malformed', async () => {
    const test = sender(response(200, sensitiveProviderResponse));

    const result = await test.instance.send(subscription, facts);

    assert.deepEqual(result, { kind: 'malformed-response' });
    assert.deepEqual(test.removalRequests, []);
    assert.deepEqual(test.logs, ['fcm-change-reminder-malformed-response']);
  });

  it('rejects unknown provider status values as malformed', async () => {
    const test = sender(response(400, fcmError(400, 'NOT_A_GOOGLE_STATUS')));

    const result = await test.instance.send(subscription, facts);

    assert.deepEqual(result, { kind: 'malformed-response' });
    assert.deepEqual(test.removalRequests, []);
    assert.deepEqual(test.logs, ['fcm-change-reminder-malformed-response']);
  });

  for (const [status, providerStatus] of [
    [400, 'UNAVAILABLE'],
    [404, 'UNAVAILABLE'],
  ] as const) {
    it(`rejects contradictory ${status}/${providerStatus} unregistered responses`, async () => {
      const test = sender(
        response(status, fcmError(status, providerStatus, unregisteredDetails)),
      );

      const result = await test.instance.send(subscription, facts);

      assert.deepEqual(result, { kind: 'malformed-response' });
      assert.deepEqual(test.removalRequests, []);
      assert.deepEqual(test.logs, ['fcm-change-reminder-malformed-response']);
    });
  }

  it('distinguishes a permanent non-token provider rejection', async () => {
    const test = sender(response(400, fcmError(400, 'INVALID_ARGUMENT')));

    const result = await test.instance.send(subscription, facts);

    assert.deepEqual(result, { kind: 'permanent-rejection' });
    assert.deepEqual(test.removalRequests, []);
    assert.deepEqual(test.logs, ['fcm-change-reminder-permanent-rejection']);
  });

  it('classifies each supported transient FCM error pair without cleanup', async () => {
    for (const [status, providerStatus] of [
      [429, 'RESOURCE_EXHAUSTED'],
      [500, 'INTERNAL'],
      [503, 'UNAVAILABLE'],
    ] as const) {
      const test = sender(response(status, fcmError(status, providerStatus)));

      const result = await test.instance.send(subscription, facts);

      assert.deepEqual(result, { kind: 'transient-rejection' });
      assert.deepEqual(test.removalRequests, []);
      assert.deepEqual(test.logs, ['fcm-change-reminder-transient-rejection']);
    }
  });

  it('classifies each supported permanent FCM error pair without cleanup', async () => {
    for (const [status, providerStatus] of [
      [400, 'INVALID_ARGUMENT'],
      [401, 'UNAUTHENTICATED'],
      [403, 'PERMISSION_DENIED'],
      [404, 'NOT_FOUND'],
    ] as const) {
      const test = sender(response(status, fcmError(status, providerStatus)));

      const result = await test.instance.send(subscription, facts);

      assert.deepEqual(result, { kind: 'permanent-rejection' });
      assert.deepEqual(test.removalRequests, []);
      assert.deepEqual(test.logs, ['fcm-change-reminder-permanent-rejection']);
    }
  });

  it('treats failed keyless credential acquisition as transient', async () => {
    const test = sender(response(200, JSON.stringify({ name: 'ignored' })), {
      accessToken: async () => {
        throw new Error(fullCredential);
      },
    });

    const result = await test.instance.send(subscription, facts);

    assert.deepEqual(result, { kind: 'transient-rejection' });
    assert.deepEqual(test.requests, []);
    assert.deepEqual(test.removalRequests, []);
    assert.deepEqual(test.logs, ['fcm-change-reminder-transient-rejection']);
  });

  it('does not expose tokens, credentials, or provider responses through logs', async () => {
    const test = sender(
      response(404, fcmError(404, 'NOT_FOUND', unregisteredDetails)),
    );

    await test.instance.send(subscription, facts);

    const serialisedLogs = JSON.stringify(test.logs);
    assert.doesNotMatch(serialisedLogs, new RegExp(fullDeviceToken));
    assert.doesNotMatch(serialisedLogs, new RegExp(fullCredential));
    assert.doesNotMatch(serialisedLogs, new RegExp(sensitiveProviderResponse));
  });

  it('keeps permanent invalid-token truth when cleanup rejects', async () => {
    const cleanupFailure = 'cleanup detail that must not log';
    const test = sender(
      response(404, fcmError(404, 'NOT_FOUND', unregisteredDetails)),
      {
        removeIfDeviceTokenMatches: async () => {
          throw new Error(cleanupFailure);
        },
      },
    );

    const result = await test.instance.send(subscription, facts);

    assert.deepEqual(result, {
      kind: 'permanent-invalid-token',
      cleanupStatus: 'failed',
    });
    assert.deepEqual(test.removalRequests, [subscription]);
    assert.deepEqual(test.logs, [
      'fcm-change-reminder-permanent-invalid-token',
      'fcm-change-reminder-invalid-token-cleanup-failed',
    ]);
    const serialisedLogs = JSON.stringify(test.logs);
    assert.doesNotMatch(serialisedLogs, new RegExp(fullDeviceToken));
    assert.doesNotMatch(serialisedLogs, new RegExp(fullCredential));
    assert.doesNotMatch(serialisedLogs, new RegExp(sensitiveProviderResponse));
    assert.doesNotMatch(serialisedLogs, new RegExp(cleanupFailure));
  });

  it('keeps a rotated token when the conditional remover finds a mismatch', async () => {
    const test = sender(
      response(404, fcmError(404, 'NOT_FOUND', unregisteredDetails)),
      {
        removeIfDeviceTokenMatches: async () => 'token-replaced',
      },
    );

    const result = await test.instance.send(subscription, facts);

    assert.deepEqual(result, {
      kind: 'permanent-invalid-token',
      cleanupStatus: 'token-replaced',
    });
    assert.deepEqual(test.removalRequests, [subscription]);
  });
});
