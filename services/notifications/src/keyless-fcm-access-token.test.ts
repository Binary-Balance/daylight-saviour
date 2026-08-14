import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createKeylessFcmAccessTokenProvider,
  type KeylessFcmFetch,
  type KeylessFcmLogEvent,
} from './keyless-fcm-access-token.js';

const now = new Date('2026-07-28T01:00:00.000Z');
const entraAssertion = 'sensitive-entra-assertion';
const federatedToken = 'sensitive-federated-token';
const fcmToken = 'sensitive-fcm-token';
const workloadIdentityProvider =
  '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/portable-pool/providers/azure-runtime';
const serviceAccountEmail =
  'portable-fcm-sender@portable-project.iam.gserviceaccount.com';

interface RecordedRequest {
  readonly body: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly input: string;
  readonly method: 'POST';
}

function response(status: number, body: unknown) {
  return {
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function harness(
  responses: readonly ReturnType<typeof response>[],
  options: {
    readonly assertionExpiresOnTimestamp?: number;
    readonly transportFailureAt?: number;
  } = {},
) {
  const events: KeylessFcmLogEvent[] = [];
  const requests: RecordedRequest[] = [];
  const audiences: string[] = [];
  let responseIndex = 0;
  const fetch: KeylessFcmFetch = async (input, init) => {
    const currentRequest = responseIndex;
    requests.push({
      body: init.body,
      headers: init.headers,
      input,
      method: init.method,
    });
    if (options.transportFailureAt === currentRequest) {
      throw new Error(
        `sensitive transport ${entraAssertion} ${federatedToken} ${fcmToken}`,
      );
    }
    const next = responses[responseIndex];
    responseIndex += 1;
    if (next === undefined) throw new Error('unexpected fetch');
    return next;
  };
  const provider = createKeylessFcmAccessTokenProvider(
    {
      entraAssertionAudience: 'api://portable-google-federation',
      managedIdentityClientId: '11111111-2222-4333-8444-555555555555',
      serviceAccountEmail,
      workloadIdentityProvider,
    },
    {
      clock: () => now,
      createCredential: () => ({
        getToken: async (audience) => {
          audiences.push(audience);
          return {
            expiresOnTimestamp:
              options.assertionExpiresOnTimestamp ??
              now.getTime() + 30 * 60 * 1000,
            token: entraAssertion,
          };
        },
      }),
      fetch,
      logger: { write: (event) => events.push(event) },
    },
  );
  return { audiences, events, provider, requests };
}

function successfulResponses() {
  return [
    response(200, {
      access_token: federatedToken,
      expires_in: 1800,
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      token_type: 'Bearer',
    }),
    response(200, {
      accessToken: fcmToken,
      expireTime: '2026-07-28T01:30:00.000Z',
    }),
  ] as const;
}

describe('keyless FCM access-token provider', () => {
  it('exchanges one managed-identity assertion for an exact service-account FCM token', async () => {
    const test = harness(successfulResponses());

    const token = await test.provider.getAccessToken();

    assert.deepEqual(token, {
      expiresAt: new Date('2026-07-28T01:30:00.000Z'),
      value: fcmToken,
    });
    assert.deepEqual(test.audiences, [
      'api://portable-google-federation/.default',
    ]);
    assert.deepEqual(test.requests, [
      {
        body: new URLSearchParams({
          audience: workloadIdentityProvider,
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          scope: 'https://www.googleapis.com/auth/cloud-platform',
          subject_token: entraAssertion,
          subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        }).toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        input: 'https://sts.googleapis.com/v1/token',
        method: 'POST',
      },
      {
        body: JSON.stringify({
          lifetime: '3600s',
          scope: ['https://www.googleapis.com/auth/firebase.messaging'],
        }),
        headers: {
          Authorization: `Bearer ${federatedToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        input:
          'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' +
          'portable-fcm-sender%40portable-project.iam.gserviceaccount.com:generateAccessToken',
        method: 'POST',
      },
    ]);
    assert.deepEqual(test.events, ['fcm-credential-ready']);
  });

  it('accepts a 90-minute Entra assertion for STS and impersonation', async () => {
    const test = harness(successfulResponses(), {
      assertionExpiresOnTimestamp: now.getTime() + 90 * 60 * 1000,
    });

    assert.deepEqual(await test.provider.getAccessToken(), {
      expiresAt: new Date('2026-07-28T01:30:00.000Z'),
      value: fcmToken,
    });
    assert.equal(test.requests.length, 2);
    assert.deepEqual(test.events, ['fcm-credential-ready']);
  });

  it('classifies provider denial without logging credentials or response bodies', async () => {
    const sensitiveBody = `denied ${entraAssertion} ${federatedToken} ${fcmToken}`;
    const test = harness([response(403, sensitiveBody)]);

    await assert.rejects(
      test.provider.getAccessToken(),
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'FCM credential acquisition failed: sts-denied',
    );

    assert.deepEqual(test.events, ['fcm-credential-sts-denied']);
    const logs = JSON.stringify(test.events);
    assert.doesNotMatch(logs, /sensitive-/);
    assert.doesNotMatch(logs, new RegExp(entraAssertion));
    assert.doesNotMatch(logs, new RegExp(federatedToken));
    assert.doesNotMatch(logs, new RegExp(fcmToken));
  });

  it('distinguishes STS and impersonation transport failures from provider denial', async () => {
    const stsTransport = harness(successfulResponses(), {
      transportFailureAt: 0,
    });
    await assert.rejects(
      stsTransport.provider.getAccessToken(),
      /sts-transport/,
    );
    assert.deepEqual(stsTransport.events, ['fcm-credential-sts-transport']);

    const impersonationTransport = harness(successfulResponses(), {
      transportFailureAt: 1,
    });
    await assert.rejects(
      impersonationTransport.provider.getAccessToken(),
      /impersonation-transport/,
    );
    assert.deepEqual(impersonationTransport.events, [
      'fcm-credential-impersonation-transport',
    ]);

    const logs = JSON.stringify([
      ...stsTransport.events,
      ...impersonationTransport.events,
    ]);
    assert.doesNotMatch(logs, /sensitive/);
    assert.doesNotMatch(logs, new RegExp(entraAssertion));
    assert.doesNotMatch(logs, new RegExp(federatedToken));
    assert.doesNotMatch(logs, new RegExp(fcmToken));
  });

  it('rejects expired and overlong credentials at every exchange boundary', async () => {
    const expiredAssertion = harness(successfulResponses(), {
      assertionExpiresOnTimestamp: now.getTime(),
    });
    await assert.rejects(
      expiredAssertion.provider.getAccessToken(),
      /entra-expired/,
    );
    assert.deepEqual(expiredAssertion.requests, []);
    assert.deepEqual(expiredAssertion.events, ['fcm-credential-entra-expired']);

    const expiredFederation = harness([
      response(200, {
        access_token: federatedToken,
        expires_in: 0,
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        token_type: 'Bearer',
      }),
    ]);
    await assert.rejects(
      expiredFederation.provider.getAccessToken(),
      /sts-expired/,
    );
    assert.deepEqual(expiredFederation.events, ['fcm-credential-sts-expired']);

    const overlongFcm = harness([
      successfulResponses()[0],
      response(200, {
        accessToken: fcmToken,
        expireTime: '2026-07-28T02:00:00.001Z',
      }),
    ]);
    await assert.rejects(
      overlongFcm.provider.getAccessToken(),
      /impersonation-expired/,
    );
    assert.deepEqual(overlongFcm.events, [
      'fcm-credential-impersonation-expired',
    ]);
  });

  it('fails closed on malformed responses at both Google boundaries', async () => {
    const malformedSts = harness([response(200, { access_token: fcmToken })]);
    await assert.rejects(
      malformedSts.provider.getAccessToken(),
      /sts-malformed/,
    );
    assert.deepEqual(malformedSts.events, ['fcm-credential-sts-malformed']);

    const malformedImpersonation = harness([
      successfulResponses()[0],
      response(200, { accessToken: fcmToken, unexpected: true }),
    ]);
    await assert.rejects(
      malformedImpersonation.provider.getAccessToken(),
      /impersonation-malformed/,
    );
    assert.deepEqual(malformedImpersonation.events, [
      'fcm-credential-impersonation-malformed',
    ]);
  });

  it('classifies a bounded exchange timeout without leaking transport errors', async () => {
    const events: KeylessFcmLogEvent[] = [];
    const provider = createKeylessFcmAccessTokenProvider(
      {
        entraAssertionAudience: 'api://portable-google-federation',
        managedIdentityClientId: '11111111-2222-4333-8444-555555555555',
        serviceAccountEmail,
        workloadIdentityProvider,
      },
      {
        clock: () => now,
        createCredential: () => ({
          getToken: async () => ({
            expiresOnTimestamp: now.getTime() + 30 * 60 * 1000,
            token: entraAssertion,
          }),
        }),
        fetch: async (_input, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(new Error(`timeout ${fcmToken}`)),
            );
          }),
        logger: { write: (event) => events.push(event) },
        timeoutMs: 1,
      },
    );

    await assert.rejects(provider.getAccessToken(), /timeout/);

    assert.deepEqual(events, ['fcm-credential-timeout']);
    assert.doesNotMatch(JSON.stringify(events), /sensitive-/);
  });
});
