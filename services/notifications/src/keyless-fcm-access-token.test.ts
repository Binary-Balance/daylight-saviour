import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
  createKeylessFcmAccessTokenProvider,
  type KeylessFcmFetch,
  type KeylessFcmLogEvent,
  type ManagedIdentityAssertion,
} from './keyless-fcm-access-token.ts';

const now = new Date('2026-07-28T01:00:00.000Z');
const entraAssertion = 'sensitive-entra-assertion';
const federatedToken = 'sensitive-federated-token';
const fcmToken = 'sensitive-fcm-token';
const workloadIdentityProvider =
  '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/portable-pool/providers/azure-runtime';
const serviceAccountEmail =
  'portable-fcm-sender@portable-project.iam.gserviceaccount.com';
const configuration = {
  entraAssertionAudience: 'api://portable-google-federation',
  managedIdentityClientId: '11111111-2222-4333-8444-555555555555',
  serviceAccountEmail,
  workloadIdentityProvider,
};

interface RecordedRequest {
  readonly body: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly input: string;
  readonly method: 'POST';
}

// Fails a test whose awaited work never settles, instead of letting it hang.
// Seshat treats a hang, or node:test's own timeout, as an unresolved mutant
// and then withholds the mutation score.
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
    readonly getToken?: () => Promise<ManagedIdentityAssertion | null>;
    readonly timeoutMs?: number;
    readonly transportFailureAt?: number;
  } = {},
) {
  const events: KeylessFcmLogEvent[] = [];
  const requests: RecordedRequest[] = [];
  const signals: AbortSignal[] = [];
  const audiences: string[] = [];
  let responseIndex = 0;
  const fetch: KeylessFcmFetch = async (input, init) => {
    const currentRequest = responseIndex;
    signals.push(init.signal);
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
        getToken:
          options.getToken ??
          (async (audience) => {
            audiences.push(audience);
            return {
              expiresOnTimestamp:
                options.assertionExpiresOnTimestamp ??
                now.getTime() + 30 * 60 * 1000,
              token: entraAssertion,
            };
          }),
      }),
      fetch,
      logger: { write: (event) => events.push(event) },
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    },
  );
  return { audiences, events, provider, requests, signals };
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

function stsBody(overrides: Record<string, unknown> = {}) {
  return {
    access_token: federatedToken,
    expires_in: 1800,
    issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    token_type: 'Bearer',
    ...overrides,
  };
}

function impersonationBody(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: fcmToken,
    expireTime: '2026-07-28T01:30:00.000Z',
    ...overrides,
  };
}

function providerWithTimeout(timeoutMs: number) {
  return createKeylessFcmAccessTokenProvider(configuration, {
    createCredential: () => ({ getToken: async () => null }),
    fetch: async () => {
      throw new Error('request made');
    },
    logger: { write: () => undefined },
    timeoutMs,
  });
}

describe('keyless FCM access-token provider', () => {
  for (const [invalid, message] of [
    [
      { managedIdentityClientId: 'not-a-client-id' },
      'Invalid FCM managed-identity client ID',
    ],
    [
      { entraAssertionAudience: 'ftp://portable-google-federation' },
      'Invalid FCM Entra assertion audience',
    ],
    [
      { entraAssertionAudience: `api://${'a'.repeat(507)}` },
      'Invalid FCM Entra assertion audience',
    ],
    [
      { entraAssertionAudience: 'api://portable-google-federation/.default' },
      'Invalid FCM Entra assertion audience',
    ],
    [
      { serviceAccountEmail: 'someone@example.com' },
      'Invalid FCM service-account email',
    ],
    [
      { workloadIdentityProvider: 'projects/123456/providers/fcm' },
      'Invalid FCM workload-identity provider',
    ],
  ] as const) {
    it(`rejects before creating a credential: ${message}`, () => {
      assert.throws(
        () =>
          createKeylessFcmAccessTokenProvider(
            {
              entraAssertionAudience: 'api://portable-google-federation',
              managedIdentityClientId: '11111111-2222-4333-8444-555555555555',
              serviceAccountEmail,
              workloadIdentityProvider,
              ...invalid,
            },
            {
              createCredential: () => {
                throw new Error('credential created');
              },
              fetch: async () => {
                throw new Error('request made');
              },
              logger: { write: () => undefined },
            },
          ),
        { message },
      );
    });
  }

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
          lifetime: '3300s',
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

  it('accepts an IAM expiry within the request clock-skew margin', async () => {
    const test = harness([
      successfulResponses()[0],
      response(200, {
        accessToken: fcmToken,
        expireTime: '2026-07-28T01:59:00.000Z',
      }),
    ]);

    assert.deepEqual(await test.provider.getAccessToken(), {
      expiresAt: new Date('2026-07-28T01:59:00.000Z'),
      value: fcmToken,
    });
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

    await assert.rejects(settled(provider.getAccessToken()), /timeout/);

    assert.deepEqual(events, ['fcm-credential-timeout']);
    assert.doesNotMatch(JSON.stringify(events), /sensitive-/);
  });

  it('accepts an Entra assertion audience of exactly 512 characters', () => {
    const entraAssertionAudience = `api://${'a'.repeat(506)}`;
    assert.equal(entraAssertionAudience.length, 512);

    assert.doesNotThrow(() =>
      createKeylessFcmAccessTokenProvider(
        { ...configuration, entraAssertionAudience },
        {
          createCredential: () => ({ getToken: async () => null }),
          fetch: async () => {
            throw new Error('request made');
          },
          logger: { write: () => undefined },
        },
      ),
    );
  });

  for (const timeoutMs of [0, -1, 1.5, Number.NaN, 60_001]) {
    it(`rejects a credential timeout of ${timeoutMs}`, () => {
      assert.throws(() => providerWithTimeout(timeoutMs), {
        message: 'Invalid FCM credential timeout',
      });
    });
  }

  for (const timeoutMs of [1, 60_000]) {
    it(`accepts a credential timeout of ${timeoutMs}`, () => {
      assert.doesNotThrow(() => providerWithTimeout(timeoutMs));
    });
  }

  it('rejects a missing assertion as malformed', async () => {
    const test = harness(successfulResponses(), { getToken: async () => null });

    await assert.rejects(() => test.provider.getAccessToken(), {
      kind: 'entra-malformed',
    });

    assert.deepEqual(test.events, ['fcm-credential-entra-malformed']);
    assert.deepEqual(test.requests, []);
  });

  for (const [name, token] of [
    ['an empty token', ''],
    ['a token with a space', 'has space'],
    ['a token with a control character', 'has\ttab'],
    ['a token with a DEL character', 'has\x7fdel'],
    ['a token with a non-ASCII character', 'tok\u00e9n'],
    ['a token longer than 16 KiB', 'a'.repeat(16 * 1024 + 1)],
    // The type says text. A list has a length, as text does, so a check that
    // only looked at the length would let it through.
    ['a token that is not text', 12345],
    ['a token that is a list', ['abc']],
    ['a missing token', undefined],
  ] as const) {
    it(`rejects ${name} as a malformed Entra assertion`, async () => {
      const test = harness(successfulResponses(), {
        getToken: async () =>
          ({ expiresOnTimestamp: now.getTime() + 60_000, token }) as never,
      });

      await assert.rejects(() => test.provider.getAccessToken(), {
        kind: 'entra-malformed',
      });

      assert.deepEqual(test.events, ['fcm-credential-entra-malformed']);
      assert.deepEqual(test.requests, []);
    });
  }

  it('accepts an Entra assertion of 16 KiB using the widest allowed characters', async () => {
    const token = `!~${'a'.repeat(16 * 1024 - 2)}`;
    const test = harness(successfulResponses(), {
      getToken: async () => ({
        expiresOnTimestamp: now.getTime() + 60_000,
        token,
      }),
    });

    await test.provider.getAccessToken();

    assert.equal(
      new URLSearchParams(test.requests[0]?.body).get('subject_token'),
      token,
    );
  });

  for (const [name, expiresOnTimestamp] of [
    ['already expired', now.getTime() - 1],
    ['not a number', Number.NaN],
    ['not a whole number of milliseconds', now.getTime() + 0.5],
    ['not finite', Number.POSITIVE_INFINITY],
  ] as const) {
    it(`rejects an Entra assertion that is ${name}`, async () => {
      const test = harness(successfulResponses(), {
        assertionExpiresOnTimestamp: expiresOnTimestamp,
      });

      await assert.rejects(() => test.provider.getAccessToken(), {
        kind: 'entra-expired',
      });

      assert.deepEqual(test.events, ['fcm-credential-entra-expired']);
      assert.deepEqual(test.requests, []);
    });
  }

  it('accepts an Entra assertion that expires a millisecond from now', async () => {
    const test = harness(successfulResponses(), {
      assertionExpiresOnTimestamp: now.getTime() + 1,
    });

    await test.provider.getAccessToken();

    assert.deepEqual(test.events, ['fcm-credential-ready']);
  });

  it('reports a failed credential as denied without calling Google', async () => {
    const test = harness(successfulResponses(), {
      getToken: async () => {
        throw new Error(`sensitive ${entraAssertion}`);
      },
    });

    await assert.rejects(() => test.provider.getAccessToken(), {
      kind: 'entra-denied',
    });

    assert.deepEqual(test.events, ['fcm-credential-entra-denied']);
    assert.deepEqual(test.requests, []);
  });

  it('reports a credential that never answers as a timeout', async () => {
    const test = harness(successfulResponses(), {
      getToken: () => new Promise<never>(() => undefined),
      timeoutMs: 1,
    });

    await assert.rejects(() => settled(test.provider.getAccessToken()), {
      kind: 'timeout',
    });

    assert.deepEqual(test.events, ['fcm-credential-timeout']);
    assert.deepEqual(test.requests, []);
  });

  for (const [name, body] of [
    ['an unexpected field', stsBody({ unexpected: true })],
    ['a missing access token', stsBody({ access_token: undefined })],
    ['an empty access token', stsBody({ access_token: '' })],
    ['an access token with a space', stsBody({ access_token: 'has space' })],
    ['another issued token type', stsBody({ issued_token_type: 'jwt' })],
    ['a missing issued token type', stsBody({ issued_token_type: undefined })],
    ['another token type', stsBody({ token_type: 'bearer' })],
    ['a missing token type', stsBody({ token_type: undefined })],
    [
      'another scope',
      stsBody({ scope: 'https://www.googleapis.com/auth/firebase.messaging' }),
    ],
    ['a fractional lifetime', stsBody({ expires_in: 1800.5 })],
    ['a lifetime in text', stsBody({ expires_in: '1800' })],
    ['a missing lifetime', stsBody({ expires_in: undefined })],
    ['null', 'null'],
    ['a list', '[]'],
    ['text', '"text"'],
    ['a number', '42'],
    ['an empty body', ''],
    ['a body that is not JSON', 'not json'],
  ] as const) {
    it(`rejects an STS response with ${name} as malformed`, async () => {
      const test = harness([response(200, body)]);

      await assert.rejects(() => test.provider.getAccessToken(), {
        kind: 'sts-malformed',
      });

      assert.deepEqual(test.events, ['fcm-credential-sts-malformed']);
      assert.equal(test.requests.length, 1);
    });
  }

  it('accepts an STS response that names the requested scope', async () => {
    const test = harness([
      response(
        200,
        stsBody({ scope: 'https://www.googleapis.com/auth/cloud-platform' }),
      ),
      successfulResponses()[1],
    ]);

    await test.provider.getAccessToken();

    assert.deepEqual(test.events, ['fcm-credential-ready']);
  });

  it('accepts a federated token that lasts one hour', async () => {
    const test = harness([
      response(200, stsBody({ expires_in: 3600 })),
      successfulResponses()[1],
    ]);

    await test.provider.getAccessToken();

    assert.deepEqual(test.events, ['fcm-credential-ready']);
  });

  for (const expiresIn of [3601, -1]) {
    it(`rejects a federated token that lasts ${expiresIn} seconds`, async () => {
      const test = harness([response(200, stsBody({ expires_in: expiresIn }))]);

      await assert.rejects(() => test.provider.getAccessToken(), {
        kind: 'sts-expired',
      });

      assert.deepEqual(test.events, ['fcm-credential-sts-expired']);
      assert.equal(test.requests.length, 1);
    });
  }

  it('reads an exchange response of 64 KiB but not one character more', async () => {
    // JSON allows trailing whitespace, so padding keeps the body valid.
    const sts = JSON.stringify(stsBody());
    const atLimit = harness([
      response(200, sts.padEnd(64 * 1024)),
      successfulResponses()[1],
    ]);

    await atLimit.provider.getAccessToken();

    assert.deepEqual(atLimit.events, ['fcm-credential-ready']);

    const overLimit = harness([response(200, sts.padEnd(64 * 1024 + 1))]);

    await assert.rejects(() => overLimit.provider.getAccessToken(), {
      kind: 'sts-malformed',
    });

    assert.deepEqual(overLimit.events, ['fcm-credential-sts-malformed']);
  });

  for (const status of [401, 403, 500, 201]) {
    it(`reports an impersonation response with status ${status} as denied`, async () => {
      const test = harness([
        successfulResponses()[0],
        response(status, impersonationBody()),
      ]);

      await assert.rejects(() => test.provider.getAccessToken(), {
        kind: 'impersonation-denied',
      });

      assert.deepEqual(test.events, ['fcm-credential-impersonation-denied']);
    });
  }

  for (const [name, body] of [
    ['an unexpected field', impersonationBody({ unexpected: true })],
    ['a missing access token', impersonationBody({ accessToken: undefined })],
    ['an empty access token', impersonationBody({ accessToken: '' })],
    [
      'an access token with a space',
      impersonationBody({ accessToken: 'has space' }),
    ],
    ['an expiry that is not text', impersonationBody({ expireTime: 1800 })],
    ['a missing expiry', impersonationBody({ expireTime: undefined })],
    ['null', 'null'],
    ['a list', '[]'],
    ['text', '"text"'],
    ['an empty body', ''],
    ['a body that is not JSON', 'not json'],
  ] as const) {
    it(`rejects an impersonation response with ${name} as malformed`, async () => {
      const test = harness([successfulResponses()[0], response(200, body)]);

      await assert.rejects(() => test.provider.getAccessToken(), {
        kind: 'impersonation-malformed',
      });

      assert.deepEqual(test.events, ['fcm-credential-impersonation-malformed']);
    });
  }

  for (const [name, expireTime] of [
    ['now', '2026-07-28T01:00:00.000Z'],
    ['in the past', '2026-07-28T00:00:00.000Z'],
    ['not a date', 'not-a-date'],
  ] as const) {
    it(`rejects an impersonated token whose expiry is ${name}`, async () => {
      const test = harness([
        successfulResponses()[0],
        response(200, impersonationBody({ expireTime })),
      ]);

      await assert.rejects(() => test.provider.getAccessToken(), {
        kind: 'impersonation-expired',
      });

      assert.deepEqual(test.events, ['fcm-credential-impersonation-expired']);
    });
  }

  it('accepts an impersonated token that lasts exactly one hour', async () => {
    const test = harness([
      successfulResponses()[0],
      response(
        200,
        impersonationBody({ expireTime: '2026-07-28T02:00:00.000Z' }),
      ),
    ]);

    assert.deepEqual(await test.provider.getAccessToken(), {
      expiresAt: new Date('2026-07-28T02:00:00.000Z'),
      value: fcmToken,
    });
  });

  it('aborts a request that outlasts its deadline', async () => {
    let signal: AbortSignal | undefined;
    const provider = createKeylessFcmAccessTokenProvider(configuration, {
      clock: () => now,
      createCredential: () => ({
        getToken: async () => ({
          expiresOnTimestamp: now.getTime() + 30 * 60 * 1000,
          token: entraAssertion,
        }),
      }),
      // Ignores the abort, like a stalled connection, so only the deadline
      // ends the wait.
      fetch: (_input, init) => {
        signal = init.signal;
        return new Promise<never>(() => undefined);
      },
      logger: { write: () => undefined },
      timeoutMs: 1,
    });

    await assert.rejects(() => settled(provider.getAccessToken()), {
      kind: 'timeout',
    });

    assert.equal(signal?.aborted, true);
  });

  it('stops the deadline of each request once it has completed', async () => {
    // A deadline left running would later abort a request that already
    // finished.
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const test = harness(successfulResponses());
      const outcome = { settled: false };
      void test.provider
        .getAccessToken()
        .catch(() => undefined)
        .finally(() => {
          outcome.settled = true;
        });

      await new Promise(setImmediate);
      assert.equal(outcome.settled, true);
      mock.timers.tick(10_000);

      assert.deepEqual(
        test.signals.map((signal) => signal.aborted),
        [false, false],
      );
    } finally {
      mock.timers.reset();
    }
  });
});
