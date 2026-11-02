import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import { AppState, StyleSheet } from 'react-native';
import type { ReactTestRendererNode } from 'react-test-renderer';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import { contrastRatio } from '../../../test-support/contrast';
import { daylightSaviourPalettes } from '../../theme';
import type {
  ChangeReminderAdapters,
  ChangeReminderTokenRefreshResult,
} from './change-reminder-adapters';
import ChangeReminderSection from './change-reminder-section';
import type { ChangeReminderSessionSnapshot } from './change-reminder-session';

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

function renderSection(
  boundary: ChangeReminderAdapters,
  testBuild = false,
  verifiedNoEvent = false,
) {
  return render(
    <ChangeReminderSection
      adapters={boundary}
      homeTimeZone="Australia/Sydney"
      palette={daylightSaviourPalettes.light}
      testBuild={testBuild}
      verifiedNoEvent={verifiedNoEvent}
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
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Enable reminders' }));
  });
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

it.each(['light', 'dark'] as const)(
  'renders timing labels legibly in %s appearance',
  async (appearance) => {
    const palette = daylightSaviourPalettes[appearance];
    render(
      <ChangeReminderSection
        adapters={adapters({
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
        })}
        homeTimeZone="Australia/Sydney"
        palette={palette}
      />,
    );

    for (const label of ['One week before', 'One day before']) {
      const { color } = StyleSheet.flatten(
        (await screen.findByText(label)).props.style,
      );
      expect(color).toBe(palette.ink);
      expect(
        contrastRatio(String(color), palette.background),
      ).toBeGreaterThanOrEqual(4.5);
    }
  },
);

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
  expect(screen.getByText(copy.changeReminders.saving.body)).toBeTruthy();
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

it('shows a recoverable Home Time Zone update failure', async () => {
  let resolveUpdate!: (result: { readonly kind: 'failed' }) => void;
  const updateHomeTimeZone = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<{ readonly kind: 'failed' }>((resolve) => {
          resolveUpdate = resolve;
        }),
    )
    .mockResolvedValueOnce({ kind: 'enabled' as const });
  const boundary = adapters({
    restore: jest.fn(async () => ({
      kind: 'registered' as const,
      notificationPermissionGranted: true,
      registration: {
        attemptGeneration: 1,
        credential: 'c'.repeat(43),
        deviceToken: 'fcm-token:with_valid.characters-123',
        homeTimeZone: 'Australia/Brisbane',
        installationId: 'i'.repeat(43),
        oneDayEnabled: true,
        oneWeekEnabled: true,
        registrationRequestId: 'a'.repeat(64),
        state: 'registered' as const,
        version: 4 as const,
      },
    })),
    updateHomeTimeZone,
  });
  renderSection(boundary);

  expect(
    await screen.findByText('Updating reminders for your Home Time Zone…'),
  ).toBeTruthy();
  await act(async () => resolveUpdate({ kind: 'failed' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /Home Time Zone is saved/i,
  );
  fireEvent.press(
    screen.getByRole('button', { name: 'Try Home Time Zone update again' }),
  );
  expect(
    await screen.findByText(
      /one-week and one-day Change Reminders are enabled/i,
    ),
  ).toBeTruthy();
  expect(updateHomeTimeZone).toHaveBeenCalledTimes(2);
});

it('explains that enabled reminders stay dormant in a verified no-event zone', async () => {
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
  });
  renderSection(boundary, false, true);

  expect(
    await screen.findByText(
      'No change scheduled. Keep reminders on and we’ll warn you if that changes.',
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole('switch', { name: 'One-week Change Reminder' }),
  ).toBeTruthy();
  expect(
    screen.getByRole('switch', { name: 'One-day Change Reminder' }),
  ).toBeTruthy();
});

it('does not show dormant copy without verified no-event facts', async () => {
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
  });
  renderSection(boundary);

  expect(
    await screen.findByText(
      /one-week and one-day Change Reminders are enabled/i,
    ),
  ).toBeTruthy();
  expect(
    screen.queryByText(
      'No change scheduled. Keep reminders on and we’ll warn you if that changes.',
    ),
  ).toBeNull();
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
  expect(screen.getByText(copy.changeReminders.saving.body)).toBeTruthy();
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
    await screen.findByText(
      /enabling again will create a fresh reminder registration/i,
    ),
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
  expect(screen.queryByRole('button', { name: 'Keep reminders' })).toBeNull();
  rendered.unmount();
  appStateSpy.mockRestore();
});

it('disables timing switches while a failed save is awaiting retry or cancellation', async () => {
  const appStateSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(() => ({ remove: jest.fn() }));
  const rendered = renderSection(
    adapters({
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
      updatePreferences: jest.fn(async () => ({ kind: 'failed' as const })),
    }),
  );
  fireEvent(
    await screen.findByRole('switch', { name: 'One-week Change Reminder' }),
    'valueChange',
    false,
  );
  await screen.findByRole('alert');
  expect(
    screen.getByRole('switch', {
      disabled: true,
      name: 'One-week Change Reminder',
    }),
  ).toBeTruthy();
  rendered.unmount();
  appStateSpy.mockRestore();
});

const reminders = copy.changeReminders;
// Dark gives every role its own colour. Light uses one for both ink and the
// action fill, so it could not show a swap.
const dark = daylightSaviourPalettes.dark;
const never = () => new Promise<never>(() => undefined);
const enabledBody = reminders.enabled.body({
  oneDayEnabled: true,
  oneWeekEnabled: true,
});

function restoresRegistration({
  notificationPermissionGranted = true,
  ...stored
}: {
  readonly homeTimeZone?: string;
  readonly notificationPermissionGranted?: boolean;
  readonly oneDayEnabled?: boolean;
  readonly oneWeekEnabled?: boolean;
} = {}): ChangeReminderAdapters['restore'] {
  return async () => ({
    kind: 'registered',
    notificationPermissionGranted,
    registration: {
      attemptGeneration: 1,
      credential: 'c'.repeat(43),
      deviceToken: 'fcm-token:with_valid.characters-123',
      homeTimeZone: 'Australia/Sydney',
      installationId: 'i'.repeat(43),
      oneDayEnabled: true,
      oneWeekEnabled: true,
      registrationRequestId: 'a'.repeat(64),
      state: 'registered',
      version: 4,
      ...stored,
    },
  });
}

// Pressing can start adapter work that settles at once, so let act flush it.
async function pressButton(name: string) {
  const button = await screen.findByRole('button', { name });
  await act(async () => fireEvent.press(button));
}

async function switchOff(name: string) {
  const toggle = await screen.findByRole('switch', { name });
  await act(async () => fireEvent(toggle, 'valueChange', false));
}

async function startEnabling() {
  await pressButton(reminders.untouched.action);
  await pressButton(reminders.explainer.confirm);
}

const switchOffWeek = () => switchOff(reminders.accessibility.oneWeek);

// With the day timing already off, turning off the week asks to delete.
async function disable() {
  await switchOffWeek();
  await pressButton(reminders.disableConfirmation.confirm);
}

type Kind = ChangeReminderSessionSnapshot['kind'];

interface Expected {
  readonly body: string;
  readonly buttons?: readonly {
    readonly hint?: string;
    readonly name: string;
    readonly primary?: true;
  }[];
  readonly heading?: string;
  readonly noEvent?: true;
  readonly switches?: 'enabled' | 'locked';
  readonly tone?: 'busy' | 'error';
}

interface State {
  readonly boundary: () => ChangeReminderAdapters;
  readonly expected: Expected;
  readonly steps?: () => Promise<void>;
}

// Every state the card can be in, how to reach it, and what it must show.
const states: Record<Kind, State> = {
  loading: {
    boundary: () => adapters({ restore: never }),
    expected: { body: reminders.loading, tone: 'busy' },
  },
  'load-failed': {
    boundary: () =>
      adapters({
        restore: jest.fn().mockRejectedValue(new Error('SecureStore failed')),
      }),
    expected: {
      body: reminders.loadFailed.body,
      buttons: [{ name: reminders.loadFailed.retry }],
      heading: reminders.loadFailed.heading,
      tone: 'error',
    },
  },
  untouched: {
    boundary: () => adapters(),
    expected: {
      body: reminders.untouched.body,
      buttons: [
        {
          hint: reminders.accessibility.enableHint,
          name: reminders.untouched.action,
        },
      ],
    },
  },
  unavailable: {
    boundary: () =>
      adapters({ restore: async () => ({ kind: 'unavailable' }) }),
    expected: {
      body: reminders.webUnavailable.body,
      heading: reminders.webUnavailable.heading,
    },
  },
  explainer: {
    boundary: () => adapters(),
    expected: {
      body: reminders.explainer.body,
      buttons: [{ name: reminders.explainer.confirm, primary: true }],
      heading: reminders.explainer.heading,
    },
    steps: () => pressButton(reminders.untouched.action),
  },
  saving: {
    boundary: () => adapters({ enable: never }),
    expected: {
      body: reminders.saving.body,
      heading: reminders.saving.heading,
      tone: 'busy',
    },
    steps: startEnabling,
  },
  failed: {
    boundary: () =>
      adapters({ enable: jest.fn(async () => ({ kind: 'failed' as const })) }),
    expected: {
      body: reminders.failed.body,
      buttons: [{ name: reminders.failed.retry }],
      heading: reminders.failed.heading,
      tone: 'error',
    },
    steps: startEnabling,
  },
  'permission-denied': {
    boundary: () =>
      adapters({
        enable: jest.fn(async () => ({ kind: 'permission-denied' as const })),
      }),
    expected: {
      body: reminders.permissionDenied.body,
      buttons: [{ name: reminders.permissionDenied.retry }],
      heading: reminders.permissionDenied.heading,
      tone: 'error',
    },
    steps: startEnabling,
  },
  'os-blocked': {
    boundary: () =>
      adapters({ enable: async () => ({ kind: 'os-blocked' as const }) }),
    expected: {
      body: reminders.osBlocked.body,
      buttons: [
        {
          hint: reminders.accessibility.openSettingsHint,
          name: reminders.osBlocked.openSettings,
        },
      ],
      heading: reminders.osBlocked.heading,
      tone: 'error',
    },
    steps: startEnabling,
  },
  enabled: {
    boundary: () => adapters({ restore: restoresRegistration() }),
    expected: {
      body: enabledBody,
      heading: reminders.enabled.heading,
      noEvent: true,
      switches: 'enabled',
    },
  },
  'retry-pending': {
    boundary: () =>
      adapters({
        restore: async () => ({
          homeTimeZone: 'Australia/Sydney',
          kind: 'pending',
        }),
      }),
    expected: {
      body: reminders.retryPending.body,
      buttons: [{ name: reminders.retryPending.retry }],
      heading: reminders.retryPending.heading,
      tone: 'error',
    },
  },
  'zone-mismatch': {
    boundary: () =>
      adapters({
        restore: restoresRegistration({ homeTimeZone: 'Australia/Brisbane' }),
      }),
    expected: {
      body: reminders.zoneMismatch.body,
      heading: reminders.zoneMismatch.heading,
      tone: 'error',
    },
  },
  'permission-revoked': {
    boundary: () =>
      adapters({
        restore: restoresRegistration({ notificationPermissionGranted: false }),
      }),
    expected: {
      body: reminders.permissionRevoked.body,
      buttons: [
        {
          hint: reminders.accessibility.openSettingsHint,
          name: reminders.permissionRevoked.openSettings,
        },
      ],
      heading: reminders.permissionRevoked.heading,
      tone: 'error',
    },
  },
  'saving-zone': {
    boundary: () =>
      adapters({
        restore: restoresRegistration(),
        updateHomeTimeZone: never,
      }),
    expected: { body: reminders.savingZone, tone: 'busy' },
  },
  'zone-failed': {
    boundary: () =>
      adapters({
        restore: restoresRegistration(),
        updateHomeTimeZone: async () => ({ kind: 'failed' }),
      }),
    expected: {
      body: reminders.zoneFailed.body,
      buttons: [{ name: reminders.zoneFailed.retry }],
      heading: reminders.zoneFailed.heading,
      tone: 'error',
    },
  },
  'saving-preferences': {
    boundary: () =>
      adapters({
        restore: restoresRegistration(),
        updatePreferences: never,
      }),
    expected: { body: reminders.savingPreferences, tone: 'busy' },
    steps: switchOffWeek,
  },
  'preferences-failed': {
    boundary: () =>
      adapters({
        restore: restoresRegistration(),
        updatePreferences: jest.fn(async () => ({ kind: 'failed' as const })),
      }),
    expected: {
      body: reminders.preferencesFailed.body,
      buttons: [
        { name: reminders.preferencesFailed.retry },
        { name: reminders.preferencesFailed.cancel },
      ],
      heading: reminders.preferencesFailed.heading,
      switches: 'locked',
      tone: 'error',
    },
    steps: switchOffWeek,
  },
  'confirm-disable': {
    boundary: () =>
      adapters({ restore: restoresRegistration({ oneDayEnabled: false }) }),
    expected: {
      body: reminders.disableConfirmation.body,
      buttons: [
        { name: reminders.disableConfirmation.cancel },
        { name: reminders.disableConfirmation.confirm, primary: true },
      ],
      heading: reminders.disableConfirmation.heading,
    },
    steps: switchOffWeek,
  },
  disabling: {
    boundary: () =>
      adapters({
        disable: never,
        restore: restoresRegistration({ oneDayEnabled: false }),
      }),
    expected: { body: reminders.disabling, tone: 'busy' },
    steps: disable,
  },
  'disable-failed': {
    boundary: () =>
      adapters({
        disable: jest.fn(async () => ({ kind: 'failed' as const })),
        restore: restoresRegistration({ oneDayEnabled: false }),
      }),
    expected: {
      body: reminders.disableFailed.body,
      buttons: [{ name: reminders.disableFailed.confirm, primary: true }],
      heading: reminders.disableFailed.heading,
      switches: 'locked',
      tone: 'error',
    },
    steps: disable,
  },
  disabled: {
    boundary: () =>
      adapters({ restore: restoresRegistration({ oneDayEnabled: false }) }),
    expected: {
      body: reminders.disabled.body,
      buttons: [
        {
          hint: reminders.accessibility.enableHint,
          name: reminders.disabled.action,
        },
      ],
      heading: reminders.disabled.heading,
    },
    steps: disable,
  },
};

// Reaches a state with the dormant note switched on, so a card that shows it
// outside `enabled` fails its check.
async function reach({ boundary, expected, steps }: State) {
  const reached = boundary();
  render(
    <ChangeReminderSection
      adapters={reached}
      homeTimeZone="Australia/Sydney"
      palette={dark}
      verifiedNoEvent
    />,
  );
  if (steps !== undefined) await steps();
  await screen.findByText(expected.body);
  return reached;
}

// The strings a screen reader walks through, in order.
function visibleText(node: ReactTestRendererNode | null): string[] {
  if (node === null || typeof node === 'string') return [];
  const children = node.children ?? [];
  return node.type === 'Text'
    ? [children.join('')]
    : children.flatMap(visibleText);
}

function cardJson() {
  const json = screen.toJSON();
  if (json === null || Array.isArray(json)) {
    throw new Error('Expected the card to be the only root');
  }
  return json;
}

function expectCard({
  body,
  buttons = [],
  heading,
  noEvent,
  switches,
  tone,
}: Expected) {
  const card = cardJson();
  expect(StyleSheet.flatten(card.props.style)).toMatchObject({
    borderColor: dark.rule,
  });
  expect(visibleText(card)).toEqual([
    reminders.heading,
    ...(heading === undefined ? [] : [heading]),
    body,
    ...(noEvent === undefined ? [] : [reminders.noEvent]),
    ...(switches === undefined
      ? []
      : [reminders.timing.oneWeek, reminders.timing.oneDay]),
    ...buttons.map(({ name }) => name),
  ]);

  const title = screen.getByRole('header', { name: reminders.heading });
  expect(StyleSheet.flatten(title.props.style)).toMatchObject({
    color: dark.secondaryInk,
  });
  if (heading !== undefined) {
    expect(
      StyleSheet.flatten(screen.getByText(heading).props.style),
    ).toMatchObject({ color: dark.secondaryInk });
  }

  const message = screen.getByText(body);
  expect(StyleSheet.flatten(message.props.style)).toMatchObject({
    color: dark.ink,
  });
  if (tone === 'busy') {
    expect(message).toBeBusy();
    expect(message.props.accessibilityLabel).toBe(body);
  } else {
    expect(message).not.toBeBusy();
    expect(message.props.accessibilityLabel).toBeUndefined();
  }
  expect(message.props.accessibilityLiveRegion).toBe(
    tone === 'error' ? 'assertive' : 'none',
  );
  expect(message.props.accessibilityRole).toBe(
    tone === 'error' ? 'alert' : undefined,
  );
  expect(screen.queryAllByRole('alert')).toHaveLength(tone === 'error' ? 1 : 0);

  expect(screen.queryAllByRole('switch')).toHaveLength(
    switches === undefined ? 0 : 2,
  );
  expect(screen.queryAllByRole('switch', { disabled: true })).toHaveLength(
    switches === 'locked' ? 2 : 0,
  );

  expect(screen.queryAllByRole('button')).toHaveLength(buttons.length);
  for (const { hint, name, primary } of buttons) {
    const button = screen.getByRole('button', { name });
    const label = within(button).getByText(name);
    expect(button.props.accessibilityHint).toBe(hint);
    const outline = StyleSheet.flatten(button.props.style);
    const text = StyleSheet.flatten(label.props.style);
    if (primary) {
      expect(outline).toMatchObject({ backgroundColor: dark.actionFill });
      expect(outline).not.toHaveProperty('borderColor');
      expect(text).toMatchObject({ color: dark.onActionFill });
    } else {
      expect(outline).toMatchObject({ borderColor: dark.controlBoundary });
      expect(outline).not.toHaveProperty('backgroundColor');
      expect(text).toMatchObject({ color: dark.ink });
    }
  }
}

describe('the card in each state', () => {
  beforeEach(() => {
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation(() => ({ remove: jest.fn() }));
  });

  it.each(Object.entries(states))('shows the %s card', async (_kind, state) => {
    await reach(state);
    expectCard(state.expected);
  });

  it('opens the explainer from the disabled card', async () => {
    await reach(states.disabled);

    await pressButton(reminders.disabled.action);

    expect(await screen.findByText(reminders.explainer.body)).toBeTruthy();
  });

  it('asks again for permission from the not-allowed card', async () => {
    const boundary = await reach(states['permission-denied']);

    await pressButton(reminders.permissionDenied.retry);

    await waitFor(() => expect(boundary.enable).toHaveBeenCalledTimes(2));
  });

  it('tries deletion again from the unconfirmed deletion card', async () => {
    const boundary = await reach(states['disable-failed']);

    await pressButton(reminders.disableFailed.confirm);

    await waitFor(() => expect(boundary.disable).toHaveBeenCalledTimes(2));
  });

  it('sends the proposed timings again from the unconfirmed timing card', async () => {
    const boundary = await reach(states['preferences-failed']);

    await pressButton(reminders.preferencesFailed.retry);

    await waitFor(() =>
      expect(boundary.updatePreferences).toHaveBeenCalledTimes(2),
    );
    expect(boundary.updatePreferences).toHaveBeenLastCalledWith({
      oneDayEnabled: true,
      oneWeekEnabled: false,
    });
  });

  it('sends the saved timings again when an unconfirmed timing change is dropped', async () => {
    const boundary = await reach(states['preferences-failed']);

    await pressButton(reminders.preferencesFailed.cancel);

    await waitFor(() =>
      expect(boundary.updatePreferences).toHaveBeenCalledTimes(2),
    );
    expect(boundary.updatePreferences).toHaveBeenLastCalledWith({
      oneDayEnabled: true,
      oneWeekEnabled: true,
    });
  });
});

describe('the views the card keeps', () => {
  let returnToApp: () => Promise<void>;

  beforeEach(() => {
    let onAppStateChange: ((state: string) => void) | undefined;
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, listener) => {
        onAppStateChange = listener as (state: string) => void;
        return { remove: jest.fn() };
      });
    returnToApp = () => act(async () => onAppStateChange?.('active'));
  });

  // Reading a view that has been replaced throws, so each test reads one that
  // it found before the change.
  it('updates the message in place when one message gives way to another', async () => {
    let refresh:
      | ((result: ChangeReminderTokenRefreshResult) => void)
      | undefined;
    renderSection(
      adapters({
        restore: restoresRegistration(),
        startTokenRefresh: jest.fn((_zone, listener) => {
          refresh = listener;
          return () => undefined;
        }),
      }),
    );
    const message = await screen.findByText(enabledBody);

    await act(async () => refresh?.({ kind: 'failed', retryable: false }));

    expect(message).toHaveTextContent(reminders.failed.body);
  });

  it('keeps the start button when the disabled card gives way to the untouched one', async () => {
    renderSection(
      adapters({
        restore: jest
          .fn()
          .mockImplementationOnce(
            restoresRegistration({ oneDayEnabled: false }),
          )
          .mockResolvedValue({ kind: 'unregistered' }),
      }),
    );
    await disable();
    const button = await screen.findByRole('button', {
      name: reminders.disabled.action,
    });

    // Once deleted, the registration is gone from the device.
    await returnToApp();

    await screen.findByText(reminders.untouched.body);
    expect(button).toHaveTextContent(reminders.untouched.action);
  });
});

describe('subscriptions', () => {
  beforeEach(() => {
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation(() => ({ remove: jest.fn() }));
  });

  it('removes the app-state listener when it unmounts', async () => {
    const remove = jest.fn();
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation(() => ({ remove }));
    const rendered = renderSection(adapters());
    await screen.findByRole('button', { name: reminders.untouched.action });
    expect(remove).not.toHaveBeenCalled();

    rendered.unmount();

    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('removes the token listener when it unmounts', async () => {
    const remove = jest.fn();
    const rendered = renderSection(
      adapters({
        restore: restoresRegistration(),
        startTokenRefresh: jest.fn(() => remove),
      }),
    );
    await screen.findByText(enabledBody);
    expect(remove).not.toHaveBeenCalled();

    rendered.unmount();

    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('the installation ID in a test build', () => {
  const diagnostic = (id: string) => `Test installation ID: ${id}`;
  let returnToApp: () => Promise<void>;

  beforeEach(() => {
    let onAppStateChange: ((state: string) => void) | undefined;
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, listener) => {
        onAppStateChange = listener as (state: string) => void;
        return { remove: jest.fn() };
      });
    returnToApp = () => act(async () => onAppStateChange?.('active'));
  });

  // Each read waits for the test to settle it, so one can finish late.
  function slowReads() {
    const reads: {
      readonly reject: (reason: Error) => void;
      readonly resolve: (id: string) => void;
    }[] = [];
    const readInstallationId = jest.fn(
      () =>
        new Promise<string | null>((resolve, reject) => {
          reads.push({ reject, resolve });
        }),
    );
    return { readInstallationId, reads };
  }

  async function showFirstRead() {
    const { readInstallationId, reads } = slowReads();
    renderSection(
      adapters({ readInstallationId, restore: restoresRegistration() }),
      true,
    );
    await waitFor(() => expect(reads).toHaveLength(1));
    return reads;
  }

  it('is not read until reminders are enabled', async () => {
    const readInstallationId = jest.fn(async () => 'i'.repeat(43));
    renderSection(adapters({ readInstallationId }), true);
    await screen.findByRole('button', { name: reminders.untouched.action });
    expect(readInstallationId).not.toHaveBeenCalled();
  });

  it('is read once reminders are enabled', async () => {
    const readInstallationId = jest.fn(async () => 'i'.repeat(43));
    renderSection(
      adapters({ readInstallationId, restore: restoresRegistration() }),
      true,
    );
    await screen.findByText(diagnostic('i'.repeat(43)));
    expect(readInstallationId).toHaveBeenCalledTimes(1);
  });

  it('is hidden while the card is not in the enabled state', async () => {
    renderSection(
      adapters({
        readInstallationId: async () => 'saved',
        restore: restoresRegistration({ oneDayEnabled: false }),
      }),
      true,
    );
    await screen.findByText(diagnostic('saved'));

    await switchOffWeek();

    expect(screen.queryByText(/Test installation ID/)).toBeNull();
    await pressButton(reminders.disableConfirmation.cancel);
    expect(await screen.findByText(diagnostic('saved'))).toBeTruthy();
  });

  it('is cleared when a later read fails', async () => {
    const reads = await showFirstRead();
    await act(async () => reads[0]?.resolve('first'));
    await screen.findByText(diagnostic('first'));

    await returnToApp();
    await waitFor(() => expect(reads).toHaveLength(2));
    await act(async () => reads[1]?.reject(new Error('read failed')));

    await waitFor(() =>
      expect(screen.queryByText(/Test installation ID/)).toBeNull(),
    );
  });

  it('ignores a read that finishes after a newer one', async () => {
    const reads = await showFirstRead();
    await returnToApp();
    await waitFor(() => expect(reads).toHaveLength(2));
    await act(async () => reads[1]?.resolve('newer'));
    await screen.findByText(diagnostic('newer'));

    await act(async () => reads[0]?.resolve('older'));

    expect(screen.getByText(diagnostic('newer'))).toBeTruthy();
  });

  it('ignores a failed read that ends after a newer one', async () => {
    const reads = await showFirstRead();
    await returnToApp();
    await waitFor(() => expect(reads).toHaveLength(2));
    await act(async () => reads[1]?.resolve('newer'));
    await screen.findByText(diagnostic('newer'));

    await act(async () => reads[0]?.reject(new Error('too late')));

    expect(screen.getByText(diagnostic('newer'))).toBeTruthy();
  });
});

describe('the optional extras', () => {
  beforeEach(() => {
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation(() => ({ remove: jest.fn() }));
  });

  it('are off unless the section is asked for them', async () => {
    const readInstallationId = jest.fn(async () => 'i'.repeat(43));
    render(
      <ChangeReminderSection
        adapters={adapters({
          readInstallationId,
          restore: restoresRegistration(),
        })}
        homeTimeZone="Australia/Sydney"
        palette={dark}
      />,
    );

    await screen.findByText(enabledBody);

    expect(screen.queryByText(reminders.noEvent)).toBeNull();
    expect(screen.queryByText(/Test installation ID/)).toBeNull();
    expect(readInstallationId).not.toHaveBeenCalled();
  });
});
