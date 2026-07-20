import { render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import { activateAustralianTimeZoneDataPack } from '@daylight-saviour/domain';
import { bundledAustralianDataPack } from '@daylight-saviour/time-zone-data';

import { daylightSaviourPalettes } from '../../theme';
import ChangeEventSection from './change-event-section';
import { createStatusViewModel } from './status-view-model';
import type { TimeZoneDataPackFreshness } from '../time-zone-data/time-zone-data-manager';

const pack = activateAustralianTimeZoneDataPack(bundledAustralianDataPack);

function report(
  instant: string,
  zoneId = 'Australia/Sydney',
  freshness: TimeZoneDataPackFreshness = 'current',
) {
  return createStatusViewModel(
    pack,
    freshness,
    zoneId,
    new Date(instant),
    false,
    'test-installation',
  );
}

describe('ChangeEventSection', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['light', 'dark'] as const)(
    'renders complete Backward Change facts in %s appearance',
    (appearance) => {
      const palette = daylightSaviourPalettes[appearance];
      render(
        <ChangeEventSection
          palette={palette}
          reducedMotion
          report={report('2026-04-04T15:59:59.000Z')}
        />,
      );

      expect(screen.getByTestId('reminder-day-civil-time-report')).toBeTruthy();
      expect(screen.getByRole('header', { name: '5 April 2026' })).toBeTruthy();
      expect(screen.getByText('Backward Change')).toBeTruthy();
      expect(screen.getByText('3:00 am → 2:00 am')).toBeTruthy();
      expect(screen.getByText('UTC+11:00 → UTC+10:00')).toBeTruthy();
      expect(screen.getByText('In 1 second')).toBeTruthy();
      expect(
        ReactNative.StyleSheet.flatten(
          screen.getByText('Backward Change').props.style,
        ).color,
      ).toBe(palette.accent);
    },
  );

  it('renders validity expiry without civil-time claims', () => {
    render(
      <ChangeEventSection
        palette={daylightSaviourPalettes.light}
        reducedMotion
        report={report('2031-01-01T00:00:00.000Z')}
      />,
    );

    expect(
      screen.getByRole('header', { name: 'Civil-time decision unavailable' }),
    ).toBeTruthy();
    expect(screen.getByTestId('expired-civil-time-report')).toBeTruthy();
    expect(screen.queryByText(/UTC\+\d/)).toBeNull();
    expect(screen.queryByTestId('no-event-civil-time-report')).toBeNull();
  });

  it('distinguishes non-expiry decision failures', () => {
    render(
      <ChangeEventSection
        palette={daylightSaviourPalettes.light}
        reducedMotion
        report={report('2026-07-19T00:00:00.000Z', 'Europe/London')}
      />,
    );

    expect(screen.getByTestId('unavailable-civil-time-report')).toBeTruthy();
    expect(screen.getByText('DECISION UNAVAILABLE')).toBeTruthy();
    expect(screen.getByText(/Home Time Zone is not supported/)).toBeTruthy();
    expect(screen.queryByText('Validity Horizon passed')).toBeNull();
  });

  it.each(['light', 'dark'] as const)(
    'renders intentional no-event record in %s appearance',
    (appearance) => {
      render(
        <ChangeEventSection
          palette={daylightSaviourPalettes[appearance]}
          reducedMotion
          report={report('2026-07-19T00:00:00.000Z', 'Australia/Brisbane')}
        />,
      );

      expect(
        screen.getByRole('header', {
          name: 'No Change Event scheduled within verified data',
        }),
      ).toBeTruthy();
      expect(screen.queryByText(/^In /)).toBeNull();
      expect(screen.getByText(/No countdown required/)).toBeTruthy();
      expect(screen.getByTestId('no-event-civil-time-report')).toBeTruthy();
    },
  );

  it('uses directional one-shot motion and reduced-motion replacement', () => {
    const loopSpy = jest.spyOn(ReactNative.Animated, 'loop');
    const backward = render(
      <ChangeEventSection
        palette={daylightSaviourPalettes.light}
        reducedMotion={false}
        report={report('2026-04-04T15:59:59.000Z')}
      />,
    );
    expect(screen.getByTestId('motion-reverse-fading-echo')).toBeTruthy();
    expect(
      screen.getAllByText('3:00 am → 2:00 am', {
        includeHiddenElements: true,
      }),
    ).toHaveLength(2);
    expect(loopSpy).not.toHaveBeenCalled();

    backward.unmount();
    render(
      <ChangeEventSection
        palette={daylightSaviourPalettes.light}
        reducedMotion
        report={report('2026-10-02T16:00:00.000Z')}
      />,
    );
    expect(screen.getByTestId('motion-short-fade')).toBeTruthy();
    expect(screen.getByText('Forward Change')).toBeTruthy();
    expect(screen.queryAllByText('2:00 am → 3:00 am')).toHaveLength(1);
    expect(loopSpy).not.toHaveBeenCalled();
  });

  it('waits without motion until reduced-motion preference resolves', () => {
    const rendered = render(
      <ChangeEventSection
        palette={daylightSaviourPalettes.light}
        reducedMotion={null}
        report={report('2026-04-04T15:59:59.000Z')}
      />,
    );

    expect(screen.getByTestId('motion-awaiting-preference')).toBeTruthy();
    expect(
      screen.getByTestId('semantic-event-content').props.style.opacity,
    ).toBe(1);
    expect(
      screen.getAllByText('3:00 am → 2:00 am', {
        includeHiddenElements: true,
      }),
    ).toHaveLength(1);

    rendered.rerender(
      <ChangeEventSection
        palette={daylightSaviourPalettes.light}
        reducedMotion
        report={report('2026-04-04T15:59:59.000Z')}
      />,
    );
    expect(screen.getByTestId('motion-short-fade')).toBeTruthy();
  });

  it('themes decorative Backward echo through its palette', () => {
    render(
      <ChangeEventSection
        palette={daylightSaviourPalettes.dark}
        reducedMotion={false}
        report={report('2026-04-04T15:59:59.000Z')}
      />,
    );

    const echo = screen
      .getAllByText('3:00 am → 2:00 am', { includeHiddenElements: true })
      .find((node) => node.props.accessibilityElementsHidden);
    expect(echo).toBeDefined();
    expect(ReactNative.StyleSheet.flatten(echo?.props.style).color).toBe(
      daylightSaviourPalettes.dark.secondaryInk,
    );
  });

  it('renders Lord Howe 30-minute Forward Change and absolute countdown', () => {
    render(
      <ChangeEventSection
        palette={daylightSaviourPalettes.light}
        reducedMotion
        report={report('2026-10-02T15:30:00.000Z', 'Australia/Lord_Howe')}
      />,
    );

    expect(screen.getByText('Forward Change')).toBeTruthy();
    expect(screen.getByText('2:00 am → 2:30 am')).toBeTruthy();
    expect(screen.getByText('UTC+10:30 → UTC+11:00')).toBeTruthy();
    expect(screen.getByText(/Clocks move 30 minutes/)).toBeTruthy();
    expect(screen.getByText('In 1 day')).toBeTruthy();
  });
});
