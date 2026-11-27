import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Dimensions, StyleSheet, Text } from 'react-native';

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
            zoneId: 'Antarctica/Casey',
          }}
          onChooseZone={chooseZone}
          palette={palette}
        />,
      );

      expect(
        screen.getByText('Daylight Saviour · Keeping civil time civil', {
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
      expect(StyleSheet.flatten(zone.props.style).borderColor).toBe(
        palette.controlBoundary,
      );
      fireEvent.press(zone);
      expect(chooseZone).toHaveBeenCalledTimes(1);
    },
  );

  // The Settings button is drawn over the report's top right corner.
  it.each([
    [1.235, { paddingRight: 92 }],
    [1.3, { paddingRight: 0, paddingTop: 48 }],
  ])(
    'keeps the document label clear of Settings at text scale %d',
    (fontScale, clearance) => {
      const window = Dimensions.get('window');
      const deviceScreen = Dimensions.get('screen');
      Dimensions.set({
        screen: { ...deviceScreen, fontScale },
        window: { ...window, fontScale },
      });
      try {
        render(
          <CivilTimeReportHeader
            facts={{
              friendlyZoneLabel: 'Sydney, Canberra & most of NSW',
              zoneId: 'Australia/Sydney',
            }}
            palette={daylightSaviourPalettes.light}
          />,
        );

        expect(
          StyleSheet.flatten(
            screen.getByTestId('utility-header', {
              includeHiddenElements: true,
            }).props.style,
          ),
        ).toMatchObject(clearance);
      } finally {
        act(() => Dimensions.set({ screen: deviceScreen, window }));
      }
    },
  );

  it('shows a notice between the document label and the Home Time Zone', () => {
    const { toJSON } = render(
      <CivilTimeReportHeader
        facts={{
          friendlyZoneLabel: 'Sydney, Canberra & most of NSW',
          zoneId: 'Australia/Sydney',
        }}
        notice={<Text>Notice</Text>}
        palette={daylightSaviourPalettes.light}
      />,
    );

    const rendered = JSON.stringify(toJSON());
    const label = rendered.indexOf('Daylight Saviour');
    const notice = rendered.indexOf('"Notice"');
    expect(label).toBeGreaterThanOrEqual(0);
    expect(notice).toBeGreaterThan(label);
    expect(notice).toBeLessThan(rendered.indexOf('Home Time Zone'));
  });

  it('renders non-actionable scope without button semantics', () => {
    render(
      <CivilTimeReportHeader
        facts={{
          friendlyZoneLabel: 'Sydney, Canberra & most of NSW',
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
