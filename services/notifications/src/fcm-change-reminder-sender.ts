import { changeReminderNotification } from '@daylight-saviour/copy/change-reminder-notification';
import type {
  ChangeReminderNotification,
  FcmTransportProofNotification,
} from '@daylight-saviour/contracts/reminder-subscription-runtime';
import { canonicalAustralianZoneId } from '@daylight-saviour/domain/australian-zone-runtime';

const fcmOrigin = 'https://fcm.googleapis.com';
const maxFcmResponseCharacters = 64 * 1024;
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

export interface FcmChangeReminderPayload {
  readonly message:
    | {
        readonly android: {
          readonly notification: {
            readonly channel_id: 'change-reminders';
            readonly sound: 'default';
          };
          readonly priority: 'HIGH';
        };
        readonly data: ChangeReminderNotification;
        readonly notification: {
          readonly body: string;
          readonly title: string;
        };
        readonly token: string;
      }
    | {
        readonly android: { readonly priority: 'HIGH' };
        readonly data: FcmTransportProofNotification;
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
  | 'fcm-change-reminder-invalid-token-cleanup-failed'
  | 'fcm-change-reminder-malformed-response'
  | 'fcm-change-reminder-permanent-invalid-token'
  | 'fcm-change-reminder-permanent-rejection'
  | 'fcm-change-reminder-transient-rejection'
  | 'fcm-transport-proof-accepted'
  | 'fcm-transport-proof-invalid-token-cleanup-failed'
  | 'fcm-transport-proof-malformed-response'
  | 'fcm-transport-proof-permanent-invalid-token'
  | 'fcm-transport-proof-permanent-rejection'
  | 'fcm-transport-proof-transient-rejection';

export interface FcmChangeReminderLogger {
  readonly write: (event: FcmChangeReminderLogEvent) => void;
}

export type FcmChangeReminderResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'malformed-response' }
  | {
      readonly kind: 'permanent-invalid-token';
      /**
       * Storage cleanup is independent from provider delivery. A failed cleanup
       * must be retried without sending this already-rejected FCM message again.
       */
      readonly cleanupStatus: FcmSubscriptionCleanupStatus;
    }
  | { readonly kind: 'permanent-rejection' }
  | { readonly kind: 'transient-rejection' };

export interface FcmChangeReminderSender {
  readonly send: (
    subscription: FcmChangeReminderSubscription,
    facts: ReviewedChangeReminderFacts,
  ) => Promise<FcmChangeReminderResult>;
  readonly sendTransportProof: (
    subscription: FcmChangeReminderSubscription,
    homeTimeZone: string,
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
    readonly signal?: AbortSignal;
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

function assertSubscription(subscription: FcmChangeReminderSubscription) {
  if (!installationIdPattern.test(subscription.installationId))
    throw new Error('Invalid reminder subscription installation ID');
  if (!deviceTokenPattern.test(subscription.deviceToken))
    throw new Error('Invalid reminder subscription token');
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

function buildTransportProofPayload(
  subscription: FcmChangeReminderSubscription,
  homeTimeZone: string,
): FcmChangeReminderPayload {
  assertSubscription(subscription);
  if (canonicalAustralianZoneId(homeTimeZone) !== homeTimeZone) {
    throw new Error('Invalid transport-proof Home Time Zone');
  }
  return {
    message: {
      android: { priority: 'HIGH' },
      data: {
        homeTimeZone,
        notificationKind: 'fcm-transport-proof',
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
  deliveryKind: 'change-reminder' | 'transport-proof',
): FcmChangeReminderResult {
  const events: Record<
    'change-reminder' | 'transport-proof',
    Record<FcmChangeReminderResult['kind'], FcmChangeReminderLogEvent>
  > = {
    'change-reminder': {
      accepted: 'fcm-change-reminder-accepted',
      'malformed-response': 'fcm-change-reminder-malformed-response',
      'permanent-invalid-token': 'fcm-change-reminder-permanent-invalid-token',
      'permanent-rejection': 'fcm-change-reminder-permanent-rejection',
      'transient-rejection': 'fcm-change-reminder-transient-rejection',
    },
    'transport-proof': {
      accepted: 'fcm-transport-proof-accepted',
      'malformed-response': 'fcm-transport-proof-malformed-response',
      'permanent-invalid-token': 'fcm-transport-proof-permanent-invalid-token',
      'permanent-rejection': 'fcm-transport-proof-permanent-rejection',
      'transient-rejection': 'fcm-transport-proof-transient-rejection',
    },
  };
  try {
    logger.write(events[deliveryKind][result.kind]);
  } catch {
    // Logging must not alter a provider delivery result.
  }
  return result;
}

function reportCleanupFailure(
  logger: FcmChangeReminderLogger,
  deliveryKind: 'change-reminder' | 'transport-proof',
): void {
  try {
    logger.write(
      deliveryKind === 'change-reminder'
        ? 'fcm-change-reminder-invalid-token-cleanup-failed'
        : 'fcm-transport-proof-invalid-token-cleanup-failed',
    );
  } catch {
    // Logging must not alter a provider delivery result.
  }
}

export function fcmSendEndpoint(projectId: string) {
  if (!fcmProjectIdPattern.test(projectId))
    throw new Error('Invalid injected FCM project ID');
  return new URL(`/v1/projects/${projectId}/messages:send`, fcmOrigin);
}

export function createFetchFcmHttpTransport(
  fetch: FcmFetch,
  options: { readonly timeoutMs?: number } = {},
): FcmHttpTransport {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > 60_000)
  ) {
    throw new Error('Invalid FCM transport timeout');
  }
  return {
    async post(request) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const operation = async () => {
        const response = await fetch(request.endpoint.toString(), {
          body: JSON.stringify(request.payload),
          headers: {
            Authorization: `Bearer ${request.accessToken}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          method: 'POST',
          ...(options.timeoutMs === undefined
            ? {}
            : { signal: controller.signal }),
        });
        return { body: await response.text(), status: response.status };
      };
      if (options.timeoutMs === undefined) return operation();
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('FCM transport timeout'));
        }, options.timeoutMs);
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
    payload: FcmChangeReminderPayload,
    deliveryKind: 'change-reminder' | 'transport-proof',
  ): Promise<FcmChangeReminderResult> {
    let accessToken: FcmAccessToken;
    try {
      accessToken = await dependencies.accessTokenProvider.getAccessToken();
    } catch {
      return report(
        dependencies.logger,
        { kind: 'transient-rejection' },
        deliveryKind,
      );
    }
    // The provider owns lifetime policy. After asynchronous acquisition, the
    // sender only rechecks current usability.
    if (!hasUsableAccessToken(accessToken, clock())) {
      return report(
        dependencies.logger,
        { kind: 'transient-rejection' },
        deliveryKind,
      );
    }

    let response: FcmHttpResponse;
    try {
      response = await dependencies.transport.post({
        accessToken: accessToken.value,
        endpoint,
        payload,
      });
    } catch {
      return report(
        dependencies.logger,
        { kind: 'transient-rejection' },
        deliveryKind,
      );
    }

    const body = parseJson(response.body);
    if (isAcceptedResponse(response.status, body)) {
      return report(dependencies.logger, { kind: 'accepted' }, deliveryKind);
    }

    const error = parseProviderError(response.status, body);
    if (error === undefined) {
      return report(
        dependencies.logger,
        { kind: 'malformed-response' },
        deliveryKind,
      );
    }
    if (error.hasUnregisteredToken) {
      if (response.status !== 404 || error.status !== 'NOT_FOUND') {
        return report(
          dependencies.logger,
          { kind: 'malformed-response' },
          deliveryKind,
        );
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
      const result = report(
        dependencies.logger,
        { kind: 'permanent-invalid-token', cleanupStatus: cleanup },
        deliveryKind,
      );
      if (cleanup === 'failed') {
        reportCleanupFailure(dependencies.logger, deliveryKind);
      }
      return result;
    }
    return report(
      dependencies.logger,
      {
        kind:
          error.classification === 'transient'
            ? 'transient-rejection'
            : 'permanent-rejection',
      },
      deliveryKind,
    );
  }

  return {
    async send(subscription, facts) {
      assertReviewedFacts(subscription, facts);
      return send(
        subscription,
        buildPayload(subscription, facts),
        'change-reminder',
      );
    },
    async sendTransportProof(subscription, homeTimeZone) {
      return send(
        subscription,
        buildTransportProofPayload(subscription, homeTimeZone),
        'transport-proof',
      );
    },
  };
}
