import { act, render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { activateAustralianTimeZoneDataPack } from '@daylight-saviour/domain';
import { bundledAustralianDataPack } from '@daylight-saviour/time-zone-data';

import { holdAnimations } from '../../../test-support/hold-animations';
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

function section(instant: string, reducedMotion: boolean | null) {
  return (
    <ChangeEventSection
      palette={daylightSaviourPalettes.light}
      reducedMotion={reducedMotion}
      report={report(instant)}
    />
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
      expect(
        screen.getByRole('header', { name: 'NEXT CHANGE EVENT' }),
      ).toBeTruthy();
      expect(screen.getByText('Backward Change')).toBeTruthy();
      expect(screen.getByText('3:00 am → 2:00 am')).toBeTruthy();
      expect(screen.getByText('UTC+11:00 → UTC+10:00')).toBeTruthy();
      expect(screen.getByText('In 1 second')).toBeTruthy();
      expect(
        ReactNative.StyleSheet.flatten(
          screen.getByTestId('countdown-current').props.style,
        ).color,
      ).toBe(palette.ink);
      expect(
        ReactNative.StyleSheet.flatten(
          screen.getByText('Backward Change').props.style,
        ).color,
      ).toBe(palette.solarGold);
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
    expect(screen.getByText('In 1 day').props.accessibilityLiveRegion).toBe(
      'none',
    );
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

  it('crossfades every mounted countdown value without replaying event motion', () => {
    const timingSpy = jest.spyOn(ReactNative.Animated, 'timing');
    const loopSpy = jest.spyOn(ReactNative.Animated, 'loop');
    const rendered = render(
      <ChangeEventSection
        palette={daylightSaviourPalettes.light}
        reducedMotion
        report={report('2026-04-04T15:59:58.000Z')}
      />,
    );
    const eventMotionCalls = timingSpy.mock.calls.length;

    rendered.rerender(
      <ChangeEventSection
        palette={daylightSaviourPalettes.light}
        reducedMotion
        report={report('2026-04-04T15:59:59.000Z')}
      />,
    );

    expect(screen.getByTestId('countdown-current').props.children).toBe(
      'In 1 second',
    );
    expect(timingSpy.mock.calls.length).toBe(eventMotionCalls + 2);
    expect(loopSpy).not.toHaveBeenCalled();
  });

  it('replaces unit-shaped countdown facts without exposing the previous value', () => {
    const loopSpy = jest.spyOn(ReactNative.Animated, 'loop');
    const rendered = render(
      <ChangeEventSection
        palette={daylightSaviourPalettes.light}
        reducedMotion={false}
        report={report('2026-04-04T15:58:00.000Z')}
      />,
    );
    const directionalCalls = jest.spyOn(ReactNative.Animated, 'timing').mock
      .calls.length;
    rendered.rerender(
      <ChangeEventSection
        palette={daylightSaviourPalettes.light}
        reducedMotion={false}
        report={report('2026-04-04T15:59:59.000Z')}
      />,
    );
    expect(
      screen.getByTestId('countdown-current').props.accessibilityLiveRegion,
    ).toBe('none');
    const previous = screen
      .getAllByText(/In /, { includeHiddenElements: true })
      .find((node) => node.props.accessibilityElementsHidden);
    expect(previous).toBeDefined();
    expect(jest.spyOn(ReactNative.Animated, 'timing').mock.calls.length).toBe(
      directionalCalls + 2,
    );
    expect(loopSpy).not.toHaveBeenCalled();
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

  describe('event motion', () => {
    const backward = '2026-04-04T15:59:59.000Z';
    const forward = '2026-10-02T16:00:00.000Z';

    it.each([
      ['Backward Change', false, backward, 280, 1, { translateX: 12 }, true],
      ['Forward Change', false, forward, 260, 1, { translateY: -12 }, false],
      ['Backward Change', true, backward, 90, 0.72, { translateX: 0 }, false],
      ['Forward Change', true, forward, 90, 0.72, { translateY: 0 }, false],
    ] as const)(
      'starts %s motion at its first frame and runs it to rest (reduced motion: %s)',
      (
        _direction,
        reducedMotion,
        instant,
        duration,
        startOpacity,
        startTransform,
        hasEcho,
      ) => {
        const held = holdAnimations();
        const timing = jest.spyOn(ReactNative.Animated, 'timing');

        render(section(instant, reducedMotion));

        const content = screen.getByTestId('semantic-event-content');
        expect(content.props.style.opacity).toBe(startOpacity);
        expect(content.props.style.transform).toEqual([startTransform]);
        const toRest = { duration, toValue: 0, useNativeDriver: true };
        expect(timing.mock.calls.map(([, config]) => config)).toEqual([
          { duration, toValue: 1, useNativeDriver: true },
          toRest,
          ...(hasEcho ? [toRest] : []),
        ]);
        expect(held).toHaveLength(1);
        expect(held[0]?.started).toBe(true);
      },
    );

    it('starts the decorative echo faint and offset, then fades it out', () => {
      render(section(backward, false));

      const echo = screen
        .getAllByText('3:00 am → 2:00 am', { includeHiddenElements: true })
        .find((node) => node.props.accessibilityElementsHidden);
      expect(ReactNative.StyleSheet.flatten(echo?.props.style)).toMatchObject({
        opacity: 0.35,
        transform: [{ translateX: 12 }],
      });
    });

    it('restarts for a different event and abandons the motion it replaces', () => {
      const held = holdAnimations();
      const view = render(section(backward, false));
      expect(held[0]?.stop).not.toHaveBeenCalled();

      view.rerender(section(forward, false));

      expect(held[0]?.stop).toHaveBeenCalledTimes(1);
      const content = screen.getByTestId('semantic-event-content');
      expect(content.props.style.transform).toEqual([{ translateY: -12 }]);
    });

    it('stops the motion in flight when it unmounts', () => {
      const held = holdAnimations();
      const view = render(section(backward, false));

      view.unmount();

      expect(held[0]?.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe('countdown crossfade', () => {
    const threeSeconds = '2026-04-04T15:59:57.000Z';
    const twoSeconds = '2026-04-04T15:59:58.000Z';
    const oneSecond = '2026-04-04T15:59:59.000Z';

    const opacityOf = (node: ReactTestInstance) =>
      ReactNative.StyleSheet.flatten(node.props.style).opacity;
    const hiddenCountdown = (text: string) =>
      screen.queryByText(text, { includeHiddenElements: true });

    it('does not crossfade a countdown that has not changed', () => {
      const held = holdAnimations();
      const view = render(section(twoSeconds, null));
      expect(
        screen.getAllByText('In 2 seconds', { includeHiddenElements: true }),
      ).toHaveLength(1);

      view.rerender(section(twoSeconds, false));

      // Only the event's own motion starts, now that the preference is known.
      expect(held).toHaveLength(1);
      expect(
        screen.getAllByText('In 2 seconds', { includeHiddenElements: true }),
      ).toHaveLength(1);
    });

    it.each([
      [false, 0.7, 140],
      [true, 0.85, 90],
    ] as const)(
      'fades the new countdown in over the old one when reduced motion is %s',
      (reducedMotion, startOpacity, duration) => {
        const held = holdAnimations();
        const timing = jest.spyOn(ReactNative.Animated, 'timing');
        const view = render(section(twoSeconds, reducedMotion));
        // held[0] is the event's own motion, started on mount.
        const eventMotionCalls = timing.mock.calls.length;

        view.rerender(section(oneSecond, reducedMotion));

        const previous = screen.getByText('In 2 seconds', {
          includeHiddenElements: true,
        });
        expect(previous.props.accessibilityElementsHidden).toBe(true);
        expect(opacityOf(previous)).toBe(1);
        expect(opacityOf(screen.getByTestId('countdown-current'))).toBe(
          startOpacity,
        );
        expect(
          timing.mock.calls.slice(eventMotionCalls).map(([, config]) => config),
        ).toEqual([
          { duration, toValue: 0, useNativeDriver: true },
          { duration, toValue: 1, useNativeDriver: true },
        ]);
        expect(held).toHaveLength(2);
        expect(held[1]?.started).toBe(true);

        act(() => held[1]?.finish());

        expect(hiddenCountdown('In 2 seconds')).toBeNull();
        expect(screen.getByTestId('countdown-current').props.children).toBe(
          'In 1 second',
        );
      },
    );

    it('uses a motion preference that resolved after the first render', () => {
      holdAnimations();
      const view = render(section(twoSeconds, null));
      view.rerender(section(twoSeconds, false));

      view.rerender(section(oneSecond, false));

      expect(opacityOf(screen.getByTestId('countdown-current'))).toBe(0.7);
    });

    it('uses a motion preference that changes with the countdown', () => {
      holdAnimations();
      const view = render(section(twoSeconds, false));

      view.rerender(section(oneSecond, true));

      expect(opacityOf(screen.getByTestId('countdown-current'))).toBe(0.85);
    });

    it('fades from the value it last showed', () => {
      const held = holdAnimations();
      const view = render(section(threeSeconds, false));
      view.rerender(section(twoSeconds, false));
      act(() => held[1]?.finish());

      view.rerender(section(oneSecond, false));

      expect(
        hiddenCountdown('In 2 seconds')?.props.accessibilityElementsHidden,
      ).toBe(true);
      expect(hiddenCountdown('In 3 seconds')).toBeNull();
    });

    it('changes the countdown without a crossfade while the motion preference is unknown', () => {
      const held = holdAnimations();
      const view = render(section(twoSeconds, null));

      view.rerender(section(oneSecond, null));

      expect(screen.getByTestId('countdown-current').props.children).toBe(
        'In 1 second',
      );
      expect(hiddenCountdown('In 2 seconds')).toBeNull();
      expect(held).toHaveLength(0);
    });

    it.each([
      [false, true],
      [true, false],
      [false, null],
    ] as const)(
      'lets a crossfade finish when reduced motion changes from %s to %s',
      (before, after) => {
        const held = holdAnimations();
        const view = render(section(twoSeconds, before));
        view.rerender(section(oneSecond, before));
        // The first animation is the section's entrance.
        const crossfade = held[1];

        view.rerender(section(oneSecond, after));

        expect(crossfade?.stop).not.toHaveBeenCalled();
        act(() => crossfade?.finish());
        expect(hiddenCountdown('In 2 seconds')).toBeNull();
      },
    );

    it('stops a crossfade in flight when it unmounts', () => {
      const held = holdAnimations();
      const view = render(section(twoSeconds, false));
      view.rerender(section(oneSecond, false));
      expect(held[1]?.stop).not.toHaveBeenCalled();

      view.unmount();

      expect(held[1]?.stop).toHaveBeenCalledTimes(1);
    });
  });
});
