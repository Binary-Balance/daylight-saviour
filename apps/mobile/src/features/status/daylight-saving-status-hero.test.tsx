import { act, render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';

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

describe('DaylightSavingStatusHero', () => {
  afterEach(() => {
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
});
