import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Linking, Platform } from 'react-native';
import { parseReminderSubscriptionRegistrationResponse } from '@daylight-saviour/contracts';
import { canonicalAustralianZoneId } from '@daylight-saviour/domain/australian-zone-runtime';

import type {
  ChangeReminderAdapters,
  ChangeReminderEnableResult,
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
  const expectedKeys =
    candidate.state === 'pending'
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
        ];
  if (
    Object.keys(candidate).sort().join(',') !== expectedKeys.sort().join(',') ||
    !validStoredBase(candidate)
  ) {
    throw new Error('Invalid stored reminder state');
  }

  const base = {
    attemptGeneration: Number(candidate.attemptGeneration),
    homeTimeZone: String(candidate.homeTimeZone),
    oneDayEnabled: true,
    oneWeekEnabled: true,
    registrationRequestId: String(candidate.registrationRequestId),
    version: 2 as const,
  };
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

      const registrationEndpoint = validHttpsEndpoint(endpoint);
      if (registrationEndpoint === null) return { kind: 'failed' };
      const token = await notifications.getDevicePushTokenAsync();
      const saved = await loadStoredState();
      if (saved?.state === 'registered') {
        return {
          kind: saved.homeTimeZone === homeTimeZone ? 'enabled' : 'failed',
        };
      }

      const nextGeneration = (saved?.attemptGeneration ?? 0) + 1;
      if (nextGeneration > maximumAttemptGeneration) {
        return { kind: 'failed' };
      }
      const pending = {
        attemptGeneration: nextGeneration,
        homeTimeZone: saved?.homeTimeZone ?? homeTimeZone,
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId:
          saved?.registrationRequestId ?? (await createRegistrationRequestId()),
        state: 'pending',
        version: 2,
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
            deviceToken: token.data,
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

  let enableInFlight: Promise<ChangeReminderEnableResult> | null = null;
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
      return {
        kind: 'registered',
        notificationPermissionGranted: permission.granted,
        registration: saved,
      };
    },
    enable(homeTimeZone) {
      if (enableInFlight !== null) return enableInFlight;
      enableInFlight = performEnable(homeTimeZone).finally(() => {
        enableInFlight = null;
      });
      return enableInFlight;
    },
    openSettings,
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
