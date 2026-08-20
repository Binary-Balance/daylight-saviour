import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { AppState } from 'react-native';

import { daylightSaviourPalettes } from '../../theme';
import type { ChangeReminderAdapters } from './change-reminder-adapters';
import ChangeReminderSection from './change-reminder-section';

function adapters(
  overrides: Partial<ChangeReminderAdapters> = {},
): ChangeReminderAdapters {
  return {
    disable: jest.fn(async () => ({ kind: 'disabled' as const })),
    enable: jest.fn(async () => ({ kind: 'enabled' as const })),
    openSettings: jest.fn(async () => undefined),
    restore: jest.fn(async () => ({ kind: 'unregistered' as const })),
    startTokenRefresh: jest.fn(() => () => undefined),
    updatePreferences: jest.fn(async (preferences) => ({
      kind: 'enabled' as const,
      preferences,
    })),
    ...overrides,
  };
}

function renderSection(boundary: ChangeReminderAdapters, testBuild = false) {
  return render(
    <ChangeReminderSection
      adapters={boundary}
      homeTimeZone="Australia/Sydney"
      palette={daylightSaviourPalettes.light}
      testBuild={testBuild}
    />,
  );
}

it('does not request a reminder before explicit confirmation', async () => {
  const boundary = adapters();
  renderSection(boundary);
  const initialAction = await screen.findByRole('button', {
    name: 'Warn me before time misbehaves',
  });
  fireEvent.press(initialAction);
  expect(boundary.enable).not.toHaveBeenCalled();
  expect(boundary.startTokenRefresh).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Enable reminders' }));
  expect(boundary.enable).toHaveBeenCalledWith('Australia/Sydney');
  expect(
    await screen.findByText(
      /one-week and one-day Change Reminders are enabled/i,
    ),
  ).toBeTruthy();
  expect(boundary.startTokenRefresh).toHaveBeenCalledWith(
    'Australia/Sydney',
    expect.any(Function),
  );
});

it('renders restored registration truthfully without another enable action', async () => {
  const boundary = adapters({
    restore: jest.fn(async () => ({
      kind: 'registered' as const,
      notificationPermissionGranted: true,
      registration: {
        attemptGeneration: 1,
        credential: 'c'.repeat(43),
        deviceToken: 'fcm-token:with_valid.characters-123',
        homeTimeZone: 'Australia/Sydney',
        installationId: 'i'.repeat(43),
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'registered' as const,
        version: 2 as const,
      },
    })),
  });
  renderSection(boundary);
  expect(
    await screen.findByText(
      /one-week and one-day Change Reminders are enabled/i,
    ),
  ).toBeTruthy();
  expect(
    screen.queryByRole('button', {
      name: 'Warn me before time misbehaves',
    }),
  ).toBeNull();
  expect(boundary.enable).not.toHaveBeenCalled();
});

it('shows only a selectable installation ID in an external test build', async () => {
  const savedInstallationId = 'i'.repeat(43);
  const boundary = adapters({
    readInstallationId: jest.fn(async () => savedInstallationId),
    restore: jest.fn(async () => ({
      kind: 'registered' as const,
      notificationPermissionGranted: true,
      registration: {
        attemptGeneration: 1,
        credential: 'c'.repeat(43),
        deviceToken: 'fcm-token:with_valid.characters-123',
        homeTimeZone: 'Australia/Sydney',
        installationId: savedInstallationId,
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'registered' as const,
        version: 4 as const,
      },
    })),
  });
  renderSection(boundary, true);

  const diagnostic = await screen.findByText(
    `Test installation ID: ${savedInstallationId}`,
  );
  expect(diagnostic.props.selectable).toBe(true);
  expect(screen.queryByText('c'.repeat(43))).toBeNull();
});

it('omits the installation diagnostic from ordinary builds', async () => {
  const boundary = adapters({
    readInstallationId: jest.fn(async () => 'i'.repeat(43)),
    restore: jest.fn(async () => ({
      kind: 'registered' as const,
      notificationPermissionGranted: true,
      registration: {
        attemptGeneration: 1,
        credential: 'c'.repeat(43),
        deviceToken: 'fcm-token:with_valid.characters-123',
        homeTimeZone: 'Australia/Sydney',
        installationId: 'i'.repeat(43),
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'registered' as const,
        version: 4 as const,
      },
    })),
  });
  renderSection(boundary);

  await screen.findByText(/reminders are enabled/i);
  expect(screen.queryByText(/Test installation ID:/)).toBeNull();
  expect(boundary.readInstallationId).not.toHaveBeenCalled();
});

it('shows accessible load and registration failures with recovery actions', async () => {
  const boundary = adapters({
    enable: jest.fn(async () => {
      throw new Error('adapter rejected');
    }),
    restore: jest
      .fn()
      .mockRejectedValueOnce(new Error('SecureStore read failed'))
      .mockResolvedValueOnce({ kind: 'unregistered' }),
  });
  renderSection(boundary);

  const loadAlert = await screen.findByRole('alert');
  expect(loadAlert.props.children).toMatch(/could not be read securely/i);
  fireEvent.press(
    screen.getByRole('button', { name: 'Check reminder status again' }),
  );
  fireEvent.press(
    await screen.findByRole('button', {
      name: 'Warn me before time misbehaves',
    }),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Enable reminders' }));
  const registrationAlert = await screen.findByRole('alert');
  expect(registrationAlert.props.children).toMatch(/not enabled/i);
  expect(
    screen.getByRole('button', { name: 'Try registration again' }),
  ).toBeTruthy();
});

it('keeps saving state bounded to pending adapter work', async () => {
  let resolve!: (value: { readonly kind: 'failed' }) => void;
  const boundary = adapters({
    enable: jest.fn(
      () =>
        new Promise((onResolve) => {
          resolve = onResolve;
        }),
    ),
  });
  renderSection(boundary);
  fireEvent.press(
    await screen.findByRole('button', {
      name: 'Warn me before time misbehaves',
    }),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Enable reminders' }));
  expect(screen.getByText('Registering reminders…')).toBeTruthy();
  expect(
    screen.getByText('Registering reminders…').props.accessibilityLiveRegion,
  ).toBe('none');
  expect(screen.queryByRole('button')).toBeNull();

  await act(async () => resolve({ kind: 'failed' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Try registration again' }),
    ).toBeTruthy(),
  );
});

it('renders restored pending state as retryable without claiming enablement', async () => {
  const boundary = adapters({
    restore: jest.fn(async () => ({
      homeTimeZone: 'Australia/Sydney',
      kind: 'pending' as const,
    })),
  });
  renderSection(boundary);

  expect(await screen.findByText(/registration did not finish/i)).toBeTruthy();
  expect(screen.queryByText(/reminders are enabled/i)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Retry registration' }));
  expect(boundary.enable).toHaveBeenCalledWith('Australia/Sydney');
  expect(
    await screen.findByText(
      /one-week and one-day Change Reminders are enabled/i,
    ),
  ).toBeTruthy();
});

it('renders truthful zone-mismatch and revoked-permission restore states', async () => {
  const stored = {
    attemptGeneration: 1,
    credential: 'c'.repeat(43),
    homeTimeZone: 'Australia/Brisbane',
    installationId: 'i'.repeat(43),
    oneDayEnabled: true,
    oneWeekEnabled: true,
    registrationRequestId: 'a'.repeat(64),
    state: 'registered' as const,
    version: 2 as const,
  };
  const mismatch = renderSection(
    adapters({
      restore: jest.fn(async () => ({
        kind: 'registered' as const,
        notificationPermissionGranted: true,
        registration: stored,
      })),
    }),
  );
  expect(
    await screen.findByText(/not enabled for this Home Time Zone/i),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Enable reminders' })).toBeNull();
  mismatch.unmount();

  const openSettings = jest.fn(async () => undefined);
  const revoked = adapters({
    openSettings,
    restore: jest.fn(async () => ({
      kind: 'registered' as const,
      notificationPermissionGranted: false,
      registration: { ...stored, homeTimeZone: 'Australia/Sydney' },
    })),
  });
  renderSection(revoked);
  expect(
    await screen.findByText(/registered, but notifications are blocked/i),
  ).toBeTruthy();
  expect(revoked.startTokenRefresh).not.toHaveBeenCalled();
  fireEvent.press(
    screen.getByRole('button', { name: 'Open notification settings' }),
  );
  expect(openSettings).toHaveBeenCalledTimes(1);
});

it('stops token listening and shows retry when a valid refresh fails', async () => {
  let onResult:
    | ((result: {
        readonly kind: 'failed';
        readonly retryable: boolean;
      }) => void)
    | undefined;
  const remove = jest.fn();
  const boundary = adapters({
    restore: jest.fn(async () => ({
      kind: 'registered' as const,
      notificationPermissionGranted: true,
      registration: {
        attemptGeneration: 1,
        credential: 'c'.repeat(43),
        homeTimeZone: 'Australia/Sydney',
        installationId: 'i'.repeat(43),
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'registered' as const,
        version: 2 as const,
      },
    })),
    startTokenRefresh: jest.fn((_zone, listener) => {
      onResult = listener as typeof onResult;
      return remove;
    }),
  });
  renderSection(boundary);
  await screen.findByText(/one-week and one-day Change Reminders are enabled/i);

  await act(async () => onResult?.({ kind: 'failed', retryable: true }));
  expect(await screen.findByText(/registration did not finish/i)).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Retry registration' }),
  ).toBeTruthy();
  expect(remove).toHaveBeenCalledTimes(1);
});

it('restores permission truth when Android returns to foreground', async () => {
  let onAppStateChange: ((state: string) => void) | undefined;
  const appStateSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      onAppStateChange = listener as (state: string) => void;
      return { remove: jest.fn() };
    });
  const registered = {
    attemptGeneration: 1,
    credential: 'c'.repeat(43),
    homeTimeZone: 'Australia/Sydney',
    installationId: 'i'.repeat(43),
    oneDayEnabled: true,
    oneWeekEnabled: true,
    registrationRequestId: 'a'.repeat(64),
    state: 'registered' as const,
    version: 2 as const,
  };
  const boundary = adapters({
    restore: jest
      .fn()
      .mockResolvedValueOnce({
        kind: 'registered' as const,
        notificationPermissionGranted: true,
        registration: registered,
      })
      .mockResolvedValueOnce({
        kind: 'registered' as const,
        notificationPermissionGranted: false,
        registration: registered,
      })
      .mockResolvedValueOnce({ kind: 'unregistered' as const }),
  });
  const rendered = renderSection(boundary);
  await screen.findByText(/one-week and one-day Change Reminders are enabled/i);

  await act(async () => onAppStateChange?.('active'));
  expect(
    await screen.findByText(/registered, but notifications are blocked/i),
  ).toBeTruthy();
  await act(async () => onAppStateChange?.('active'));
  expect(
    await screen.findByRole('button', {
      name: 'Warn me before time misbehaves',
    }),
  ).toBeTruthy();
  rendered.unmount();
  appStateSpy.mockRestore();
});

it('saves one timing at a time and asks before deleting both', async () => {
  const appStateSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(() => ({ remove: jest.fn() }));
  const updatePreferences = jest.fn(async (preferences) => ({
    kind: 'enabled' as const,
    preferences,
  }));
  const boundary = adapters({
    restore: jest.fn(async () => ({
      kind: 'registered' as const,
      notificationPermissionGranted: true,
      registration: {
        attemptGeneration: 1,
        credential: 'c'.repeat(43),
        deviceToken: 'fcm-token:with_valid.characters-123',
        homeTimeZone: 'Australia/Sydney',
        installationId: 'i'.repeat(43),
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'registered' as const,
        version: 4 as const,
      },
    })),
    updatePreferences,
  });
  const rendered = renderSection(boundary);
  const week = await screen.findByRole('switch', {
    checked: true,
    name: 'One-week Change Reminder',
  });
  fireEvent(week, 'valueChange', false);
  await waitFor(() =>
    expect(updatePreferences).toHaveBeenCalledWith({
      oneDayEnabled: true,
      oneWeekEnabled: false,
    }),
  );
  expect(
    screen.getByRole('switch', {
      checked: false,
      name: 'One-week Change Reminder',
    }),
  ).toBeTruthy();
  const day = await screen.findByRole('switch', {
    checked: true,
    name: 'One-day Change Reminder',
  });
  fireEvent(day, 'valueChange', false);
  expect(
    await screen.findByText(/Turning off both timings deletes/i),
  ).toBeTruthy();
  expect(boundary.disable).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Keep reminders' }));
  expect(
    await screen.findByRole('switch', {
      name: 'One-day Change Reminder',
    }),
  ).toBeTruthy();
  rendered.unmount();
  appStateSpy.mockRestore();
});

it('retries initial OS-blocked enablement after settings return', async () => {
  let onAppStateChange: ((state: string) => void) | undefined;
  const appStateSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      onAppStateChange = listener as (state: string) => void;
      return { remove: jest.fn() };
    });
  const openSettings = jest.fn(async () => undefined);
  let resolveEnable!: (result: { readonly kind: 'enabled' }) => void;
  const boundary = adapters({
    enable: jest
      .fn()
      .mockResolvedValueOnce({ kind: 'os-blocked' as const })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveEnable = resolve;
          }),
      ),
    openSettings,
  });
  const rendered = renderSection(boundary);
  fireEvent.press(
    await screen.findByRole('button', {
      name: 'Warn me before time misbehaves',
    }),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Enable reminders' }));
  expect(await screen.findByText(/Notifications are blocked/i)).toBeTruthy();
  fireEvent.press(
    screen.getByRole('button', { name: 'Open notification settings' }),
  );
  expect(openSettings).toHaveBeenCalledTimes(1);
  act(() => onAppStateChange?.('active'));
  expect(screen.getByText('Registering reminders…')).toBeTruthy();
  await act(async () => resolveEnable({ kind: 'enabled' }));
  expect(
    await screen.findByText(
      /one-week and one-day Change Reminders are enabled/i,
    ),
  ).toBeTruthy();
  expect(boundary.enable).toHaveBeenCalledTimes(2);
  rendered.unmount();
  appStateSpy.mockRestore();
});

it('shows disabling, disabled, and recoverable deletion uncertainty', async () => {
  const appStateSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(() => ({ remove: jest.fn() }));
  let resolveDelete!: (value: { readonly kind: 'disabled' }) => void;
  const registered = {
    attemptGeneration: 1,
    credential: 'c'.repeat(43),
    deviceToken: 'fcm-token:with_valid.characters-123',
    homeTimeZone: 'Australia/Sydney',
    installationId: 'i'.repeat(43),
    oneDayEnabled: false,
    oneWeekEnabled: true,
    registrationRequestId: 'a'.repeat(64),
    state: 'registered' as const,
    version: 4 as const,
  };
  const boundary = adapters({
    disable: jest.fn(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        }),
    ),
    restore: jest.fn(async () => ({
      kind: 'registered' as const,
      notificationPermissionGranted: true,
      registration: registered,
    })),
  });
  const rendered = renderSection(boundary);
  fireEvent(
    await screen.findByRole('switch', { name: 'One-week Change Reminder' }),
    'valueChange',
    false,
  );
  fireEvent.press(
    screen.getByRole('button', { name: 'Disable and delete reminders' }),
  );
  expect(
    screen.getByText('Deleting Change Reminder registration…'),
  ).toBeTruthy();
  await act(async () => resolveDelete({ kind: 'disabled' }));
  expect(
    await screen.findByText(/registration has been deleted/i),
  ).toBeTruthy();
  rendered.unmount();
  appStateSpy.mockRestore();
});

it('keeps deletion uncertainty factual and recoverable', async () => {
  const appStateSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(() => ({ remove: jest.fn() }));
  const registered = {
    attemptGeneration: 1,
    credential: 'c'.repeat(43),
    deviceToken: 'fcm-token:with_valid.characters-123',
    homeTimeZone: 'Australia/Sydney',
    installationId: 'i'.repeat(43),
    oneDayEnabled: false,
    oneWeekEnabled: true,
    registrationRequestId: 'a'.repeat(64),
    state: 'registered' as const,
    version: 4 as const,
  };
  const rendered = renderSection(
    adapters({
      disable: jest.fn(async () => ({ kind: 'failed' as const })),
      restore: jest.fn(async () => ({
        kind: 'registered' as const,
        notificationPermissionGranted: true,
        registration: registered,
      })),
    }),
  );
  fireEvent(
    await screen.findByRole('switch', { name: 'One-week Change Reminder' }),
    'valueChange',
    false,
  );
  fireEvent.press(
    screen.getByRole('button', { name: 'Disable and delete reminders' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /Deletion could not be confirmed on this device/i,
  );
  expect(
    screen.getByRole('button', { name: 'Try deletion again' }),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Keep reminders' })).toBeTruthy();
  rendered.unmount();
  appStateSpy.mockRestore();
});
