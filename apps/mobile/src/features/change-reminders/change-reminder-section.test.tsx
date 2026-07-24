import { fireEvent, render, screen } from '@testing-library/react-native';

import { daylightSaviourPalettes } from '../../theme';
import ChangeReminderSection from './change-reminder-section';

it('does not request a reminder before explicit confirmation', async () => {
  const enable = jest.fn(async () => ({ kind: 'enabled' as const }));
  render(
    <ChangeReminderSection
      adapters={{ enable, openSettings: jest.fn(async () => undefined) }}
      homeTimeZone="Australia/Sydney"
      palette={daylightSaviourPalettes.light}
    />,
  );
  fireEvent.press(
    screen.getByRole('button', { name: 'Warn me before time misbehaves' }),
  );
  expect(enable).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Enable reminders' }));
  expect(enable).toHaveBeenCalledWith('Australia/Sydney');
  expect(
    await screen.findByText(
      /one-week and one-day Change Reminders are enabled/i,
    ),
  ).toBeTruthy();
});
