import { changeReminderNotification } from '@daylight-saviour/copy/change-reminder-notification';
import type { ChangeReminderNotification } from '@daylight-saviour/contracts/reminder-subscription-runtime';
import { canonicalAustralianZoneId } from '@daylight-saviour/domain/australian-zone-runtime';

const fcmOrigin = 'https://fcm.googleapis.com';
const maxFcmResponseCharacters = 64 * 1024;
const maxFcmLifetimeMs = 28 * 24 * 60 * 60 * 1000;
// Bounds every send, so no composition can leave one waiting on a stalled
// connection. Matches the APNs transport and the FCM credential provider.
const transportTimeoutMs = 10_000;
const fcmProjectIdPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const installationIdPattern = /^[A-Za-z0-9_-]{32,128}$/;
const deviceTokenPattern = /^[A-Za-z0-9_:.-]{20,4096}$/;
const fcmMessageNamePattern =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/messages\/\S+$/;
const supportedFcmErrorPairs = new Map<string, 'permanent' | 'transient'>([
  ['400/INVALID_ARGUMENT', 'permanent'],
  ['401/UNAUTHENTICATED', 'permanent'],
  ['403/PERMISSION_DENIED', 'permanent'],
  ['404/NOT_FOUND', 'permanent'],
  ['429/RESOURCE_EXHAUSTED', 'transient'],
  ['500/INTERNAL', 'transient'],
  ['503/UNAVAILABLE', 'transient'],
]);

export type ChangeDirection = 'forward' | 'backward';
export type ChangeReminderTiming = 'one-week' | 'one-day';

export interface FcmChangeReminderSubscription {
  readonly deviceToken: string;
  readonly installationId: string;
}

export interface ReviewedChangeReminderFacts {
  readonly changeDirection: ChangeDirection;
  readonly changeEventAt: Date;
  readonly homeTimeZone: string;
  readonly timing: ChangeReminderTiming;
}

export interface FcmAccessToken {
  readonly expiresAt: Date;
  readonly value: string;
}

export interface FcmAccessTokenProvider {
  readonly getAccessToken: () => Promise<FcmAccessToken>;
}

/**
 * FCM keeps an undelivered message for four weeks unless the request sets a
 * TTL, so every send states its lifetime. `immediate` sends a zero TTL: FCM
 * delivers at once or drops the message. `until` lets FCM hold the message
 * no later than `expiresAt`. The APNs sender gives both the same meaning.
 */
export type ChangeReminderLifetime =
  | { readonly kind: 'immediate' }
  | { readonly kind: 'until'; readonly expiresAt: Date };

/**
 * Bounds a scheduled send. A controlled smoke send has no delivery plan to
 * recheck, so it omits this and has only the transport's own limit.
 */
export interface ChangeReminderSendGuard {
  /** Runs once credentials are ready. `false` means nothing is sent. */
  readonly authorizeBeforeExternalSend: () => Promise<boolean>;
  readonly completeOperationDeadline: Date;
}

export interface FcmChangeReminderPayload {
  readonly message: {
    readonly android: {
      readonly notification: {
        readonly channel_id: 'change-reminders';
        readonly sound: 'default';
      };
      readonly priority: 'HIGH';
      readonly ttl: `${number}s`;
    };
    readonly data: ChangeReminderNotification;
    readonly notification: {
      readonly body: string;
      readonly title: string;
    };
    readonly token: string;
  };
}

export interface FcmHttpRequest {
  readonly accessToken: string;
  readonly endpoint: URL;
  readonly payload: FcmChangeReminderPayload;
  /** Shortens, but never extends, the transport's own limit. */
  readonly timeoutMs?: number;
}

export interface FcmHttpResponse {
  readonly body: string;
  readonly status: number;
}

export interface FcmHttpTransport {
  readonly post: (request: FcmHttpRequest) => Promise<FcmHttpResponse>;
}

export type FcmSubscriptionRemovalResult =
  | 'removed'
  | 'not-found'
  | 'token-replaced';

export type FcmSubscriptionCleanupStatus =
  | FcmSubscriptionRemovalResult
  | 'failed';

export interface FcmSubscriptionRemover {
  /**
   * Deletes one subscription only when both its installation ID and currently
   * stored device token match the FCM-rejected subscription.
   */
  readonly removeIfDeviceTokenMatches: (
    subscription: FcmChangeReminderSubscription,
  ) => Promise<FcmSubscriptionRemovalResult>;
}

export type FcmChangeReminderLogEvent =
  | 'fcm-change-reminder-accepted'
  | 'fcm-change-reminder-expired'
  | 'fcm-change-reminder-invalid-token-cleanup-failed'
  | 'fcm-change-reminder-malformed-response'
  | 'fcm-change-reminder-not-authorized'
  | 'fcm-change-reminder-permanent-invalid-token'
  | 'fcm-change-reminder-permanent-rejection'
  | 'fcm-change-reminder-transient-rejection'
  | 'fcm-change-reminder-uncertain';

export interface FcmChangeReminderLogger {
  readonly write: (event: FcmChangeReminderLogEvent) => void;
}

export type FcmChangeReminderResult =
  | { readonly kind: 'accepted' }
  /** The lifetime ended before the request could be made; nothing was sent. */
  | { readonly kind: 'expired' }
  | { readonly kind: 'malformed-response' }
  /** Final authorization refused the send after credentials were ready. */
  | { readonly kind: 'not-authorized' }
  | {
      readonly kind: 'permanent-invalid-token';
      /**
       * Storage cleanup is independent from provider delivery. A failed cleanup
       * must be retried without sending this already-rejected FCM message again.
       */
      readonly cleanupStatus: FcmSubscriptionCleanupStatus;
    }
  | { readonly kind: 'permanent-rejection' }
  | { readonly kind: 'transient-rejection' }
  /**
   * The request failed or timed out in transit. FCM may still have accepted
   * it, so this is not a rejection and the send must not be repeated.
   */
  | { readonly kind: 'uncertain' };

export interface FcmChangeReminderSender {
  readonly send: (
    subscription: FcmChangeReminderSubscription,
    facts: ReviewedChangeReminderFacts,
    lifetime: ChangeReminderLifetime,
    guard?: ChangeReminderSendGuard,
  ) => Promise<FcmChangeReminderResult>;
}

export interface FcmChangeReminderSenderDependencies {
  readonly accessTokenProvider: FcmAccessTokenProvider;
  readonly clock?: () => Date;
  readonly logger: FcmChangeReminderLogger;
  readonly subscriptionRemover: FcmSubscriptionRemover;
  readonly transport: FcmHttpTransport;
}

interface ParsedProviderError {
  readonly classification: 'permanent' | 'transient';
  readonly hasUnregisteredToken: boolean;
  readonly status: string;
}

interface FcmFetchResponse {
  readonly status: number;
  readonly text: () => Promise<string>;
}

export type FcmFetch = (
  input: string,
  init: {
    readonly body: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly method: 'POST';
    readonly signal: AbortSignal;
  },
) => Promise<FcmFetchResponse>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actualKeys = Object.keys(value).sort();
  return (
    actualKeys.length === keys.length &&
    actualKeys.every((key, index) => key === keys[index])
  );
}

function hasAllowedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
) {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function parseJson(body: unknown): unknown | undefined {
  if (
    typeof body !== 'string' ||
    body.length === 0 ||
    body.length > maxFcmResponseCharacters
  )
    return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function isAcceptedResponse(status: number, body: unknown) {
  return (
    status === 200 &&
    isRecord(body) &&
    hasOnlyKeys(body, ['name']) &&
    typeof body.name === 'string' &&
    fcmMessageNamePattern.test(body.name)
  );
}

function isUnregisteredTokenDetail(value: unknown) {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['@type', 'errorCode']) &&
    value['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' &&
    value.errorCode === 'UNREGISTERED'
  );
}

function parseProviderError(
  statusCode: number,
  body: unknown,
): ParsedProviderError | undefined {
  if (
    !Number.isSafeInteger(statusCode) ||
    statusCode < 400 ||
    statusCode > 599
  ) {
    return undefined;
  }
  if (!isRecord(body) || !hasOnlyKeys(body, ['error'])) return undefined;
  const error = body.error;
  if (!isRecord(error)) return undefined;
  if (!hasAllowedKeys(error, ['code', 'details', 'message', 'status']))
    return undefined;
  if (
    error.code !== statusCode ||
    typeof error.message !== 'string' ||
    error.message.length === 0 ||
    typeof error.status !== 'string'
  ) {
    return undefined;
  }
  if (
    error.details !== undefined &&
    (!Array.isArray(error.details) || error.details.length > 16)
  ) {
    return undefined;
  }
  const classification = supportedFcmErrorPairs.get(
    `${statusCode}/${error.status}`,
  );
  if (classification === undefined) return undefined;
  return {
    classification,
    hasUnregisteredToken:
      Array.isArray(error.details) &&
      error.details.some((detail) => isUnregisteredTokenDetail(detail)),
    status: error.status,
  };
}

function cleanupStatus(result: unknown): FcmSubscriptionCleanupStatus {
  return result === 'removed' ||
    result === 'not-found' ||
    result === 'token-replaced'
    ? result
    : 'failed';
}

function assertReviewedFacts(
  subscription: FcmChangeReminderSubscription,
  facts: ReviewedChangeReminderFacts,
) {
  if (!installationIdPattern.test(subscription.installationId))
    throw new Error('Invalid reminder subscription installation ID');
  if (!deviceTokenPattern.test(subscription.deviceToken))
    throw new Error('Invalid reminder subscription token');
  if (canonicalAustralianZoneId(facts.homeTimeZone) !== facts.homeTimeZone)
    throw new Error('Invalid Change Reminder Home Time Zone');
  if (!['forward', 'backward'].includes(facts.changeDirection))
    throw new Error('Invalid Change Reminder direction');
  if (!['one-week', 'one-day'].includes(facts.timing))
    throw new Error('Invalid Change Reminder timing');
  if (
    !(facts.changeEventAt instanceof Date) ||
    Number.isNaN(facts.changeEventAt.getTime())
  ) {
    throw new Error('Invalid Change Reminder event instant');
  }
}

function assertLifetime(lifetime: ChangeReminderLifetime, now: Date) {
  if (lifetime.kind === 'immediate') return;
  if (lifetime.kind !== 'until' || !(lifetime.expiresAt instanceof Date))
    throw new Error('Invalid FCM message lifetime');
  const remainingMs = lifetime.expiresAt.getTime() - now.getTime();
  // An expiry that has already passed is not invalid: a caller can race the
  // clock. The send reports it as `expired` once the TTL is taken.
  if (!Number.isFinite(remainingMs) || remainingMs > maxFcmLifetimeMs)
    throw new Error('Invalid FCM message lifetime');
}

function messageTtl(
  lifetime: ChangeReminderLifetime,
  now: Date,
): `${number}s` | undefined {
  if (lifetime.kind === 'immediate') return '0s';
  const remainingMs = lifetime.expiresAt.getTime() - now.getTime();
  // Round down so FCM never holds the message past its expiry.
  return remainingMs > 0 ? `${Math.floor(remainingMs / 1000)}s` : undefined;
}

/**
 * The last check before a request leaves. Credential exchange and authorization
 * take time, so the lifetime comes from the clock just before the request
 * rather than from when the send was requested.
 */
export async function finalSendCheck<Lifetime>(
  guard: ChangeReminderSendGuard | undefined,
  clock: () => Date,
  lifetimeAt: (now: Date) => Lifetime | undefined,
) {
  if (guard !== undefined && !(await guard.authorizeBeforeExternalSend())) {
    return 'not-authorized' as const;
  }
  const now = clock();
  const lifetime = lifetimeAt(now);
  const deadline = guard?.completeOperationDeadline.getTime() ?? Infinity;
  if (lifetime === undefined || deadline <= now.getTime()) {
    return 'expired' as const;
  }
  return {
    lifetime,
    timeout: guard === undefined ? {} : { timeoutMs: deadline - now.getTime() },
  };
}

function buildPayload(
  subscription: FcmChangeReminderSubscription,
  facts: ReviewedChangeReminderFacts,
  ttl: `${number}s`,
): FcmChangeReminderPayload {
  return {
    message: {
      android: {
        notification: {
          channel_id: 'change-reminders',
          sound: 'default',
        },
        priority: 'HIGH',
        ttl,
      },
      data: {
        changeDirection: facts.changeDirection,
        changeEventAt: facts.changeEventAt.toISOString(),
        homeTimeZone: facts.homeTimeZone,
        reminderKind: 'change-reminder',
        reminderTiming: facts.timing,
      },
      notification: {
        body: changeReminderNotification.body,
        title: changeReminderNotification.title,
      },
      token: subscription.deviceToken,
    },
  };
}

function hasUsableAccessToken(token: FcmAccessToken, now: Date) {
  return (
    typeof token.value === 'string' &&
    token.value.length > 0 &&
    token.value.length <= 16 * 1024 &&
    token.expiresAt instanceof Date &&
    Number.isFinite(token.expiresAt.getTime()) &&
    token.expiresAt.getTime() > now.getTime()
  );
}

function report(
  logger: FcmChangeReminderLogger,
  result: FcmChangeReminderResult,
): FcmChangeReminderResult {
  const events: Record<
    FcmChangeReminderResult['kind'],
    FcmChangeReminderLogEvent
  > = {
    accepted: 'fcm-change-reminder-accepted',
    expired: 'fcm-change-reminder-expired',
    'malformed-response': 'fcm-change-reminder-malformed-response',
    'not-authorized': 'fcm-change-reminder-not-authorized',
    'permanent-invalid-token': 'fcm-change-reminder-permanent-invalid-token',
    'permanent-rejection': 'fcm-change-reminder-permanent-rejection',
    'transient-rejection': 'fcm-change-reminder-transient-rejection',
    uncertain: 'fcm-change-reminder-uncertain',
  };
  try {
    logger.write(events[result.kind]);
  } catch {
    // Logging must not alter a provider delivery result.
  }
  return result;
}

function reportCleanupFailure(logger: FcmChangeReminderLogger): void {
  try {
    logger.write('fcm-change-reminder-invalid-token-cleanup-failed');
  } catch {
    // Logging must not alter a provider delivery result.
  }
}

export function fcmSendEndpoint(projectId: string) {
  if (!fcmProjectIdPattern.test(projectId))
    throw new Error('Invalid injected FCM project ID');
  return new URL(`/v1/projects/${projectId}/messages:send`, fcmOrigin);
}

export function createFetchFcmHttpTransport(fetch: FcmFetch): FcmHttpTransport {
  return {
    async post(request) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The deadline covers the body as well as the headers. The race ends
      // the wait even if fetch ignores the abort.
      const operation = async () => {
        const response = await fetch(request.endpoint.toString(), {
          body: JSON.stringify(request.payload),
          headers: {
            Authorization: `Bearer ${request.accessToken}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          method: 'POST',
          signal: controller.signal,
        });
        return { body: await response.text(), status: response.status };
      };
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            controller.abort();
            reject(new Error('FCM transport timeout'));
          },
          Math.min(transportTimeoutMs, request.timeoutMs ?? transportTimeoutMs),
        );
      });
      try {
        return await Promise.race([operation(), timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

export function createFcmChangeReminderSender(
  projectId: string,
  dependencies: FcmChangeReminderSenderDependencies,
): FcmChangeReminderSender {
  const endpoint = fcmSendEndpoint(projectId);
  const clock = dependencies.clock ?? (() => new Date());

  async function send(
    subscription: FcmChangeReminderSubscription,
    facts: ReviewedChangeReminderFacts,
    lifetime: ChangeReminderLifetime,
    guard: ChangeReminderSendGuard | undefined,
  ): Promise<FcmChangeReminderResult> {
    let accessToken: FcmAccessToken;
    try {
      accessToken = await dependencies.accessTokenProvider.getAccessToken();
    } catch {
      return report(dependencies.logger, { kind: 'transient-rejection' });
    }
    // The token provider owns credential lifetime policy. After asynchronous
    // acquisition, the sender only rechecks current usability.
    if (!hasUsableAccessToken(accessToken, clock())) {
      return report(dependencies.logger, { kind: 'transient-rejection' });
    }
    const check = await finalSendCheck(guard, clock, (now) =>
      messageTtl(lifetime, now),
    );
    if (typeof check === 'string') {
      return report(dependencies.logger, { kind: check });
    }

    let response: FcmHttpResponse;
    try {
      response = await dependencies.transport.post({
        accessToken: accessToken.value,
        endpoint,
        payload: buildPayload(subscription, facts, check.lifetime),
        ...check.timeout,
      });
    } catch {
      return report(dependencies.logger, { kind: 'uncertain' });
    }

    const body = parseJson(response.body);
    if (isAcceptedResponse(response.status, body)) {
      return report(dependencies.logger, { kind: 'accepted' });
    }

    const error = parseProviderError(response.status, body);
    if (error === undefined) {
      return report(dependencies.logger, { kind: 'malformed-response' });
    }
    if (error.hasUnregisteredToken) {
      if (response.status !== 404 || error.status !== 'NOT_FOUND') {
        return report(dependencies.logger, { kind: 'malformed-response' });
      }
      let cleanup: FcmSubscriptionCleanupStatus = 'failed';
      try {
        cleanup = cleanupStatus(
          await dependencies.subscriptionRemover.removeIfDeviceTokenMatches(
            subscription,
          ),
        );
      } catch {
        // Provider rejection remains permanent when storage cleanup needs retry.
      }
      const result = report(dependencies.logger, {
        kind: 'permanent-invalid-token',
        cleanupStatus: cleanup,
      });
      if (cleanup === 'failed') {
        reportCleanupFailure(dependencies.logger);
      }
      return result;
    }
    return report(dependencies.logger, {
      kind:
        error.classification === 'transient'
          ? 'transient-rejection'
          : 'permanent-rejection',
    });
  }

  return {
    async send(subscription, facts, lifetime, guard) {
      assertReviewedFacts(subscription, facts);
      assertLifetime(lifetime, clock());
      return send(subscription, facts, lifetime, guard);
    },
  };
}
