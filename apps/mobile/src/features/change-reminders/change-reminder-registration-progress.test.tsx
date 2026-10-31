import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { AppState } from 'react-native';
import { PermissionStatus } from 'expo-notifications';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import { daylightSaviourPalettes } from '../../theme';
import type { ChangeReminderAdapters } from './change-reminder-adapters';
import { createProductionChangeReminderAdapters } from './change-reminder-production-adapters';
import ChangeReminderSection from './change-reminder-section';

interface Permission {
  readonly canAskAgain: boolean;
  readonly granted: boolean;
  readonly status: PermissionStatus;
}

const undetermined: Permission = {
  canAskAgain: true,
  granted: false,
  status: PermissionStatus.UNDETERMINED,
};
const granted: Permission = {
  canAskAgain: true,
  granted: true,
  status: PermissionStatus.GRANTED,
};
const registration = {
  credential: 'c'.repeat(43),
  installationId: 'i'.repeat(43),
};
const deadlineMs = 10_000;
// A mutant that retries without end must fail a test, not exhaust memory.
const maximumRequests = 5;

let returnToApp: ((state: string) => void) | undefined;

beforeEach(() => {
  // Response bodies settle on microtasks, which must keep running.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      returnToApp = listener as (state: string) => void;
      return { remove: jest.fn() };
    });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

// Answers each request with the next reply, so no test reaches a real server.
function inOrder(...replies: readonly Promise<Response>[]) {
  let next = 0;
  return async () =>
    replies[next++] ?? Promise.reject(new Error('Unexpected request'));
}

function setup({
  beforeSave,
  fetchImplementation,
  platform = 'android',
  prompt = async () => granted,
}: {
  readonly beforeSave?: (value: string) => Promise<void>;
  readonly fetchImplementation: () => Promise<Response>;
  readonly platform?: string;
  readonly prompt?: () => Promise<Permission>;
}) {
  const storage: { value: string | null } = { value: null };
  let permission = undetermined;
  let requests = 0;
  const request = jest.fn(() =>
    ++requests > maximumRequests
      ? Promise.reject(new Error('Too many registration requests'))
      : fetchImplementation(),
  ) as unknown as jest.MockedFunction<typeof fetch>;
  const adapters = createProductionChangeReminderAdapters({
    createRegistrationRequestId: async () => 'a'.repeat(64),
    endpoint: 'https://reminders.example.test/reminder-subscriptions',
    fetch: request,
    notifications: {
      addPushTokenListener: () => ({ remove: () => undefined }),
      getDevicePushTokenAsync: async () => ({
        data: 'fcm-token:with_valid.characters-123',
      }),
      getPermissionsAsync: async () => permission,
      requestPermissionsAsync: async () => {
        permission = await prompt();
        return permission;
      },
      setNotificationChannelAsync: async () => null,
    },
    openSettings: async () => undefined,
    platform,
    secureStore: {
      deleteItemAsync: async () => {
        storage.value = null;
      },
      getItemAsync: async () => storage.value,
      setItemAsync: async (_key, value) => {
        await beforeSave?.(value);
        storage.value = value;
      },
    },
    timeoutMs: deadlineMs,
  });
  return {
    adapters,
    request,
    stored: () => (storage.value === null ? null : JSON.parse(storage.value)),
  };
}

async function startRegistration(adapters: ChangeReminderAdapters) {
  render(
    <ChangeReminderSection
      adapters={adapters}
      homeTimeZone="Australia/Sydney"
      palette={daylightSaviourPalettes.light}
    />,
  );
  fireEvent.press(
    await screen.findByRole('button', {
      name: copy.changeReminders.untouched.action,
    }),
  );
  fireEvent.press(
    screen.getByRole('button', {
      name: copy.changeReminders.explainer.confirm,
    }),
  );
}

async function passDeadline() {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(deadlineMs);
  });
}

function expectRegistrationInProgress() {
  expect(screen.getByText(copy.changeReminders.saving.heading)).toBeTruthy();
  const busy = screen.getByText(copy.changeReminders.saving.body);
  expect(busy).toBeBusy();
  // Announced once on entry; the text is fixed while busy, so it never repeats.
  expect(busy.props.accessibilityLiveRegion).toBe('polite');
  expect(screen.queryByText(copy.changeReminders.enabled.heading)).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
}

async function expectRetryThenEnabled(
  test: ReturnType<typeof setup>,
  failure: string,
) {
  expect(await screen.findByRole('alert')).toHaveTextContent(failure);
  expect(screen.queryByText(copy.changeReminders.enabled.heading)).toBeNull();
  // The unconfirmed attempt stays saved for the retry, but is not success.
  expect(test.stored()).toMatchObject({ state: 'pending' });

  fireEvent.press(
    screen.getByRole('button', { name: copy.changeReminders.failed.retry }),
  );
  expectRegistrationInProgress();
  expect(
    await screen.findByText(copy.changeReminders.enabled.heading),
  ).toBeTruthy();
  expect(test.stored()).toMatchObject({ ...registration, state: 'registered' });
}

it.each(['android', 'ios'])(
  'on %s keeps showing registration in progress until the response is validated and saved',
  async (platform) => {
    const prompt = deferred<Permission>();
    const response = deferred<Response>();
    const finalSave = deferred<void>();
    let finalSaveReached = false;
    const test = setup({
      beforeSave: async (value) => {
        if (JSON.parse(value).state !== 'registered') return;
        finalSaveReached = true;
        await finalSave.promise;
      },
      fetchImplementation: () => response.promise,
      platform,
      prompt: () => prompt.promise,
    });

    await startRegistration(test.adapters);
    // The permission prompt is open and the busy state is already showing.
    expectRegistrationInProgress();

    await act(async () => prompt.resolve(granted));
    // Android reports a return to the app when its prompt closes.
    act(() => returnToApp?.('active'));
    expectRegistrationInProgress();
    await waitFor(() => expect(test.request).toHaveBeenCalledTimes(1));
    expect(test.stored()).toMatchObject({ state: 'pending' });

    await act(async () => response.resolve(Response.json(registration)));
    await waitFor(() => expect(finalSaveReached).toBe(true));
    expectRegistrationInProgress();
    expect(test.stored()).toMatchObject({ state: 'pending' });

    await act(async () => finalSave.resolve());
    expect(
      await screen.findByText(copy.changeReminders.enabled.heading),
    ).toBeTruthy();
    expect(screen.queryByText(copy.changeReminders.saving.heading)).toBeNull();
    expect(test.stored()).toMatchObject({
      ...registration,
      state: 'registered',
    });
    expect(test.request).toHaveBeenCalledTimes(1);
  },
);

it('announces the enabled outcome once it is confirmed', async () => {
  const test = setup({
    fetchImplementation: inOrder(Promise.resolve(Response.json(registration))),
  });

  await startRegistration(test.adapters);

  const outcome = await screen.findByText(
    copy.changeReminders.enabled.body({
      oneDayEnabled: true,
      oneWeekEnabled: true,
    }),
  );
  expect(outcome.props.accessibilityLiveRegion).toBe('polite');
});

it.each<[string, () => Response]>([
  ['a refusal', () => Response.json({}, { status: 500 })],
  [
    'a response that fails validation',
    () => Response.json({ credential: 'x' }),
  ],
])(
  'shows a failure and a working retry after %s',
  async (_description, failedResponse) => {
    const test = setup({
      fetchImplementation: inOrder(
        Promise.resolve(failedResponse()),
        Promise.resolve(Response.json(registration)),
      ),
    });

    await startRegistration(test.adapters);

    await expectRetryThenEnabled(test, copy.changeReminders.failed.body);
  },
);

it('leaves the busy state at the deadline and lets a retry finish before a late first response', async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const test = setup({
    fetchImplementation: inOrder(first.promise, second.promise),
  });

  await startRegistration(test.adapters);
  await waitFor(() => expect(test.request).toHaveBeenCalledTimes(1));
  expectRegistrationInProgress();
  await passDeadline();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    copy.changeReminders.failed.body,
  );

  fireEvent.press(
    screen.getByRole('button', { name: copy.changeReminders.failed.retry }),
  );
  await waitFor(() => expect(test.request).toHaveBeenCalledTimes(2));
  expectRegistrationInProgress();

  // The first attempt answers after its deadline and must not win.
  await act(async () =>
    first.resolve(
      Response.json({
        credential: 'd'.repeat(43),
        installationId: 'j'.repeat(43),
      }),
    ),
  );
  expectRegistrationInProgress();
  expect(test.stored()).toMatchObject({
    attemptGeneration: 2,
    state: 'pending',
  });

  await act(async () => second.resolve(Response.json(registration)));
  expect(
    await screen.findByText(copy.changeReminders.enabled.heading),
  ).toBeTruthy();
  expect(test.stored()).toMatchObject({ ...registration, state: 'registered' });
});

it('leaves the busy state at the deadline when the response body stalls', async () => {
  const test = setup({
    fetchImplementation: inOrder(
      // Headers arrive, but the body never finishes.
      Promise.resolve(
        new Response(new ReadableStream({ start: () => undefined })),
      ),
      Promise.resolve(Response.json(registration)),
    ),
  });

  await startRegistration(test.adapters);
  await waitFor(() => expect(test.request).toHaveBeenCalledTimes(1));
  expectRegistrationInProgress();
  await passDeadline();

  await expectRetryThenEnabled(test, copy.changeReminders.failed.body);
});
