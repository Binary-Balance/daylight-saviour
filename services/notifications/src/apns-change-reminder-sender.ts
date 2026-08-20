import { changeReminderNotification } from '@daylight-saviour/copy/change-reminder-notification';
import type { ChangeReminderNotification } from '@daylight-saviour/contracts/reminder-subscription-runtime';
import { canonicalAustralianZoneId } from '@daylight-saviour/domain/australian-zone-runtime';

import type { ReviewedChangeReminderFacts } from './fcm-change-reminder-sender.js';

const apnsOrigins = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;
const maxApnsResponseCharacters = 64 * 1024;
const maxDeviceTokenCharacters = 4096;
const maximumDateTimestamp = 8_640_000_000_000_000;
const installationIdPattern = /^[A-Za-z0-9_-]{32,128}$/;
const deviceTokenPattern = /^[A-Fa-f0-9]+$/;
const providerTokenPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const topicPattern = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

const supportedApnsErrorPairs = new Map<
  string,
  'permanent' | 'permanent-invalid-token' | 'transient'
>([
  ['400/BadCollapseId', 'permanent'],
  ['400/BadDeviceToken', 'permanent'],
  ['400/BadExpirationDate', 'permanent'],
  ['400/BadMessageId', 'permanent'],
  ['400/BadPriority', 'permanent'],
  ['400/BadTopic', 'permanent'],
  ['400/DeviceTokenNotForTopic', 'permanent'],
  ['400/DuplicateHeaders', 'permanent'],
  ['400/IdleTimeout', 'transient'],
  ['400/InvalidPushType', 'permanent'],
  ['400/MissingDeviceToken', 'permanent'],
  ['400/MissingTopic', 'permanent'],
  ['400/PayloadEmpty', 'permanent'],
  ['400/TopicDisallowed', 'permanent'],
  ['403/BadCertificate', 'permanent'],
  ['403/BadCertificateEnvironment', 'permanent'],
  ['403/ExpiredProviderToken', 'transient'],
  ['403/Forbidden', 'permanent'],
  ['403/InvalidProviderToken', 'permanent'],
  ['403/MissingProviderToken', 'permanent'],
  ['403/UnrelatedKeyIdInToken', 'transient'],
  ['403/BadEnvironmentKeyIdInToken', 'permanent'],
  ['404/BadPath', 'permanent'],
  ['405/MethodNotAllowed', 'permanent'],
  ['410/ExpiredToken', 'permanent-invalid-token'],
  ['410/Unregistered', 'permanent-invalid-token'],
  ['413/PayloadTooLarge', 'permanent'],
  ['429/TooManyProviderTokenUpdates', 'transient'],
  ['429/TooManyRequests', 'transient'],
  ['500/InternalServerError', 'transient'],
  ['503/ServiceUnavailable', 'transient'],
  ['503/Shutdown', 'transient'],
]);

export type ApnsEnvironment = 'production' | 'sandbox';

export interface ApnsChangeReminderSubscription {
  readonly deviceToken: string;
  readonly installationId: string;
}

export interface ApnsProviderTokenProvider {
  /** Returns a short-lived, signed provider JWT without exposing signing material. */
  readonly getProviderToken: () => Promise<string>;
}

export interface ApnsChangeReminderPayload {
  readonly aps: {
    readonly alert: {
      readonly body: string;
      readonly title: string;
    };
    readonly sound: 'default';
  };
  readonly changeDirection: ChangeReminderNotification['changeDirection'];
  readonly changeEventAt: string;
  readonly homeTimeZone: string;
  readonly reminderKind: ChangeReminderNotification['reminderKind'];
  readonly reminderTiming: ChangeReminderNotification['reminderTiming'];
}

/** The injected transport owns the HTTP/2 TLS connection to APNs. */
export interface ApnsHttpRequest {
  readonly endpoint: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly httpVersion: '2';
  readonly method: 'POST';
  readonly payload: ApnsChangeReminderPayload;
}

export interface ApnsHttpResponse {
  readonly body: string;
  readonly status: number;
}

export interface ApnsHttpTransport {
  readonly post: (request: ApnsHttpRequest) => Promise<ApnsHttpResponse>;
}

export type ApnsSubscriptionRemovalResult =
  | 'removed'
  | 'not-found'
  | 'token-replaced';

export type ApnsSubscriptionCleanupStatus =
  | ApnsSubscriptionRemovalResult
  | 'failed';

export interface ApnsSubscriptionRemover {
  /**
   * Deletes only when the persisted installation ID and iOS token still match,
   * and preserves a matching registration updated after APNs invalidated it.
   */
  readonly removeIfDeviceTokenMatches: (
    subscription: ApnsChangeReminderSubscription,
    invalidatedAt: Date,
  ) => Promise<ApnsSubscriptionRemovalResult>;
}

export type ApnsChangeReminderLogEvent =
  | 'apns-change-reminder-accepted'
  | 'apns-change-reminder-invalid-token-cleanup-failed'
  | 'apns-change-reminder-malformed-response'
  | 'apns-change-reminder-permanent-invalid-token'
  | 'apns-change-reminder-permanent-rejection'
  | 'apns-change-reminder-transient-rejection';

export interface ApnsChangeReminderLogger {
  readonly write: (event: ApnsChangeReminderLogEvent) => void;
}

export type ApnsChangeReminderResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'malformed-response' }
  | {
      readonly kind: 'permanent-invalid-token';
      readonly cleanupStatus: ApnsSubscriptionCleanupStatus;
    }
  | { readonly kind: 'permanent-rejection' }
  | { readonly kind: 'transient-rejection' };

export interface ApnsChangeReminderSender {
  readonly send: (
    subscription: ApnsChangeReminderSubscription,
    facts: ReviewedChangeReminderFacts,
  ) => Promise<ApnsChangeReminderResult>;
}

export interface ApnsChangeReminderSenderDependencies {
  readonly logger: ApnsChangeReminderLogger;
  readonly providerTokenProvider: ApnsProviderTokenProvider;
  readonly subscriptionRemover: ApnsSubscriptionRemover;
  readonly transport: ApnsHttpTransport;
}

interface ParsedProviderError {
  readonly classification:
    | 'permanent'
    | 'permanent-invalid-token'
    | 'transient';
  readonly invalidatedAt?: Date;
}

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

function parseJson(body: unknown): unknown | undefined {
  if (
    typeof body !== 'string' ||
    body.length === 0 ||
    body.length > maxApnsResponseCharacters
  ) {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function parseProviderError(
  statusCode: number,
  body: unknown,
): ParsedProviderError | undefined {
  if (
    !Number.isSafeInteger(statusCode) ||
    statusCode < 400 ||
    statusCode > 599 ||
    !isRecord(body)
  ) {
    return undefined;
  }
  let invalidatedAt: Date | undefined;
  if (
    !hasOnlyKeys(
      body,
      statusCode === 410 ? ['reason', 'timestamp'] : ['reason'],
    ) ||
    typeof body.reason !== 'string' ||
    body.reason.length === 0
  ) {
    return undefined;
  }
  if (statusCode === 410) {
    if (
      typeof body.timestamp !== 'number' ||
      !Number.isSafeInteger(body.timestamp) ||
      body.timestamp < 0 ||
      body.timestamp > maximumDateTimestamp
    ) {
      return undefined;
    }
    invalidatedAt = new Date(body.timestamp);
  }
  const classification = supportedApnsErrorPairs.get(
    `${statusCode}/${body.reason}`,
  );
  return classification === undefined
    ? undefined
    : {
        classification,
        ...(invalidatedAt === undefined ? {} : { invalidatedAt }),
      };
}

function cleanupStatus(result: unknown): ApnsSubscriptionCleanupStatus {
  return result === 'removed' ||
    result === 'not-found' ||
    result === 'token-replaced'
    ? result
    : 'failed';
}

function isApnsDeviceToken(value: string) {
  return (
    value.length > 0 &&
    value.length <= maxDeviceTokenCharacters &&
    value.length % 2 === 0 &&
    deviceTokenPattern.test(value)
  );
}

function assertReviewedFacts(
  subscription: ApnsChangeReminderSubscription,
  facts: ReviewedChangeReminderFacts,
) {
  if (!installationIdPattern.test(subscription.installationId))
    throw new Error('Invalid reminder subscription installation ID');
  if (!isApnsDeviceToken(subscription.deviceToken))
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
  facts: ReviewedChangeReminderFacts,
): ApnsChangeReminderPayload {
  return {
    aps: {
      alert: {
        body: changeReminderNotification.body,
        title: changeReminderNotification.title,
      },
      sound: 'default',
    },
    changeDirection: facts.changeDirection,
    changeEventAt: facts.changeEventAt.toISOString(),
    homeTimeZone: facts.homeTimeZone,
    reminderKind: 'change-reminder',
    reminderTiming: facts.timing,
  };
}

function report(
  logger: ApnsChangeReminderLogger,
  result: ApnsChangeReminderResult,
): ApnsChangeReminderResult {
  const events: Record<
    ApnsChangeReminderResult['kind'],
    ApnsChangeReminderLogEvent
  > = {
    accepted: 'apns-change-reminder-accepted',
    'malformed-response': 'apns-change-reminder-malformed-response',
    'permanent-invalid-token': 'apns-change-reminder-permanent-invalid-token',
    'permanent-rejection': 'apns-change-reminder-permanent-rejection',
    'transient-rejection': 'apns-change-reminder-transient-rejection',
  };
  try {
    logger.write(events[result.kind]);
  } catch {
    // Logging must not alter a provider delivery result.
  }
  return result;
}

function reportCleanupFailure(logger: ApnsChangeReminderLogger): void {
  try {
    logger.write('apns-change-reminder-invalid-token-cleanup-failed');
  } catch {
    // Logging must not alter a provider delivery result.
  }
}

export function apnsSendEndpoint(
  environment: ApnsEnvironment,
  deviceToken: string,
) {
  if (!(environment in apnsOrigins))
    throw new Error('Invalid APNs environment');
  if (!isApnsDeviceToken(deviceToken))
    throw new Error('Invalid reminder subscription token');
  return new URL(`/3/device/${deviceToken}`, apnsOrigins[environment]);
}

export function createApnsChangeReminderSender(
  environment: ApnsEnvironment,
  topic: string,
  dependencies: ApnsChangeReminderSenderDependencies,
): ApnsChangeReminderSender {
  if (!(environment in apnsOrigins))
    throw new Error('Invalid APNs environment');
  if (!topicPattern.test(topic)) throw new Error('Invalid injected APNs topic');

  return {
    async send(subscription, facts) {
      assertReviewedFacts(subscription, facts);
      let providerToken: string;
      try {
        providerToken =
          await dependencies.providerTokenProvider.getProviderToken();
      } catch {
        return report(dependencies.logger, { kind: 'transient-rejection' });
      }
      if (
        providerToken.length > 16 * 1024 ||
        !providerTokenPattern.test(providerToken)
      ) {
        return report(dependencies.logger, { kind: 'transient-rejection' });
      }

      let response: ApnsHttpResponse;
      try {
        response = await dependencies.transport.post({
          endpoint: apnsSendEndpoint(environment, subscription.deviceToken),
          headers: {
            'apns-expiration': '0',
            'apns-priority': '10',
            'apns-push-type': 'alert',
            'apns-topic': topic,
            authorization: `bearer ${providerToken}`,
            'content-type': 'application/json; charset=utf-8',
          },
          httpVersion: '2',
          method: 'POST',
          payload: buildPayload(facts),
        });
      } catch {
        return report(dependencies.logger, { kind: 'transient-rejection' });
      }

      if (response.status === 200 && response.body === '') {
        return report(dependencies.logger, { kind: 'accepted' });
      }
      const error = parseProviderError(
        response.status,
        parseJson(response.body),
      );
      if (error === undefined) {
        return report(dependencies.logger, { kind: 'malformed-response' });
      }
      if (
        error.classification !== 'permanent-invalid-token' ||
        error.invalidatedAt === undefined
      ) {
        return report(dependencies.logger, {
          kind:
            error.classification === 'transient'
              ? 'transient-rejection'
              : 'permanent-rejection',
        });
      }

      let cleanup: ApnsSubscriptionCleanupStatus = 'failed';
      try {
        cleanup = cleanupStatus(
          await dependencies.subscriptionRemover.removeIfDeviceTokenMatches(
            subscription,
            error.invalidatedAt,
          ),
        );
      } catch {
        // Provider rejection remains permanent when storage cleanup needs retry.
      }
      const result = report(dependencies.logger, {
        kind: 'permanent-invalid-token',
        cleanupStatus: cleanup,
      });
      if (cleanup === 'failed') reportCleanupFailure(dependencies.logger);
      return result;
    },
  };
}
