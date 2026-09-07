import { AndroidImportance } from 'expo-notifications';

import { createProductionChangeReminderAdapters } from './change-reminder-production-adapters';

const responseBody = {
  credential: 'c'.repeat(43),
  installationId: 'i'.repeat(43),
};
const iosDeviceToken = 'a'.repeat(64);
const refreshedIosDeviceToken = 'b'.repeat(64);

function harness({
  createRegistrationRequestId = async () => 'a'.repeat(64),
  currentToken = 'fcm-token:with_valid.characters-123',
  deleteItemImplementation = async () => undefined,
  endpoint = 'https://reminders.example.test/reminder-subscriptions',
  existingPermission = { canAskAgain: true, granted: true },
  fetchImplementation = async () => Response.json(responseBody),
  platform = 'android',
  requestedPermission = { canAskAgain: true, granted: true },
  setItemImplementation = async () => undefined,
  storage = { value: null },
  timeoutMs = 100,
}: {
  readonly createRegistrationRequestId?: () => Promise<string>;
  readonly currentToken?: string;
  readonly deleteItemImplementation?: () => Promise<void>;
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
  readonly storage?: { value: string | null };
  readonly timeoutMs?: number;
} = {}) {
  const calls: string[] = [];
  const secureSet = jest.fn(async (key: string, value: string) => {
    calls.push(`store:${key}`);
    await setItemImplementation(key, value);
    storage.value = value;
  });
  const request = jest.fn(async (...args: Parameters<typeof fetch>) => {
    calls.push('fetch');
    return fetchImplementation(...args);
  }) as jest.MockedFunction<typeof fetch>;
  const dependencies = {
    createRegistrationRequestId,
    endpoint,
    fetch: request,
    notifications: {
      addPushTokenListener: jest.fn(
        (_listener: (token: { readonly data: unknown }) => void) => ({
          remove: jest.fn(),
        }),
      ),
      getDevicePushTokenAsync: jest.fn(async () => {
        calls.push('token');
        return { data: currentToken };
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
      deleteItemAsync: jest.fn(async () => {
        calls.push('delete:change-reminder-registration-v2');
        await deleteItemImplementation();
        storage.value = null;
      }),
      getItemAsync: jest.fn(async () => storage.value),
      setItemAsync: secureSet,
    },
    timeoutMs,
  };
  return {
    adapters: createProductionChangeReminderAdapters(dependencies),
    calls,
    dependencies,
    stored: () => storage.value,
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
      'store:change-reminder-registration-v2',
      'fetch',
      'store:change-reminder-registration-v2',
    ]);
    expect(
      test.dependencies.notifications.setNotificationChannelAsync,
    ).toHaveBeenCalledWith('change-reminders', {
      importance: AndroidImportance.HIGH,
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
      attemptGeneration: 1,
      deviceToken: 'fcm-token:with_valid.characters-123',
      homeTimeZone: 'Australia/Sydney',
      oneDayEnabled: true,
      oneWeekEnabled: true,
      platform: 'android',
      registrationRequestId: 'a'.repeat(64),
    });
  });

  it('requests iOS permission before registering its device token', async () => {
    const test = harness({
      currentToken: iosDeviceToken,
      existingPermission: { canAskAgain: true, granted: false },
      platform: 'ios',
    });

    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'enabled',
    });
    expect(test.calls).toEqual([
      'permission:get',
      'permission:request',
      'token',
      'store:change-reminder-registration-v2',
      'fetch',
      'store:change-reminder-registration-v2',
    ]);
    expect(
      test.dependencies.notifications.setNotificationChannelAsync,
    ).not.toHaveBeenCalled();
    expect(
      JSON.parse(String(test.dependencies.fetch.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({ deviceToken: iosDeviceToken, platform: 'ios' });
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

  it('retries a timed-out registration with the same request ID and a higher generation', async () => {
    const captured: { signal: AbortSignal | null } = { signal: null };
    const fetchImplementation = jest
      .fn()
      .mockImplementationOnce(
        async (_input: URL | RequestInfo, init?: RequestInit) => {
          captured.signal = init?.signal ?? null;
          return await new Promise<Response>(() => undefined);
        },
      )
      .mockImplementationOnce(async () =>
        Response.json(responseBody),
      ) as jest.MockedFunction<typeof fetch>;
    const test = harness({ fetchImplementation, timeoutMs: 1 });
    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'failed',
    });
    expect(captured.signal?.aborted).toBe(true);
    const pending = JSON.parse(test.stored() ?? '');
    expect(pending).toMatchObject({
      attemptGeneration: 1,
      registrationRequestId: 'a'.repeat(64),
      state: 'pending',
    });

    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'enabled',
    });
    const transmitted = test.dependencies.fetch.mock.calls.map((request) =>
      JSON.parse(String(request[1]?.body)),
    );
    expect(transmitted).toEqual([
      expect.objectContaining({
        attemptGeneration: 1,
        registrationRequestId: 'a'.repeat(64),
      }),
      expect.objectContaining({
        attemptGeneration: 2,
        registrationRequestId: 'a'.repeat(64),
      }),
    ]);
  });

  it('shares one in-flight enable operation', async () => {
    let resolve!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((onStarted) => {
      markStarted = onStarted;
    });
    const fetchImplementation = jest.fn(async (_input: URL | RequestInfo) => {
      markStarted();
      return await new Promise<Response>((onResolve) => {
        resolve = onResolve;
      });
    }) as jest.MockedFunction<typeof fetch>;
    const test = harness({ fetchImplementation });
    const first = test.adapters.enable('Australia/Sydney');
    const second = test.adapters.enable('Australia/Sydney');
    await started;
    resolve(Response.json(responseBody));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'enabled' },
      { kind: 'enabled' },
    ]);
    expect(test.dependencies.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not share in-flight enablement across different zones', async () => {
    let resolve!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((onStarted) => {
      markStarted = onStarted;
    });
    const fetchImplementation = jest.fn(async (_input: URL | RequestInfo) => {
      markStarted();
      return await new Promise<Response>((onResolve) => {
        resolve = onResolve;
      });
    }) as jest.MockedFunction<typeof fetch>;
    const test = harness({ fetchImplementation });
    const sydney = test.adapters.enable('Australia/Sydney');
    await started;

    await expect(test.adapters.enable('Australia/Brisbane')).resolves.toEqual({
      kind: 'failed',
    });
    resolve(Response.json(responseBody));
    await expect(sydney).resolves.toEqual({ kind: 'enabled' });
    expect(test.dependencies.fetch).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String(test.dependencies.fetch.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({ homeTimeZone: 'Australia/Sydney' });
  });

  it('persists and restores one versioned SecureStore value', async () => {
    const test = harness();
    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'enabled',
    });
    expect(test.dependencies.secureStore.setItemAsync).toHaveBeenCalledTimes(2);
    expect(JSON.parse(test.stored() ?? '')).toEqual({
      ...responseBody,
      attemptGeneration: 1,
      deviceToken: 'fcm-token:with_valid.characters-123',
      homeTimeZone: 'Australia/Sydney',
      oneDayEnabled: true,
      oneWeekEnabled: true,
      registrationRequestId: 'a'.repeat(64),
      state: 'registered',
      version: 4,
    });
    await expect(test.adapters.restore()).resolves.toEqual({
      kind: 'registered',
      notificationPermissionGranted: true,
      registration: {
        ...responseBody,
        attemptGeneration: 1,
        deviceToken: 'fcm-token:with_valid.characters-123',
        homeTimeZone: 'Australia/Sydney',
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'registered',
        version: 4,
      },
    });
  });

  it('retries relaunched pending state using the caller current zone', async () => {
    const storage = {
      value: JSON.stringify({
        attemptGeneration: 4,
        deviceToken: 'fcm-token:with_valid.characters-123',
        homeTimeZone: 'Australia/Sydney',
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'b'.repeat(64),
        state: 'pending',
        version: 4,
      }),
    };
    const relaunched = harness({ storage });
    await expect(relaunched.adapters.restore()).resolves.toEqual({
      homeTimeZone: 'Australia/Sydney',
      kind: 'pending',
    });
    await expect(
      relaunched.adapters.enable('Australia/Brisbane'),
    ).resolves.toEqual({ kind: 'enabled' });
    expect(
      JSON.parse(
        String(relaunched.dependencies.fetch.mock.calls[0]?.[1]?.body),
      ),
    ).toMatchObject({
      attemptGeneration: 5,
      homeTimeZone: 'Australia/Sydney',
      registrationRequestId: 'b'.repeat(64),
    });
    expect(
      JSON.parse(
        String(relaunched.dependencies.fetch.mock.calls[1]?.[1]?.body),
      ),
    ).toMatchObject({
      attemptGeneration: 6,
      homeTimeZone: 'Australia/Brisbane',
    });
    expect(relaunched.dependencies.fetch.mock.calls[1]?.[1]).toMatchObject({
      method: 'PUT',
    });
    expect(JSON.parse(storage.value)).toMatchObject({
      homeTimeZone: 'Australia/Brisbane',
      state: 'registered',
    });
  });

  it('converges after server success followed by SecureStore failure', async () => {
    let writes = 0;
    const storage = { value: null };
    const firstLaunch = harness({
      setItemImplementation: jest.fn(async () => {
        writes += 1;
        if (writes === 2) throw new Error('SecureStore write failed');
      }),
      storage,
    });
    await expect(
      firstLaunch.adapters.enable('Australia/Sydney'),
    ).resolves.toEqual({ kind: 'failed' });
    expect(JSON.parse(storage.value ?? '')).toMatchObject({
      attemptGeneration: 1,
      state: 'pending',
    });

    const relaunched = harness({ storage });
    await expect(
      relaunched.adapters.enable('Australia/Sydney'),
    ).resolves.toEqual({ kind: 'enabled' });
    const body = JSON.parse(
      String(relaunched.dependencies.fetch.mock.calls[0]?.[1]?.body),
    );
    expect(body).toMatchObject({
      attemptGeneration: 2,
      registrationRequestId: 'a'.repeat(64),
    });
    expect(JSON.parse(storage.value ?? '')).toMatchObject({
      attemptGeneration: 2,
      state: 'registered',
    });
  });

  it('replays lost initial registration before authenticated desired-state update', async () => {
    const storage = {
      value: JSON.stringify({
        attemptGeneration: 4,
        deviceToken: 'fcm-token:old_valid.characters-123',
        homeTimeZone: 'Australia/Sydney',
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'b'.repeat(64),
        state: 'pending',
        version: 4,
      }),
    };
    const test = harness({
      currentToken: 'fcm-token:replacement_valid.characters-456',
      storage,
    });
    await expect(test.adapters.enable('Australia/Brisbane')).resolves.toEqual({
      kind: 'enabled',
    });
    const [post, put] = test.dependencies.fetch.mock.calls;
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      attemptGeneration: 5,
      deviceToken: 'fcm-token:old_valid.characters-123',
      homeTimeZone: 'Australia/Sydney',
      registrationRequestId: 'b'.repeat(64),
    });
    expect(post?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({
      attemptGeneration: 6,
      deviceToken: 'fcm-token:replacement_valid.characters-456',
      homeTimeZone: 'Australia/Brisbane',
    });
    expect(put?.[1]).toMatchObject({ method: 'PUT' });
  });

  it('does not recreate a deleted authenticated installation after PUT 404', async () => {
    const deleted = harness({
      fetchImplementation: jest
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { status: 404 }),
        ) as jest.MockedFunction<typeof fetch>,
      storage: {
        value: JSON.stringify({
          ...responseBody,
          attemptGeneration: 4,
          deviceToken: 'fcm-token:old_valid.characters-123',
          homeTimeZone: 'Australia/Sydney',
          oneDayEnabled: true,
          oneWeekEnabled: true,
          registrationRequestId: 'a'.repeat(64),
          state: 'registered',
          version: 4,
        }),
      },
    });
    await expect(deleted.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'failed',
    });
    expect(
      deleted.dependencies.fetch.mock.calls.map((call) => call[1]?.method),
    ).toEqual(['PUT']);

    const unauthorized = harness({
      currentToken: 'fcm-token:another_valid.characters-789',
      fetchImplementation: jest.fn(
        async (_input: URL | RequestInfo) =>
          new Response(null, { status: 401 }),
      ) as jest.MockedFunction<typeof fetch>,
      storage: { value: deleted.stored() },
    });
    await expect(
      unauthorized.adapters.enable('Australia/Sydney'),
    ).resolves.toEqual({
      kind: 'failed',
    });
    expect(unauthorized.dependencies.fetch).toHaveBeenCalledTimes(1);
  });

  it('clears an expired initial identity so an explicit retry creates v2', async () => {
    const nextRequestId = `v2.${String(Date.now()).padStart(13, '0')}.${'b'.repeat(64)}`;
    const test = harness({
      createRegistrationRequestId: async () => nextRequestId,
      fetchImplementation: jest
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 410 }))
        .mockResolvedValueOnce(
          Response.json(responseBody),
        ) as jest.MockedFunction<typeof fetch>,
      storage: {
        value: JSON.stringify({
          attemptGeneration: 4,
          deviceToken: 'fcm-token:with_valid.characters-123',
          homeTimeZone: 'Australia/Sydney',
          oneDayEnabled: true,
          oneWeekEnabled: true,
          registrationRequestId: 'a'.repeat(64),
          state: 'pending',
          version: 4,
        }),
      },
    });
    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'failed',
    });
    expect(test.stored()).toBeNull();
    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'enabled',
    });
    expect(
      JSON.parse(String(test.dependencies.fetch.mock.calls[1]?.[1]?.body)),
    ).toMatchObject({ registrationRequestId: nextRequestId });
  });

  it('reconciles an offline token rotation during restore before reporting enabled', async () => {
    const storage = {
      value: JSON.stringify({
        ...responseBody,
        attemptGeneration: 7,
        deviceToken: 'fcm-token:old_valid.characters-123',
        homeTimeZone: 'Australia/Sydney',
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'registered',
        version: 4,
      }),
    };
    const test = harness({
      currentToken: 'fcm-token:replacement_valid.characters-456',
      storage,
    });

    await expect(test.adapters.restore()).resolves.toMatchObject({
      kind: 'registered',
      notificationPermissionGranted: true,
      registration: {
        attemptGeneration: 8,
        deviceToken: 'fcm-token:replacement_valid.characters-456',
        registrationRequestId: 'a'.repeat(64),
        version: 4,
      },
    });
    expect(
      JSON.parse(String(test.dependencies.fetch.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      attemptGeneration: 8,
      deviceToken: 'fcm-token:replacement_valid.characters-456',
    });
    expect(test.dependencies.fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        authorization: `Bearer ${responseBody.credential}`,
      }),
      method: 'PUT',
    });
  });

  it('migrates legacy v2 registration through one token reconciliation', async () => {
    const storage = {
      value: JSON.stringify({
        ...responseBody,
        attemptGeneration: 3,
        homeTimeZone: 'Australia/Sydney',
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'registered',
        version: 2,
      }),
    };
    const test = harness({ storage });

    await expect(test.adapters.restore()).resolves.toMatchObject({
      kind: 'registered',
      registration: {
        attemptGeneration: 4,
        deviceToken: 'fcm-token:with_valid.characters-123',
        version: 4,
      },
    });
  });

  it('migrates an exact legacy v2 pending retry after explicit enablement', async () => {
    const storage = {
      value: JSON.stringify({
        attemptGeneration: 3,
        homeTimeZone: 'Australia/Sydney',
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'pending',
        version: 2,
      }),
    };
    const test = harness({ storage });

    await expect(test.adapters.restore()).resolves.toEqual({
      homeTimeZone: 'Australia/Sydney',
      kind: 'pending',
    });
    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'enabled',
    });
    expect(
      JSON.parse(String(test.dependencies.fetch.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      attemptGeneration: 4,
      deviceToken: 'fcm-token:with_valid.characters-123',
      registrationRequestId: 'a'.repeat(64),
    });
    expect(JSON.parse(storage.value)).toMatchObject({
      attemptGeneration: 4,
      deviceToken: 'fcm-token:with_valid.characters-123',
      registrationRequestId: 'a'.repeat(64),
      state: 'registered',
      version: 4,
    });
  });

  it('refreshes an iOS registered token once with the same request ID and next generation', async () => {
    let listener: ((token: { readonly data: unknown }) => void) | undefined;
    const remove = jest.fn();
    const outcomes: unknown[] = [];
    const test = harness({ currentToken: iosDeviceToken, platform: 'ios' });
    jest
      .mocked(test.dependencies.notifications.addPushTokenListener)
      .mockImplementation((nextListener) => {
        listener = nextListener;
        return { remove };
      });
    await test.adapters.enable('Australia/Sydney');
    const stop = test.adapters.startTokenRefresh('Australia/Sydney', (result) =>
      outcomes.push(result),
    );
    listener?.({ data: refreshedIosDeviceToken });
    listener?.({ data: refreshedIosDeviceToken });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const requests = test.dependencies.fetch.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)),
    );
    expect(requests).toEqual([
      expect.objectContaining({
        attemptGeneration: 1,
        deviceToken: iosDeviceToken,
        platform: 'ios',
        registrationRequestId: 'a'.repeat(64),
      }),
      expect.objectContaining({
        attemptGeneration: 2,
        deviceToken: refreshedIosDeviceToken,
        homeTimeZone: 'Australia/Sydney',
        platform: 'ios',
      }),
    ]);
    expect(JSON.parse(test.stored() ?? '')).toMatchObject({
      attemptGeneration: 2,
      state: 'registered',
    });
    expect(outcomes).toEqual([{ kind: 'succeeded' }]);
    stop();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('does not refresh a replaced-zone registration or a malformed token', async () => {
    const test = harness({
      storage: {
        value: JSON.stringify({
          ...responseBody,
          attemptGeneration: 4,
          homeTimeZone: 'Australia/Brisbane',
          oneDayEnabled: true,
          oneWeekEnabled: true,
          registrationRequestId: 'a'.repeat(64),
          state: 'registered',
          version: 2,
        }),
      },
    });
    let listener: ((token: { readonly data: unknown }) => void) | undefined;
    jest
      .mocked(test.dependencies.notifications.addPushTokenListener)
      .mockImplementation((nextListener) => {
        listener = nextListener;
        return { remove: jest.fn() };
      });
    const outcomes: unknown[] = [];
    test.adapters.startTokenRefresh('Australia/Sydney', (result) =>
      outcomes.push(result),
    );
    listener?.({ data: 'short' });
    listener?.({ data: 'fcm-token:replacement_valid.characters-456' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(test.dependencies.fetch).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });

  it('keeps failed token refresh pending and retries the same token', async () => {
    const fetchImplementation = jest
      .fn()
      .mockResolvedValueOnce(Response.json(responseBody))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json(responseBody),
      ) as jest.MockedFunction<typeof fetch>;
    const test = harness({ fetchImplementation });
    const outcomes: unknown[] = [];
    let listener: ((token: { readonly data: unknown }) => void) | undefined;
    jest
      .mocked(test.dependencies.notifications.addPushTokenListener)
      .mockImplementation((nextListener) => {
        listener = nextListener;
        return { remove: jest.fn() };
      });
    await test.adapters.enable('Australia/Sydney');
    test.adapters.startTokenRefresh('Australia/Sydney', (result) =>
      outcomes.push(result),
    );
    const replacement = 'fcm-token:replacement_valid.characters-456';
    listener?.({ data: replacement });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(test.stored() ?? '')).toMatchObject({
      attemptGeneration: 2,
      deviceToken: replacement,
      state: 'pending-update',
    });
    expect(outcomes).toEqual([{ kind: 'failed', retryable: true }]);
    listener?.({ data: replacement });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(test.stored() ?? '')).toMatchObject({
      attemptGeneration: 3,
      deviceToken: replacement,
      state: 'registered',
    });
    expect(outcomes).toEqual([
      { kind: 'failed', retryable: true },
      { kind: 'succeeded' },
    ]);
  });

  it('retries the same token after the refresh registration SecureStore write fails', async () => {
    let writes = 0;
    const storage = { value: null };
    const test = harness({
      setItemImplementation: async () => {
        writes += 1;
        if (writes === 4) throw new Error('SecureStore write failed');
      },
      storage,
    });
    let listener: ((token: { readonly data: unknown }) => void) | undefined;
    jest
      .mocked(test.dependencies.notifications.addPushTokenListener)
      .mockImplementation((nextListener) => {
        listener = nextListener;
        return { remove: jest.fn() };
      });
    await test.adapters.enable('Australia/Sydney');
    test.adapters.startTokenRefresh('Australia/Sydney');
    const replacement = 'fcm-token:replacement_valid.characters-456';

    listener?.({ data: replacement });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(storage.value ?? '')).toMatchObject({
      attemptGeneration: 2,
      deviceToken: replacement,
      state: 'pending-update',
    });

    listener?.({ data: replacement });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(storage.value ?? '')).toMatchObject({
      attemptGeneration: 3,
      deviceToken: replacement,
      state: 'registered',
    });
  });

  it('reports web unavailable without touching native or secure APIs', async () => {
    const test = harness({ platform: 'web' });

    await expect(test.adapters.restore()).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(test.dependencies.secureStore.getItemAsync).not.toHaveBeenCalled();
    expect(test.dependencies.secureStore.setItemAsync).not.toHaveBeenCalled();
    expect(
      test.dependencies.notifications.getPermissionsAsync,
    ).not.toHaveBeenCalled();
    expect(
      test.dependencies.notifications.requestPermissionsAsync,
    ).not.toHaveBeenCalled();
    expect(
      test.dependencies.notifications.getDevicePushTokenAsync,
    ).not.toHaveBeenCalled();
    expect(
      test.dependencies.notifications.setNotificationChannelAsync,
    ).not.toHaveBeenCalled();
    expect(test.dependencies.fetch).not.toHaveBeenCalled();
  });

  it('persists a pending timing attempt before PUT and keeps confirmed values after failure', async () => {
    const test = harness({
      storage: {
        value: JSON.stringify({
          ...responseBody,
          attemptGeneration: 4,
          deviceToken: 'fcm-token:with_valid.characters-123',
          homeTimeZone: 'Australia/Sydney',
          oneDayEnabled: true,
          oneWeekEnabled: true,
          registrationRequestId: 'a'.repeat(64),
          state: 'registered',
          version: 4,
        }),
      },
    });
    jest
      .mocked(test.dependencies.fetch)
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(
      test.adapters.updatePreferences({
        oneDayEnabled: false,
        oneWeekEnabled: true,
      }),
    ).resolves.toEqual({ kind: 'failed' });
    expect(JSON.parse(test.stored() ?? '')).toMatchObject({
      attemptGeneration: 5,
      confirmedOneDayEnabled: true,
      confirmedOneWeekEnabled: true,
      oneDayEnabled: false,
      oneWeekEnabled: true,
      state: 'pending-update',
    });

    jest
      .mocked(test.dependencies.fetch)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(
      test.adapters.updatePreferences({
        oneDayEnabled: false,
        oneWeekEnabled: true,
      }),
    ).resolves.toEqual({ kind: 'enabled' });
    expect(JSON.parse(test.stored() ?? '')).toMatchObject({
      attemptGeneration: 6,
      oneDayEnabled: false,
      oneWeekEnabled: true,
      state: 'registered',
    });
    expect(
      JSON.parse(String(test.dependencies.fetch.mock.calls[1]?.[1]?.body)),
    ).toMatchObject({
      attemptGeneration: 6,
      oneDayEnabled: false,
      oneWeekEnabled: true,
    });
  });

  it('keeps a preference attempt durable when the final SecureStore save fails', async () => {
    let writes = 0;
    const storage = {
      value: JSON.stringify({
        ...responseBody,
        attemptGeneration: 4,
        deviceToken: 'fcm-token:with_valid.characters-123',
        homeTimeZone: 'Australia/Sydney',
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'registered',
        version: 4,
      }),
    };
    const fetchImplementation = jest
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 204 }),
      ) as jest.MockedFunction<typeof fetch>;
    const test = harness({
      setItemImplementation: async () => {
        writes += 1;
        if (writes === 2) throw new Error('SecureStore write failed');
      },
      storage,
      fetchImplementation,
    });

    await expect(
      test.adapters.updatePreferences({
        oneDayEnabled: false,
        oneWeekEnabled: true,
      }),
    ).resolves.toEqual({ kind: 'failed' });
    expect(JSON.parse(storage.value ?? '')).toMatchObject({
      attemptGeneration: 5,
      oneDayEnabled: false,
      oneWeekEnabled: true,
      state: 'pending-update',
    });

    const recreated = harness({ fetchImplementation, storage });
    await expect(
      recreated.adapters.updatePreferences({
        oneDayEnabled: false,
        oneWeekEnabled: true,
      }),
    ).resolves.toEqual({ kind: 'enabled' });
    expect(JSON.parse(storage.value ?? '')).toMatchObject({
      attemptGeneration: 6,
      oneDayEnabled: false,
      oneWeekEnabled: true,
      state: 'registered',
    });
    expect(
      fetchImplementation.mock.calls.map(
        (call) => JSON.parse(String(call[1]?.body)).attemptGeneration,
      ),
    ).toEqual([5, 6]);
  });

  it('restores a pending preference attempt with confirmed and proposed values', async () => {
    const storage = {
      value: JSON.stringify({
        ...responseBody,
        attemptGeneration: 5,
        confirmedOneDayEnabled: true,
        confirmedOneWeekEnabled: true,
        deviceToken: 'fcm-token:with_valid.characters-123',
        homeTimeZone: 'Australia/Sydney',
        oneDayEnabled: false,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'pending-update',
        version: 4,
      }),
    };
    const test = harness({ storage });

    await expect(test.adapters.restore()).resolves.toEqual({
      homeTimeZone: 'Australia/Sydney',
      kind: 'pending',
      pendingPreferences: {
        confirmed: { oneDayEnabled: true, oneWeekEnabled: true },
        proposed: { oneDayEnabled: false, oneWeekEnabled: true },
      },
    });
    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'enabled',
    });
    expect(
      JSON.parse(String(test.dependencies.fetch.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      attemptGeneration: 6,
      oneDayEnabled: false,
      oneWeekEnabled: true,
    });
  });

  it('recovers a lost preference acknowledgement with the server stale-generation rule', async () => {
    const storage = {
      value: JSON.stringify({
        ...responseBody,
        attemptGeneration: 4,
        deviceToken: 'fcm-token:with_valid.characters-123',
        homeTimeZone: 'Australia/Sydney',
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'registered',
        version: 4,
      }),
    };
    let serverGeneration = 4;
    let serverPreferences = { oneDayEnabled: true, oneWeekEnabled: true };
    let loseResponse = true;
    const attempts: number[] = [];
    const serverRequest = jest.fn(async (_input: URL | RequestInfo, init) => {
      const body = JSON.parse(String(init?.body)) as {
        attemptGeneration: number;
        oneDayEnabled: boolean;
        oneWeekEnabled: boolean;
      };
      attempts.push(body.attemptGeneration);
      if (body.attemptGeneration <= serverGeneration) {
        return new Response(null, { status: 409 });
      }
      serverGeneration = body.attemptGeneration;
      serverPreferences = {
        oneDayEnabled: body.oneDayEnabled,
        oneWeekEnabled: body.oneWeekEnabled,
      };
      if (loseResponse) {
        loseResponse = false;
        throw new Error('response lost after server commit');
      }
      return new Response(null, { status: 204 });
    }) as jest.MockedFunction<typeof fetch>;
    const test = harness({
      fetchImplementation: serverRequest,
      storage,
    });

    await expect(
      test.adapters.updatePreferences({
        oneDayEnabled: false,
        oneWeekEnabled: true,
      }),
    ).resolves.toEqual({ kind: 'failed' });

    const recreated = harness({
      fetchImplementation: serverRequest,
      storage,
    });
    await expect(
      recreated.adapters.updatePreferences({
        oneDayEnabled: false,
        oneWeekEnabled: true,
      }),
    ).resolves.toEqual({ kind: 'enabled' });

    expect(attempts).toEqual([5, 6]);
    expect(serverGeneration).toBe(6);
    expect(serverPreferences).toEqual({
      oneDayEnabled: false,
      oneWeekEnabled: true,
    });
    expect(JSON.parse(storage.value ?? '')).toMatchObject({
      attemptGeneration: 6,
      oneDayEnabled: false,
      oneWeekEnabled: true,
      state: 'registered',
    });
  });

  it('reconciles cancelled timings through newer uncertain attempts after restart', async () => {
    const storage = {
      value: JSON.stringify({
        ...responseBody,
        attemptGeneration: 4,
        deviceToken: 'fcm-token:with_valid.characters-123',
        homeTimeZone: 'Australia/Sydney',
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'registered',
        version: 4,
      }),
    };
    let serverGeneration = 4;
    let serverPreferences = { oneDayEnabled: true, oneWeekEnabled: true };
    const attempts: {
      readonly attemptGeneration: number;
      readonly oneDayEnabled: boolean;
    }[] = [];
    const loseResponses = new Set([5, 6]);
    const serverRequest = jest.fn(async (_input: URL | RequestInfo, init) => {
      const body = JSON.parse(String(init?.body)) as {
        attemptGeneration: number;
        oneDayEnabled: boolean;
        oneWeekEnabled: boolean;
      };
      attempts.push({
        attemptGeneration: body.attemptGeneration,
        oneDayEnabled: body.oneDayEnabled,
      });
      if (body.attemptGeneration <= serverGeneration) {
        return new Response(null, { status: 409 });
      }
      serverGeneration = body.attemptGeneration;
      serverPreferences = {
        oneDayEnabled: body.oneDayEnabled,
        oneWeekEnabled: true,
      };
      if (loseResponses.delete(body.attemptGeneration)) {
        throw new Error('response lost after server commit');
      }
      return new Response(null, { status: 204 });
    }) as jest.MockedFunction<typeof fetch>;
    const first = harness({ fetchImplementation: serverRequest, storage });

    await expect(
      first.adapters.updatePreferences({
        oneDayEnabled: false,
        oneWeekEnabled: true,
      }),
    ).resolves.toEqual({ kind: 'failed' });
    await expect(
      first.adapters.updatePreferences({
        oneDayEnabled: true,
        oneWeekEnabled: true,
      }),
    ).resolves.toEqual({ kind: 'failed' });

    const recreated = harness({ fetchImplementation: serverRequest, storage });
    await expect(recreated.adapters.restore()).resolves.toEqual({
      homeTimeZone: 'Australia/Sydney',
      kind: 'pending',
      pendingPreferences: {
        confirmed: { oneDayEnabled: true, oneWeekEnabled: true },
        proposed: { oneDayEnabled: true, oneWeekEnabled: true },
      },
    });
    await expect(
      recreated.adapters.updatePreferences({
        oneDayEnabled: true,
        oneWeekEnabled: true,
      }),
    ).resolves.toEqual({ kind: 'enabled' });

    expect(attempts).toEqual([
      { attemptGeneration: 5, oneDayEnabled: false },
      { attemptGeneration: 6, oneDayEnabled: true },
      { attemptGeneration: 7, oneDayEnabled: true },
    ]);
    expect(serverGeneration).toBe(7);
    expect(serverPreferences).toEqual({
      oneDayEnabled: true,
      oneWeekEnabled: true,
    });
    expect(JSON.parse(storage.value ?? '')).toMatchObject({
      attemptGeneration: 7,
      oneDayEnabled: true,
      oneWeekEnabled: true,
      state: 'registered',
    });
  });

  it('serializes a concurrent token refresh after a pending preference attempt', async () => {
    const storage = {
      value: JSON.stringify({
        ...responseBody,
        attemptGeneration: 4,
        deviceToken: 'fcm-token:with_valid.characters-123',
        homeTimeZone: 'Australia/Sydney',
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'registered',
        version: 4,
      }),
    };
    const replacement = 'fcm-token:replacement_valid.characters-456';
    let serverGeneration = 4;
    let releasePreferenceRequest!: () => void;
    let markPreferenceRequestStarted!: () => void;
    const preferenceRequestStarted = new Promise<void>((resolve) => {
      markPreferenceRequestStarted = resolve;
    });
    const attempts: {
      readonly attemptGeneration: number;
      readonly deviceToken: string;
      readonly oneDayEnabled: boolean;
    }[] = [];
    const test = harness({
      fetchImplementation: jest.fn(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          attemptGeneration: number;
          deviceToken: string;
          oneDayEnabled: boolean;
          oneWeekEnabled: boolean;
        };
        attempts.push(body);
        if (body.attemptGeneration <= serverGeneration) {
          return new Response(null, { status: 409 });
        }
        serverGeneration = body.attemptGeneration;
        if (body.attemptGeneration === 5) {
          markPreferenceRequestStarted();
          await new Promise<void>((resolve) => {
            releasePreferenceRequest = resolve;
          });
          throw new Error('response lost after server commit');
        }
        return new Response(null, { status: 204 });
      }) as jest.MockedFunction<typeof fetch>,
      storage,
    });
    let listener: ((token: { readonly data: unknown }) => void) | undefined;
    jest
      .mocked(test.dependencies.notifications.addPushTokenListener)
      .mockImplementation((nextListener) => {
        listener = nextListener;
        return { remove: jest.fn() };
      });

    const preferenceUpdate = test.adapters.updatePreferences({
      oneDayEnabled: false,
      oneWeekEnabled: true,
    });
    await preferenceRequestStarted;
    test.adapters.startTokenRefresh('Australia/Sydney');
    listener?.({ data: replacement });
    releasePreferenceRequest();

    await expect(preferenceUpdate).resolves.toEqual({ kind: 'failed' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attempts).toEqual([
      expect.objectContaining({
        attemptGeneration: 5,
        deviceToken: 'fcm-token:with_valid.characters-123',
        oneDayEnabled: false,
      }),
      expect.objectContaining({
        attemptGeneration: 6,
        deviceToken: replacement,
        oneDayEnabled: false,
      }),
    ]);
    expect(JSON.parse(storage.value ?? '')).toMatchObject({
      attemptGeneration: 6,
      deviceToken: replacement,
      oneDayEnabled: false,
      oneWeekEnabled: true,
      state: 'registered',
    });
  });

  it('deletes credentials only after an authenticated DELETE succeeds', async () => {
    const storage = {
      value: JSON.stringify({
        ...responseBody,
        attemptGeneration: 4,
        deviceToken: 'fcm-token:with_valid.characters-123',
        homeTimeZone: 'Australia/Sydney',
        oneDayEnabled: true,
        oneWeekEnabled: false,
        registrationRequestId: 'a'.repeat(64),
        state: 'registered',
        version: 4,
      }),
    };
    const test = harness({
      fetchImplementation: jest
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 202 }))
        .mockResolvedValueOnce(
          new Response(null, { status: 204 }),
        ) as jest.MockedFunction<typeof fetch>,
      storage,
    });
    await expect(test.adapters.disable()).resolves.toEqual({ kind: 'failed' });
    expect(JSON.parse(storage.value ?? '')).toMatchObject({
      state: 'pending-delete',
      credential: responseBody.credential,
    });
    await expect(test.adapters.disable()).resolves.toEqual({
      kind: 'disabled',
    });
    expect(storage.value).toBeNull();
    expect(
      test.dependencies.fetch.mock.calls.map((call) => call[1]?.method),
    ).toEqual(['DELETE', 'DELETE']);
    expect(test.calls).toEqual([
      'store:change-reminder-registration-v2',
      'fetch',
      'store:change-reminder-registration-v2',
      'fetch',
      'delete:change-reminder-registration-v2',
    ]);
    expect(test.dependencies.fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${responseBody.credential}`,
    });
  });

  it('keeps pending deletion when local cleanup cannot finish after remote 204', async () => {
    const storage = {
      value: JSON.stringify({
        ...responseBody,
        attemptGeneration: 4,
        deviceToken: 'fcm-token:with_valid.characters-123',
        homeTimeZone: 'Australia/Sydney',
        oneDayEnabled: true,
        oneWeekEnabled: false,
        registrationRequestId: 'a'.repeat(64),
        state: 'registered',
        version: 4,
      }),
    };
    const test = harness({
      deleteItemImplementation: async () => {
        throw new Error('SecureStore delete failed');
      },
      fetchImplementation: jest.fn(
        async (_input: URL | RequestInfo) =>
          new Response(null, { status: 204 }),
      ) as jest.MockedFunction<typeof fetch>,
      storage,
    });
    await expect(test.adapters.disable()).resolves.toEqual({ kind: 'failed' });
    expect(JSON.parse(storage.value ?? '')).toMatchObject({
      state: 'pending-delete',
      credential: responseBody.credential,
      installationId: responseBody.installationId,
    });
  });

  it('restores pending deletion without requesting permission or a device token', async () => {
    const storage = {
      value: JSON.stringify({
        attemptGeneration: 4,
        credential: responseBody.credential,
        homeTimeZone: 'Australia/Sydney',
        installationId: responseBody.installationId,
        oneDayEnabled: false,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'pending-delete',
        version: 4,
      }),
    };
    const test = harness({ storage });
    await expect(test.adapters.restore()).resolves.toEqual({
      homeTimeZone: 'Australia/Sydney',
      kind: 'deleting',
      preferences: { oneDayEnabled: false, oneWeekEnabled: true },
    });
    expect(
      test.dependencies.notifications.getPermissionsAsync,
    ).not.toHaveBeenCalled();
    expect(
      test.dependencies.notifications.getDevicePushTokenAsync,
    ).not.toHaveBeenCalled();
  });

  it('does not send DELETE when persisting deletion intent fails', async () => {
    const test = harness({
      setItemImplementation: async () => {
        throw new Error('SecureStore write failed');
      },
      storage: {
        value: JSON.stringify({
          ...responseBody,
          attemptGeneration: 4,
          deviceToken: 'fcm-token:with_valid.characters-123',
          homeTimeZone: 'Australia/Sydney',
          oneDayEnabled: true,
          oneWeekEnabled: false,
          registrationRequestId: 'a'.repeat(64),
          state: 'registered',
          version: 4,
        }),
      },
    });
    await expect(test.adapters.disable()).resolves.toEqual({ kind: 'failed' });
    expect(test.dependencies.fetch).not.toHaveBeenCalled();
  });

  it('deletes a pending update and never recreates a missing server row', async () => {
    const storage = {
      value: JSON.stringify({
        ...responseBody,
        attemptGeneration: 5,
        deviceToken: 'fcm-token:replacement_valid.characters-456',
        homeTimeZone: 'Australia/Sydney',
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'pending-update',
        version: 4,
      }),
    };
    const test = harness({
      fetchImplementation: jest
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { status: 204 }),
        ) as jest.MockedFunction<typeof fetch>,
      storage,
    });
    await expect(test.adapters.disable()).resolves.toEqual({
      kind: 'disabled',
    });
    expect(
      test.dependencies.fetch.mock.calls.map((call) => call[1]?.method),
    ).toEqual(['DELETE']);
  });

  it('ignores a delayed token callback after deletion and fresh opt-in', async () => {
    let oldListener: ((token: { readonly data: unknown }) => void) | undefined;
    const test = harness({
      createRegistrationRequestId: async () => 'b'.repeat(64),
      fetchImplementation: jest
        .fn()
        .mockResolvedValueOnce(Response.json(responseBody))
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(
          Response.json(responseBody),
        ) as jest.MockedFunction<typeof fetch>,
    });
    jest
      .mocked(test.dependencies.notifications.addPushTokenListener)
      .mockImplementation((listener) => {
        oldListener = listener;
        return { remove: jest.fn() };
      });
    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'enabled',
    });
    const stop = test.adapters.startTokenRefresh('Australia/Sydney');
    stop();
    await expect(test.adapters.disable()).resolves.toEqual({
      kind: 'disabled',
    });
    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'enabled',
    });
    oldListener?.({ data: 'fcm-token:old_valid.characters-123' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      test.dependencies.fetch.mock.calls.map((call) => call[1]?.method),
    ).toEqual(['POST', 'DELETE', 'POST']);
    expect(
      JSON.parse(String(test.dependencies.fetch.mock.calls[2]?.[1]?.body)),
    ).toMatchObject({
      registrationRequestId: 'b'.repeat(64),
    });
  });

  it('does not let a delayed restore re-register after deletion', async () => {
    let resolveToken!: (value: { readonly data: string }) => void;
    const test = harness({
      currentToken: 'fcm-token:replacement_valid.characters-456',
      fetchImplementation: jest.fn(
        async (_input: URL | RequestInfo) =>
          new Response(null, { status: 204 }),
      ) as jest.MockedFunction<typeof fetch>,
      storage: {
        value: JSON.stringify({
          ...responseBody,
          attemptGeneration: 4,
          deviceToken: 'fcm-token:old_valid.characters-123',
          homeTimeZone: 'Australia/Sydney',
          oneDayEnabled: true,
          oneWeekEnabled: true,
          registrationRequestId: 'a'.repeat(64),
          state: 'registered',
          version: 4,
        }),
      },
    });
    jest
      .mocked(test.dependencies.notifications.getDevicePushTokenAsync)
      .mockImplementationOnce(
        async () =>
          await new Promise<{ readonly data: string }>((resolve) => {
            resolveToken = resolve;
          }),
      );
    const restoring = test.adapters.restore();
    await Promise.resolve();
    await expect(test.adapters.disable()).resolves.toEqual({
      kind: 'disabled',
    });
    resolveToken({ data: 'fcm-token:replacement_valid.characters-456' });
    await expect(restoring).resolves.toMatchObject({
      homeTimeZone: 'Australia/Sydney',
      kind: 'pending',
    });
    expect(
      test.dependencies.fetch.mock.calls.map((call) => call[1]?.method),
    ).toEqual(['DELETE']);
    expect(test.stored()).toBeNull();
  });

  it('reloads latest timing intent before a delayed restore token update', async () => {
    const storage = {
      value: JSON.stringify({
        ...responseBody,
        attemptGeneration: 4,
        deviceToken: 'fcm-token:old_valid.characters-123',
        homeTimeZone: 'Australia/Sydney',
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'registered',
        version: 4,
      }),
    };
    const replacement = 'fcm-token:replacement_valid.characters-456';
    let serverGeneration = 4;
    let serverPreferences = { oneDayEnabled: true, oneWeekEnabled: true };
    const attempts: {
      readonly attemptGeneration: number;
      readonly deviceToken: string;
      readonly oneDayEnabled: boolean;
    }[] = [];
    const serverRequest = jest.fn(async (_input: URL | RequestInfo, init) => {
      const body = JSON.parse(String(init?.body)) as {
        attemptGeneration: number;
        deviceToken: string;
        oneDayEnabled: boolean;
        oneWeekEnabled: boolean;
      };
      attempts.push({
        attemptGeneration: body.attemptGeneration,
        deviceToken: body.deviceToken,
        oneDayEnabled: body.oneDayEnabled,
      });
      if (body.attemptGeneration <= serverGeneration) {
        return new Response(null, { status: 409 });
      }
      serverGeneration = body.attemptGeneration;
      serverPreferences = {
        oneDayEnabled: body.oneDayEnabled,
        oneWeekEnabled: body.oneWeekEnabled,
      };
      return new Response(null, { status: 204 });
    }) as jest.MockedFunction<typeof fetch>;
    let releaseToken!: () => void;
    let markTokenRequested!: () => void;
    const tokenRequested = new Promise<void>((resolve) => {
      markTokenRequested = resolve;
    });
    const test = harness({
      currentToken: replacement,
      fetchImplementation: serverRequest,
      storage,
    });
    jest
      .mocked(test.dependencies.notifications.getDevicePushTokenAsync)
      .mockImplementation(
        async () =>
          await new Promise<{ readonly data: string }>((resolve) => {
            markTokenRequested();
            releaseToken = () => resolve({ data: replacement });
          }),
      );

    const restoring = test.adapters.restore();
    await tokenRequested;
    await expect(
      test.adapters.updatePreferences({
        oneDayEnabled: false,
        oneWeekEnabled: true,
      }),
    ).resolves.toEqual({ kind: 'enabled' });
    releaseToken();

    await expect(restoring).resolves.toMatchObject({
      kind: 'registered',
      registration: {
        attemptGeneration: 6,
        deviceToken: replacement,
        oneDayEnabled: false,
        oneWeekEnabled: true,
      },
    });
    expect(attempts).toEqual([
      {
        attemptGeneration: 5,
        deviceToken: 'fcm-token:old_valid.characters-123',
        oneDayEnabled: false,
      },
      {
        attemptGeneration: 6,
        deviceToken: replacement,
        oneDayEnabled: false,
      },
    ]);
    expect(serverGeneration).toBe(6);
    expect(serverPreferences).toEqual({
      oneDayEnabled: false,
      oneWeekEnabled: true,
    });
  });

  it('keeps confirmed timing choices when a token refresh updates the registration', async () => {
    const test = harness({
      currentToken: 'fcm-token:replacement_valid.characters-456',
      storage: {
        value: JSON.stringify({
          ...responseBody,
          attemptGeneration: 4,
          deviceToken: 'fcm-token:with_valid.characters-123',
          homeTimeZone: 'Australia/Sydney',
          oneDayEnabled: false,
          oneWeekEnabled: true,
          registrationRequestId: 'a'.repeat(64),
          state: 'registered',
          version: 4,
        }),
      },
    });
    await expect(test.adapters.restore()).resolves.toMatchObject({
      kind: 'registered',
    });
    expect(
      JSON.parse(String(test.dependencies.fetch.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      oneDayEnabled: false,
      oneWeekEnabled: true,
    });
  });

  it('retries a failed token refresh with its saved timing choices', async () => {
    const storage = {
      value: JSON.stringify({
        ...responseBody,
        attemptGeneration: 4,
        deviceToken: 'fcm-token:with_valid.characters-123',
        homeTimeZone: 'Australia/Sydney',
        oneDayEnabled: false,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'registered',
        version: 4,
      }),
    };
    const test = harness({
      fetchImplementation: jest
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(
          new Response(null, { status: 204 }),
        ) as jest.MockedFunction<typeof fetch>,
      storage,
    });
    let listener: ((token: { readonly data: unknown }) => void) | undefined;
    jest
      .mocked(test.dependencies.notifications.addPushTokenListener)
      .mockImplementation((nextListener) => {
        listener = nextListener;
        return { remove: jest.fn() };
      });
    const outcomes: unknown[] = [];
    test.adapters.startTokenRefresh('Australia/Sydney', (result) =>
      outcomes.push(result),
    );
    listener?.({ data: 'fcm-token:replacement_valid.characters-456' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcomes).toEqual([{ kind: 'failed', retryable: true }]);

    await expect(test.adapters.enable('Australia/Sydney')).resolves.toEqual({
      kind: 'enabled',
    });
    expect(
      JSON.parse(String(test.dependencies.fetch.mock.calls[1]?.[1]?.body)),
    ).toMatchObject({ oneDayEnabled: false, oneWeekEnabled: true });
    expect(JSON.parse(storage.value ?? '')).toMatchObject({
      oneDayEnabled: false,
      oneWeekEnabled: true,
      state: 'registered',
    });
  });

  it('restores a token-only pending update as registration uncertainty', async () => {
    const test = harness({
      storage: {
        value: JSON.stringify({
          ...responseBody,
          attemptGeneration: 5,
          deviceToken: 'fcm-token:replacement_valid.characters-456',
          homeTimeZone: 'Australia/Sydney',
          oneDayEnabled: true,
          oneWeekEnabled: true,
          registrationRequestId: 'a'.repeat(64),
          state: 'pending-update',
          version: 4,
        }),
      },
    });

    await expect(test.adapters.restore()).resolves.toEqual({
      homeTimeZone: 'Australia/Sydney',
      kind: 'pending',
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
    await expect(invalidStored.adapters.restore()).rejects.toThrow(
      'Invalid stored reminder state',
    );

    const noncanonicalStored = harness();
    jest
      .mocked(noncanonicalStored.dependencies.secureStore.getItemAsync)
      .mockResolvedValueOnce(
        JSON.stringify({
          ...responseBody,
          attemptGeneration: 1,
          homeTimeZone: 'Australia/ACT',
          oneDayEnabled: true,
          oneWeekEnabled: true,
          registrationRequestId: 'a'.repeat(64),
          state: 'registered',
          version: 2,
        }),
      );
    await expect(noncanonicalStored.adapters.restore()).rejects.toThrow(
      'Invalid stored reminder state',
    );
  });

  it('rejects malformed stored retry fields and generated request IDs', async () => {
    for (const malformed of [
      {
        attemptGeneration: 0,
        registrationRequestId: 'a'.repeat(64),
      },
      {
        attemptGeneration: 1.5,
        registrationRequestId: 'a'.repeat(64),
      },
      {
        attemptGeneration: 1,
        registrationRequestId: 'A'.repeat(64),
      },
    ]) {
      const test = harness();
      jest
        .mocked(test.dependencies.secureStore.getItemAsync)
        .mockResolvedValueOnce(
          JSON.stringify({
            ...malformed,
            homeTimeZone: 'Australia/Sydney',
            oneDayEnabled: true,
            oneWeekEnabled: true,
            state: 'pending',
            version: 2,
          }),
        );
      await expect(test.adapters.restore()).rejects.toThrow(
        'Invalid stored reminder state',
      );
    }

    const malformedLegacyPending = harness({
      storage: {
        value: JSON.stringify({
          attemptGeneration: 1,
          credential: 'c'.repeat(43),
          homeTimeZone: 'Australia/Sydney',
          installationId: 'i'.repeat(43),
          oneDayEnabled: true,
          oneWeekEnabled: true,
          registrationRequestId: 'a'.repeat(64),
          state: 'pending',
          version: 2,
        }),
      },
    });
    await expect(malformedLegacyPending.adapters.restore()).rejects.toThrow(
      'Invalid stored reminder state',
    );

    const invalidGenerated = harness({
      createRegistrationRequestId: async () => 'not-random',
    });
    await expect(
      invalidGenerated.adapters.enable('Australia/Sydney'),
    ).resolves.toEqual({ kind: 'failed' });
    expect(invalidGenerated.dependencies.fetch).not.toHaveBeenCalled();
    expect(
      invalidGenerated.dependencies.secureStore.setItemAsync,
    ).not.toHaveBeenCalled();
  });
});
