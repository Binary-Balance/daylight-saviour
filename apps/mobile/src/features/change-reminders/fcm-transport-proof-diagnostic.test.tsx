import { fireEvent, render, screen } from '@testing-library/react-native';

import { daylightSaviourPalettes } from '../../theme';
import FcmTransportProofDiagnostic from './fcm-transport-proof-diagnostic';

describe('FCM transport proof diagnostic', () => {
  it('reveals only installation ID and matching Home Time Zone on demand', async () => {
    const reader = {
      read: jest.fn(async () => ({
        homeTimeZone: 'Australia/Sydney',
        installationId: 'i'.repeat(43),
      })),
    };
    render(
      <FcmTransportProofDiagnostic
        homeTimeZone="Australia/Sydney"
        palette={daylightSaviourPalettes.light}
        reader={reader}
      />,
    );

    expect(screen.queryByText('i'.repeat(43))).toBeNull();
    fireEvent.press(
      screen.getByRole('button', {
        name: 'Show transport-test installation ID',
      }),
    );

    expect(await screen.findByText('i'.repeat(43))).toBeTruthy();
    expect(screen.getByText('Australia/Sydney')).toBeTruthy();
    expect(reader.read).toHaveBeenCalledWith('Australia/Sydney');
    expect(JSON.stringify(screen.toJSON())).not.toContain('credential');
    expect(JSON.stringify(screen.toJSON())).not.toContain('deviceToken');
  });

  it('fails closed when no matching successful registration exists', async () => {
    render(
      <FcmTransportProofDiagnostic
        homeTimeZone="Australia/Sydney"
        palette={daylightSaviourPalettes.light}
        reader={{ read: jest.fn(async () => null) }}
      />,
    );

    fireEvent.press(
      screen.getByRole('button', {
        name: 'Show transport-test installation ID',
      }),
    );
    expect(
      await screen.findByRole('alert', {
        name: /enable change reminders for this home time zone/i,
      }),
    ).toBeTruthy();
  });
});
