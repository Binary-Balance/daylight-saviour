import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Linking, Platform } from 'react-native';
import { parseReminderSubscriptionRegistrationResponse } from '@daylight-saviour/contracts';
import { canonicalAustralianZoneId } from '@daylight-saviour/domain/australian-zone-runtime';

import { parseReminderRegistrationEndpoint } from './reminder-registration-endpoint.cjs';
import type {
  ChangeReminderAdapters,
  ChangeReminderEnableResult,
  ChangeReminderPreferences,
  ChangeReminderTokenRefreshResult,
  StoredLegacyChangeReminderPending,
  StoredLegacyChangeReminderRegistration,
  StoredChangeReminderPending,
  StoredChangeReminderPendingUpdate,
  StoredChangeReminderState,
} from './change-reminder-adapters';

const registrationKey = 'change-reminder-registration-v2';
const requestTimeoutMs = 10_000;
const notificationChannelId = 'change-reminders';
const maximumAttemptGeneration = 2_147_483_647;

interface PermissionResult {
  readonly canAskAgain: boolean;
  readonly granted: boolean;
}

interface ProductionAdapterDependencies {
  readonly createRegistrationRequestId: () => Promise<string>;
  readonly endpoint: string | undefined;
  readonly fetch: typeof fetch;
  readonly notifications: {
    readonly addPushTokenListener: (
      listener: (token: { readonly data: unknown }) => void,
    ) => {
      readonly remove: () => void;
    };
    readonly getDevicePushTokenAsync: () => Promise<{ readonly data: string }>;
    readonly getPermissionsAsync: () => Promise<PermissionResult>;
    readonly requestPermissionsAsync: () => Promise<PermissionResult>;
    readonly setNotificationChannelAsync: (
      channelId: string,
      channel: {
        readonly importance: Notifications.AndroidImportance;
        readonly name: string;
      },
    ) => Promise<unknown>;
  };
  readonly openSettings: () => Promise<void>;
  readonly platform: string;
  readonly secureStore: {
    readonly deleteItemAsync: (key: string) => Promise<void>;
    readonly getItemAsync: (key: string) => Promise<string | null>;
    readonly setItemAsync: (key: string, value: string) => Promise<void>;
  };
  readonly timeoutMs?: number;
}

function validStoredBase(candidate: Record<string, unknown>) {
  return (
    (candidate.version === 3 || candidate.version === 4) &&
    validDeviceToken(candidate.deviceToken) &&
    typeof candidate.registrationRequestId === 'string' &&
    /^[a-f0-9]{64}$/.test(candidate.registrationRequestId) &&
    Number.isSafeInteger(candidate.attemptGeneration) &&
    Number(candidate.attemptGeneration) >= 1 &&
    Number(candidate.attemptGeneration) <= maximumAttemptGeneration &&
    typeof candidate.homeTimeZone === 'string' &&
    canonicalAustralianZoneId(candidate.homeTimeZone) ===
      candidate.homeTimeZone &&
    typeof candidate.oneDayEnabled === 'boolean' &&
    typeof candidate.oneWeekEnabled === 'boolean' &&
    (candidate.oneDayEnabled || candidate.oneWeekEnabled)
  );
}

function validLegacyStoredBase(candidate: Record<string, unknown>) {
  return (
    candidate.version === 2 &&
    typeof candidate.registrationRequestId === 'string' &&
    /^[a-f0-9]{64}$/.test(candidate.registrationRequestId) &&
    Number.isSafeInteger(candidate.attemptGeneration) &&
    Number(candidate.attemptGeneration) >= 1 &&
    Number(candidate.attemptGeneration) <= maximumAttemptGeneration &&
    typeof candidate.homeTimeZone === 'string' &&
    canonicalAustralianZoneId(candidate.homeTimeZone) ===
      candidate.homeTimeZone &&
    candidate.oneDayEnabled === true &&
    candidate.oneWeekEnabled === true
  );
}

function parseStoredState(value: string): StoredChangeReminderState {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid stored reminder state');
  }
  const candidate = parsed as Record<string, unknown>;
  const isLegacy = candidate.version === 2;
  const isV3 = candidate.version === 3;
  const expectedKeys =
    candidate.state === 'pending' && !isLegacy
      ? [
          'attemptGeneration',
          'deviceToken',
          'homeTimeZone',
          'oneDayEnabled',
          'oneWeekEnabled',
          'registrationRequestId',
          'state',
          'version',
        ]
      : candidate.state === 'pending-update' && !isLegacy
        ? [
            'attemptGeneration',
            'credential',
            'deviceToken',
            'homeTimeZone',
            'installationId',
            'oneDayEnabled',
            'oneWeekEnabled',
            'registrationRequestId',
            'state',
            'version',
          ]
        : isLegacy
          ? candidate.state === 'pending'
            ? [
                'attemptGeneration',
                'homeTimeZone',
                'oneDayEnabled',
                'oneWeekEnabled',
                'registrationRequestId',
                'state',
                'version',
              ]
            : [
                'attemptGeneration',
                'credential',
                'homeTimeZone',
                'installationId',
                'oneDayEnabled',
                'oneWeekEnabled',
                'registrationRequestId',
                'state',
                'version',
              ]
          : [
              'attemptGeneration',
              'credential',
              'deviceToken',
              'homeTimeZone',
              'installationId',
              'oneDayEnabled',
              'oneWeekEnabled',
              'registrationRequestId',
              'state',
              'version',
            ];
  if (
    Object.keys(candidate).sort().join(',') !== expectedKeys.sort().join(',') ||
    !(isLegacy ? validLegacyStoredBase(candidate) : validStoredBase(candidate))
  ) {
    throw new Error('Invalid stored reminder state');
  }

  const base = {
    attemptGeneration: Number(candidate.attemptGeneration),
    deviceToken: String(candidate.deviceToken),
    homeTimeZone: String(candidate.homeTimeZone),
    oneDayEnabled: Boolean(candidate.oneDayEnabled),
    oneWeekEnabled: Boolean(candidate.oneWeekEnabled),
    registrationRequestId: String(candidate.registrationRequestId),
    version: candidate.version as 3 | 4,
  };
  if (isLegacy) {
    if (candidate.state === 'pending') {
      return {
        attemptGeneration: Number(candidate.attemptGeneration),
        homeTimeZone: String(candidate.homeTimeZone),
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: String(candidate.registrationRequestId),
        state: 'pending',
        version: 2,
      } satisfies StoredLegacyChangeReminderPending;
    }
    if (candidate.state !== 'registered') {
      throw new Error('Invalid stored reminder state');
    }
    const response = parseReminderSubscriptionRegistrationResponse({
      credential: candidate.credential,
      installationId: candidate.installationId,
    });
    return {
      attemptGeneration: Number(candidate.attemptGeneration),
      ...response,
      homeTimeZone: String(candidate.homeTimeZone),
      oneDayEnabled: true,
      oneWeekEnabled: true,
      registrationRequestId: String(candidate.registrationRequestId),
      state: 'registered',
      version: 2,
    } satisfies StoredLegacyChangeReminderRegistration;
  }
  if (candidate.state === 'pending') {
    return { ...base, state: 'pending' } as StoredChangeReminderPending;
  }
  if (candidate.state === 'pending-update') {
    if (isV3) throw new Error('Invalid stored reminder state');
    const response = parseReminderSubscriptionRegistrationResponse({
      credential: candidate.credential,
      installationId: candidate.installationId,
    });
    return {
      ...base,
      ...response,
      state: 'pending-update',
    } as StoredChangeReminderPendingUpdate;
  }
  if (candidate.state !== 'registered') {
    throw new Error('Invalid stored reminder state');
  }
  const response = parseReminderSubscriptionRegistrationResponse({
    credential: candidate.credential,
    installationId: candidate.installationId,
  });
  return {
    ...base,
    ...response,
    state: 'registered',
  } as StoredChangeReminderState;
}

function bytesToLowerHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function createRegistrationRequestId() {
  return bytesToLowerHex(await Crypto.getRandomBytesAsync(32));
}

function updateEndpoint(registrationEndpoint: string, installationId: string) {
  const url = new URL(registrationEndpoint);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(installationId)}`;
  return url.toString();
}

function validDeviceToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 20 &&
    value.length <= 4_096 &&
    /^[A-Za-z0-9_:.-]+$/.test(value)
  );
}

async function fetchWithTimeout(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(url, { ...init, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Reminder registration timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createProductionChangeReminderAdapters({
  createRegistrationRequestId,
  endpoint,
  fetch: request,
  notifications,
  openSettings,
  platform,
  secureStore,
  timeoutMs = requestTimeoutMs,
}: ProductionAdapterDependencies): ChangeReminderAdapters {
  async function loadStoredState() {
    const saved = await secureStore.getItemAsync(registrationKey);
    return saved === null ? null : parseStoredState(saved);
  }

  async function saveStoredState(state: StoredChangeReminderState) {
    await secureStore.setItemAsync(registrationKey, JSON.stringify(state));
  }

  async function synchronize(
    homeTimeZone: string,
    deviceToken: string,
    forceTokenReplacement: boolean,
    preferences: ChangeReminderPreferences,
    preserveConfirmedRecord = false,
  ): Promise<ChangeReminderEnableResult> {
    const registrationEndpoint = parseReminderRegistrationEndpoint(endpoint);
    if (registrationEndpoint === null || !validDeviceToken(deviceToken)) {
      return { kind: 'failed' };
    }
    const saved = await loadStoredState();
    if (
      saved?.state === 'registered' &&
      saved.version !== 2 &&
      saved.deviceToken === deviceToken &&
      !forceTokenReplacement &&
      saved.oneDayEnabled === preferences.oneDayEnabled &&
      saved.oneWeekEnabled === preferences.oneWeekEnabled
    ) {
      if (saved.homeTimeZone !== homeTimeZone) return { kind: 'failed' };
      return { kind: 'enabled' };
    }
    const nextGeneration = (saved?.attemptGeneration ?? 0) + 1;
    try {
      if (nextGeneration > maximumAttemptGeneration) {
        return { kind: 'failed' };
      }
      const replayingInitialRegistration =
        saved?.state === 'pending' && saved.version !== 2;
      const base = {
        attemptGeneration: nextGeneration,
        deviceToken: replayingInitialRegistration
          ? saved.deviceToken
          : deviceToken,
        homeTimeZone: replayingInitialRegistration
          ? saved.homeTimeZone
          : homeTimeZone,
        oneDayEnabled: replayingInitialRegistration
          ? saved.oneDayEnabled
          : preferences.oneDayEnabled,
        oneWeekEnabled: replayingInitialRegistration
          ? saved.oneWeekEnabled
          : preferences.oneWeekEnabled,
        registrationRequestId:
          saved?.registrationRequestId ?? (await createRegistrationRequestId()),
        version: 4 as const,
      };
      const pending =
        saved?.state === 'registered' || saved?.state === 'pending-update'
          ? ({
              ...base,
              credential: saved.credential,
              installationId: saved.installationId,
              state: 'pending-update' as const,
            } satisfies StoredChangeReminderPendingUpdate)
          : ({
              ...base,
              state: 'pending',
            } satisfies StoredChangeReminderPending);
      if (!/^[a-f0-9]{64}$/.test(pending.registrationRequestId)) {
        return { kind: 'failed' };
      }
      const replayNeedsAuthenticatedUpdate =
        replayingInitialRegistration &&
        (pending.deviceToken !== deviceToken ||
          pending.homeTimeZone !== homeTimeZone);
      if (!preserveConfirmedRecord) await saveStoredState(pending);

      const response = await fetchWithTimeout(
        request,
        pending.state === 'pending'
          ? registrationEndpoint
          : updateEndpoint(registrationEndpoint, pending.installationId),
        {
          body: JSON.stringify({
            attemptGeneration: pending.attemptGeneration,
            deviceToken: pending.deviceToken,
            homeTimeZone: pending.homeTimeZone,
            oneDayEnabled: pending.oneDayEnabled,
            oneWeekEnabled: pending.oneWeekEnabled,
            platform,
            ...(pending.state === 'pending'
              ? { registrationRequestId: pending.registrationRequestId }
              : {}),
          }),
          headers:
            pending.state === 'pending'
              ? { 'content-type': 'application/json' }
              : {
                  authorization: `Bearer ${pending.credential}`,
                  'content-type': 'application/json',
                },
          method: pending.state === 'pending' ? 'POST' : 'PUT',
        },
        timeoutMs,
      );
      if (!response.ok) {
        if (
          pending.state === 'pending-update' &&
          response.status === 404 &&
          !preserveConfirmedRecord
        ) {
          const replacement = {
            attemptGeneration: 1,
            deviceToken,
            homeTimeZone,
            oneDayEnabled: preferences.oneDayEnabled,
            oneWeekEnabled: preferences.oneWeekEnabled,
            registrationRequestId: await createRegistrationRequestId(),
            state: 'pending' as const,
            version: 4 as const,
          } satisfies StoredChangeReminderPending;
          if (!/^[a-f0-9]{64}$/.test(replacement.registrationRequestId)) {
            return { kind: 'failed' };
          }
          await saveStoredState(replacement);
          return synchronize(homeTimeZone, deviceToken, true, preferences);
        }
        return { kind: 'failed' };
      }
      const registration =
        pending.state === 'pending'
          ? parseReminderSubscriptionRegistrationResponse(await response.json())
          : {
              credential: pending.credential,
              installationId: pending.installationId,
            };
      await saveStoredState({
        ...pending,
        ...registration,
        state: 'registered' as const,
        version: 4,
      });
      if (replayNeedsAuthenticatedUpdate) {
        return synchronize(homeTimeZone, deviceToken, true, preferences);
      }
      return { kind: 'enabled' };
    } catch {
      return { kind: 'failed' };
    }
  }

  async function performEnable(
    homeTimeZone: string,
  ): Promise<ChangeReminderEnableResult> {
    if (platform === 'web') return { kind: 'unavailable' };
    try {
      if (platform === 'android') {
        await notifications.setNotificationChannelAsync(notificationChannelId, {
          importance: Notifications.AndroidImportance.HIGH,
          name: 'Change Reminders',
        });
      }
      const existing = await notifications.getPermissionsAsync();
      if (!existing.granted && !existing.canAskAgain) {
        return { kind: 'os-blocked' };
      }
      const permission = existing.granted
        ? existing
        : await notifications.requestPermissionsAsync();
      if (!permission.granted) {
        return {
          kind: permission.canAskAgain ? 'permission-denied' : 'os-blocked',
        };
      }
      if (parseReminderRegistrationEndpoint(endpoint) === null) {
        return { kind: 'failed' };
      }
      const token = await notifications.getDevicePushTokenAsync();
      return synchronize(homeTimeZone, token.data, false, {
        oneDayEnabled: true,
        oneWeekEnabled: true,
      });
    } catch {
      return { kind: 'failed' };
    }
  }

  async function performTokenRefresh(
    homeTimeZone: string,
    token: unknown,
  ): Promise<ChangeReminderTokenRefreshResult | null> {
    if (platform === 'web' || !validDeviceToken(token)) return null;
    try {
      const saved = await loadStoredState();
      if (saved === null || saved.homeTimeZone !== homeTimeZone) {
        return null;
      }
      if (
        saved.state === 'registered' &&
        saved.version !== 2 &&
        saved.deviceToken === token
      ) {
        return null;
      }
      if (
        (
          await synchronize(homeTimeZone, token, true, {
            oneDayEnabled: saved.oneDayEnabled,
            oneWeekEnabled: saved.oneWeekEnabled,
          })
        ).kind === 'enabled'
      ) {
        return { kind: 'succeeded' };
      }
    } catch {
      // A later token update or explicit retry uses the durable pending state.
    }
    try {
      const saved = await loadStoredState();
      return {
        kind: 'failed',
        retryable:
          (saved?.state === 'pending' || saved?.state === 'pending-update') &&
          saved.homeTimeZone === homeTimeZone,
      };
    } catch {
      return { kind: 'failed', retryable: false };
    }
  }

  let enableInFlight: {
    readonly homeTimeZone: string;
    readonly promise: Promise<ChangeReminderEnableResult>;
  } | null = null;
  let disableInFlight: Promise<
    { readonly kind: 'disabled' } | { readonly kind: 'failed' }
  > | null = null;
  let registrationQueue = Promise.resolve();
  let queuedRefreshToken: unknown = null;
  let refreshInFlight: Promise<void> | null = null;
  let refreshingToken: unknown = null;
  let lastRefreshedToken: unknown = null;

  function enqueue<T>(operation: () => Promise<T>) {
    const next = registrationQueue.then(operation, operation);
    registrationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function queueTokenRefresh(
    homeTimeZone: string,
    token: unknown,
    onResult: (result: ChangeReminderTokenRefreshResult) => void,
  ) {
    if (!validDeviceToken(token)) return;
    if (
      token === queuedRefreshToken ||
      token === refreshingToken ||
      token === lastRefreshedToken
    ) {
      return;
    }
    queuedRefreshToken = token;
    if (refreshInFlight !== null) return;
    refreshInFlight = (async () => {
      while (queuedRefreshToken !== null) {
        const currentToken = queuedRefreshToken;
        queuedRefreshToken = null;
        refreshingToken = currentToken;
        try {
          const result = await enqueue(() =>
            performTokenRefresh(homeTimeZone, currentToken),
          );
          if (result?.kind === 'succeeded') {
            lastRefreshedToken = currentToken;
            onResult(result);
          } else if (result?.kind === 'failed') {
            onResult(result);
          }
        } finally {
          refreshingToken = null;
        }
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }

  return {
    async restore() {
      if (platform === 'web') return { kind: 'unavailable' };
      const saved = await loadStoredState();
      if (saved === null) return { kind: 'unregistered' };
      if (saved.state === 'pending' || saved.state === 'pending-update') {
        return {
          homeTimeZone: saved.homeTimeZone,
          kind: 'pending',
        };
      }
      const permission = await notifications.getPermissionsAsync();
      if (!permission.granted) {
        return {
          kind: 'registered',
          notificationPermissionGranted: false,
          registration: saved,
        };
      }
      let currentToken: string;
      try {
        currentToken = (await notifications.getDevicePushTokenAsync()).data;
      } catch {
        return { homeTimeZone: saved.homeTimeZone, kind: 'pending' };
      }
      if (!validDeviceToken(currentToken)) {
        return { homeTimeZone: saved.homeTimeZone, kind: 'pending' };
      }
      if (saved.version !== 4 || saved.deviceToken !== currentToken) {
        const result = await enqueue(() =>
          synchronize(saved.homeTimeZone, currentToken, true, {
            oneDayEnabled: saved.oneDayEnabled,
            oneWeekEnabled: saved.oneWeekEnabled,
          }),
        );
        if (result.kind !== 'enabled') {
          return { homeTimeZone: saved.homeTimeZone, kind: 'pending' };
        }
        const refreshed = await loadStoredState();
        if (refreshed?.state !== 'registered' || refreshed.version !== 4) {
          return { homeTimeZone: saved.homeTimeZone, kind: 'pending' };
        }
        return {
          kind: 'registered',
          notificationPermissionGranted: true,
          registration: refreshed,
        };
      }
      return {
        kind: 'registered',
        notificationPermissionGranted: permission.granted,
        registration: saved,
      };
    },
    enable(homeTimeZone) {
      if (enableInFlight !== null) {
        return enableInFlight.homeTimeZone === homeTimeZone
          ? enableInFlight.promise
          : Promise.resolve({ kind: 'failed' });
      }
      const promise = enqueue(() => performEnable(homeTimeZone)).finally(() => {
        if (enableInFlight?.promise === promise) enableInFlight = null;
      });
      enableInFlight = { homeTimeZone, promise };
      return promise;
    },
    async updatePreferences(preferences) {
      if (!preferences.oneDayEnabled && !preferences.oneWeekEnabled) {
        return { kind: 'failed' };
      }
      return enqueue(async () => {
        const saved = await loadStoredState();
        if (saved?.state !== 'registered' || saved.version === 2)
          return { kind: 'failed' };
        return synchronize(
          saved.homeTimeZone,
          saved.deviceToken,
          true,
          preferences,
          true,
        );
      });
    },
    disable() {
      if (disableInFlight !== null) return disableInFlight;
      const promise = enqueue(async () => {
        try {
          const registrationEndpoint =
            parseReminderRegistrationEndpoint(endpoint);
          const saved = await loadStoredState();
          if (registrationEndpoint === null || saved?.state !== 'registered') {
            return { kind: 'failed' as const };
          }
          const response = await fetchWithTimeout(
            request,
            updateEndpoint(registrationEndpoint, saved.installationId),
            {
              headers: { authorization: `Bearer ${saved.credential}` },
              method: 'DELETE',
            },
            timeoutMs,
          );
          if (!response.ok) return { kind: 'failed' as const };
          await secureStore.deleteItemAsync(registrationKey);
          return { kind: 'disabled' as const };
        } catch {
          return { kind: 'failed' as const };
        }
      }).finally(() => {
        if (disableInFlight === promise) disableInFlight = null;
      });
      disableInFlight = promise;
      return promise;
    },
    async readInstallationId() {
      const saved = await loadStoredState();
      return saved?.state === 'registered' ? saved.installationId : null;
    },
    openSettings,
    startTokenRefresh(homeTimeZone, onResult = () => undefined) {
      if (platform === 'web') return () => undefined;
      let listening = true;
      const subscription = notifications.addPushTokenListener((token) => {
        queueTokenRefresh(homeTimeZone, token.data, (result) => {
          if (listening) onResult(result);
        });
      });
      return () => {
        listening = false;
        subscription.remove();
      };
    },
  };
}

export const productionChangeReminderAdapters =
  createProductionChangeReminderAdapters({
    createRegistrationRequestId,
    endpoint: process.env.EXPO_PUBLIC_REMINDER_REGISTRATION_URL,
    fetch,
    notifications: Notifications,
    openSettings: () => Linking.openSettings(),
    platform: Platform.OS,
    secureStore: SecureStore,
  });
