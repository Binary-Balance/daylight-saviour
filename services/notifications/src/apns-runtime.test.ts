import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import {
  createApnsProviderTokenProvider,
  createNodeApnsHttpTransport,
} from './apns-runtime.js';
import type { ApnsHttpRequest } from './apns-change-reminder-sender.js';

const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privateKey = keys.privateKey
  .export({ format: 'pem', type: 'pkcs8' })
  .toString();
const fixedNow = new Date('2026-08-25T01:02:03.000Z');

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

    assert.deepEqual(await transport.post(apnsRequest), {
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

  it('rejects bounded transport failures and closes the session', async () => {
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

      await assert.rejects(transport.post(request()));
      assert.equal(sessionClosed, 1, event);
      assert.equal(streamClosed, 1, event);
    }
  });
});
