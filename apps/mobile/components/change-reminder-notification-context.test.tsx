import { render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import { StyleSheet } from 'react-native';

import { daylightSaviourPalettes } from '../src/theme';
import ChangeReminderNotificationContext from './change-reminder-notification-context';

const passedLabel =
  "REMINDER EVENT PASSED. This reminder's Change Event passed 48 hours ago or more. Current Civil Time Report details are shown instead.";

function Notice({ reducedMotion }: { readonly reducedMotion: boolean | null }) {
  // A fresh context object on every render, as the status view model makes
  // one each second.
  return (
    <ChangeReminderNotificationContext
      context={{ kind: 'aged-out' }}
      palette={daylightSaviourPalettes.light}
      reducedMotion={reducedMotion}
    />
  );
}

function glowOpacity() {
  return StyleSheet.flatten(
    screen.getByTestId('reminder-notice-glow', { includeHiddenElements: true })
      .props.style,
  ).opacity;
}

let timing: jest.SpiedFunction<typeof ReactNative.Animated.timing>;
let announce: jest.SpiedFunction<
  typeof ReactNative.AccessibilityInfo.announceForAccessibility
>;

beforeEach(() => {
  timing = jest.spyOn(ReactNative.Animated, 'timing');
  announce = jest.spyOn(
    ReactNative.AccessibilityInfo,
    'announceForAccessibility',
  );
  // React Native's Jest setup shares one mock across tests.
  announce.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('renders nothing without a reminder tap', () => {
  const { toJSON } = render(
    <ChangeReminderNotificationContext
      context={null}
      palette={daylightSaviourPalettes.light}
      reducedMotion={false}
    />,
  );

  expect(toJSON()).toBeNull();
  expect(announce).not.toHaveBeenCalled();
});

it('glows once as it appears and settles within two seconds', () => {
  const { rerender } = render(<Notice reducedMotion={false} />);
  rerender(<Notice reducedMotion={false} />);
  rerender(<Notice reducedMotion={false} />);

  expect(timing).toHaveBeenCalledTimes(1);
  const [, config] = timing.mock.calls[0]!;
  expect(config).toMatchObject({ toValue: 0, useNativeDriver: true });
  const settlesAfter = (config.delay ?? 0) + (config.duration ?? 0);
  expect(settlesAfter).toBeGreaterThanOrEqual(1000);
  expect(settlesAfter).toBeLessThanOrEqual(2000);
  expect(glowOpacity()).toBe(1);
  expect(
    screen.getByTestId('reminder-notice-glow', { includeHiddenElements: true })
      .props.accessibilityElementsHidden,
  ).toBe(true);
});

it('waits for the reduced-motion preference before glowing', () => {
  const { rerender } = render(<Notice reducedMotion={null} />);
  expect(timing).not.toHaveBeenCalled();
  expect(glowOpacity()).toBe(0);

  rerender(<Notice reducedMotion={false} />);
  rerender(<Notice reducedMotion={true} />);
  rerender(<Notice reducedMotion={false} />);

  expect(timing).toHaveBeenCalledTimes(1);
});

it.each([true, null])(
  'does not glow when reduced motion is %s',
  (reducedMotion) => {
    render(<Notice reducedMotion={reducedMotion} />);

    expect(timing).not.toHaveBeenCalled();
    expect(glowOpacity()).toBe(0);
    expect(screen.getByRole('alert', { name: passedLabel })).toBeTruthy();
  },
);

it('announces the notice once when it appears', () => {
  const { rerender } = render(<Notice reducedMotion={true} />);
  rerender(<Notice reducedMotion={true} />);

  expect(announce.mock.calls).toEqual([[passedLabel]]);
});
