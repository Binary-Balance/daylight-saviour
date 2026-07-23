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
        flexWrap: 'nowrap',
      });
      const clock = screen.getByTestId('clock-value');
      expect(clock.props.children).toBe(expectedClock);
      expect(clock.props.maxFontSizeMultiplier).toBe(1.2);
      expect(ReactNative.StyleSheet.flatten(clock.props.style)).toMatchObject({
        color: palette.ink,
        fontSize: expectedClockSize,
      });

      if (expectedMeridiem === null) {
        expect(screen.queryByTestId('clock-meridiem')).toBeNull();
      } else {
        const meridiem = screen.getByTestId('clock-meridiem');
        expect(meridiem.props.children).toBe(expectedMeridiem);
        expect(meridiem.props.maxFontSizeMultiplier).toBe(1.2);
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
});
