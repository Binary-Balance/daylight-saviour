import { render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';

import StatusScreen from './status-screen';

describe('StatusScreen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(['light', 'dark'] as const)(
    'renders literal foundation state in %s appearance',
    (appearance) => {
      jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(appearance);

      render(<StatusScreen />);

      expect(
        screen.getByRole('header', {
          name: 'Civil-time calculation not connected',
        }),
      ).toBeTruthy();
      expect(
        screen.getByLabelText('Home Time Zone, Australia/Sydney'),
      ).toBeTruthy();
      expect(
        screen.getByText('No daylight-saving claim is being made.'),
      ).toBeTruthy();
    },
  );
});
