import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

import { daylightSaviourPalettes } from '../../theme';
import type { ChangeReminderAdapters } from './change-reminder-adapters';
import ChangeReminderSection from './change-reminder-section';

function adapters(
  overrides: Partial<ChangeReminderAdapters> = {},
): ChangeReminderAdapters {
  return {
    enable: jest.fn(async () => ({ kind: 'enabled' as const })),
    openSettings: jest.fn(async () => undefined),
    restore: jest.fn(async () => ({ kind: 'unregistered' as const })),
    ...overrides,
  };
}

function renderSection(boundary: ChangeReminderAdapters) {
  return render(
    <ChangeReminderSection
      adapters={boundary}
      homeTimeZone="Australia/Sydney"
      palette={daylightSaviourPalettes.light}
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
  fireEvent.press(screen.getByRole('button', { name: 'Enable reminders' }));
  expect(boundary.enable).toHaveBeenCalledWith('Australia/Sydney');
  expect(
    await screen.findByText(
      /one-week and one-day Change Reminders are enabled/i,
    ),
  ).toBeTruthy();
});

it('renders restored registration truthfully without another enable action', async () => {
  const boundary = adapters({
    restore: jest.fn(async () => ({
      kind: 'registered' as const,
      notificationPermissionGranted: true,
      registration: {
        credential: 'c'.repeat(43),
        homeTimeZone: 'Australia/Sydney',
        installationId: 'i'.repeat(43),
        oneDayEnabled: true,
        oneWeekEnabled: true,
        version: 1 as const,
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
  expect(screen.queryByRole('button')).toBeNull();

  await act(async () => resolve({ kind: 'failed' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Try registration again' }),
    ).toBeTruthy(),
  );
});

it('renders truthful zone-mismatch and revoked-permission restore states', async () => {
  const stored = {
    credential: 'c'.repeat(43),
    homeTimeZone: 'Australia/Brisbane',
    installationId: 'i'.repeat(43),
    oneDayEnabled: true,
    oneWeekEnabled: true,
    version: 1 as const,
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
  renderSection(
    adapters({
      openSettings,
      restore: jest.fn(async () => ({
        kind: 'registered' as const,
        notificationPermissionGranted: false,
        registration: { ...stored, homeTimeZone: 'Australia/Sydney' },
      })),
    }),
  );
  expect(
    await screen.findByText(/registered, but notifications are blocked/i),
  ).toBeTruthy();
  fireEvent.press(
    screen.getByRole('button', { name: 'Open notification settings' }),
  );
  expect(openSettings).toHaveBeenCalledTimes(1);
});
