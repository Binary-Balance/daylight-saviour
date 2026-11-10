import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

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
        screen.getByText('DAYLIGHT SAVIOUR · KEEPING CIVIL TIME CIVIL', {
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
    const label = rendered.indexOf('DAYLIGHT SAVIOUR');
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
