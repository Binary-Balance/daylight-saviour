import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Linking, Platform } from 'react-native';
import { parseReminderSubscriptionRegistrationResponse } from '@daylight-saviour/contracts';
import { normalizeAustralianZoneId } from '@daylight-saviour/domain';
import { canonicalAustralianZoneId } from '@daylight-saviour/domain/australian-zone-runtime';

import { parseReminderRegistrationEndpoint } from './reminder-registration-endpoint.cjs';
import type {
  ChangeReminderAdapters,
  ChangeReminderEnableResult,
  ChangeReminderPreferences,
  ChangeReminderRestoreResult,
  ChangeReminderTokenRefreshResult,
  StoredLegacyChangeReminderPending,
  StoredLegacyChangeReminderRegistration,
  StoredChangeReminderPending,
  StoredChangeReminderPendingDelete,
  StoredChangeReminderPendingUpdate,
  StoredChangeReminderRegistration,
  StoredChangeReminderState,
  StoredV3ChangeReminderPending,
  StoredV3ChangeReminderRegistration,
} from './change-reminder-adapters';

const registrationKey = 'change-reminder-registration-v2';
const requestTimeoutMs = 10_000;
const checkInIntervalMs = 30 * 24 * 60 * 60 * 1_000;
const notificationChannelId = 'change-reminders';
const maximumAttemptGeneration = 2_147_483_647;

interface PermissionResult {
  readonly canAskAgain: boolean;
  readonly granted: boolean;
  readonly status: Notifications.PermissionStatus;
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
  readonly now?: () => Date;
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
    validRegistrationRequestId(candidate.registrationRequestId) &&
    Number.isSafeInteger(candidate.attemptGeneration) &&
    Number(candidate.attemptGeneration) >= 1 &&
    Number(candidate.attemptGeneration) <= maximumAttemptGeneration &&
    typeof candidate.homeTimeZone === 'string' &&
    canonicalAustralianZoneId(candidate.homeTimeZone) ===
      candidate.homeTimeZone &&
    (candidate.confirmedHomeTimeZone === undefined ||
      (typeof candidate.confirmedHomeTimeZone === 'string' &&
        canonicalAustralianZoneId(candidate.confirmedHomeTimeZone) ===
          candidate.confirmedHomeTimeZone)) &&
    (candidate.lastContactAt === undefined ||
      (typeof candidate.lastContactAt === 'string' &&
        Number.isFinite(Date.parse(candidate.lastContactAt)))) &&
    typeof candidate.oneDayEnabled === 'boolean' &&
    typeof candidate.oneWeekEnabled === 'boolean' &&
    (candidate.oneDayEnabled || candidate.oneWeekEnabled)
  );
}

function validLegacyStoredBase(candidate: Record<string, unknown>) {
  return (
    candidate.version === 2 &&
    typeof candidate.registrationRequestId === 'string' &&
    validRegistrationRequestId(candidate.registrationRequestId) &&
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

function validStoredPendingDelete(candidate: Record<string, unknown>) {
  return (
    candidate.version === 4 &&
    typeof candidate.credential === 'string' &&
    /^[A-Za-z0-9_-]{32,128}$/.test(candidate.credential) &&
    typeof candidate.installationId === 'string' &&
    /^[A-Za-z0-9_-]{32,128}$/.test(candidate.installationId) &&
    validRegistrationRequestId(candidate.registrationRequestId) &&
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

function validRegistrationRequestId(value: unknown): value is string {
  return (
    (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) ||
    (typeof value === 'string' && /^v2\.\d{13}\.[a-f0-9]{64}$/.test(value))
  );
}

function hasConfirmedPreferences(candidate: Record<string, unknown>) {
  return (
    typeof candidate.confirmedOneDayEnabled === 'boolean' &&
    typeof candidate.confirmedOneWeekEnabled === 'boolean'
  );
}

// The fields a record of this kind holds, and no others.
function expectedStoredKeys(candidate: Record<string, unknown>) {
  if (candidate.version === 2) {
    return candidate.state === 'pending'
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
  }
  if (candidate.state === 'pending') {
    return [
      'attemptGeneration',
      'deviceToken',
      'homeTimeZone',
      'oneDayEnabled',
      'oneWeekEnabled',
      'registrationRequestId',
      'state',
      'version',
    ];
  }
  if (candidate.state === 'pending-update') {
    return [
      'attemptGeneration',
      ...(hasConfirmedPreferences(candidate)
        ? ['confirmedOneDayEnabled', 'confirmedOneWeekEnabled']
        : []),
      ...(typeof candidate.confirmedHomeTimeZone === 'string'
        ? ['confirmedHomeTimeZone']
        : []),
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
  }
  if (candidate.state === 'pending-delete') {
    return [
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
  }
  return [
    'attemptGeneration',
    'credential',
    'deviceToken',
    'homeTimeZone',
    'installationId',
    ...(typeof candidate.lastContactAt === 'string' ? ['lastContactAt'] : []),
    'oneDayEnabled',
    'oneWeekEnabled',
    'registrationRequestId',
    'state',
    'version',
  ];
}

function validStoredFields(candidate: Record<string, unknown>) {
  return candidate.state === 'pending-delete'
    ? validStoredPendingDelete(candidate)
    : candidate.version === 2
      ? validLegacyStoredBase(candidate)
      : validStoredBase(candidate);
}

function storedBase(candidate: Record<string, unknown>) {
  return {
    attemptGeneration: Number(candidate.attemptGeneration),
    deviceToken: String(candidate.deviceToken),
    homeTimeZone: String(candidate.homeTimeZone),
    oneDayEnabled: Boolean(candidate.oneDayEnabled),
    oneWeekEnabled: Boolean(candidate.oneWeekEnabled),
    registrationRequestId: String(candidate.registrationRequestId),
    version: candidate.version as 3 | 4,
  };
}

function parseStoredPendingDelete(candidate: Record<string, unknown>) {
  const response = parseReminderSubscriptionRegistrationResponse({
    credential: candidate.credential,
    installationId: candidate.installationId,
  });
  return {
    attemptGeneration: Number(candidate.attemptGeneration),
    ...response,
    homeTimeZone: String(candidate.homeTimeZone),
    oneDayEnabled: Boolean(candidate.oneDayEnabled),
    oneWeekEnabled: Boolean(candidate.oneWeekEnabled),
    registrationRequestId: String(candidate.registrationRequestId),
    state: 'pending-delete',
    version: 4,
  } satisfies StoredChangeReminderPendingDelete;
}

function parseLegacyStoredState(candidate: Record<string, unknown>) {
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

function parseStoredPendingUpdate(candidate: Record<string, unknown>) {
  if (candidate.version === 3) throw new Error('Invalid stored reminder state');
  const response = parseReminderSubscriptionRegistrationResponse({
    credential: candidate.credential,
    installationId: candidate.installationId,
  });
  return {
    ...storedBase(candidate),
    ...response,
    ...(hasConfirmedPreferences(candidate)
      ? {
          confirmedOneDayEnabled: Boolean(candidate.confirmedOneDayEnabled),
          confirmedOneWeekEnabled: Boolean(candidate.confirmedOneWeekEnabled),
        }
      : {}),
    ...(typeof candidate.confirmedHomeTimeZone === 'string'
      ? { confirmedHomeTimeZone: String(candidate.confirmedHomeTimeZone) }
      : {}),
    state: 'pending-update',
  } as StoredChangeReminderPendingUpdate;
}

function parseCurrentStoredState(candidate: Record<string, unknown>) {
  if (candidate.state === 'pending') {
    return {
      ...storedBase(candidate),
      state: 'pending',
    } as StoredChangeReminderPending;
  }
  if (candidate.state === 'pending-update') {
    return parseStoredPendingUpdate(candidate);
  }
  if (candidate.state !== 'registered') {
    throw new Error('Invalid stored reminder state');
  }
  const response = parseReminderSubscriptionRegistrationResponse({
    credential: candidate.credential,
    installationId: candidate.installationId,
  });
  return {
    ...storedBase(candidate),
    ...response,
    ...(typeof candidate.lastContactAt === 'string'
      ? { lastContactAt: String(candidate.lastContactAt) }
      : {}),
    state: 'registered',
  } as StoredChangeReminderState;
}

function parseStoredState(value: string): StoredChangeReminderState {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid stored reminder state');
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(',') !==
      expectedStoredKeys(candidate).sort().join(',') ||
    !validStoredFields(candidate)
  ) {
    throw new Error('Invalid stored reminder state');
  }
  if (candidate.state === 'pending-delete') {
    return parseStoredPendingDelete(candidate);
  }
  return candidate.version === 2
    ? parseLegacyStoredState(candidate)
    : parseCurrentStoredState(candidate);
}

function bytesToLowerHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function createRegistrationRequestId() {
  return `v2.${String(Date.now()).padStart(13, '0')}.${bytesToLowerHex(
    await Crypto.getRandomBytesAsync(32),
  )}`;
}

function updateEndpoint(
  registrationEndpoint: string,
  installationId: string,
  suffix = '',
) {
  const url = new URL(registrationEndpoint);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(installationId)}${suffix}`;
  return url.toString();
}

// Only the service's own answer says this registration is gone. A 404 from
// the platform alone, such as for a route an older service has not deployed
// yet, says nothing about it.
function registrationGone(response: {
  readonly body: string;
  readonly status: number;
}) {
  return (
    response.status === 404 &&
    response.body.includes('Registration unavailable')
  );
}

function checkInDue(lastContactAt: string | undefined, now: Date) {
  if (lastContactAt === undefined) return true;
  const sinceContact = now.getTime() - Date.parse(lastContactAt);
  // A last contact in the future means the clock was set back.
  return sinceContact < 0 || sinceContact >= checkInIntervalMs;
}

function validDeviceToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 20 &&
    value.length <= 4_096 &&
    /^[A-Za-z0-9_:.-]+$/.test(value)
  );
}

// Reads the body before the deadline too: headers can arrive and the body
// then stall.
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
      request(url, { ...init, signal: controller.signal }).then(
        async (response) => ({
          body: await response.text(),
          ok: response.ok,
          status: response.status,
        }),
      ),
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

type SavedRegistration = Extract<
  StoredChangeReminderState,
  { state: 'pending-update' | 'registered' }
>;
type RegistrationAttempt =
  | StoredChangeReminderPending
  | StoredChangeReminderPendingUpdate;

// The caller read a registration earlier and must still find that same one.
function registrationReplaced(
  saved: StoredChangeReminderState | null,
  expectedRegistrationRequestId: string | undefined,
  expectedInstallationId: string | undefined,
) {
  return (
    expectedRegistrationRequestId !== undefined &&
    (saved?.registrationRequestId !== expectedRegistrationRequestId ||
      (expectedInstallationId !== undefined &&
        saved?.state !== 'pending' &&
        saved?.installationId !== expectedInstallationId))
  );
}

function registrationMatches(
  saved: StoredChangeReminderState | null,
  deviceToken: string,
  forceTokenReplacement: boolean,
  preferences: ChangeReminderPreferences,
): saved is
  | StoredChangeReminderRegistration
  | StoredV3ChangeReminderRegistration {
  return (
    saved?.state === 'registered' &&
    saved.version !== 2 &&
    saved.deviceToken === deviceToken &&
    !forceTokenReplacement &&
    saved.oneDayEnabled === preferences.oneDayEnabled &&
    saved.oneWeekEnabled === preferences.oneWeekEnabled
  );
}

// A lost initial registration is replayed as it was first sent.
function replayingInitialRegistration(
  saved: StoredChangeReminderState | null,
): saved is StoredChangeReminderPending | StoredV3ChangeReminderPending {
  return saved?.state === 'pending' && saved.version !== 2;
}

function attemptBase(
  saved: StoredChangeReminderState | null,
  attemptGeneration: number,
  deviceToken: string,
  homeTimeZone: string,
  preferences: ChangeReminderPreferences,
  registrationRequestId: string,
) {
  const replaying = replayingInitialRegistration(saved);
  return {
    attemptGeneration,
    deviceToken: replaying ? saved.deviceToken : deviceToken,
    homeTimeZone: replaying ? saved.homeTimeZone : homeTimeZone,
    oneDayEnabled: replaying ? saved.oneDayEnabled : preferences.oneDayEnabled,
    oneWeekEnabled: replaying
      ? saved.oneWeekEnabled
      : preferences.oneWeekEnabled,
    registrationRequestId,
    version: 4 as const,
  };
}

function confirmedHomeTimeZoneFor(
  saved: SavedRegistration,
  homeTimeZone: string,
) {
  const changed =
    saved.homeTimeZone !== homeTimeZone ? saved.homeTimeZone : undefined;
  return saved.state === 'pending-update'
    ? (saved.confirmedHomeTimeZone ?? changed)
    : changed;
}

function confirmedPreferences(
  saved: SavedRegistration,
  preservePreferenceContext: boolean,
) {
  const carriesPreferenceContext =
    preservePreferenceContext ||
    (saved.state === 'pending-update' &&
      saved.confirmedOneDayEnabled !== undefined &&
      saved.confirmedOneWeekEnabled !== undefined);
  if (!carriesPreferenceContext) return {};
  return {
    confirmedOneDayEnabled:
      saved.state === 'pending-update'
        ? (saved.confirmedOneDayEnabled ?? saved.oneDayEnabled)
        : saved.oneDayEnabled,
    confirmedOneWeekEnabled:
      saved.state === 'pending-update'
        ? (saved.confirmedOneWeekEnabled ?? saved.oneWeekEnabled)
        : saved.oneWeekEnabled,
  };
}

function nextAttempt(
  saved: StoredChangeReminderState | null,
  base: ReturnType<typeof attemptBase>,
  homeTimeZone: string,
  preservePreferenceContext: boolean,
): RegistrationAttempt {
  if (saved?.state === 'registered' || saved?.state === 'pending-update') {
    const confirmedHomeTimeZone = confirmedHomeTimeZoneFor(saved, homeTimeZone);
    return {
      ...base,
      ...confirmedPreferences(saved, preservePreferenceContext),
      ...(confirmedHomeTimeZone === undefined ? {} : { confirmedHomeTimeZone }),
      credential: saved.credential,
      installationId: saved.installationId,
      state: 'pending-update',
    };
  }
  return { ...base, state: 'pending' };
}

function registrationRequest(
  registrationEndpoint: string,
  pending: RegistrationAttempt,
  platform: string,
) {
  return {
    url:
      pending.state === 'pending'
        ? registrationEndpoint
        : updateEndpoint(registrationEndpoint, pending.installationId),
    init: {
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
  };
}

function pendingRestoreResult(
  saved: Extract<
    StoredChangeReminderState,
    { state: 'pending' | 'pending-update' }
  >,
): ChangeReminderRestoreResult {
  return {
    homeTimeZone: saved.homeTimeZone,
    kind: 'pending',
    ...(saved.state === 'pending-update' &&
    saved.confirmedOneDayEnabled !== undefined &&
    saved.confirmedOneWeekEnabled !== undefined
      ? {
          pendingPreferences: {
            confirmed: {
              oneDayEnabled: saved.confirmedOneDayEnabled,
              oneWeekEnabled: saved.confirmedOneWeekEnabled,
            },
            proposed: {
              oneDayEnabled: saved.oneDayEnabled,
              oneWeekEnabled: saved.oneWeekEnabled,
            },
          },
        }
      : {}),
    ...(saved.state === 'pending-update' &&
    saved.confirmedHomeTimeZone !== undefined
      ? {
          pendingHomeTimeZone: {
            confirmed: saved.confirmedHomeTimeZone,
            proposed: saved.homeTimeZone,
          },
        }
      : {}),
  };
}

export function createProductionChangeReminderAdapters({
  createRegistrationRequestId,
  endpoint,
  fetch: request,
  notifications,
  now = () => new Date(),
  openSettings,
  platform,
  secureStore,
  timeoutMs = requestTimeoutMs,
}: ProductionAdapterDependencies): ChangeReminderAdapters {
  // The native request has no timeout, and on iOS it never settles without a
  // network connection. Registration holds its queue while it waits, so an
  // unbounded wait would leave the card busy until the app restarts.
  async function devicePushToken() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const token = await Promise.race([
        notifications.getDevicePushTokenAsync(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Device push token timed out'));
          }, timeoutMs);
        }),
      ]);
      return token.data;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function loadStoredState() {
    const saved = await secureStore.getItemAsync(registrationKey);
    return saved === null ? null : parseStoredState(saved);
  }

  async function saveStoredState(state: StoredChangeReminderState) {
    await secureStore.setItemAsync(registrationKey, JSON.stringify(state));
  }

  function deleteRegistration(
    registrationEndpoint: string,
    registration: {
      readonly credential: string;
      readonly installationId: string;
    },
  ) {
    return fetchWithTimeout(
      request,
      updateEndpoint(registrationEndpoint, registration.installationId),
      {
        headers: { authorization: `Bearer ${registration.credential}` },
        method: 'DELETE',
      },
      timeoutMs,
    );
  }

  async function synchronize(
    homeTimeZone: string,
    deviceToken: string,
    forceTokenReplacement: boolean,
    preferences: ChangeReminderPreferences,
    expectedRegistrationRequestId?: string,
    expectedInstallationId?: string,
    preservePreferenceContext = false,
  ): Promise<ChangeReminderEnableResult> {
    const registrationEndpoint = parseReminderRegistrationEndpoint(endpoint);
    if (registrationEndpoint === null || !validDeviceToken(deviceToken)) {
      return { kind: 'failed' };
    }
    const saved = await loadStoredState();
    if (
      registrationReplaced(
        saved,
        expectedRegistrationRequestId,
        expectedInstallationId,
      )
    ) {
      return { kind: 'failed' };
    }
    if (saved?.state === 'pending-delete') return { kind: 'failed' };
    if (
      registrationMatches(
        saved,
        deviceToken,
        forceTokenReplacement,
        preferences,
      )
    ) {
      if (saved.homeTimeZone !== homeTimeZone) return { kind: 'failed' };
      return { kind: 'enabled' };
    }
    return attemptRegistration(
      saved,
      registrationEndpoint,
      homeTimeZone,
      deviceToken,
      preferences,
      preservePreferenceContext,
    );
  }

  async function attemptRegistration(
    saved: StoredChangeReminderState | null,
    registrationEndpoint: string,
    homeTimeZone: string,
    deviceToken: string,
    preferences: ChangeReminderPreferences,
    preservePreferenceContext: boolean,
  ): Promise<ChangeReminderEnableResult> {
    const nextGeneration = (saved?.attemptGeneration ?? 0) + 1;
    try {
      if (nextGeneration > maximumAttemptGeneration) {
        return { kind: 'failed' };
      }
      const registrationRequestId =
        saved?.registrationRequestId ?? (await createRegistrationRequestId());
      const pending = nextAttempt(
        saved,
        attemptBase(
          saved,
          nextGeneration,
          deviceToken,
          homeTimeZone,
          preferences,
          registrationRequestId,
        ),
        homeTimeZone,
        preservePreferenceContext,
      );
      if (!validRegistrationRequestId(pending.registrationRequestId)) {
        return { kind: 'failed' };
      }
      // A successful server write can outlive its response, so retries must
      // advance from this durable proposed attempt rather than the last
      // confirmed display values.
      const replayNeedsAuthenticatedUpdate =
        replayingInitialRegistration(saved) &&
        (pending.deviceToken !== deviceToken ||
          pending.homeTimeZone !== homeTimeZone);
      await saveStoredState(pending);

      const { init, url } = registrationRequest(
        registrationEndpoint,
        pending,
        platform,
      );
      const response = await fetchWithTimeout(request, url, init, timeoutMs);
      if (!response.ok) {
        // Awaited, so a failure to clear the saved record is caught below
        // and reported as a failed attempt.
        return await failedRegistration(response, pending);
      }
      const registration =
        pending.state === 'pending'
          ? parseReminderSubscriptionRegistrationResponse(
              JSON.parse(response.body),
            )
          : {
              credential: pending.credential,
              installationId: pending.installationId,
            };
      await saveStoredState({
        attemptGeneration: pending.attemptGeneration,
        deviceToken: pending.deviceToken,
        homeTimeZone: pending.homeTimeZone,
        oneDayEnabled: pending.oneDayEnabled,
        oneWeekEnabled: pending.oneWeekEnabled,
        registrationRequestId: pending.registrationRequestId,
        ...registration,
        lastContactAt: now().toISOString(),
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

  async function failedRegistration(
    response: { readonly body: string; readonly status: number },
    pending: RegistrationAttempt,
  ): Promise<ChangeReminderEnableResult> {
    if (response.status === 410 && pending.state === 'pending') {
      // The server proved this unauthenticated identity cannot be resumed.
      // Clear it only on this explicit enable/retry so the next attempt
      // creates a new request identity instead of replaying an expired one.
      await secureStore.deleteItemAsync(registrationKey);
    }
    if (registrationGone(response)) {
      await secureStore.deleteItemAsync(registrationKey);
      return { kind: 'unregistered' };
    }
    return { kind: 'failed' };
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
      const token = await devicePushToken();
      const saved = await loadStoredState();
      return synchronize(homeTimeZone, token, false, {
        oneDayEnabled: saved?.oneDayEnabled ?? true,
        oneWeekEnabled: saved?.oneWeekEnabled ?? true,
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
      if (saved === null) return null;
      const currentHomeTimeZone =
        latestHomeTimeZoneIntent ??
        (saved.homeTimeZone === homeTimeZone ? homeTimeZone : null);
      if (currentHomeTimeZone === null) return null;
      if (saved.state === 'pending-delete') return null;
      if (
        saved.state === 'registered' &&
        saved.version !== 2 &&
        saved.deviceToken === token
      ) {
        return null;
      }
      const result = await synchronize(currentHomeTimeZone, token, true, {
        oneDayEnabled: saved.oneDayEnabled,
        oneWeekEnabled: saved.oneWeekEnabled,
      });
      if (result.kind === 'enabled') {
        lastRefreshedToken = token;
        return { kind: 'succeeded' };
      }
      if (result.kind === 'unregistered') return result;
    } catch {
      // A later token update or explicit retry uses the durable pending state.
    }
    try {
      const saved = await loadStoredState();
      return {
        kind: 'failed',
        retryable:
          (saved?.state === 'pending' || saved?.state === 'pending-update') &&
          saved.homeTimeZone === (latestHomeTimeZoneIntent ?? homeTimeZone),
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
  let queuedRefreshListenerGeneration = 0;
  let refreshInFlight: Promise<void> | null = null;
  let refreshingToken: unknown = null;
  let lastRefreshedToken: unknown = null;
  let tokenListenerGeneration = 0;
  let latestHomeTimeZoneIntent: string | null = null;

  function enqueue<T>(operation: () => Promise<T>) {
    const next = registrationQueue.then(operation, operation);
    // A failed operation must not stop the ones behind it. Its caller still
    // gets the outcome through `next`.
    registrationQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  // Contact tells the service this registration is still in use, so it does
  // not expire it. Only a success is recorded and nothing is shown for a
  // failure, so the next foreground tries again. It runs queued, on the latest
  // saved registration, so it cannot overwrite an update that finished first.
  async function checkInWhenDue(
    restored: Extract<ChangeReminderRestoreResult, { kind: 'registered' }>,
  ): Promise<ChangeReminderRestoreResult> {
    const { registration } = restored;
    // Most foregrounds find nothing due and should cost nothing extra.
    if (
      registration.version !== 4 ||
      !checkInDue(registration.lastContactAt, now())
    ) {
      return restored;
    }
    return enqueue(async () => {
      try {
        const registrationEndpoint =
          parseReminderRegistrationEndpoint(endpoint);
        const latest = await loadStoredState();
        // Another restore or update cleared it while this one was queued.
        if (latest === null) return { kind: 'unregistered' };
        if (
          registrationEndpoint === null ||
          latest.state !== 'registered' ||
          latest.version !== 4 ||
          !checkInDue(latest.lastContactAt, now())
        ) {
          return restored;
        }
        const response = await fetchWithTimeout(
          request,
          updateEndpoint(
            registrationEndpoint,
            latest.installationId,
            '/check-in',
          ),
          {
            headers: { authorization: `Bearer ${latest.credential}` },
            method: 'POST',
          },
          timeoutMs,
        );
        if (registrationGone(response)) {
          await secureStore.deleteItemAsync(registrationKey);
          return { kind: 'unregistered' };
        }
        if (response.status !== 204) return restored;
        const checkedIn = { ...latest, lastContactAt: now().toISOString() };
        await saveStoredState(checkedIn);
        return { ...restored, registration: checkedIn };
      } catch {
        return restored;
      }
    });
  }

  function queueTokenRefresh(
    homeTimeZone: string,
    token: unknown,
    listenerGeneration: number,
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
    queuedRefreshListenerGeneration = listenerGeneration;
    if (refreshInFlight !== null) return;
    refreshInFlight = (async () => {
      while (queuedRefreshToken !== null) {
        const currentToken = queuedRefreshToken;
        const currentListenerGeneration = queuedRefreshListenerGeneration;
        queuedRefreshToken = null;
        refreshingToken = currentToken;
        try {
          const result = await enqueue(() =>
            currentListenerGeneration === tokenListenerGeneration
              ? performTokenRefresh(homeTimeZone, currentToken)
              : Promise.resolve(null),
          );
          // Nothing awaits this loop, so it only compares the result with
          // null. Reading result.kind here would turn a result that a Seshat
          // mutant leaves empty into an unhandled rejection. Seshat counts
          // that as an execution error unless the test also fails an
          // assertion, and the mutation score would be withheld.
          if (result !== null) onResult(result);
        } finally {
          refreshingToken = null;
        }
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }

  async function performHomeTimeZoneUpdate(
    homeTimeZone: string,
  ): Promise<ChangeReminderEnableResult> {
    if (platform === 'web') return { kind: 'unavailable' };
    const canonicalZoneId = normalizeAustralianZoneId(homeTimeZone);
    if (canonicalZoneId === null) return { kind: 'failed' };
    try {
      const saved = await loadStoredState();
      if (saved === null) return { kind: 'unregistered' };
      if (saved.state === 'pending-delete') return { kind: 'failed' };
      const deviceToken =
        'deviceToken' in saved ? saved.deviceToken : await devicePushToken();
      if (!validDeviceToken(deviceToken)) return { kind: 'failed' };
      const preferences = {
        oneDayEnabled: saved.oneDayEnabled,
        oneWeekEnabled: saved.oneWeekEnabled,
      };
      if (
        saved.state === 'registered' &&
        saved.version === 4 &&
        saved.homeTimeZone === canonicalZoneId
      ) {
        return { kind: 'enabled', preferences };
      }
      const result = await synchronize(
        canonicalZoneId,
        deviceToken,
        true,
        preferences,
        undefined,
        undefined,
        true,
      );
      return result.kind === 'enabled' ? { ...result, preferences } : result;
    } catch {
      return { kind: 'failed' };
    }
  }

  async function forgetPreviousInstall(
    saved: Exclude<
      StoredChangeReminderState,
      StoredChangeReminderPendingDelete
    >,
  ): Promise<ChangeReminderRestoreResult> {
    const registrationEndpoint = parseReminderRegistrationEndpoint(endpoint);
    // ponytail: a failed delete is not retried, so the old subscription
    // waits for provider cleanup; keep a pending deletion if that matters.
    if (saved.state !== 'pending' && registrationEndpoint !== null) {
      await deleteRegistration(registrationEndpoint, saved).catch(() => {});
    }
    await secureStore.deleteItemAsync(registrationKey);
    return { kind: 'unregistered' };
  }

  async function reconcileDeviceToken(
    saved: Extract<StoredChangeReminderState, { state: 'registered' }>,
    currentToken: string,
  ): Promise<ChangeReminderRestoreResult> {
    const result = await enqueue(async () => {
      const latest = await loadStoredState();
      return synchronize(
        latest?.homeTimeZone ?? saved.homeTimeZone,
        currentToken,
        true,
        latest === null
          ? {
              oneDayEnabled: saved.oneDayEnabled,
              oneWeekEnabled: saved.oneWeekEnabled,
            }
          : {
              oneDayEnabled: latest.oneDayEnabled,
              oneWeekEnabled: latest.oneWeekEnabled,
            },
        saved.registrationRequestId,
        saved.installationId,
      );
    });
    if (result.kind === 'unregistered') return result;
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
    async restore() {
      if (platform === 'web') return { kind: 'unavailable' };
      const saved = await loadStoredState();
      if (saved === null) return { kind: 'unregistered' };
      if (saved.state === 'pending-delete') {
        return {
          homeTimeZone: saved.homeTimeZone,
          kind: 'deleting',
          preferences: {
            oneDayEnabled: saved.oneDayEnabled,
            oneWeekEnabled: saved.oneWeekEnabled,
          },
        };
      }
      const permission = await notifications.getPermissionsAsync();
      // Enabling saves nothing until permission is granted, so a record beside
      // never-asked permission belongs to a previous install: the iOS keychain
      // survives uninstall. Delete its server registration rather than wait
      // for the provider to reject the old token, which Apple does not
      // guarantee. A pending deletion
      // above is kept: finishing it honours the user's intent.
      if (permission.status === Notifications.PermissionStatus.UNDETERMINED) {
        return forgetPreviousInstall(saved);
      }
      if (saved.state === 'pending' || saved.state === 'pending-update') {
        return pendingRestoreResult(saved);
      }
      if (!permission.granted) {
        return checkInWhenDue({
          kind: 'registered',
          notificationPermissionGranted: false,
          registration: saved,
        });
      }
      let currentToken: string;
      try {
        currentToken = await devicePushToken();
      } catch {
        return { homeTimeZone: saved.homeTimeZone, kind: 'pending' };
      }
      if (!validDeviceToken(currentToken)) {
        return { homeTimeZone: saved.homeTimeZone, kind: 'pending' };
      }
      if (saved.version !== 4 || saved.deviceToken !== currentToken) {
        return reconcileDeviceToken(saved, currentToken);
      }
      return checkInWhenDue({
        kind: 'registered',
        notificationPermissionGranted: permission.granted,
        registration: saved,
      });
    },
    enable(homeTimeZone) {
      if (enableInFlight !== null) {
        return enableInFlight.homeTimeZone === homeTimeZone
          ? enableInFlight.promise
          : Promise.resolve({ kind: 'failed' });
      }
      const canonicalZoneId = normalizeAustralianZoneId(homeTimeZone);
      if (canonicalZoneId !== null) latestHomeTimeZoneIntent = canonicalZoneId;
      const promise = enqueue(() => performEnable(homeTimeZone)).finally(() => {
        if (enableInFlight?.promise === promise) enableInFlight = null;
      });
      enableInFlight = { homeTimeZone, promise };
      return promise;
    },
    updateHomeTimeZone(homeTimeZone) {
      const canonicalZoneId = normalizeAustralianZoneId(homeTimeZone);
      if (canonicalZoneId === null) return Promise.resolve({ kind: 'failed' });
      latestHomeTimeZoneIntent = canonicalZoneId;
      return enqueue(() => performHomeTimeZoneUpdate(canonicalZoneId));
    },
    async updatePreferences(preferences) {
      if (!preferences.oneDayEnabled && !preferences.oneWeekEnabled) {
        return { kind: 'failed' };
      }
      return enqueue(async () => {
        const saved = await loadStoredState();
        // A check-in may have cleared it while this waited in the queue.
        if (saved === null) return { kind: 'unregistered' };
        if (
          (saved.state !== 'registered' && saved.state !== 'pending-update') ||
          saved.version === 2
        )
          return { kind: 'failed' };
        return synchronize(
          saved.homeTimeZone,
          saved.deviceToken,
          true,
          preferences,
          undefined,
          undefined,
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
          // A check-in may have cleared it while this waited in the queue.
          if (saved === null) return { kind: 'disabled' as const };
          if (
            registrationEndpoint === null ||
            (saved.state !== 'registered' &&
              saved.state !== 'pending-update' &&
              saved.state !== 'pending-delete')
          ) {
            return { kind: 'failed' as const };
          }
          const pendingDelete =
            saved.state === 'pending-delete'
              ? saved
              : ({
                  attemptGeneration: saved.attemptGeneration,
                  credential: saved.credential,
                  homeTimeZone: saved.homeTimeZone,
                  installationId: saved.installationId,
                  oneDayEnabled: saved.oneDayEnabled,
                  oneWeekEnabled: saved.oneWeekEnabled,
                  registrationRequestId: saved.registrationRequestId,
                  state: 'pending-delete' as const,
                  version: 4 as const,
                } satisfies StoredChangeReminderPendingDelete);
          await saveStoredState(pendingDelete);
          const response = await deleteRegistration(
            registrationEndpoint,
            pendingDelete,
          );
          if (response.status !== 204) return { kind: 'failed' as const };
          await secureStore.deleteItemAsync(registrationKey);
          latestHomeTimeZoneIntent = null;
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
    startTokenRefresh(homeTimeZone, onResult = () => {}) {
      if (platform === 'web') return () => {};
      let listening = true;
      const listenerGeneration = ++tokenListenerGeneration;
      const subscription = notifications.addPushTokenListener((token) => {
        if (!listening) return;
        queueTokenRefresh(
          homeTimeZone,
          token.data,
          listenerGeneration,
          (result) => {
            if (listening) onResult(result);
          },
        );
      });
      return () => {
        listening = false;
        if (tokenListenerGeneration === listenerGeneration) {
          tokenListenerGeneration += 1;
          queuedRefreshToken = null;
        }
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
