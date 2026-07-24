import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { registerReminderSubscription } from './reminder-subscriptions.js';

function request(body: unknown, contentType = 'application/json') {
  return {
    headers: new Headers({
      'content-type': contentType,
      'x-forwarded-for': '198.51.100.7',
    }),
    text: async () => JSON.stringify(body),
  } as never;
}

describe('reminder subscription registration', () => {
  it('stores a credential hash, never the returned credential, after strict validation', async () => {
    let saved: Record<string, unknown> | undefined;
    const result = await registerReminderSubscription(
      request({
        deviceToken: 'a'.repeat(32),
        homeTimeZone: 'Australia/Sydney',
        oneDayEnabled: true,
        oneWeekEnabled: true,
        platform: 'android',
      }),
      {
        saveSubscription: async (record) => {
          saved = record;
        },
        takeSourceAllowance: async () => true,
      },
    );
    assert.equal(result.status, 201);
    const body = result.jsonBody as {
      credential: string;
      installationId: string;
    };
    assert.equal(saved?.credentialHash === body.credential, false);
    assert.equal(saved?.deviceToken, 'a'.repeat(32));
  });

  it('rejects arbitrary fields and throttled sources without exposing request values', async () => {
    const store = {
      saveSubscription: async () => assert.fail('must not save'),
      takeSourceAllowance: async () => false,
    };
    const result = await registerReminderSubscription(
      request({ arbitrary: 'never accepted' }),
      store,
    );
    assert.equal(result.status, 429);
    assert.deepEqual(result.jsonBody, { error: 'Try again later' });
  });
});
