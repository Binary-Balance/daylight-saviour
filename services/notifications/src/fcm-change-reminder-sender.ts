import { changeReminderNotification } from '@daylight-saviour/copy/change-reminder-notification';
import { canonicalAustralianZoneId } from '@daylight-saviour/domain/australian-zone-runtime';

const fcmOrigin = 'https://fcm.googleapis.com';
const maxAccessTokenLifetimeMs = 60 * 60 * 1000;
const maxFcmResponseCharacters = 64 * 1024;
const fcmProjectIdPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const installationIdPattern = /^[A-Za-z0-9_-]{32,128}$/;
const deviceTokenPattern = /^[A-Za-z0-9_:.-]{20,4096}$/;
const fcmMessageNamePattern =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/messages\/\S+$/;
const googleRpcStatuses = new Set([
  'ABORTED',
  'ALREADY_EXISTS',
  'CANCELLED',
  'DATA_LOSS',
  'DEADLINE_EXCEEDED',
  'FAILED_PRECONDITION',
  'INTERNAL',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'OUT_OF_RANGE',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'UNAUTHENTICATED',
  'UNAVAILABLE',
  'UNIMPLEMENTED',
  'UNKNOWN',
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

export interface FcmChangeReminderPayload {
  readonly message: {
    readonly android: {
      readonly notification: {
        readonly channel_id: 'change-reminders';
        readonly sound: 'default';
      };
      readonly priority: 'HIGH';
    };
    readonly data: {
      readonly changeDirection: ChangeDirection;
      readonly changeEventAt: string;
      readonly homeTimeZone: string;
      readonly reminderKind: 'change-reminder';
      readonly reminderTiming: ChangeReminderTiming;
    };
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
}

export interface FcmHttpResponse {
  readonly body: string;
  readonly status: number;
}

export interface FcmHttpTransport {
  readonly post: (request: FcmHttpRequest) => Promise<FcmHttpResponse>;
}

export interface FcmSubscriptionRemover {
  /**
   * Deletes one subscription only when both its installation ID and currently
   * stored device token match the FCM-rejected subscription.
   */
  readonly removeIfDeviceTokenMatches: (
    subscription: FcmChangeReminderSubscription,
  ) => Promise<'removed' | 'not-found' | 'token-replaced'>;
}

export type FcmChangeReminderLogEvent =
  | 'fcm-change-reminder-accepted'
  | 'fcm-change-reminder-malformed-response'
  | 'fcm-change-reminder-permanent-invalid-token'
  | 'fcm-change-reminder-permanent-rejection'
  | 'fcm-change-reminder-transient-rejection';

export interface FcmChangeReminderLogger {
  readonly write: (event: FcmChangeReminderLogEvent) => void;
}

export type FcmChangeReminderResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'malformed-response' }
  | { readonly kind: 'permanent-invalid-token' }
  | { readonly kind: 'permanent-rejection' }
  | { readonly kind: 'transient-rejection' };

export interface FcmChangeReminderSender {
  readonly send: (
    subscription: FcmChangeReminderSubscription,
    facts: ReviewedChangeReminderFacts,
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
  },
) => Promise<FcmFetchResponse>;

function isRecord(value: unknown): value is Record<string, unknown> {
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

function parseJson(body: unknown): unknown | undefined {
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
    typeof error.status !== 'string' ||
    !googleRpcStatuses.has(error.status)
  ) {
    return undefined;
  }
  if (
    error.details !== undefined &&
    (!Array.isArray(error.details) || error.details.length > 16)
  ) {
    return undefined;
  }
  return {
    hasUnregisteredToken:
      Array.isArray(error.details) &&
      error.details.some((detail) => isUnregisteredTokenDetail(detail)),
    status: error.status,
  };
}

function isTransientProviderError(statusCode: number, status: string) {
  return (
    [408, 429, 500, 502, 503, 504].includes(statusCode) ||
    [
      'ABORTED',
      'DEADLINE_EXCEEDED',
      'INTERNAL',
      'RESOURCE_EXHAUSTED',
      'UNAUTHENTICATED',
      'UNAVAILABLE',
    ].includes(status)
  );
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

function buildPayload(
  subscription: FcmChangeReminderSubscription,
  facts: ReviewedChangeReminderFacts,
): FcmChangeReminderPayload {
  return {
    message: {
      android: {
        notification: {
          channel_id: 'change-reminders',
          sound: 'default',
        },
        priority: 'HIGH',
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
    !Number.isNaN(token.expiresAt.getTime()) &&
    token.expiresAt.getTime() > now.getTime() &&
    token.expiresAt.getTime() - now.getTime() <= maxAccessTokenLifetimeMs
  );
}

function report(
  logger: FcmChangeReminderLogger,
  result: FcmChangeReminderResult,
): FcmChangeReminderResult {
  const event: Record<
    FcmChangeReminderResult['kind'],
    FcmChangeReminderLogEvent
  > = {
    accepted: 'fcm-change-reminder-accepted',
    'malformed-response': 'fcm-change-reminder-malformed-response',
    'permanent-invalid-token': 'fcm-change-reminder-permanent-invalid-token',
    'permanent-rejection': 'fcm-change-reminder-permanent-rejection',
    'transient-rejection': 'fcm-change-reminder-transient-rejection',
  };
  try {
    logger.write(event[result.kind]);
  } catch {
    // Logging must not alter a provider delivery result.
  }
  return result;
}

export function fcmSendEndpoint(projectId: string) {
  if (!fcmProjectIdPattern.test(projectId))
    throw new Error('Invalid injected FCM project ID');
  return new URL(`/v1/projects/${projectId}/messages:send`, fcmOrigin);
}

export function createFetchFcmHttpTransport(fetch: FcmFetch): FcmHttpTransport {
  return {
    async post(request) {
      const response = await fetch(request.endpoint.toString(), {
        body: JSON.stringify(request.payload),
        headers: {
          Authorization: `Bearer ${request.accessToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        method: 'POST',
      });
      return { body: await response.text(), status: response.status };
    },
  };
}

export function createFcmChangeReminderSender(
  projectId: string,
  dependencies: FcmChangeReminderSenderDependencies,
): FcmChangeReminderSender {
  const endpoint = fcmSendEndpoint(projectId);
  const clock = dependencies.clock ?? (() => new Date());

  return {
    async send(subscription, facts) {
      assertReviewedFacts(subscription, facts);
      let accessToken: FcmAccessToken;
      const now = clock();
      try {
        accessToken = await dependencies.accessTokenProvider.getAccessToken();
      } catch {
        return report(dependencies.logger, { kind: 'transient-rejection' });
      }
      if (!hasUsableAccessToken(accessToken, now)) {
        return report(dependencies.logger, { kind: 'transient-rejection' });
      }

      let response: FcmHttpResponse;
      try {
        response = await dependencies.transport.post({
          accessToken: accessToken.value,
          endpoint,
          payload: buildPayload(subscription, facts),
        });
      } catch {
        return report(dependencies.logger, { kind: 'transient-rejection' });
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
        try {
          await dependencies.subscriptionRemover.removeIfDeviceTokenMatches(
            subscription,
          );
        } catch {
          return report(dependencies.logger, { kind: 'transient-rejection' });
        }
        return report(dependencies.logger, {
          kind: 'permanent-invalid-token',
        });
      }
      if (isTransientProviderError(response.status, error.status)) {
        return report(dependencies.logger, { kind: 'transient-rejection' });
      }
      return report(dependencies.logger, { kind: 'permanent-rejection' });
    },
  };
}
