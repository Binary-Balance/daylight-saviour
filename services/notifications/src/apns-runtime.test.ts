import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, it, type TestContext } from 'node:test';

import {
  createApnsProviderTokenProvider,
  createNodeApnsHttpTransport,
} from './apns-runtime.ts';
import type { ApnsHttpRequest } from './apns-change-reminder-sender.ts';

const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privateKey = keys.privateKey
  .export({ format: 'pem', type: 'pkcs8' })
  .toString();
const fixedNow = new Date('2026-08-25T01:02:03.000Z');

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

function decode(value: string) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function request(): ApnsHttpRequest {
  return {
    endpoint: new URL('https://api.sandbox.push.apple.com/3/device/aa'),
    headers: {
      authorization: 'bearer token',
      'content-type': 'application/json',
    },
    httpVersion: '2',
    method: 'POST',
    payload: {
      aps: { alert: { body: 'Body', title: 'Title' }, sound: 'default' },
      body: {
        changeDirection: 'forward',
        changeEventAt: fixedNow.toISOString(),
        homeTimeZone: 'Australia/Sydney',
        reminderKind: 'change-reminder',
        reminderTiming: 'one-week',
      },
    },
  };
}

describe('APNs runtime', () => {
  it('creates and caches a valid short-lived ES256 provider JWT', async () => {
    let now = fixedNow;
    const provider = createApnsProviderTokenProvider(
      { keyId: 'ABCDE12345', privateKey, teamId: 'ZYXWV98765' },
      { clock: () => now },
    );
    const token = await provider.getProviderToken();
    const [header, claims, signature] = token.split('.');

    assert.deepEqual(decode(header!), { alg: 'ES256', kid: 'ABCDE12345' });
    assert.deepEqual(decode(claims!), {
      iat: Math.floor(fixedNow.getTime() / 1000),
      iss: 'ZYXWV98765',
    });
    assert.equal(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        { dsaEncoding: 'ieee-p1363', key: keys.publicKey },
        Buffer.from(signature!, 'base64url'),
      ),
      true,
    );
    now = new Date(now.getTime() + 49 * 60 * 1000);
    assert.equal(await provider.getProviderToken(), token);
    now = new Date(now.getTime() + 60 * 1000);
    const refreshed = await provider.getProviderToken();
    assert.notEqual(refreshed, token);
    assert.equal(
      decode(refreshed.split('.')[1]!).iat,
      Math.floor(now.getTime() / 1000),
    );
  });

  it('fails closed for malformed identifiers and non-P-256 keys', () => {
    const ed25519 = generateKeyPairSync('ed25519')
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    assert.throws(
      () =>
        createApnsProviderTokenProvider({
          keyId: 'too-short',
          privateKey,
          teamId: 'ZYXWV98765',
        }),
      /key ID/,
    );
    assert.throws(
      () =>
        createApnsProviderTokenProvider({
          keyId: 'ABCDE12345',
          privateKey: ed25519,
          teamId: 'ZYXWV98765',
        }),
      /P-256/,
    );
    assert.throws(() =>
      createApnsProviderTokenProvider({
        keyId: 'ABCDE12345',
        privateKey: 'not a PEM key',
        teamId: 'ZYXWV98765',
      }),
    );
  });

  it('maps one request through HTTP/2 and closes the session', async () => {
    const stream = Object.assign(new EventEmitter(), {
      close() {},
      end(payload: string) {
        queueMicrotask(() => {
          stream.emit('response', {
            ':status': 200,
            'apns-id': '12345678-1234-1234-1234-123456789abc',
          });
          stream.emit('data', Buffer.from(''));
          stream.emit('end');
        });
        actualPayload = payload;
      },
    });
    let headers: Record<string, string> | undefined;
    let actualPayload: string | undefined;
    let closes = 0;
    const session = Object.assign(new EventEmitter(), {
      close: () => {
        closes += 1;
      },
      request: (actualHeaders: Record<string, string>) => {
        headers = actualHeaders;
        return stream;
      },
    });
    const transport = createNodeApnsHttpTransport({
      connect: () => session as never,
    });
    const apnsRequest = request();

    assert.deepEqual(await settled(transport.post(apnsRequest)), {
      body: '',
      apnsId: '12345678-1234-1234-1234-123456789abc',
      status: 200,
    });
    assert.deepEqual(headers, {
      ':method': 'POST',
      ':path': '/3/device/aa',
      authorization: 'bearer token',
      'content-type': 'application/json',
    });
    assert.equal(actualPayload, JSON.stringify(apnsRequest.payload));
    assert.equal(closes, 1);
  });

  describe('transport settlement', () => {
    const timeoutMs = 4_321;

    // Runs one request against a stream driven by `emit`, and counts the calls
    // that show whether the request settled once and cleared its timer once.
    async function settle(
      t: TestContext,
      emit: (stream: EventEmitter, session: EventEmitter) => void,
    ) {
      const setTimer = t.mock.method(globalThis, 'setTimeout');
      const clearTimer = t.mock.method(globalThis, 'clearTimeout');
      let streamClosed = 0;
      const stream = Object.assign(new EventEmitter(), {
        close() {
          streamClosed += 1;
        },
        end() {
          queueMicrotask(() => emit(stream, session));
        },
      });
      const session = Object.assign(new EventEmitter(), {
        close() {},
        request: () => stream,
      });
      const outcome = settled(
        createNodeApnsHttpTransport({
          connect: () => session as never,
          timeoutMs,
        }).post(request()),
      ).then(
        (response) => ({ response }),
        (error: Error) => ({ error }),
      );

      const result = await outcome;
      const timer = setTimer.mock.calls.find(
        (call) => call.arguments[1] === timeoutMs,
      )?.result;
      const timerClears = clearTimer.mock.calls.filter(
        (call) => call.arguments[0] === timer,
      ).length;
      return { result, streamClosed, timerClears };
    }

    for (const [name, requestTimeoutMs, expected] of [
      ['shortens', 1_234, 1_234],
      ['never extends', 60_000, timeoutMs],
    ] as const) {
      it(`${name} its limit for a request deadline`, async (t) => {
        const setTimer = t.mock.method(globalThis, 'setTimeout');
        const stream = Object.assign(new EventEmitter(), {
          end() {
            queueMicrotask(() => {
              stream.emit('response', { ':status': 200 });
              stream.emit('end');
            });
          },
        });
        const session = Object.assign(new EventEmitter(), {
          close() {},
          request: () => stream,
        });

        await settled(
          createNodeApnsHttpTransport({
            connect: () => session as never,
            timeoutMs,
          }).post({ ...request(), timeoutMs: requestTimeoutMs }),
        );

        assert.ok(
          setTimer.mock.calls.some((call) => call.arguments[1] === expected),
        );
      });
    }

    it('ignores a stream error after the response has ended', async (t) => {
      const { result, streamClosed, timerClears } = await settle(
        t,
        (stream) => {
          stream.emit('response', { ':status': 200 });
          stream.emit('end');
          stream.emit('error', new Error('late failure'));
        },
      );

      assert.deepEqual(result, { response: { body: '', status: 200 } });
      assert.equal(streamClosed, 0);
      assert.equal(timerClears, 1);
    });

    it('settles only once when failures and the end arrive together', async (t) => {
      const failure = new Error('first failure');
      const { result, streamClosed, timerClears } = await settle(
        t,
        (stream, session) => {
          stream.emit('response', { ':status': 200 });
          session.emit('error', failure);
          stream.emit('error', new Error('second failure'));
          stream.emit('end');
        },
      );

      assert.deepEqual(result, { error: failure });
      assert.equal(streamClosed, 1);
      assert.equal(timerClears, 1);
    });
  });

  it('rejects bounded transport failures and closes the session', async () => {
    const failures = {
      error: { message: 'transport failure' },
      oversized: { message: 'APNs response body exceeded limit' },
      timeout: { message: 'APNs transport timeout' },
    };
    for (const event of ['oversized', 'error', 'timeout'] as const) {
      const stream = Object.assign(new EventEmitter(), {
        close() {
          streamClosed += 1;
        },
        end() {
          queueMicrotask(() => {
            if (event === 'oversized') {
              stream.emit('response', { ':status': 500 });
              stream.emit('data', Buffer.alloc(64 * 1024 + 1));
            } else if (event === 'error') {
              stream.emit('error', new Error('transport failure'));
            }
          });
        },
      });
      let sessionClosed = 0;
      let streamClosed = 0;
      const session = Object.assign(new EventEmitter(), {
        close() {
          sessionClosed += 1;
        },
        request: () => stream,
      });
      const transport = createNodeApnsHttpTransport({
        connect: () => session as never,
        timeoutMs: 1,
      });

      await assert.rejects(
        settled(transport.post(request())),
        failures[event],
        event,
      );
      assert.equal(sessionClosed, 1, event);
      assert.equal(streamClosed, 1, event);
    }
  });
});
