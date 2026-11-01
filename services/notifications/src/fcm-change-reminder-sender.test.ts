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
  type ChangeReminderLifetime,
  type FcmSubscriptionRemovalResult,
  type ReviewedChangeReminderFacts,
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

const acceptedBody = JSON.stringify({
  name: 'projects/portable-project/messages/1',
});

// A valid 503 error with the given fields replaced. An undefined value drops
// the field, because JSON leaves it out.
function transientError(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    error: {
      code: 503,
      details: [],
      message: sensitiveProviderResponse,
      status: 'UNAVAILABLE',
      ...overrides,
    },
  });
}

const fcmErrorType = 'type.googleapis.com/google.firebase.fcm.v1.FcmError';

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
          lifetime as unknown as ChangeReminderLifetime,
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

  for (const [invalidSubscription, invalidFacts, message] of [
    [
      { ...subscription, installationId: 'too-short' },
      facts,
      'Invalid reminder subscription installation ID',
    ],
    [
      { ...subscription, deviceToken: 'not a device token' },
      facts,
      'Invalid reminder subscription token',
    ],
    [
      subscription,
      { ...facts, homeTimeZone: 'Europe/London' },
      'Invalid Change Reminder Home Time Zone',
    ],
    [
      subscription,
      { ...facts, changeDirection: 'sideways' },
      'Invalid Change Reminder direction',
    ],
    [
      subscription,
      { ...facts, timing: 'one-month' },
      'Invalid Change Reminder timing',
    ],
    [
      subscription,
      { ...facts, changeEventAt: new Date(Number.NaN) },
      'Invalid Change Reminder event instant',
    ],
    [
      subscription,
      { ...facts, changeEventAt: '2026-10-04T16:00:00.000Z' },
      'Invalid Change Reminder event instant',
    ],
  ] as const) {
    it(`rejects before any request: ${message}`, async () => {
      const test = sender(response(200, '{}'));

      await assert.rejects(
        test.instance.send(
          invalidSubscription as never,
          invalidFacts as never,
          immediate,
        ),
        { message },
      );
      assert.deepEqual(test.requests, []);
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

  for (const [name, body] of [
    ['a code that differs from the HTTP status', transientError({ code: 500 })],
    ['no code', transientError({ code: undefined })],
    ['an empty message', transientError({ message: '' })],
    ['a message that is not text', transientError({ message: 503 })],
    ['no message', transientError({ message: undefined })],
    ['a status that is not text', transientError({ status: 503 })],
    ['no status', transientError({ status: undefined })],
    ['an unexpected field', transientError({ extra: true })],
    ['details that are text', transientError({ details: 'UNREGISTERED' })],
    ['details that are an object', transientError({ details: {} })],
    [
      'more than 16 details',
      transientError({ details: Array.from({ length: 17 }, () => ({})) }),
    ],
    [
      'an unexpected top-level field',
      JSON.stringify({ ...JSON.parse(transientError()), extra: true }),
    ],
    ['no error', '{}'],
    ['an error that is text', JSON.stringify({ error: 'UNAVAILABLE' })],
    ['an error that is null', JSON.stringify({ error: null })],
    ['null', 'null'],
    ['a list', '[]'],
    ['text', '"text"'],
    ['a number', '42'],
    ['an empty body', ''],
    ['a body that is not JSON', 'not json'],
  ] as const) {
    it(`reports a provider error with ${name} as malformed`, async () => {
      const test = sender(response(503, body));

      const result = await test.instance.send(subscription, facts, immediate);

      assert.deepEqual(result, { kind: 'malformed-response' });
      assert.deepEqual(test.removalRequests, []);
      assert.deepEqual(test.logs, ['fcm-change-reminder-malformed-response']);
    });
  }

  it('reports a response body that is not text as malformed', async () => {
    const test = sender(response(503, undefined as never));

    const result = await test.instance.send(subscription, facts, immediate);

    assert.deepEqual(result, { kind: 'malformed-response' });
    assert.deepEqual(test.logs, ['fcm-change-reminder-malformed-response']);
  });

  for (const [name, body] of [
    ['no details', transientError({ details: undefined })],
    [
      '16 details',
      transientError({ details: Array.from({ length: 16 }, () => ({})) }),
    ],
  ] as const) {
    it(`classifies a provider error with ${name}`, async () => {
      const test = sender(response(503, body));

      const result = await test.instance.send(subscription, facts, immediate);

      assert.deepEqual(result, { kind: 'transient-rejection' });
    });
  }

  it('reads a response body of 64 KiB but not one character more', async () => {
    // JSON allows trailing whitespace, so padding keeps the body valid.
    const atLimit = sender(response(200, acceptedBody.padEnd(64 * 1024)));
    assert.deepEqual(
      await atLimit.instance.send(subscription, facts, immediate),
      { kind: 'accepted' },
    );

    const overLimit = sender(response(200, acceptedBody.padEnd(64 * 1024 + 1)));
    assert.deepEqual(
      await overLimit.instance.send(subscription, facts, immediate),
      { kind: 'malformed-response' },
    );
  });

  for (const [name, details] of [
    ['null', [null]],
    [
      'an unexpected field',
      [{ '@type': fcmErrorType, errorCode: 'UNREGISTERED', extra: true }],
    ],
    [
      'another type',
      [
        {
          '@type': 'type.googleapis.com/google.rpc.Help',
          errorCode: 'UNREGISTERED',
        },
      ],
    ],
    ['no type', [{ errorCode: 'UNREGISTERED' }]],
    [
      'another error code',
      [{ '@type': fcmErrorType, errorCode: 'QUOTA_EXCEEDED' }],
    ],
    ['no error code', [{ '@type': fcmErrorType }]],
  ] as const) {
    it(`does not take ${name} in the details for an unregistered token`, async () => {
      const test = sender(response(404, fcmError(404, 'NOT_FOUND', details)));

      const result = await test.instance.send(subscription, facts, immediate);

      assert.deepEqual(result, { kind: 'permanent-rejection' });
      assert.deepEqual(test.removalRequests, []);
      assert.deepEqual(test.logs, ['fcm-change-reminder-permanent-rejection']);
    });
  }

  it('finds an unregistered token among other details', async () => {
    const test = sender(
      response(
        404,
        fcmError(404, 'NOT_FOUND', [
          { '@type': 'type.googleapis.com/google.rpc.Help' },
          ...unregisteredDetails,
        ]),
      ),
    );

    const result = await test.instance.send(subscription, facts, immediate);

    assert.deepEqual(result, {
      kind: 'permanent-invalid-token',
      cleanupStatus: 'removed',
    });
    assert.deepEqual(test.removalRequests, [subscription]);
  });

  for (const [status, providerStatus] of [
    [400, 'INVALID_ARGUMENT'],
    [403, 'PERMISSION_DENIED'],
    [503, 'UNAVAILABLE'],
  ] as const) {
    it(`rejects an unregistered token on ${status}/${providerStatus} as malformed`, async () => {
      const test = sender(
        response(status, fcmError(status, providerStatus, unregisteredDetails)),
      );

      const result = await test.instance.send(subscription, facts, immediate);

      assert.deepEqual(result, { kind: 'malformed-response' });
      assert.deepEqual(test.removalRequests, []);
      assert.deepEqual(test.logs, ['fcm-change-reminder-malformed-response']);
    });
  }

  const validExpiry = new Date(now.getTime() + 30 * 60 * 1000);

  for (const [name, accessToken] of [
    ['an empty value', { expiresAt: validExpiry, value: '' }],
    [
      'a value longer than 16 KiB',
      { expiresAt: validExpiry, value: 'a'.repeat(16 * 1024 + 1) },
    ],
    // The type says text. A list has a length, as text does, so a check that
    // only looked at the length would let it through.
    ['a value that is a list', { expiresAt: validExpiry, value: ['abc'] }],
    ['no value', { expiresAt: validExpiry }],
    [
      'an expiry that is not a date',
      { expiresAt: '2026-07-26T00:30:00.000Z', value: fullCredential },
    ],
    [
      'an invalid expiry',
      { expiresAt: new Date(Number.NaN), value: fullCredential },
    ],
    ['an expiry of now', { expiresAt: now, value: fullCredential }],
  ] as const) {
    it(`treats an access token with ${name} as a transient failure`, async () => {
      const test = sender(response(200, acceptedBody), {
        accessToken: async () => accessToken as never,
      });

      const result = await test.instance.send(subscription, facts, immediate);

      assert.deepEqual(result, { kind: 'transient-rejection' });
      assert.deepEqual(test.requests, []);
      assert.deepEqual(test.logs, ['fcm-change-reminder-transient-rejection']);
    });
  }

  it('accepts an access token of 16 KiB that expires a millisecond from now', async () => {
    const value = 'a'.repeat(16 * 1024);
    const test = sender(response(200, acceptedBody), {
      accessToken: async () => ({
        expiresAt: new Date(now.getTime() + 1),
        value,
      }),
    });

    const result = await test.instance.send(subscription, facts, immediate);

    assert.deepEqual(result, { kind: 'accepted' });
    assert.equal(test.requests[0]?.accessToken, value);
  });

  it('stops the transport deadline once the response has been read', async () => {
    // A deadline left running would later abort a request that already
    // finished.
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let signal: AbortSignal | undefined;
      const outcome = { settled: false };
      void createFetchFcmHttpTransport(async (_input, init) => {
        signal = init.signal;
        return { status: 200, text: async () => acceptedBody };
      })
        .post({
          accessToken: fullCredential,
          endpoint: fcmSendEndpoint('portable-project'),
          payload: {} as FcmHttpRequest['payload'],
        })
        .catch(() => undefined)
        .finally(() => {
          outcome.settled = true;
        });

      await new Promise(setImmediate);
      assert.equal(outcome.settled, true);
      mock.timers.tick(10_000);

      assert.equal(signal?.aborted, false);
    } finally {
      mock.timers.reset();
    }
  });

  it('times out at once for a request deadline of zero', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let signal: AbortSignal | undefined;
      const outcome = { settled: false };
      void createFetchFcmHttpTransport((_input, init) => {
        signal = init.signal;
        return new Promise<never>(() => undefined);
      })
        .post({
          accessToken: fullCredential,
          endpoint: fcmSendEndpoint('portable-project'),
          payload: {} as FcmHttpRequest['payload'],
          timeoutMs: 0,
        })
        .catch(() => undefined)
        .finally(() => {
          outcome.settled = true;
        });

      await new Promise(setImmediate);
      mock.timers.tick(0);
      await new Promise(setImmediate);

      assert.equal(outcome.settled, true);
      assert.equal(signal?.aborted, true);
    } finally {
      mock.timers.reset();
    }
  });

  describe('a scheduled send', () => {
    const accepted = response(
      200,
      JSON.stringify({ name: 'projects/portable-project/messages/1' }),
    );
    const expiresAt = new Date(now.getTime() + 60_000);
    const authorized = {
      authorizeBeforeExternalSend: async () => true,
      completeOperationDeadline: new Date(now.getTime() + 2_500),
    };

    it('passes the time left before the deadline to the transport', async () => {
      const test = sender(accepted);

      assert.deepEqual(
        await test.instance.send(
          subscription,
          facts,
          until(expiresAt),
          authorized,
        ),
        { kind: 'accepted' },
      );
      assert.equal(test.requests[0]?.timeoutMs, 2_500);
    });

    it('sends nothing when the complete-operation deadline has passed', async () => {
      const test = sender(accepted);

      assert.deepEqual(
        await test.instance.send(subscription, facts, until(expiresAt), {
          ...authorized,
          completeOperationDeadline: now,
        }),
        { kind: 'expired' },
      );
      assert.deepEqual(test.requests, []);
    });

    it('sends nothing when the complete-operation deadline is the epoch', async () => {
      const test = sender(accepted);

      assert.deepEqual(
        await test.instance.send(subscription, facts, until(expiresAt), {
          ...authorized,
          completeOperationDeadline: new Date(0),
        }),
        { kind: 'expired' },
      );
      assert.deepEqual(test.requests, []);
    });

    it('authorizes after credentials and before the request', async () => {
      const steps: string[] = [];
      const test = sender(accepted, {
        accessToken: async () => {
          steps.push('credential');
          return {
            expiresAt: new Date(now.getTime() + 60_000),
            value: fullCredential,
          };
        },
        post: async () => {
          steps.push('request');
          return accepted;
        },
      });

      await test.instance.send(subscription, facts, until(expiresAt), {
        ...authorized,
        authorizeBeforeExternalSend: async () => {
          steps.push('authorize');
          return true;
        },
      });

      assert.deepEqual(steps, ['credential', 'authorize', 'request']);
    });

    it('takes the TTL from the clock after authorization', async () => {
      let current = now;
      const test = sender(accepted, { clock: () => current });

      await test.instance.send(subscription, facts, until(expiresAt), {
        ...authorized,
        authorizeBeforeExternalSend: async () => {
          current = new Date(now.getTime() + 1_000);
          return true;
        },
      });

      assert.equal(test.requests[0]?.payload.message.android.ttl, '59s');
    });

    it('reports a refused send without calling FCM', async () => {
      const test = sender(accepted);

      assert.deepEqual(
        await test.instance.send(subscription, facts, until(expiresAt), {
          ...authorized,
          authorizeBeforeExternalSend: async () => false,
        }),
        { kind: 'not-authorized' },
      );
      assert.deepEqual(test.requests, []);
      assert.deepEqual(test.logs, ['fcm-change-reminder-not-authorized']);
    });

    for (const [name, timeoutMs, firesAfterMs] of [
      ['shortens', 1_000, 1_000],
      ['never extends', 60_000, 10_000],
    ] as const) {
      it(`${name} the transport limit for a request deadline`, async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
          const outcome = { settled: false };
          void createFetchFcmHttpTransport(
            () =>
              new Promise(() => {
                // Never answers, like a stalled connection.
              }),
          )
            .post({
              accessToken: fullCredential,
              endpoint: fcmSendEndpoint('portable-project'),
              payload: {} as FcmHttpRequest['payload'],
              timeoutMs,
            })
            .catch(() => undefined)
            .finally(() => {
              outcome.settled = true;
            });

          mock.timers.tick(firesAfterMs - 1);
          await new Promise(setImmediate);
          assert.equal(outcome.settled, false);
          mock.timers.tick(1);
          await new Promise(setImmediate);
          assert.equal(outcome.settled, true);
        } finally {
          mock.timers.reset();
        }
      });
    }
  });
});

describe('FCM Change Reminder warning', () => {
  // The payload as it was sent before the warning existed. Comparing bytes,
  // not objects, also catches a change in key order.
  const unwarnedJson =
    '{"message":{"android":{"notification":{"channel_id":"change-reminders","sound":"default"},"priority":"HIGH","ttl":"0s"},"data":{"changeDirection":"forward","changeEventAt":"2026-10-04T16:00:00.000Z","homeTimeZone":"Australia/Sydney","reminderKind":"change-reminder","reminderTiming":"one-week"},"notification":{"body":"Your Home Time Zone changes soon.","title":"Change Reminder"},"token":"fcm-token:with_valid.characters-123"}}';

  async function sentPayload(
    reviewedFacts: ReviewedChangeReminderFacts,
    target: FcmChangeReminderSubscription = subscription,
  ) {
    const test = sender(response(200, acceptedBody));
    await test.instance.send(target, reviewedFacts, immediate);
    return test.requests[0]?.payload;
  }

  for (const [name, reviewedFacts] of [
    ['no warning', facts],
    ['a warning of false', { ...facts, warned: false }],
  ] as const) {
    it(`sends the bytes it sent before for ${name}`, async () => {
      assert.equal(
        JSON.stringify(await sentPayload(reviewedFacts)),
        unwarnedJson,
      );
    });
  }

  it('sends the warned body and changes nothing else', async () => {
    assert.deepEqual(await sentPayload({ ...facts, warned: true }), {
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
          body: 'Your Home Time Zone changes soon. Tap to keep Change Reminders on.',
          title: 'Change Reminder',
        },
        token: fullDeviceToken,
      },
    });
  });

  // FCM allows a payload of 4096 bytes. Measuring the whole request body with
  // a token longer than FCM issues, the longest zone and a backward change is
  // stricter than the limit.
  for (const warned of [false, true]) {
    it(`keeps ${warned ? 'a warned' : 'an unwarned'} payload within 4096 bytes`, async () => {
      const payload = await sentPayload(
        {
          ...facts,
          changeDirection: 'backward',
          homeTimeZone: 'Australia/Broken_Hill',
          warned,
        },
        { ...subscription, deviceToken: 'a'.repeat(200) },
      );

      assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 4096);
    });
  }
});
