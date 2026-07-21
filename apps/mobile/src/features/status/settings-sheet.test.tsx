import { fireEvent, render, screen } from '@testing-library/react-native';
import { Modal } from 'react-native';

import { daylightSaviourPalettes } from '../../theme';
import SettingsSheet from './settings-sheet';

const facts = {
  friendlyZoneLabel: 'Sydney, Canberra & most of NSW',
  packVersion: '2026a-test.1',
} as const;

describe('SettingsSheet', () => {
  it.each([
    [false, 'fade'],
    [true, 'none'],
    [null, 'none'],
  ] as const)(
    'owns bounded sheet state with %s reduced-motion preference',
    (reducedMotion, animationType) => {
      render(
        <SettingsSheet
          facts={facts}
          palette={daylightSaviourPalettes.light}
          reducedMotion={reducedMotion}
        />,
      );

      expect(screen.UNSAFE_getByType(Modal).props.animationType).toBe(
        animationType,
      );
      fireEvent.press(screen.getByRole('button', { name: 'Settings' }));
      expect(screen.getByRole('header', { name: 'Settings' })).toBeTruthy();
      expect(screen.getByText(/Home Time Zone: Sydney/)).toBeTruthy();
      expect(screen.queryByText(/not available|version|arrive/i)).toBeNull();
      expect(
        screen.getByTestId('settings-modal-safe-area').props.edges,
      ).toMatchObject({ bottom: 'additive', top: 'off' });

      fireEvent.press(screen.getByRole('button', { name: 'Close settings' }));
      expect(screen.queryByRole('header', { name: 'Settings' })).toBeNull();
    },
  );
});
