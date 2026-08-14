import { ManagedIdentityCredential } from '@azure/identity';

import type {
  FcmAccessToken,
  FcmAccessTokenProvider,
} from './fcm-change-reminder-sender.js';

const googleStsEndpoint = 'https://sts.googleapis.com/v1/token';
const googleIamCredentialsOrigin = 'https://iamcredentials.googleapis.com';
const cloudPlatformScope = 'https://www.googleapis.com/auth/cloud-platform';
const firebaseMessagingScope =
  'https://www.googleapis.com/auth/firebase.messaging';
const tokenExchangeGrant = 'urn:ietf:params:oauth:grant-type:token-exchange';
const accessTokenType = 'urn:ietf:params:oauth:token-type:access_token';
const jwtTokenType = 'urn:ietf:params:oauth:token-type:jwt';
const maximumTokenLifetimeMs = 60 * 60 * 1000;
const maximumResponseCharacters = 64 * 1024;
const maximumTokenCharacters = 16 * 1024;
const defaultTimeoutMs = 10_000;
const clientIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const serviceAccountPattern =
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const workloadIdentityProviderPattern =
  /^\/\/iam\.googleapis\.com\/projects\/[1-9][0-9]{5,19}\/locations\/global\/workloadIdentityPools\/[a-z][a-z0-9-]{2,30}[a-z0-9]\/providers\/[a-z][a-z0-9-]{2,30}[a-z0-9]$/;

export type KeylessFcmFailure =
  | 'entra-denied'
  | 'entra-expired'
  | 'entra-malformed'
  | 'impersonation-denied'
  | 'impersonation-expired'
  | 'impersonation-malformed'
  | 'impersonation-transport'
  | 'sts-denied'
  | 'sts-expired'
  | 'sts-malformed'
  | 'sts-transport'
  | 'timeout';

export type KeylessFcmLogEvent =
  | 'fcm-credential-ready'
  | `fcm-credential-${KeylessFcmFailure}`;

export interface KeylessFcmLogger {
  readonly write: (event: KeylessFcmLogEvent) => void;
}

export interface KeylessFcmConfiguration {
  readonly entraAssertionAudience: string;
  readonly managedIdentityClientId: string;
  readonly serviceAccountEmail: string;
  readonly workloadIdentityProvider: string;
}

export interface ManagedIdentityAssertion {
  readonly expiresOnTimestamp: number;
  readonly token: string;
}

export interface ManagedIdentityAssertionCredential {
  readonly getToken: (
    scope: string,
  ) => Promise<ManagedIdentityAssertion | null>;
}

interface KeylessFcmFetchResponse {
  readonly status: number;
  readonly text: () => Promise<string>;
}

interface KeylessFcmFetchRequest {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: 'POST';
  readonly signal: AbortSignal;
}

export type KeylessFcmFetch = (
  input: string,
  init: KeylessFcmFetchRequest,
) => Promise<KeylessFcmFetchResponse>;

export interface KeylessFcmDependencies {
  readonly clock?: () => Date;
  readonly createCredential?: (
    clientId: string,
  ) => ManagedIdentityAssertionCredential;
  readonly fetch?: KeylessFcmFetch;
  readonly logger: KeylessFcmLogger;
  readonly timeoutMs?: number;
}

export class KeylessFcmAccessTokenError extends Error {
  constructor(readonly kind: KeylessFcmFailure) {
    super(`FCM credential acquisition failed: ${kind}`);
  }
}

class ExchangeTimeoutError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasAllowedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumTokenCharacters &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint >= 0x21 && codePoint <= 0x7e;
    })
  );
}

function validExpiry(expiresAt: Date, now: Date) {
  const lifetime = expiresAt.getTime() - now.getTime();
  return (
    Number.isFinite(expiresAt.getTime()) &&
    lifetime > 0 &&
    lifetime <= maximumTokenLifetimeMs
  );
}

function validFutureTimestamp(timestamp: number, now: Date) {
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function parseResponseBody(body: string): unknown | undefined {
  if (body.length === 0 || body.length > maximumResponseCharacters) {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function assertConfiguration(configuration: KeylessFcmConfiguration) {
  if (!clientIdPattern.test(configuration.managedIdentityClientId)) {
    throw new Error('Invalid FCM managed-identity client ID');
  }
  if (
    configuration.entraAssertionAudience.length > 512 ||
    !/^(?:api|https):\/\/[A-Za-z0-9._~:/-]+$/.test(
      configuration.entraAssertionAudience,
    ) ||
    configuration.entraAssertionAudience.endsWith('/.default')
  ) {
    throw new Error('Invalid FCM Entra assertion audience');
  }
  if (!serviceAccountPattern.test(configuration.serviceAccountEmail)) {
    throw new Error('Invalid FCM service-account email');
  }
  if (
    !workloadIdentityProviderPattern.test(
      configuration.workloadIdentityProvider,
    )
  ) {
    throw new Error('Invalid FCM workload-identity provider');
  }
}

function report(logger: KeylessFcmLogger, event: KeylessFcmLogEvent): void {
  try {
    logger.write(event);
  } catch {
    // Logging must not change credential acquisition.
  }
}

async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ExchangeTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readResponse(
  fetch: KeylessFcmFetch,
  timeoutMs: number,
  input: string,
  init: Omit<KeylessFcmFetchRequest, 'signal'>,
) {
  return withTimeout(timeoutMs, async (signal) => {
    const response = await fetch(input, { ...init, signal });
    return {
      body: parseResponseBody(await response.text()),
      status: response.status,
    };
  });
}

function defaultCredential(
  clientId: string,
): ManagedIdentityAssertionCredential {
  return new ManagedIdentityCredential(clientId);
}

function defaultFetch(
  input: string,
  init: KeylessFcmFetchRequest,
): Promise<KeylessFcmFetchResponse> {
  return fetch(input, init);
}

export function createKeylessFcmAccessTokenProvider(
  configuration: KeylessFcmConfiguration,
  dependencies: KeylessFcmDependencies,
): FcmAccessTokenProvider {
  assertConfiguration(configuration);
  const clock = dependencies.clock ?? (() => new Date());
  const createCredential = dependencies.createCredential ?? defaultCredential;
  const exchangeFetch = dependencies.fetch ?? defaultFetch;
  const timeoutMs = dependencies.timeoutMs ?? defaultTimeoutMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 60_000
  ) {
    throw new Error('Invalid FCM credential timeout');
  }
  const credential = createCredential(configuration.managedIdentityClientId);

  return {
    async getAccessToken(): Promise<FcmAccessToken> {
      let assertion: ManagedIdentityAssertion | null;
      try {
        assertion = await withTimeout(timeoutMs, () =>
          credential.getToken(
            `${configuration.entraAssertionAudience}/.default`,
          ),
        );
      } catch (error) {
        const kind =
          error instanceof ExchangeTimeoutError ? 'timeout' : 'entra-denied';
        report(dependencies.logger, `fcm-credential-${kind}`);
        throw new KeylessFcmAccessTokenError(kind);
      }
      if (assertion === null || !validToken(assertion.token)) {
        report(dependencies.logger, 'fcm-credential-entra-malformed');
        throw new KeylessFcmAccessTokenError('entra-malformed');
      }
      if (
        !Number.isSafeInteger(assertion.expiresOnTimestamp) ||
        !validFutureTimestamp(assertion.expiresOnTimestamp, clock())
      ) {
        report(dependencies.logger, 'fcm-credential-entra-expired');
        throw new KeylessFcmAccessTokenError('entra-expired');
      }

      let stsResponse: Awaited<ReturnType<typeof readResponse>>;
      try {
        stsResponse = await readResponse(
          exchangeFetch,
          timeoutMs,
          googleStsEndpoint,
          {
            body: new URLSearchParams({
              audience: configuration.workloadIdentityProvider,
              grant_type: tokenExchangeGrant,
              requested_token_type: accessTokenType,
              scope: cloudPlatformScope,
              subject_token: assertion.token,
              subject_token_type: jwtTokenType,
            }).toString(),
            headers: {
              'Content-Type':
                'application/x-www-form-urlencoded; charset=utf-8',
            },
            method: 'POST',
          },
        );
      } catch (error) {
        const kind =
          error instanceof ExchangeTimeoutError ? 'timeout' : 'sts-transport';
        report(dependencies.logger, `fcm-credential-${kind}`);
        throw new KeylessFcmAccessTokenError(kind);
      }
      if (stsResponse.status !== 200) {
        report(dependencies.logger, 'fcm-credential-sts-denied');
        throw new KeylessFcmAccessTokenError('sts-denied');
      }
      const sts = stsResponse.body;
      if (
        !isRecord(sts) ||
        !hasAllowedKeys(sts, [
          'access_token',
          'expires_in',
          'issued_token_type',
          'scope',
          'token_type',
        ]) ||
        !validToken(sts.access_token) ||
        sts.issued_token_type !== accessTokenType ||
        sts.token_type !== 'Bearer' ||
        (sts.scope !== undefined && sts.scope !== cloudPlatformScope) ||
        !Number.isSafeInteger(sts.expires_in)
      ) {
        report(dependencies.logger, 'fcm-credential-sts-malformed');
        throw new KeylessFcmAccessTokenError('sts-malformed');
      }
      if (
        typeof sts.expires_in !== 'number' ||
        sts.expires_in <= 0 ||
        sts.expires_in * 1000 > maximumTokenLifetimeMs
      ) {
        report(dependencies.logger, 'fcm-credential-sts-expired');
        throw new KeylessFcmAccessTokenError('sts-expired');
      }

      const endpoint = new URL(
        `/v1/projects/-/serviceAccounts/${encodeURIComponent(configuration.serviceAccountEmail)}:generateAccessToken`,
        googleIamCredentialsOrigin,
      ).toString();
      let impersonationResponse: Awaited<ReturnType<typeof readResponse>>;
      try {
        impersonationResponse = await readResponse(
          exchangeFetch,
          timeoutMs,
          endpoint,
          {
            body: JSON.stringify({
              lifetime: '3600s',
              scope: [firebaseMessagingScope],
            }),
            headers: {
              Authorization: `Bearer ${sts.access_token}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
            method: 'POST',
          },
        );
      } catch (error) {
        const kind =
          error instanceof ExchangeTimeoutError
            ? 'timeout'
            : 'impersonation-transport';
        report(dependencies.logger, `fcm-credential-${kind}`);
        throw new KeylessFcmAccessTokenError(kind);
      }
      if (impersonationResponse.status !== 200) {
        report(dependencies.logger, 'fcm-credential-impersonation-denied');
        throw new KeylessFcmAccessTokenError('impersonation-denied');
      }
      const impersonation = impersonationResponse.body;
      if (
        !isRecord(impersonation) ||
        !hasAllowedKeys(impersonation, ['accessToken', 'expireTime']) ||
        !validToken(impersonation.accessToken) ||
        typeof impersonation.expireTime !== 'string'
      ) {
        report(dependencies.logger, 'fcm-credential-impersonation-malformed');
        throw new KeylessFcmAccessTokenError('impersonation-malformed');
      }
      const expiresAt = new Date(impersonation.expireTime);
      if (!validExpiry(expiresAt, clock())) {
        report(dependencies.logger, 'fcm-credential-impersonation-expired');
        throw new KeylessFcmAccessTokenError('impersonation-expired');
      }
      report(dependencies.logger, 'fcm-credential-ready');
      return { expiresAt, value: impersonation.accessToken };
    },
  };
}
