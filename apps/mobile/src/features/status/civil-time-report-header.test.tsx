import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { daylightSaviourPalettes } from '../../theme';
import CivilTimeReportHeader from './civil-time-report-header';

describe('CivilTimeReportHeader', () => {
  it.each(['light', 'dark'] as const)(
    'presents document scope and actionable Home Time Zone in %s appearance',
    (appearance) => {
      const chooseZone = jest.fn();
      const palette = daylightSaviourPalettes[appearance];

      render(
        <CivilTimeReportHeader
          facts={{
            friendlyZoneLabel: 'Casey Station, Australian Antarctic Territory',
            packVersion: '2026a-australian-v1',
            zoneId: 'Antarctica/Casey',
          }}
          onChooseZone={chooseZone}
          palette={palette}
        />,
      );

      expect(
        screen.getByText('DAYLIGHT SAVIOUR · CIVIL TIME RECORD', {
          includeHiddenElements: true,
        }),
      ).toBeTruthy();
      const zone = screen.getByRole('button', {
        name: 'Home Time Zone, Casey Station, Australian Antarctic Territory, Antarctica/Casey',
      });
      expect(zone.props.accessibilityHint).toBe(
        'Opens Australian Home Time Zone selection',
      );
      expect(
        StyleSheet.flatten(
          screen.getByText('Casey Station, Australian Antarctic Territory')
            .props.style,
        ).color,
      ).toBe(palette.ink);
      expect(
        StyleSheet.flatten(
          screen.getByText('2026a-australian-v1', {
            includeHiddenElements: true,
          }).props.style,
        ).color,
      ).toBe(palette.solarGold);
      expect(
        StyleSheet.flatten(
          screen.getByTestId('utility-identity', {
            includeHiddenElements: true,
          }).props.style,
        ),
      ).toMatchObject({ flexShrink: 1, gap: 4 });
      expect(StyleSheet.flatten(zone.props.style).borderColor).toBe(
        palette.controlBoundary,
      );
      fireEvent.press(zone);
      expect(chooseZone).toHaveBeenCalledTimes(1);
    },
  );

  it('renders non-actionable scope without button semantics', () => {
    render(
      <CivilTimeReportHeader
        facts={{
          friendlyZoneLabel: 'Sydney, Canberra & most of NSW',
          packVersion: '2026a-australian-v1',
          zoneId: 'Australia/Sydney',
        }}
        palette={daylightSaviourPalettes.light}
      />,
    );

    expect(
      screen.queryByRole('button', {
        name: /Home Time Zone, Sydney/,
      }),
    ).toBeNull();
    expect(
      screen.getByLabelText(
        'Home Time Zone, Sydney, Canberra & most of NSW, Australia/Sydney',
      ),
    ).toBeDisabled();
  });
});
