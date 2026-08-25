import { createPrivateKey, sign } from 'node:crypto';
import { connect, type ClientHttp2Session } from 'node:http2';

import type {
  ApnsHttpRequest,
  ApnsHttpResponse,
  ApnsHttpTransport,
  ApnsProviderTokenProvider,
} from './apns-change-reminder-sender.js';

const providerTokenCacheMs = 50 * 60 * 1000;
const maxResponseBytes = 64 * 1024;
const defaultTimeoutMs = 10_000;
const appleIdentifierPattern = /^[A-Z0-9]{10}$/;
const apnsRequestIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export interface ApnsProviderTokenConfiguration {
  readonly keyId: string;
  readonly privateKey: string;
  readonly teamId: string;
}

export interface ApnsProviderTokenDependencies {
  readonly clock?: () => Date;
}

export interface NodeApnsHttpTransportOptions {
  readonly connect?: (authority: string) => ClientHttp2Session;
  readonly timeoutMs?: number;
}

function assertIdentifier(value: string, name: string) {
  if (!appleIdentifierPattern.test(value))
    throw new Error(`Invalid APNs ${name}`);
}

function encodedJson(value: object) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Creates short-lived APNs provider JWTs without logging or persisting private material. */
export function createApnsProviderTokenProvider(
  configuration: ApnsProviderTokenConfiguration,
  dependencies: ApnsProviderTokenDependencies = {},
): ApnsProviderTokenProvider {
  assertIdentifier(configuration.teamId, 'team ID');
  assertIdentifier(configuration.keyId, 'key ID');
  const privateKey = createPrivateKey(configuration.privateKey);
  if (
    privateKey.asymmetricKeyType !== 'ec' ||
    privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw new Error('APNs private key must use P-256');
  }
  const clock = dependencies.clock ?? (() => new Date());
  let cached: { readonly issuedAt: number; readonly value: string } | undefined;

  return {
    async getProviderToken() {
      const now = clock().getTime();
      if (!Number.isFinite(now)) throw new Error('Invalid APNs clock');
      if (
        cached !== undefined &&
        now >= cached.issuedAt &&
        now - cached.issuedAt < providerTokenCacheMs
      ) {
        return cached.value;
      }
      const value = `${encodedJson({ alg: 'ES256', kid: configuration.keyId })}.${encodedJson(
        {
          iat: Math.floor(now / 1000),
          iss: configuration.teamId,
        },
      )}`;
      const signature = sign('sha256', Buffer.from(value), {
        dsaEncoding: 'ieee-p1363',
        key: privateKey,
      });
      if (signature.byteLength !== 64)
        throw new Error('Invalid APNs signature');
      const token = `${value}.${signature.toString('base64url')}`;
      cached = { issuedAt: now, value: token };
      return token;
    },
  };
}

/** A bounded HTTP/2 APNs transport; every request owns and closes its session. */
export function createNodeApnsHttpTransport(
  options: NodeApnsHttpTransportOptions = {},
): ApnsHttpTransport {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 60_000
  ) {
    throw new Error('Invalid APNs transport timeout');
  }
  const open = options.connect ?? connect;

  return {
    async post(request: ApnsHttpRequest): Promise<ApnsHttpResponse> {
      const session = open(request.endpoint.origin);
      try {
        return await new Promise<ApnsHttpResponse>((resolve, reject) => {
          const stream = session.request({
            ':method': request.method,
            ':path': request.endpoint.pathname,
            ...request.headers,
          });
          const chunks: Buffer[] = [];
          let length = 0;
          let status: number | undefined;
          let apnsId: string | undefined;
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            stream.close();
            reject(error);
          };
          timer = setTimeout(
            () => fail(new Error('APNs transport timeout')),
            timeoutMs,
          );
          const finish = (response: ApnsHttpResponse) => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            resolve(response);
          };

          session.once('error', (error) => fail(error));
          stream.once('error', (error) => fail(error));
          stream.on('response', (headers) => {
            const value = headers[':status'];
            if (typeof value === 'number' && Number.isSafeInteger(value)) {
              status = value;
            }
            const valueId = headers['apns-id'];
            if (
              typeof valueId === 'string' &&
              apnsRequestIdPattern.test(valueId)
            ) {
              apnsId = valueId;
            }
          });
          stream.on('data', (chunk: Buffer | string) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            length += bytes.byteLength;
            if (length > maxResponseBytes) {
              fail(new Error('APNs response body exceeded limit'));
              return;
            }
            chunks.push(bytes);
          });
          stream.once('end', () => {
            if (status === undefined) {
              fail(new Error('APNs response status unavailable'));
              return;
            }
            finish({
              body: Buffer.concat(chunks).toString('utf8'),
              ...(apnsId === undefined ? {} : { apnsId }),
              status,
            });
          });
          stream.end(JSON.stringify(request.payload));
        });
      } finally {
        session.close();
      }
    },
  };
}
