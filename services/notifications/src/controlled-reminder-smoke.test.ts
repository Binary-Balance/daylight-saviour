import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  controlledReminderSmokeOptions,
  createControlledReminderSmokeHandler,
} from './controlled-reminder-smoke.js';
import type {
  ApnsChangeReminderResult,
  ApnsChangeReminderSubscription,
} from './apns-change-reminder-sender.js';
import type {
  FcmChangeReminderResult,
  FcmChangeReminderSubscription,
  ReviewedChangeReminderFacts,
} from './fcm-change-reminder-sender.js';

const installationId = 'a'.repeat(43);
const deviceToken = 'fcm-token:with_valid.characters-123';
const facts = {
  changeDirection: 'forward',
  changeEventAt: '2026-10-04T16:00:00.000Z',
  homeTimeZone: 'Australia/Sydney',
  installationId,
  timing: 'one-week',
} as const;

function request(
  body: unknown,
  options: {
    readonly contentLength?: string;
    readonly contentType?: string;
  } = {},
) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
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

function runtime(
  overrides: {
    readonly apnsRuntimeEnabled?: boolean;
    readonly apnsSend?: (
      subscription: ApnsChangeReminderSubscription,
      facts: ReviewedChangeReminderFacts,
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
    )(request(facts));

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
    )(request(facts));

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
    )(request(facts));

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
    ['oversized declared body', facts, { contentLength: '1025' }],
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
      )(request(input, options));

      assert.equal(result.status, 400);
      assert.equal(sends, 0);
      assert.deepEqual(result.jsonBody, { outcome: 'unavailable' });
    });
  }

  it('returns a fixed outcome when the requested Android registration is absent', async () => {
    const result = await createControlledReminderSmokeHandler(
      runtime({ getSubscription: async () => null }),
    )(request(facts));

    assert.deepEqual(result, {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { outcome: 'unavailable' },
      status: 404,
    });
  });

  it('sends reviewed facts to the exact stored Android subscription', async () => {
    let actual:
      | {
          readonly facts: unknown;
          readonly subscription: unknown;
        }
      | undefined;
    const result = await createControlledReminderSmokeHandler(
      runtime({
        send: async (subscription, reviewedFacts) => {
          actual = { facts: reviewedFacts, subscription };
          return { kind: 'accepted' };
        },
      }),
    )(request(facts));

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
      subscription: { deviceToken, installationId },
    });
  });

  it('maps a non-accepted sender result to a fixed unavailable outcome', async () => {
    const result = await createControlledReminderSmokeHandler(
      runtime({ send: async () => ({ kind: 'transient-rejection' }) }),
    )(request(facts));

    assert.deepEqual(result, {
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { outcome: 'unavailable' },
      status: 503,
    });
  });

  it('routes a stored iOS subscription through the explicitly enabled APNs sender', async () => {
    let sent: unknown;
    const result = await createControlledReminderSmokeHandler(
      runtime({
        apnsRuntimeEnabled: true,
        apnsSend: async (subscription) => {
          sent = subscription;
          return { kind: 'accepted' };
        },
        getSubscription: async () => ({
          deviceToken: 'b'.repeat(64),
          installationId,
          platform: 'ios',
        }),
      }),
    )(request(facts));

    assert.equal(result.status, 202);
    assert.deepEqual(sent, { deviceToken: 'b'.repeat(64), installationId });
  });

  it('does not expose provider details when delivery fails', async () => {
    const credential = 'short-lived-credential-value';
    const providerDetail = 'provider response body';
    const result = await createControlledReminderSmokeHandler(
      runtime({
        send: async () => {
          throw new Error(`${credential}: ${providerDetail}`);
        },
      }),
    )(request(facts));

    assert.equal(result.status, 503);
    assert.deepEqual(result.jsonBody, { outcome: 'unavailable' });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(credential));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(providerDetail));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(deviceToken));
  });
});
