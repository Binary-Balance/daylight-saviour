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
    load: jest.fn(async () => null),
    openSettings: jest.fn(async () => undefined),
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
    load: jest.fn(async () => ({
      credential: 'c'.repeat(43),
      homeTimeZone: 'Australia/Sydney',
      installationId: 'i'.repeat(43),
      oneDayEnabled: true,
      oneWeekEnabled: true,
      version: 1 as const,
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
    load: jest
      .fn()
      .mockRejectedValueOnce(new Error('SecureStore read failed'))
      .mockResolvedValueOnce(null),
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
