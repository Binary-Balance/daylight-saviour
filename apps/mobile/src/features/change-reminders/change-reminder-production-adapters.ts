import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Linking, Platform } from 'react-native';
import { parseReminderSubscriptionRegistrationResponse } from '@daylight-saviour/contracts';

import type {
  ChangeReminderAdapters,
  StoredChangeReminderRegistration,
} from './change-reminder-adapters';

const registrationKey = 'change-reminder-registration-v1';
const requestTimeoutMs = 10_000;
const notificationChannelId = 'change-reminders';

interface PermissionResult {
  readonly canAskAgain: boolean;
  readonly granted: boolean;
}

interface ProductionAdapterDependencies {
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

function parseStoredRegistration(
  value: string,
): StoredChangeReminderRegistration {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(',') !==
      'credential,homeTimeZone,installationId,oneDayEnabled,oneWeekEnabled,version'
  ) {
    throw new Error('Invalid stored reminder registration');
  }
  const candidate = parsed as Record<string, unknown>;
  const response = parseReminderSubscriptionRegistrationResponse({
    credential: candidate.credential,
    installationId: candidate.installationId,
  });
  if (
    candidate.version !== 1 ||
    typeof candidate.homeTimeZone !== 'string' ||
    candidate.homeTimeZone.length === 0 ||
    candidate.oneDayEnabled !== true ||
    candidate.oneWeekEnabled !== true
  ) {
    throw new Error('Invalid stored reminder registration');
  }
  return {
    ...response,
    homeTimeZone: candidate.homeTimeZone,
    oneDayEnabled: true,
    oneWeekEnabled: true,
    version: 1,
  };
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
  endpoint,
  fetch: request,
  notifications,
  openSettings,
  platform,
  secureStore,
  timeoutMs = requestTimeoutMs,
}: ProductionAdapterDependencies): ChangeReminderAdapters {
  return {
    async load() {
      const saved = await secureStore.getItemAsync(registrationKey);
      return saved === null ? null : parseStoredRegistration(saved);
    },
    async enable(homeTimeZone) {
      if (platform === 'web') return { kind: 'unavailable' };
      try {
        if (platform === 'android') {
          await notifications.setNotificationChannelAsync(
            notificationChannelId,
            {
              importance: Notifications.AndroidImportance.DEFAULT,
              name: 'Change Reminders',
            },
          );
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
        const response = await fetchWithTimeout(
          request,
          registrationEndpoint,
          {
            body: JSON.stringify({
              deviceToken: token.data,
              homeTimeZone,
              oneDayEnabled: true,
              oneWeekEnabled: true,
              platform,
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
        await secureStore.setItemAsync(
          registrationKey,
          JSON.stringify({
            ...registration,
            homeTimeZone,
            oneDayEnabled: true,
            oneWeekEnabled: true,
            version: 1,
          } satisfies StoredChangeReminderRegistration),
        );
        return { kind: 'enabled' };
      } catch {
        return { kind: 'failed' };
      }
    },
    openSettings,
  };
}

export const productionChangeReminderAdapters =
  createProductionChangeReminderAdapters({
    endpoint: process.env.EXPO_PUBLIC_REMINDER_REGISTRATION_URL,
    fetch,
    notifications: Notifications,
    openSettings: () => Linking.openSettings(),
    platform: Platform.OS,
    secureStore: SecureStore,
  });
