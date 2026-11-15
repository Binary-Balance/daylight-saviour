import { act, render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import { holdAnimations } from '../../../test-support/hold-animations';
import { daylightSaviourPalettes } from '../../theme';
import DaylightSavingStatusHero, {
  type DaylightSavingStatusHeroFacts,
} from './daylight-saving-status-hero';

const facts: DaylightSavingStatusHeroFacts = {
  abbreviation: 'AEST',
  clock: '10:17 pm',
  currentOffset: 'UTC+10:00',
  phaseLabel: 'NO CHANGE IMMINENT',
  secondaryLine: 'Test secondary line.',
  status: 'Standard time applies',
};
const initialWindowDimensions = ReactNative.Dimensions.get('window');
const initialScreenDimensions = ReactNative.Dimensions.get('screen');

// The clock is announced as one label, so none of its parts may be a separate
// stop for a screen reader.
function expectClockPartsGrouped() {
  const parts = [
    screen.getByTestId('clock-line'),
    screen.getByTestId('clock-value'),
    screen.queryByTestId('clock-overflow'),
    screen.queryByTestId('clock-meridiem'),
    screen.getByText(/^AEST · UTC\+10:00 · /),
  ];
  for (const part of parts) {
    if (part !== null) expect(part.props.accessible).toBe(false);
  }
}

describe('DaylightSavingStatusHero', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    act(() => {
      ReactNative.Dimensions.set({
        screen: initialScreenDimensions,
        window: initialWindowDimensions,
      });
    });
  });

  it.each([
    ['light', 430, false, '10:17', 'pm', 95.5],
    ['light', 430, true, '22:17', null, 95.5],
    ['dark', 430, false, '10:17', 'pm', 95.5],
    ['dark', 430, true, '22:17', null, 95.5],
    ['light', 320, false, '10:17', 'pm', 72],
    ['light', 320, true, '22:17', null, 72],
    ['dark', 320, false, '10:17', 'pm', 72],
    ['dark', 320, true, '22:17', null, 72],
  ] as const)(
    'keeps %s %ipx %s-hour clock as one responsive unit',
    (
      appearance,
      width,
      uses24hourClock,
      expectedClock,
      expectedMeridiem,
      expectedClockSize,
    ) => {
      ReactNative.Dimensions.set({
        screen: { fontScale: 1, height: 789, scale: 1, width },
        window: { fontScale: 1, height: 789, scale: 1, width },
      });
      const palette = daylightSaviourPalettes[appearance];

      render(
        <DaylightSavingStatusHero
          facts={{
            ...facts,
            clock: uses24hourClock ? '22:17' : facts.clock,
          }}
          palette={palette}
          uses24hourClock={uses24hourClock}
        />,
      );

      expect(
        ReactNative.StyleSheet.flatten(
          screen.getByTestId('clock-line').props.style,
        ),
      ).toMatchObject({
        alignItems: 'baseline',
        flexDirection: 'row',
        flexWrap: 'wrap',
      });
      const clock = screen.getByTestId('clock-value');
      expect(clock.props.children).toBe(expectedClock);
      expect(ReactNative.StyleSheet.flatten(clock.props.style)).toMatchObject({
        color: palette.ink,
        fontSize: expectedClockSize,
      });
      expect(
        ReactNative.StyleSheet.flatten(clock.props.style).lineHeight,
      ).toBeCloseTo(expectedClockSize * 1.05);
      expectClockPartsGrouped();

      if (expectedMeridiem === null) {
        expect(screen.queryByTestId('clock-meridiem')).toBeNull();
      } else {
        const meridiem = screen.getByTestId('clock-meridiem');
        expect(meridiem.props.children).toBe(expectedMeridiem);
        expect(
          ReactNative.StyleSheet.flatten(meridiem.props.style),
        ).toMatchObject({
          color: palette.ink,
          fontSize: expectedClockSize * 0.3,
        });
        expect(
          ReactNative.StyleSheet.flatten(meridiem.props.style).lineHeight,
        ).toBeCloseTo(expectedClockSize * 0.42);
      }

      expect(
        screen.getByLabelText(
          `Home Time Zone current time, ${uses24hourClock ? '22:17' : '10:17 pm'}, AEST, UTC+10:00`,
        ),
      ).toBeTruthy();
      expect(
        screen.getByRole('header', { name: 'Standard time applies' }),
      ).toBeTruthy();
      expect(
        screen.getByText('NO CHANGE IMMINENT', {
          includeHiddenElements: true,
        }),
      ).toBeTruthy();
      expect(
        ReactNative.StyleSheet.flatten(
          screen.getByTestId('phase-stamp', {
            includeHiddenElements: true,
          }).props.style,
        ).transform,
      ).toEqual([{ rotate: '-3deg' }]);
      expect(
        ReactNative.StyleSheet.flatten(
          screen.getByTestId('phase-stamp', {
            includeHiddenElements: true,
          }).props.style,
        ).borderColor,
      ).toBe(palette.signalRed);
    },
  );

  it.each([1, 2])(
    'leaves room for the last digit at text scale %d',
    (fontScale) => {
      ReactNative.Dimensions.set({
        screen: { fontScale, height: 789, scale: 1, width: 320 },
        window: { fontScale, height: 789, scale: 1, width: 320 },
      });

      render(
        <DaylightSavingStatusHero
          facts={{ ...facts, clock: '10:16 pm' }}
          palette={daylightSaviourPalettes.light}
          uses24hourClock={false}
        />,
      );

      const { letterSpacing, paddingRight } = ReactNative.StyleSheet.flatten(
        screen.getByTestId('clock-value').props.style,
      );
      expect(letterSpacing).toBeLessThan(0);
      expect(paddingRight).toBe(-letterSpacing);
    },
  );

  it('preserves the literal clock token while stacking it at maximum text scale', () => {
    ReactNative.Dimensions.set({
      screen: { fontScale: 2, height: 789, scale: 1, width: 320 },
      window: { fontScale: 2, height: 789, scale: 1, width: 320 },
    });

    render(
      <DaylightSavingStatusHero
        facts={facts}
        palette={daylightSaviourPalettes.light}
        uses24hourClock={false}
      />,
    );

    const clock = screen.getByTestId('clock-value');
    expect(clock.props.maxFontSizeMultiplier).toBeUndefined();
    expect(clock.props.children).toBe('10:17');
    expect(
      ReactNative.StyleSheet.flatten(
        screen.getByTestId('clock-line').props.style,
      ).flexDirection,
    ).toBe('column');
    const overflow = screen.getByTestId('clock-overflow');
    expect(ReactNative.StyleSheet.flatten(overflow.props.style)).toMatchObject({
      alignSelf: 'stretch',
      // Growing, the default, pushed the rest of the report out of reach.
      flexGrow: 0,
      maxWidth: '100%',
    });
    expect(overflow.props.horizontal).toBe(true);
    expect(
      screen.getByLabelText(/Home Time Zone current time, 10:17 pm/),
    ).toBeTruthy();
    expect(ReactNative.StyleSheet.flatten(clock.props.style).fontSize).toBe(72);
    expect(
      ReactNative.StyleSheet.flatten(clock.props.style).fontSize * 2,
    ).toBeGreaterThan(72);
    expect(
      ReactNative.StyleSheet.flatten(clock.props.style).lineHeight,
    ).toBeCloseTo(72 * 1.05);
    expectClockPartsGrouped();
  });

  it.each([
    [1.49, 'row'],
    [1.5, 'column'],
    [2, 'column'],
  ] as const)(
    'at font scale %s lays the clock out in a %s',
    (fontScale, layout) => {
      ReactNative.Dimensions.set({
        screen: { fontScale, height: 789, scale: 1, width: 430 },
        window: { fontScale, height: 789, scale: 1, width: 430 },
      });

      render(
        <DaylightSavingStatusHero
          facts={facts}
          palette={daylightSaviourPalettes.light}
          uses24hourClock={false}
        />,
      );

      expect(
        ReactNative.StyleSheet.flatten(
          screen.getByTestId('clock-line').props.style,
        ).flexDirection,
      ).toBe(layout);
      expect(screen.queryByTestId('clock-overflow') !== null).toBe(
        layout === 'column',
      );
    },
  );

  it('leaves the status wrapper out of the accessibility tree', () => {
    render(
      <DaylightSavingStatusHero
        facts={facts}
        palette={daylightSaviourPalettes.light}
        reducedMotion
        uses24hourClock={false}
      />,
    );

    // Otherwise TalkBack reads the wrapper, and the status is not a heading.
    expect(
      screen.getByTestId('status-motion-short-fade').props
        .importantForAccessibility,
    ).toBe('no');
  });

  it.each([
    [false, 180, 'status-motion-lock-in'],
    [true, 90, 'status-motion-short-fade'],
  ] as const)(
    'cleans previous status after %s-motion lock-in completion',
    (reducedMotion, duration, motionTestId) => {
      const timingSpy = jest
        .spyOn(ReactNative.Animated, 'timing')
        .mockImplementation(((
          value: { setValue: (nextValue: number) => void },
          config: { duration?: number; toValue: number },
        ) => ({
          start: (callback?: (result: { finished: boolean }) => void) => {
            value.setValue(config.toValue);
            callback?.({ finished: true });
          },
          stop: jest.fn(),
        })) as never);
      jest.spyOn(ReactNative.Animated, 'parallel').mockImplementation(((
        animations: {
          start: (callback?: (result: { finished: boolean }) => void) => void;
        }[],
      ) => ({
        start: (callback?: (result: { finished: boolean }) => void) => {
          animations.forEach((animation) => animation.start());
          callback?.({ finished: true });
        },
        stop: jest.fn(),
      })) as never);
      const rendered = render(
        <DaylightSavingStatusHero
          facts={facts}
          palette={daylightSaviourPalettes.light}
          reducedMotion={reducedMotion}
          statusTransitionKey="standard"
          uses24hourClock={false}
        />,
      );

      act(() => {
        rendered.rerender(
          <DaylightSavingStatusHero
            facts={{ ...facts, status: 'Daylight saving time applies' }}
            palette={daylightSaviourPalettes.light}
            reducedMotion={reducedMotion}
            statusTransitionKey="daylight-saving"
            uses24hourClock={false}
          />,
        );
      });

      expect(screen.getByTestId(motionTestId)).toBeTruthy();
      expect(screen.queryByText('Standard time applies')).toBeNull();
      expect(
        screen.getByRole('header', { name: 'Daylight saving time applies' }),
      ).toBeTruthy();
      expect(timingSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(
        timingSpy.mock.calls.filter(
          ([, config]) => config.duration === duration,
        ),
      ).toHaveLength(2);
      expect(
        timingSpy.mock.calls.every(
          ([, config]) => config.toValue === 1 || config.toValue === 0,
        ),
      ).toBe(true);
    },
  );

  describe('status transition', () => {
    const standard = 'Standard time applies';
    const daylight = 'Daylight saving time applies';

    function Hero({
      reducedMotion = false,
      status = standard,
      transitionKey = 'standard',
    }: {
      readonly reducedMotion?: boolean | null;
      readonly status?: DaylightSavingStatusHeroFacts['status'];
      readonly transitionKey?: string;
    }) {
      return (
        <DaylightSavingStatusHero
          facts={{ ...facts, status }}
          palette={daylightSaviourPalettes.light}
          reducedMotion={reducedMotion}
          statusTransitionKey={transitionKey}
          uses24hourClock={false}
        />
      );
    }

    const opacityOf = (node: ReactTestInstance) =>
      ReactNative.StyleSheet.flatten(node.props.style).opacity;
    const hiddenStatus = (status: string) =>
      screen.queryByText(status, { includeHiddenElements: true });

    it.each([
      [false, 0.7, 180],
      [true, 0.85, 90],
    ] as const)(
      'fades the new status in over the one it replaces when reduced motion is %s',
      (reducedMotion, startOpacity, duration) => {
        const held = holdAnimations();
        const timing = jest.spyOn(ReactNative.Animated, 'timing');
        const view = render(<Hero reducedMotion={reducedMotion} />);
        expect(timing).not.toHaveBeenCalled();

        view.rerender(
          <Hero
            reducedMotion={reducedMotion}
            status={daylight}
            transitionKey="daylight"
          />,
        );

        const previous = screen.getByText(standard, {
          includeHiddenElements: true,
        });
        expect(previous.props.accessibilityElementsHidden).toBe(true);
        expect(opacityOf(previous)).toBe(1);
        expect(opacityOf(screen.getByRole('header', { name: daylight }))).toBe(
          startOpacity,
        );
        expect(timing.mock.calls.map(([, config]) => config)).toEqual([
          { duration, toValue: 0, useNativeDriver: true },
          { duration, toValue: 1, useNativeDriver: true },
        ]);
        expect(held).toHaveLength(1);
        expect(held[0]?.started).toBe(true);

        act(() => held[0]?.finish());

        expect(hiddenStatus(standard)).toBeNull();
        expect(screen.getByRole('header', { name: daylight })).toBeTruthy();
      },
    );

    it('fades from the status it last showed', () => {
      const held = holdAnimations();
      const view = render(<Hero />);
      view.rerender(<Hero status={daylight} transitionKey="daylight" />);
      act(() => held[0]?.finish());

      view.rerender(<Hero transitionKey="standard-again" />);

      expect(held).toHaveLength(2);
      expect(hiddenStatus(daylight)?.props.accessibilityElementsHidden).toBe(
        true,
      );
    });

    it('does not replay a transition when only the motion preference changes', () => {
      const held = holdAnimations();
      const view = render(<Hero />);
      view.rerender(<Hero status={daylight} transitionKey="daylight" />);
      act(() => held[0]?.finish());

      view.rerender(
        <Hero reducedMotion status={daylight} transitionKey="daylight" />,
      );

      expect(held).toHaveLength(1);
      expect(hiddenStatus(standard)).toBeNull();
    });

    it('fades when the status returns to the one it started with', () => {
      const held = holdAnimations();
      const view = render(<Hero />);
      view.rerender(<Hero status={daylight} transitionKey="daylight" />);
      act(() => held[0]?.finish());

      view.rerender(<Hero />);

      expect(held).toHaveLength(2);
    });

    it('uses a motion preference that resolved after the first render', () => {
      holdAnimations();
      const view = render(<Hero reducedMotion={null} />);
      view.rerender(<Hero reducedMotion={false} />);

      view.rerender(
        <Hero
          reducedMotion={false}
          status={daylight}
          transitionKey="daylight"
        />,
      );

      expect(opacityOf(screen.getByRole('header', { name: daylight }))).toBe(
        0.7,
      );
    });

    it('uses a motion preference that changes with the status', () => {
      holdAnimations();
      const view = render(<Hero reducedMotion={false} />);

      view.rerender(
        <Hero reducedMotion status={daylight} transitionKey="daylight" />,
      );

      expect(opacityOf(screen.getByRole('header', { name: daylight }))).toBe(
        0.85,
      );
    });

    // Uses the real Animated module, so the opacity read back is the one a
    // user would see.
    it('shows a new status at once while the motion preference is unknown', () => {
      const timing = jest.spyOn(ReactNative.Animated, 'timing');
      const view = render(<Hero reducedMotion={null} />);

      view.rerender(
        <Hero
          reducedMotion={null}
          status={daylight}
          transitionKey="daylight"
        />,
      );

      expect(opacityOf(screen.getByRole('header', { name: daylight }))).toBe(1);
      expect(hiddenStatus(standard)).toBeNull();

      view.rerender(
        <Hero
          reducedMotion={false}
          status={daylight}
          transitionKey="daylight"
        />,
      );

      expect(screen.getByRole('header', { name: daylight })).toBeTruthy();
      expect(hiddenStatus(standard)).toBeNull();
      expect(timing).not.toHaveBeenCalled();
    });

    it.each([
      [false, true],
      [true, false],
      [false, null],
    ] as const)(
      'lets a crossfade finish when reduced motion changes from %s to %s',
      (before, after) => {
        const held = holdAnimations();
        const view = render(<Hero reducedMotion={before} />);
        view.rerender(
          <Hero
            reducedMotion={before}
            status={daylight}
            transitionKey="daylight"
          />,
        );

        view.rerender(
          <Hero
            reducedMotion={after}
            status={daylight}
            transitionKey="daylight"
          />,
        );

        expect(held).toHaveLength(1);
        expect(held[0]?.stop).not.toHaveBeenCalled();
        act(() => held[0]?.finish());
        expect(hiddenStatus(standard)).toBeNull();
      },
    );

    it('stops a crossfade in flight when it unmounts', () => {
      const held = holdAnimations();
      const view = render(<Hero />);
      view.rerender(<Hero status={daylight} transitionKey="daylight" />);
      expect(held[0]?.stop).not.toHaveBeenCalled();

      view.unmount();

      expect(held[0]?.stop).toHaveBeenCalledTimes(1);
    });
  });
});
