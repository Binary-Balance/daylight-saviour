import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Linking, Platform } from 'react-native';
import { parseReminderSubscriptionRegistrationResponse } from '@daylight-saviour/contracts';
import { canonicalAustralianZoneId } from '@daylight-saviour/domain/australian-zone-runtime';

import type {
  ChangeReminderAdapters,
  ChangeReminderEnableResult,
  StoredLegacyChangeReminderRegistration,
  StoredChangeReminderPending,
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
    readonly getItemAsync: (key: string) => Promise<string | null>;
    readonly setItemAsync: (key: string, value: string) => Promise<void>;
  };
  readonly timeoutMs?: number;
}

function validStoredBase(candidate: Record<string, unknown>) {
  return (
    candidate.version === 3 &&
    validDeviceToken(candidate.deviceToken) &&
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
      : isLegacy
        ? [
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
    oneDayEnabled: true,
    oneWeekEnabled: true,
    registrationRequestId: String(candidate.registrationRequestId),
    version: 3 as const,
  };
  if (isLegacy) {
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
    return { ...base, state: 'pending' };
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
  };
}

function bytesToLowerHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function createRegistrationRequestId() {
  return bytesToLowerHex(await Crypto.getRandomBytesAsync(32));
}

function validHttpsEndpoint(value: string | undefined) {
  if (value === undefined || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
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

  async function register(
    homeTimeZone: string,
    deviceToken: string,
    forceTokenReplacement: boolean,
  ): Promise<ChangeReminderEnableResult> {
    const registrationEndpoint = validHttpsEndpoint(endpoint);
    if (registrationEndpoint === null || !validDeviceToken(deviceToken)) {
      return { kind: 'failed' };
    }
    const saved = await loadStoredState();
    if (
      saved?.state === 'registered' &&
      saved.version === 3 &&
      saved.deviceToken === deviceToken &&
      !forceTokenReplacement
    ) {
      return {
        kind: saved.homeTimeZone === homeTimeZone ? 'enabled' : 'failed',
      };
    }
    const nextGeneration = (saved?.attemptGeneration ?? 0) + 1;
    try {
      if (nextGeneration > maximumAttemptGeneration) {
        return { kind: 'failed' };
      }
      const pending = {
        attemptGeneration: nextGeneration,
        deviceToken,
        homeTimeZone,
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId:
          saved?.registrationRequestId ?? (await createRegistrationRequestId()),
        state: 'pending',
        version: 3,
      } satisfies StoredChangeReminderPending;
      if (!/^[a-f0-9]{64}$/.test(pending.registrationRequestId)) {
        return { kind: 'failed' };
      }
      await saveStoredState(pending);

      const response = await fetchWithTimeout(
        request,
        registrationEndpoint,
        {
          body: JSON.stringify({
            attemptGeneration: pending.attemptGeneration,
            deviceToken,
            homeTimeZone: pending.homeTimeZone,
            oneDayEnabled: true,
            oneWeekEnabled: true,
            platform,
            registrationRequestId: pending.registrationRequestId,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        },
        timeoutMs,
      );
      if (!response.ok) return { kind: 'failed' };
      const registration = parseReminderSubscriptionRegistrationResponse(
        await response.json(),
      );
      await saveStoredState({
        ...pending,
        ...registration,
        state: 'registered',
      });
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
          importance: Notifications.AndroidImportance.DEFAULT,
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
      if (validHttpsEndpoint(endpoint) === null) return { kind: 'failed' };
      const token = await notifications.getDevicePushTokenAsync();
      return register(homeTimeZone, token.data, false);
    } catch {
      return { kind: 'failed' };
    }
  }

  async function performTokenRefresh(homeTimeZone: string, token: unknown) {
    if (platform === 'web' || !validDeviceToken(token)) return false;
    try {
      const saved = await loadStoredState();
      if (saved === null || saved.homeTimeZone !== homeTimeZone) {
        return false;
      }
      if (
        saved.state === 'registered' &&
        saved.version === 3 &&
        saved.deviceToken === token
      ) {
        return true;
      }
      return (await register(homeTimeZone, token, true)).kind === 'enabled';
    } catch {
      // A later token update or explicit retry uses the durable pending state.
      return false;
    }
  }

  let enableInFlight: {
    readonly homeTimeZone: string;
    readonly promise: Promise<ChangeReminderEnableResult>;
  } | null = null;
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

  function queueTokenRefresh(homeTimeZone: string, token: unknown) {
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
          const refreshed = await enqueue(() =>
            performTokenRefresh(homeTimeZone, currentToken),
          );
          if (refreshed) lastRefreshedToken = currentToken;
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
      if (saved.state === 'pending') {
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
      if (saved.version !== 3 || saved.deviceToken !== currentToken) {
        const result = await enqueue(() =>
          register(saved.homeTimeZone, currentToken, true),
        );
        if (result.kind !== 'enabled') {
          return { homeTimeZone: saved.homeTimeZone, kind: 'pending' };
        }
        const refreshed = await loadStoredState();
        if (refreshed?.state !== 'registered' || refreshed.version !== 3) {
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
    openSettings,
    startTokenRefresh(homeTimeZone) {
      if (platform === 'web') return () => undefined;
      const subscription = notifications.addPushTokenListener((token) => {
        queueTokenRefresh(homeTimeZone, token.data);
      });
      return () => subscription.remove();
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
