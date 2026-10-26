import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
  createFcmChangeReminderSender,
  createFetchFcmHttpTransport,
  fcmSendEndpoint,
  type FcmChangeReminderLogEvent,
  type FcmHttpRequest,
  type FcmHttpResponse,
  type FcmChangeReminderSubscription,
  type FcmMessageLifetime,
  type FcmSubscriptionRemovalResult,
} from './fcm-change-reminder-sender.ts';

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

const immediate = { kind: 'immediate' } as const;

function until(expiresAt: Date) {
  return { kind: 'until', expiresAt } as const;
}

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
    readonly clock?: () => Date;
    readonly logWrite?: (event: FcmChangeReminderLogEvent) => void;
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
    clock: options.clock ?? (() => now),
    logger: { write: options.logWrite ?? ((event) => logs.push(event)) },
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

    const result = await test.instance.send(subscription, facts, immediate);

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
              ttl: '0s',
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

  it('sends a queued message with the whole seconds left before expiry', async () => {
    const test = sender(
      response(
        200,
        JSON.stringify({ name: 'projects/portable-project/messages/1' }),
      ),
    );

    const result = await test.instance.send(
      subscription,
      facts,
      until(new Date(now.getTime() + 90_500)),
    );

    assert.deepEqual(result, { kind: 'accepted' });
    assert.equal(test.requests[0]?.payload.message.android.ttl, '90s');
  });

  it('accepts the four-week FCM maximum lifetime', async () => {
    const test = sender(
      response(
        200,
        JSON.stringify({ name: 'projects/portable-project/messages/1' }),
      ),
    );

    await test.instance.send(
      subscription,
      facts,
      until(new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000)),
    );

    assert.equal(test.requests[0]?.payload.message.android.ttl, '2419200s');
  });

  it('takes the TTL from the clock after credential acquisition', async () => {
    let currentTime = now.getTime();
    const test = sender(
      response(
        200,
        JSON.stringify({ name: 'projects/portable-project/messages/1' }),
      ),
      {
        accessToken: async () => {
          currentTime += 30_000;
          return {
            expiresAt: new Date(currentTime + 30 * 60 * 1000),
            value: fullCredential,
          };
        },
        clock: () => new Date(currentTime),
      },
    );

    await test.instance.send(
      subscription,
      facts,
      until(new Date(now.getTime() + 60_000)),
    );

    assert.equal(test.requests[0]?.payload.message.android.ttl, '30s');
  });

  it('sends a zero TTL while less than a second remains', async () => {
    let currentTime = now.getTime();
    const test = sender(
      response(
        200,
        JSON.stringify({ name: 'projects/portable-project/messages/1' }),
      ),
      {
        accessToken: async () => {
          currentTime += 999;
          return {
            expiresAt: new Date(currentTime + 30 * 60 * 1000),
            value: fullCredential,
          };
        },
        clock: () => new Date(currentTime),
      },
    );

    const result = await test.instance.send(
      subscription,
      facts,
      until(new Date(now.getTime() + 1_000)),
    );

    assert.deepEqual(result, { kind: 'accepted' });
    assert.equal(test.requests[0]?.payload.message.android.ttl, '0s');
  });

  it('sends nothing when the lifetime ends during credential acquisition', async () => {
    let currentTime = now.getTime();
    const test = sender(
      response(
        200,
        JSON.stringify({ name: 'projects/portable-project/messages/1' }),
      ),
      {
        accessToken: async () => {
          currentTime += 1_000;
          return {
            expiresAt: new Date(currentTime + 30 * 60 * 1000),
            value: fullCredential,
          };
        },
        clock: () => new Date(currentTime),
      },
    );

    const result = await test.instance.send(
      subscription,
      facts,
      until(new Date(now.getTime() + 1_000)),
    );

    assert.deepEqual(result, { kind: 'expired' });
    assert.deepEqual(test.requests, []);
    assert.deepEqual(test.logs, ['fcm-change-reminder-expired']);
  });

  for (const [name, expiresAt] of [
    ['at the current time', now],
    ['in the past', new Date(now.getTime() - 1)],
  ] as const) {
    it(`reports an expiry ${name} as expired without sending`, async () => {
      const test = sender(response(200, '{}'));

      const result = await test.instance.send(
        subscription,
        facts,
        until(expiresAt),
      );

      assert.deepEqual(result, { kind: 'expired' });
      assert.deepEqual(test.requests, []);
      assert.deepEqual(test.logs, ['fcm-change-reminder-expired']);
    });
  }

  for (const [name, lifetime] of [
    ['an invalid date', until(new Date(Number.NaN))],
    [
      'an expiry beyond the four-week FCM maximum',
      until(new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000 + 1)),
    ],
    [
      'a non-date expiry',
      { kind: 'until', expiresAt: '2026-07-27T00:00:00.000Z' },
    ],
    [
      'an unknown lifetime kind',
      { kind: 'provider-default', expiresAt: new Date(now.getTime() + 1_000) },
    ],
  ] as const) {
    it(`rejects ${name} before acquiring a credential`, async () => {
      let accessTokenRequests = 0;
      const test = sender(response(200, '{}'), {
        accessToken: async () => {
          accessTokenRequests += 1;
          return {
            expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
            value: fullCredential,
          };
        },
      });

      await assert.rejects(
        test.instance.send(
          subscription,
          facts,
          lifetime as unknown as FcmMessageLifetime,
        ),
        { message: 'Invalid FCM message lifetime' },
      );
      assert.equal(accessTokenRequests, 0);
      assert.deepEqual(test.requests, []);
      assert.deepEqual(test.logs, []);
    });
  }

  it('uses injected fetch for the FCM HTTP v1 request', async () => {
    let input: string | undefined;
    let init:
      | {
          readonly body: string;
          readonly headers: Readonly<Record<string, string>>;
          readonly method: 'POST';
          readonly signal: AbortSignal;
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
            ttl: '0s',
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
            ttl: '0s',
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
      signal: init?.signal,
    });
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(result, {
      body: JSON.stringify({ name: 'projects/portable-project/messages/1' }),
      status: 200,
    });
  });

  for (const [name, stalledResponse] of [
    ['never returns headers', () => new Promise<never>(() => undefined)],
    [
      'stalls its body after the headers',
      async () => ({
        status: 200,
        text: () => new Promise<never>(() => undefined),
      }),
    ],
  ] as const) {
    it(`times out a request that ${name} after ten seconds`, async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        let signal: AbortSignal | undefined;
        const transport = createFetchFcmHttpTransport(async (_input, init) => {
          signal = init.signal;
          // Like a network implementation that ignores abort.
          return stalledResponse();
        });
        const outcome = { error: undefined as unknown, settled: false };
        void transport
          .post({
            accessToken: fullCredential,
            endpoint: fcmSendEndpoint('portable-project'),
            payload: {} as FcmHttpRequest['payload'],
          })
          .catch((error: unknown) => {
            outcome.error = error;
          })
          .finally(() => {
            outcome.settled = true;
          });

        mock.timers.tick(9_999);
        await new Promise(setImmediate);
        assert.equal(outcome.settled, false);
        mock.timers.tick(1);
        await new Promise(setImmediate);

        assert.equal(outcome.settled, true);
        assert.match(String(outcome.error), /FCM transport timeout/);
        assert.equal(signal?.aborted, true);
      } finally {
        mock.timers.reset();
      }
    });
  }

  it('reports a failed or timed-out request as uncertain, not rejected', async () => {
    const test = sender(response(200, '{}'), {
      post: async () => {
        throw new Error('FCM transport timeout');
      },
    });

    const result = await test.instance.send(subscription, facts, immediate);

    assert.deepEqual(result, { kind: 'uncertain' });
    assert.deepEqual(test.removalRequests, []);
    assert.deepEqual(test.logs, ['fcm-change-reminder-uncertain']);
  });

  it('classifies a transient provider rejection without removing a subscription', async () => {
    const test = sender(response(503, fcmError(503, 'UNAVAILABLE')));

    const result = await test.instance.send(subscription, facts, immediate);

    assert.deepEqual(result, { kind: 'transient-rejection' });
    assert.deepEqual(test.removalRequests, []);
    assert.deepEqual(test.logs, ['fcm-change-reminder-transient-rejection']);
  });

  it('removes only the provider-rejected matching subscription', async () => {
    const test = sender(
      response(404, fcmError(404, 'NOT_FOUND', unregisteredDetails)),
    );

    const result = await test.instance.send(subscription, facts, immediate);

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

    const result = await test.instance.send(subscription, facts, immediate);

    assert.deepEqual(result, { kind: 'malformed-response' });
    assert.deepEqual(test.removalRequests, []);
    assert.deepEqual(test.logs, ['fcm-change-reminder-malformed-response']);
  });

  it('rejects unknown provider status values as malformed', async () => {
    const test = sender(response(400, fcmError(400, 'NOT_A_GOOGLE_STATUS')));

    const result = await test.instance.send(subscription, facts, immediate);

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

      const result = await test.instance.send(subscription, facts, immediate);

      assert.deepEqual(result, { kind: 'malformed-response' });
      assert.deepEqual(test.removalRequests, []);
      assert.deepEqual(test.logs, ['fcm-change-reminder-malformed-response']);
    });
  }

  it('distinguishes a permanent non-token provider rejection', async () => {
    const test = sender(response(400, fcmError(400, 'INVALID_ARGUMENT')));

    const result = await test.instance.send(subscription, facts, immediate);

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

      const result = await test.instance.send(subscription, facts, immediate);

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

      const result = await test.instance.send(subscription, facts, immediate);

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

    const result = await test.instance.send(subscription, facts, immediate);

    assert.deepEqual(result, { kind: 'transient-rejection' });
    assert.deepEqual(test.requests, []);
    assert.deepEqual(test.removalRequests, []);
    assert.deepEqual(test.logs, ['fcm-change-reminder-transient-rejection']);
  });

  it('rejects a token that expires during asynchronous acquisition', async () => {
    let currentTime = now.getTime();
    const test = sender(
      response(
        200,
        JSON.stringify({ name: 'projects/portable-project/messages/1' }),
      ),
      {
        accessToken: async () => {
          const expiresAt = new Date(currentTime + 1_000);
          currentTime += 2_000;
          return {
            expiresAt,
            value: fullCredential,
          };
        },
        clock: () => new Date(currentTime),
      },
    );

    assert.deepEqual(await test.instance.send(subscription, facts, immediate), {
      kind: 'transient-rejection',
    });
    assert.deepEqual(test.requests, []);
  });

  it('leaves maximum token lifetime policy to the credential provider', async () => {
    const test = sender(
      response(
        200,
        JSON.stringify({ name: 'projects/portable-project/messages/1' }),
      ),
      {
        accessToken: async () => ({
          expiresAt: new Date(now.getTime() + 61 * 60 * 1000),
          value: fullCredential,
        }),
      },
    );

    assert.deepEqual(await test.instance.send(subscription, facts, immediate), {
      kind: 'accepted',
    });
    assert.equal(test.requests.length, 1);
  });

  it('does not expose tokens, credentials, or provider responses through logs', async () => {
    const test = sender(
      response(404, fcmError(404, 'NOT_FOUND', unregisteredDetails)),
    );

    await test.instance.send(subscription, facts, immediate);

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

    const result = await test.instance.send(subscription, facts, immediate);

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

  it('keeps an invalid-token result when logging fails', async () => {
    const test = sender(
      response(404, fcmError(404, 'NOT_FOUND', unregisteredDetails)),
      {
        logWrite: () => {
          throw new Error('logging unavailable');
        },
        removeIfDeviceTokenMatches: async () => {
          throw new Error('cleanup unavailable');
        },
      },
    );

    const result = await test.instance.send(subscription, facts, immediate);

    assert.deepEqual(result, {
      kind: 'permanent-invalid-token',
      cleanupStatus: 'failed',
    });
  });

  it('keeps a rotated token when the conditional remover finds a mismatch', async () => {
    const test = sender(
      response(404, fcmError(404, 'NOT_FOUND', unregisteredDetails)),
      {
        removeIfDeviceTokenMatches: async () => 'token-replaced',
      },
    );

    const result = await test.instance.send(subscription, facts, immediate);

    assert.deepEqual(result, {
      kind: 'permanent-invalid-token',
      cleanupStatus: 'token-replaced',
    });
    assert.deepEqual(test.removalRequests, [subscription]);
  });
});
