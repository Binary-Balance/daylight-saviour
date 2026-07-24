import { AndroidImportance } from 'expo-notifications';

import { createProductionChangeReminderAdapters } from './change-reminder-production-adapters';

const responseBody = {
  credential: 'c'.repeat(43),
  installationId: 'i'.repeat(43),
};

function harness({
  endpoint = 'https://reminders.example.test/reminder-subscriptions',
  existingPermission = { canAskAgain: true, granted: true },
  fetchImplementation = async () => Response.json(responseBody),
  platform = 'android',
  requestedPermission = { canAskAgain: true, granted: true },
  setItemImplementation = async () => undefined,
  timeoutMs = 100,
}: {
  readonly endpoint?: string;
  readonly existingPermission?: {
    readonly canAskAgain: boolean;
    readonly granted: boolean;
  };
  readonly fetchImplementation?: typeof fetch;
  readonly platform?: string;
  readonly requestedPermission?: {
    readonly canAskAgain: boolean;
    readonly granted: boolean;
  };
  readonly setItemImplementation?: (
    key: string,
    value: string,
  ) => Promise<void>;
  readonly timeoutMs?: number;
} = {}) {
  const calls: string[] = [];
  let stored: string | null = null;
  const secureSet = jest.fn(async (key: string, value: string) => {
    calls.push(`store:${key}`);
    stored = value;
    await setItemImplementation(key, value);
  });
  const request = jest.fn(async (...args: Parameters<typeof fetch>) => {
    calls.push('fetch');
    return fetchImplementation(...args);
  }) as jest.MockedFunction<typeof fetch>;
  const dependencies = {
    endpoint,
    fetch: request,
    notifications: {
      getDevicePushTokenAsync: jest.fn(async () => {
        calls.push('token');
        return { data: 'fcm-token:with_valid.characters-123' };
      }),
      getPermissionsAsync: jest.fn(async () => {
        calls.push('permission:get');
        return existingPermission;
      }),
      requestPermissionsAsync: jest.fn(async () => {
        calls.push('permission:request');
        return requestedPermission;
      }),
      setNotificationChannelAsync: jest.fn(async () => {
        calls.push('channel');
        return null;
      }),
    },
    openSettings: jest.fn(async () => undefined),
    platform,
    secureStore: {
      getItemAsync: jest.fn(async () => stored),
      setItemAsync: secureSet,
    },
    timeoutMs,
  };
  return {
    adapters: createProductionChangeReminderAdapters(dependencies),
    calls,
    dependencies,
    stored: () => stored,
  };
}

describe('production Change Reminder adapters', () => {
  it('creates Android channel before granted permission and native token work', async () => {
    const test = harness();
    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'enabled',
    });
    expect(test.calls).toEqual([
      'channel',
      'permission:get',
      'token',
      'fetch',
      'store:change-reminder-registration-v1',
    ]);
    expect(
      test.dependencies.notifications.setNotificationChannelAsync,
    ).toHaveBeenCalledWith('change-reminders', {
      importance: AndroidImportance.DEFAULT,
      name: 'Change Reminders',
    });
    expect(
      test.dependencies.notifications.requestPermissionsAsync,
    ).not.toHaveBeenCalled();

    const request = test.dependencies.fetch.mock.calls[0];
    expect(request?.[0]).toBe(
      'https://reminders.example.test/reminder-subscriptions',
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      deviceToken: 'fcm-token:with_valid.characters-123',
      homeTimeZone: 'Australia/Sydney',
      oneDayEnabled: true,
      oneWeekEnabled: true,
      platform: 'android',
    });
  });

  it('uses returned canAskAgain for first denial', async () => {
    const test = harness({
      existingPermission: { canAskAgain: true, granted: false },
      requestedPermission: { canAskAgain: true, granted: false },
    });
    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'permission-denied',
    });
    expect(test.calls).toEqual([
      'channel',
      'permission:get',
      'permission:request',
    ]);
  });

  it('does not prompt when existing permission is OS-blocked', async () => {
    const test = harness({
      existingPermission: { canAskAgain: false, granted: false },
    });
    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'os-blocked',
    });
    expect(
      test.dependencies.notifications.requestPermissionsAsync,
    ).not.toHaveBeenCalled();
    expect(
      test.dependencies.notifications.getDevicePushTokenAsync,
    ).not.toHaveBeenCalled();
  });

  it('uses returned OS-blocked status after a prompt', async () => {
    const test = harness({
      existingPermission: { canAskAgain: true, granted: false },
      requestedPermission: { canAskAgain: false, granted: false },
    });
    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'os-blocked',
    });
  });

  it('rejects non-HTTPS and credential-bearing registration endpoints', async () => {
    for (const endpoint of [
      'http://reminders.example.test',
      'https://user:password@reminders.example.test',
      'not a URL',
    ]) {
      const test = harness({ endpoint });
      await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
        kind: 'failed',
      });
      expect(test.dependencies.fetch).not.toHaveBeenCalled();
      expect(
        test.dependencies.notifications.getDevicePushTokenAsync,
      ).not.toHaveBeenCalled();
    }
  });

  it('aborts a registration request at the bounded timeout', async () => {
    const captured: { signal: AbortSignal | null } = { signal: null };
    const fetchImplementation = jest.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        captured.signal = init?.signal ?? null;
        return await new Promise<Response>(() => undefined);
      },
    ) as jest.MockedFunction<typeof fetch>;
    const test = harness({ fetchImplementation, timeoutMs: 1 });
    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'failed',
    });
    expect(captured.signal?.aborted).toBe(true);
  });

  it('persists and restores one versioned SecureStore value', async () => {
    const test = harness();
    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'enabled',
    });
    expect(test.dependencies.secureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(JSON.parse(test.stored() ?? '')).toEqual({
      ...responseBody,
      homeTimeZone: 'Australia/Sydney',
      oneDayEnabled: true,
      oneWeekEnabled: true,
      version: 1,
    });
    await expect(test.adapters.load()).resolves.toEqual({
      ...responseBody,
      homeTimeZone: 'Australia/Sydney',
      oneDayEnabled: true,
      oneWeekEnabled: true,
      version: 1,
    });
  });

  it('reports write, read, fetch, and response validation failures', async () => {
    const writeFailure = harness({
      setItemImplementation: jest.fn(async (_key: string, _value: string) => {
        throw new Error('SecureStore write failed');
      }),
    });
    await expect(
      writeFailure.adapters.enable('Australia/Sydney'),
    ).resolves.toEqual({ kind: 'failed' });

    const fetchFailure = harness({
      fetchImplementation: jest.fn(async (_input: URL | RequestInfo) => {
        throw new Error('network failed');
      }) as jest.MockedFunction<typeof fetch>,
    });
    await expect(
      fetchFailure.adapters.enable('Australia/Sydney'),
    ).resolves.toEqual({ kind: 'failed' });

    const invalidResponse = harness({
      fetchImplementation: jest.fn(async (_input: URL | RequestInfo) =>
        Response.json({ credential: 'raw-token', installationId: 'short' }),
      ) as jest.MockedFunction<typeof fetch>,
    });
    await expect(
      invalidResponse.adapters.enable('Australia/Sydney'),
    ).resolves.toEqual({ kind: 'failed' });

    const invalidStored = harness();
    jest
      .mocked(invalidStored.dependencies.secureStore.getItemAsync)
      .mockResolvedValueOnce('{"version":2}');
    await expect(invalidStored.adapters.load()).rejects.toThrow(
      'Invalid stored reminder registration',
    );
  });
});
