import { AndroidImportance } from 'expo-notifications';

import { createProductionChangeReminderAdapters } from './change-reminder-production-adapters';

const responseBody = {
  credential: 'c'.repeat(43),
  installationId: 'i'.repeat(43),
};

function harness({
  createRegistrationRequestId = async () => 'a'.repeat(64),
  currentToken = 'fcm-token:with_valid.characters-123',
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
      attemptGeneration: 1,
      deviceToken: 'fcm-token:with_valid.characters-123',
      homeTimeZone: 'Australia/Sydney',
      oneDayEnabled: true,
      oneWeekEnabled: true,
      platform: 'android',
      registrationRequestId: 'a'.repeat(64),
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
      homeTimeZone: 'Australia/Brisbane',
      registrationRequestId: 'b'.repeat(64),
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

  it('refreshes a registered token once with the same request ID and next generation', async () => {
    let listener: ((token: { readonly data: unknown }) => void) | undefined;
    const remove = jest.fn();
    const outcomes: unknown[] = [];
    const test = harness();
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
    listener?.({ data: 'fcm-token:replacement_valid.characters-456' });
    listener?.({ data: 'fcm-token:replacement_valid.characters-456' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const requests = test.dependencies.fetch.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)),
    );
    expect(requests).toEqual([
      expect.objectContaining({
        attemptGeneration: 1,
        deviceToken: 'fcm-token:with_valid.characters-123',
        registrationRequestId: 'a'.repeat(64),
      }),
      expect.objectContaining({
        attemptGeneration: 2,
        deviceToken: 'fcm-token:replacement_valid.characters-456',
        homeTimeZone: 'Australia/Sydney',
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
