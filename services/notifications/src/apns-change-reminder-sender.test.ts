import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  apnsSendEndpoint,
  createApnsChangeReminderSender,
  type ApnsChangeReminderLogEvent,
  type ApnsChangeReminderSubscription,
  type ApnsHttpRequest,
  type ApnsHttpResponse,
  type ApnsSubscriptionRemovalResult,
} from './apns-change-reminder-sender.ts';

const deviceToken = 'a'.repeat(64);
const providerToken = 'header.payload.signature';
const sensitiveProviderResponse = 'provider detail that must not log';
const invalidatedAt = 1_728_000_000_000;
const subscription = {
  deviceToken,
  installationId: 'a'.repeat(43),
} as const;
const facts = {
  changeDirection: 'forward' as const,
  changeEventAt: new Date('2026-10-04T16:00:00.000Z'),
  homeTimeZone: 'Australia/Sydney',
  timing: 'one-week' as const,
};

const immediate = { kind: 'immediate' } as const;

function response(
  status: number,
  reason: string,
  timestamp?: number,
): ApnsHttpResponse {
  return {
    body: JSON.stringify({
      reason,
      ...(timestamp === undefined ? {} : { timestamp }),
    }),
    status,
  };
}

function sender(
  providerResponse: ApnsHttpResponse = { body: '', status: 200 },
  options: {
    readonly clock?: () => Date;
    readonly getProviderToken?: () => Promise<string>;
    readonly logWrite?: (event: ApnsChangeReminderLogEvent) => void;
    readonly removeIfDeviceTokenMatches?: (
      subscription: ApnsChangeReminderSubscription,
      invalidatedAt: Date,
    ) => Promise<ApnsSubscriptionRemovalResult>;
    readonly post?: (request: ApnsHttpRequest) => Promise<ApnsHttpResponse>;
  } = {},
) {
  const logs: ApnsChangeReminderLogEvent[] = [];
  const requests: ApnsHttpRequest[] = [];
  const removalRequests: {
    readonly invalidatedAt: Date;
    readonly subscription: ApnsChangeReminderSubscription;
  }[] = [];
  const instance = createApnsChangeReminderSender(
    'sandbox',
    'com.example.app',
    {
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      logger: { write: options.logWrite ?? ((event) => logs.push(event)) },
      providerTokenProvider: {
        getProviderToken:
          options.getProviderToken ?? (async () => providerToken),
      },
      subscriptionRemover: {
        removeIfDeviceTokenMatches: async (
          matchingSubscription,
          matchingInvalidatedAt,
        ) => {
          removalRequests.push({
            invalidatedAt: matchingInvalidatedAt,
            subscription: matchingSubscription,
          });
          return (
            (await options.removeIfDeviceTokenMatches?.(
              matchingSubscription,
              matchingInvalidatedAt,
            )) ?? 'removed'
          );
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
    },
  );
  return { instance, logs, removalRequests, requests };
}

describe('APNs Change Reminder sender', () => {
  it('sends the reviewed copy and facts as an HTTP/2 APNs POST', async () => {
    const test = sender();

    assert.deepEqual(await test.instance.send(subscription, facts, immediate), {
      kind: 'accepted',
    });
    assert.deepEqual(test.requests, [
      {
        endpoint: new URL(
          `https://api.sandbox.push.apple.com/3/device/${deviceToken}`,
        ),
        headers: {
          'apns-expiration': '0',
          'apns-priority': '10',
          'apns-push-type': 'alert',
          'apns-topic': 'com.example.app',
          authorization: `bearer ${providerToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        httpVersion: '2',
        method: 'POST',
        payload: {
          aps: {
            alert: {
              body: 'Your Home Time Zone changes soon.',
              title: 'Change Reminder',
            },
            sound: 'default',
          },
          body: {
            changeDirection: 'forward',
            changeEventAt: '2026-10-04T16:00:00.000Z',
            homeTimeZone: 'Australia/Sydney',
            reminderKind: 'change-reminder',
            reminderTiming: 'one-week',
          },
        },
      },
    ]);
    assert.deepEqual(test.logs, ['apns-change-reminder-accepted']);
  });

  it('selects only the reviewed sandbox or production APNs host', () => {
    assert.equal(
      apnsSendEndpoint('production', deviceToken).toString(),
      `https://api.push.apple.com/3/device/${deviceToken}`,
    );
    assert.throws(
      () => apnsSendEndpoint('preview' as never, deviceToken),
      /Invalid APNs environment/,
    );
  });

  it('does not assume an APNs device token has a fixed size', () => {
    const longerToken = 'b'.repeat(66);
    assert.equal(
      apnsSendEndpoint('sandbox', longerToken).pathname,
      `/3/device/${longerToken}`,
    );
    assert.throws(
      () => apnsSendEndpoint('sandbox', 'a'.repeat(65)),
      /Invalid reminder subscription token/,
    );
  });

  for (const [status, reason] of [
    [400, 'IdleTimeout'],
    [403, 'ExpiredProviderToken'],
    [403, 'UnrelatedKeyIdInToken'],
    [429, 'TooManyProviderTokenUpdates'],
    [429, 'TooManyRequests'],
    [500, 'InternalServerError'],
    [503, 'ServiceUnavailable'],
    [503, 'Shutdown'],
  ] as const) {
    it(`keeps the subscription after transient ${status}/${reason}`, async () => {
      const test = sender(response(status, reason));

      assert.deepEqual(
        await test.instance.send(subscription, facts, immediate),
        {
          kind: 'transient-rejection',
        },
      );
      assert.deepEqual(test.removalRequests, []);
    });
  }

  for (const [status, reason, invalidTokenReason] of [
    [410, 'ExpiredToken', undefined],
    [410, 'Unregistered', 'unregistered'],
  ] as const) {
    it(`conditionally removes the exact subscription after ${status}/${reason}`, async () => {
      const test = sender(response(status, reason, invalidatedAt));

      assert.deepEqual(
        await test.instance.send(subscription, facts, immediate),
        {
          cleanupStatus: 'removed',
          invalidatedAt: new Date(invalidatedAt),
          kind: 'permanent-invalid-token',
          ...(invalidTokenReason === undefined ? {} : { invalidTokenReason }),
        },
      );
      assert.deepEqual(test.removalRequests, [
        { invalidatedAt: new Date(invalidatedAt), subscription },
      ]);
    });
  }

  it('fails closed without cleanup for malformed or contradictory responses', async () => {
    for (const providerResponse of [
      { body: sensitiveProviderResponse, status: 200 },
      response(410, 'BadDeviceToken'),
      response(410, 'Unregistered'),
      {
        body: JSON.stringify({ reason: 'Unregistered', timestamp: -1 }),
        status: 410,
      },
      response(410, 'Unregistered', 1.5),
      response(410, 'Unregistered', 8_640_000_000_000_001),
      response(400, 'BadDeviceToken', invalidatedAt),
      response(418, 'Unregistered'),
    ]) {
      const test = sender(providerResponse);
      assert.deepEqual(
        await test.instance.send(subscription, facts, immediate),
        {
          kind: 'malformed-response',
        },
      );
      assert.deepEqual(test.removalRequests, []);
    }
  });

  it('keeps permanent rejection separate from malformed and token outcomes', async () => {
    for (const providerResponse of [
      response(400, 'BadDeviceToken'),
      response(403, 'Forbidden'),
    ]) {
      const test = sender(providerResponse);
      assert.deepEqual(
        await test.instance.send(subscription, facts, immediate),
        {
          kind: 'permanent-rejection',
        },
      );
      assert.deepEqual(test.removalRequests, []);
    }
  });

  it('preserves a matching registration updated after APNs invalidation', async () => {
    const test = sender(response(410, 'Unregistered', invalidatedAt), {
      removeIfDeviceTokenMatches: async (
        matchingSubscription,
        matchingInvalidatedAt,
      ) => {
        assert.deepEqual(matchingSubscription, subscription);
        assert.deepEqual(matchingInvalidatedAt, new Date(invalidatedAt));
        return 'token-replaced';
      },
    });

    assert.deepEqual(await test.instance.send(subscription, facts, immediate), {
      cleanupStatus: 'token-replaced',
      invalidatedAt: new Date(invalidatedAt),
      kind: 'permanent-invalid-token',
      invalidTokenReason: 'unregistered',
    });
  });

  it('does not expose tokens, provider tokens, or response bodies through logs', async () => {
    const test = sender(response(410, 'Unregistered', invalidatedAt), {
      removeIfDeviceTokenMatches: async () => {
        throw new Error(sensitiveProviderResponse);
      },
    });

    assert.deepEqual(await test.instance.send(subscription, facts, immediate), {
      cleanupStatus: 'failed',
      invalidatedAt: new Date(invalidatedAt),
      kind: 'permanent-invalid-token',
      invalidTokenReason: 'unregistered',
    });
    assert.deepEqual(test.logs, [
      'apns-change-reminder-permanent-invalid-token',
      'apns-change-reminder-invalid-token-cleanup-failed',
    ]);
    const serialisedLogs = JSON.stringify(test.logs);
    assert.doesNotMatch(serialisedLogs, new RegExp(deviceToken));
    assert.doesNotMatch(serialisedLogs, new RegExp(providerToken));
    assert.doesNotMatch(serialisedLogs, new RegExp(sensitiveProviderResponse));
  });

  it('keeps an invalid-token result when logging fails', async () => {
    const test = sender(response(410, 'Unregistered', invalidatedAt), {
      logWrite: () => {
        throw new Error('logging unavailable');
      },
      removeIfDeviceTokenMatches: async () => {
        throw new Error('cleanup unavailable');
      },
    });

    assert.deepEqual(await test.instance.send(subscription, facts, immediate), {
      cleanupStatus: 'failed',
      invalidatedAt: new Date(invalidatedAt),
      kind: 'permanent-invalid-token',
      invalidTokenReason: 'unregistered',
    });
  });

  for (const [invalidSubscription, invalidFacts, message] of [
    [
      { ...subscription, installationId: 'too-short' },
      facts,
      'Invalid reminder subscription installation ID',
    ],
    [
      { ...subscription, deviceToken: 'not-a-device-token' },
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
      const test = sender();

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
    const test = sender(undefined, {
      post: async () => {
        throw new Error('APNs transport timeout');
      },
    });

    assert.deepEqual(await test.instance.send(subscription, facts, immediate), {
      kind: 'uncertain',
    });
    assert.deepEqual(test.removalRequests, []);
    assert.deepEqual(test.logs, ['apns-change-reminder-uncertain']);
  });

  it('treats unavailable or invalid injected provider tokens as transient', async () => {
    for (const getProviderToken of [
      async () => {
        throw new Error(providerToken);
      },
      async () => 'not-a-jwt',
    ]) {
      const test = sender(undefined, { getProviderToken });
      assert.deepEqual(
        await test.instance.send(subscription, facts, immediate),
        {
          kind: 'transient-rejection',
        },
      );
      assert.deepEqual(test.requests, []);
    }
  });

  describe('a scheduled send', () => {
    const now = new Date('2026-09-27T01:00:00.900Z');
    const expiresAt = new Date('2026-09-27T11:00:00.500Z');
    const until = { expiresAt, kind: 'until' } as const;
    const authorized = {
      authorizeBeforeExternalSend: async () => true,
      completeOperationDeadline: new Date(now.getTime() + 2_500),
    };

    it('asks APNs to hold it until the expiry, in whole seconds', async () => {
      const test = sender(undefined, { clock: () => now });

      assert.deepEqual(
        await test.instance.send(subscription, facts, until, authorized),
        { kind: 'accepted' },
      );
      assert.equal(
        test.requests[0]?.headers['apns-expiration'],
        String(Date.parse('2026-09-27T11:00:00.000Z') / 1000),
      );
      assert.equal(test.requests[0]?.timeoutMs, 2_500);
    });

    it('sends nothing when the expiry leaves less than a whole second', async () => {
      const test = sender(undefined, {
        clock: () => new Date(expiresAt.getTime() - 400),
      });

      assert.deepEqual(await test.instance.send(subscription, facts, until), {
        kind: 'expired',
      });
      assert.deepEqual(test.requests, []);
      assert.deepEqual(test.logs, ['apns-change-reminder-expired']);
    });

    it('sends nothing when the complete-operation deadline has passed', async () => {
      const test = sender(undefined, { clock: () => now });

      assert.deepEqual(
        await test.instance.send(subscription, facts, until, {
          ...authorized,
          completeOperationDeadline: now,
        }),
        { kind: 'expired' },
      );
      assert.deepEqual(test.requests, []);
    });

    it('authorizes after the provider token and before the request', async () => {
      const steps: string[] = [];
      const test = sender(undefined, {
        clock: () => now,
        getProviderToken: async () => {
          steps.push('token');
          return providerToken;
        },
        post: async () => {
          steps.push('request');
          return { body: '', status: 200 };
        },
      });

      await test.instance.send(subscription, facts, until, {
        ...authorized,
        authorizeBeforeExternalSend: async () => {
          steps.push('authorize');
          return true;
        },
      });

      assert.deepEqual(steps, ['token', 'authorize', 'request']);
    });

    it('takes the expiry from the clock after authorization', async () => {
      let current = now;
      const test = sender(undefined, { clock: () => current });

      assert.deepEqual(
        await test.instance.send(subscription, facts, until, {
          ...authorized,
          authorizeBeforeExternalSend: async () => {
            current = expiresAt;
            return true;
          },
        }),
        { kind: 'expired' },
      );
    });

    it('reports a refused send without calling APNs', async () => {
      const test = sender();

      assert.deepEqual(
        await test.instance.send(subscription, facts, until, {
          ...authorized,
          authorizeBeforeExternalSend: async () => false,
        }),
        { kind: 'not-authorized' },
      );
      assert.deepEqual(test.requests, []);
      assert.deepEqual(test.logs, ['apns-change-reminder-not-authorized']);
    });
  });
});
