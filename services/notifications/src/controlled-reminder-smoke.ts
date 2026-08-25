import type {
  HttpFunctionOptions,
  HttpRequest,
  HttpResponseInit,
} from '@azure/functions';
import { canonicalAustralianZoneId } from '@daylight-saviour/domain/australian-zone-runtime';

import {
  createApnsChangeReminderSender,
  type ApnsChangeReminderSender,
} from './apns-change-reminder-sender.js';
import {
  createApnsProviderTokenProvider,
  createNodeApnsHttpTransport,
} from './apns-runtime.js';
import {
  createFcmChangeReminderSender,
  createFetchFcmHttpTransport,
  type FcmChangeReminderSender,
  type ReviewedChangeReminderFacts,
} from './fcm-change-reminder-sender.js';
import { createKeylessFcmAccessTokenProvider } from './keyless-fcm-access-token.js';
import {
  createAzureReminderSubscriptionStore,
  type ReminderSubscriptionStore,
} from './reminder-subscriptions.js';

const maxRequestBytes = 1024;
const installationIdPattern = /^[A-Za-z0-9_-]{43}$/;

interface ControlledReminderSmokeRequest extends ReviewedChangeReminderFacts {
  readonly installationId: string;
}

interface ControlledReminderSmokeRuntime {
  readonly apnsRuntimeEnabled?: boolean;
  readonly apnsSender?: ApnsChangeReminderSender;
  readonly runtimeEnabled: boolean;
  readonly testSendEnabled: boolean;
  readonly sender?: FcmChangeReminderSender;
  readonly store?: Pick<ReminderSubscriptionStore, 'getSubscription'>;
}

function outcome(
  status: number,
  value: 'accepted' | 'apns-unregistered-token-removed' | 'unavailable',
) {
  return {
    status,
    headers: { 'Cache-Control': 'no-store' },
    jsonBody: { outcome: value },
  } satisfies HttpResponseInit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBoundedJson(request: HttpRequest): Promise<unknown> {
  if (
    request.headers.get('content-type')?.trim().toLowerCase() !==
    'application/json'
  ) {
    throw new Error('Invalid request');
  }
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maxRequestBytes
    ) {
      throw new Error('Invalid request');
    }
  }
  if (request.body === null) throw new Error('Invalid request');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array))
        throw new Error('Invalid request');
      total += chunk.value.byteLength;
      if (total > maxRequestBytes) {
        await reader.cancel();
        throw new Error('Invalid request');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new Error('Invalid request');
  }
}

async function readRequest(
  request: HttpRequest,
): Promise<ControlledReminderSmokeRequest> {
  const input = await readBoundedJson(request);
  if (!isRecord(input)) throw new Error('Invalid request');
  const keys = Object.keys(input).sort();
  if (
    keys.length !== 5 ||
    !keys.every(
      (key, index) =>
        key ===
        [
          'changeDirection',
          'changeEventAt',
          'homeTimeZone',
          'installationId',
          'timing',
        ][index],
    )
  ) {
    throw new Error('Invalid request');
  }
  const {
    changeDirection,
    changeEventAt: changeEventAtValue,
    homeTimeZone,
    installationId,
    timing,
  } = input;
  if (
    typeof installationId !== 'string' ||
    !installationIdPattern.test(installationId) ||
    (changeDirection !== 'forward' && changeDirection !== 'backward') ||
    (timing !== 'one-week' && timing !== 'one-day') ||
    typeof homeTimeZone !== 'string' ||
    canonicalAustralianZoneId(homeTimeZone) !== homeTimeZone ||
    typeof changeEventAtValue !== 'string'
  ) {
    throw new Error('Invalid request');
  }
  const changeEventAt = new Date(changeEventAtValue);
  if (
    !Number.isFinite(changeEventAt.getTime()) ||
    changeEventAt.toISOString() !== changeEventAtValue
  ) {
    throw new Error('Invalid request');
  }
  return {
    changeDirection,
    changeEventAt,
    homeTimeZone,
    installationId,
    timing,
  };
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0)
    throw new Error('Missing configuration');
  return value;
}

export function createControlledReminderSmokeRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): ControlledReminderSmokeRuntime {
  const runtimeEnabled = environment.FCM_RUNTIME_ENABLED === 'true';
  const testSendEnabled = environment.FCM_TEST_SEND_ENABLED === 'true';
  const apnsRuntimeEnabled = environment.APNS_RUNTIME_ENABLED === 'true';
  const fcmActive = runtimeEnabled && testSendEnabled;
  const apnsActive = apnsRuntimeEnabled && testSendEnabled;
  if (!fcmActive && !apnsActive) {
    return {
      apnsRuntimeEnabled,
      runtimeEnabled,
      testSendEnabled,
    };
  }

  const store = createAzureReminderSubscriptionStore(environment);

  return {
    ...(apnsActive
      ? {
          apnsSender: createApnsChangeReminderSender(
            apnsEnvironment(required(environment, 'APNS_ENVIRONMENT')),
            required(environment, 'APNS_TOPIC'),
            {
              logger: { write: () => undefined },
              providerTokenProvider: createApnsProviderTokenProvider({
                keyId: required(environment, 'APNS_KEY_ID'),
                privateKey: required(environment, 'APNS_PRIVATE_KEY'),
                teamId: required(environment, 'APNS_TEAM_ID'),
              }),
              subscriptionRemover: store,
              transport: createNodeApnsHttpTransport(),
            },
          ),
        }
      : {}),
    apnsRuntimeEnabled,
    runtimeEnabled,
    ...(fcmActive
      ? {
          sender: createFcmChangeReminderSender(
            required(environment, 'FCM_PROJECT_ID'),
            {
              accessTokenProvider: createKeylessFcmAccessTokenProvider(
                {
                  entraAssertionAudience: required(
                    environment,
                    'FCM_ENTRA_ASSERTION_AUDIENCE',
                  ),
                  managedIdentityClientId: required(
                    environment,
                    'REMINDER_MANAGED_IDENTITY_CLIENT_ID',
                  ),
                  serviceAccountEmail: required(
                    environment,
                    'FCM_SERVICE_ACCOUNT_EMAIL',
                  ),
                  workloadIdentityProvider: required(
                    environment,
                    'FCM_WORKLOAD_IDENTITY_PROVIDER',
                  ),
                },
                { logger: { write: () => undefined } },
              ),
              logger: { write: () => undefined },
              subscriptionRemover: store,
              transport: createFetchFcmHttpTransport(fetch),
            },
          ),
        }
      : {}),
    store,
    testSendEnabled,
  };
}

function apnsEnvironment(value: string): 'production' | 'sandbox' {
  if (value === 'production' || value === 'sandbox') return value;
  throw new Error('Invalid APNs environment');
}

/**
 * Function-key-protected ingress for owner-controlled Change Reminder testing.
 * It stays separate from scheduled delivery and requires the explicit server gate.
 */
export function createControlledReminderSmokeHandler(
  createRuntime: () => ControlledReminderSmokeRuntime = createControlledReminderSmokeRuntime,
) {
  let cachedRuntime: ControlledReminderSmokeRuntime | undefined;

  return async (request: HttpRequest): Promise<HttpResponseInit> => {
    let input: ControlledReminderSmokeRequest;
    try {
      input = await readRequest(request);
    } catch {
      return outcome(400, 'unavailable');
    }

    try {
      // A successfully composed warm-worker runtime retains the APNs JWT cache.
      // Do not cache exceptions: transient configuration access may recover.
      const runtime = cachedRuntime ?? (cachedRuntime = createRuntime());
      if (
        runtime.store === undefined ||
        ((!runtime.runtimeEnabled || !runtime.testSendEnabled) &&
          (!runtime.apnsRuntimeEnabled || !runtime.testSendEnabled))
      ) {
        return outcome(503, 'unavailable');
      }
      const subscription = await runtime.store.getSubscription(
        input.installationId,
      );
      if (subscription === null) return outcome(404, 'unavailable');
      const facts: ReviewedChangeReminderFacts = {
        changeDirection: input.changeDirection,
        changeEventAt: input.changeEventAt,
        homeTimeZone: input.homeTimeZone,
        timing: input.timing,
      };
      const target = {
        deviceToken: subscription.deviceToken,
        installationId: subscription.installationId,
      };
      if (subscription.platform === 'android') {
        if (
          !runtime.runtimeEnabled ||
          !runtime.testSendEnabled ||
          runtime.sender === undefined
        ) {
          return outcome(503, 'unavailable');
        }
        const result = await runtime.sender.send(target, facts);
        return result.kind === 'accepted'
          ? outcome(202, 'accepted')
          : outcome(503, 'unavailable');
      }
      if (
        !runtime.apnsRuntimeEnabled ||
        !runtime.testSendEnabled ||
        runtime.apnsSender === undefined
      ) {
        return outcome(503, 'unavailable');
      }
      const result = await runtime.apnsSender.send(target, facts);
      if (result.kind === 'accepted') return outcome(202, 'accepted');
      // This fixed outcome is deliberately narrower than the sender result:
      // only APNs 410/Unregistered plus conditional removal proves the stale
      // registration was gone without disclosing provider or subscription data.
      if (
        result.kind === 'permanent-invalid-token' &&
        result.invalidTokenReason === 'unregistered' &&
        result.cleanupStatus === 'removed'
      ) {
        return outcome(410, 'apns-unregistered-token-removed');
      }
      return outcome(503, 'unavailable');
    } catch {
      return outcome(503, 'unavailable');
    }
  };
}

export const controlledReminderSmokeOptions: HttpFunctionOptions = {
  authLevel: 'function',
  handler: createControlledReminderSmokeHandler(),
  methods: ['POST'],
  route: 'internal/controlled-change-reminder-smoke',
};
