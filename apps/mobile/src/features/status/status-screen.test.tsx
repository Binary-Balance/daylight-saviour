import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import {
  activateAustralianTimeZoneDataPack,
  decideCivilTime,
} from '@daylight-saviour/domain';
import { bundledAustralianDataPack } from '@daylight-saviour/time-zone-data';

import { daylightSaviourPalettes } from '../../theme';
import { createStatusViewModel } from './status-view-model';
import StatusScreen from './status-screen';

const initialWindowDimensions = ReactNative.Dimensions.get('window');
const initialScreenDimensions = ReactNative.Dimensions.get('screen');

type RenderNode = {
  readonly children?: readonly (RenderNode | string)[];
  readonly props?: {
    readonly accessibilityElementsHidden?: boolean;
    readonly accessibilityLabel?: string;
    readonly accessibilityRole?: string;
  };
};

function explicitAccessibilityOrder(node: RenderNode | string | null) {
  const order: string[] = [];
  function visit(current: RenderNode | string) {
    if (
      typeof current === 'string' ||
      current.props?.accessibilityElementsHidden
    )
      return;
    const label = current.props?.accessibilityLabel;
    if (label !== undefined) order.push(label);
    else if (current.props?.accessibilityRole === 'header') {
      const text = current.children?.filter(
        (child): child is string => typeof child === 'string',
      );
      if (text?.length) order.push(text.join(''));
    }
    current.children?.forEach(visit);
  }
  if (node !== null) visit(node);
  return order;
}

describe('StatusScreen', () => {
  afterEach(() => {
    act(() => {
      ReactNative.Dimensions.set({
        screen: initialScreenDimensions,
        window: initialWindowDimensions,
      });
    });
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each(['light', 'dark'] as const)(
    'renders deterministic Sydney status and event facts in %s appearance',
    (appearance) => {
      jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(appearance);
      const now = new Date('2026-04-04T15:59:59.000Z');

      render(<StatusScreen now={now} reducedMotion />);

      expect(
        screen.getByRole('header', {
          name: 'Daylight saving time applies',
        }),
      ).toBeTruthy();
      expect(
        screen.getByLabelText(
          'Home Time Zone, Sydney, Canberra & most of NSW, Australia/Sydney',
        ),
      ).toBeTruthy();
      expect(screen.getByRole('header', { name: '5 April 2026' })).toBeTruthy();
      expect(screen.getByText('Backward Change')).toBeTruthy();
      expect(screen.getByText('3:00 am → 2:00 am')).toBeTruthy();
      expect(screen.getByText('UTC+11:00 → UTC+10:00')).toBeTruthy();
      expect(screen.getByText('In 1 second')).toBeTruthy();
      expect(
        ReactNative.StyleSheet.flatten(
          screen.getByRole('header', {
            name: 'Daylight saving time applies',
          }).props.style,
        ).color,
      ).toBe(daylightSaviourPalettes[appearance].ink);
    },
  );

  it.each([
    ['light', 430, false, '10:17', 'pm', '2:00 am → 3:00 am', 95.5],
    ['light', 430, true, '22:17', null, '02:00 → 03:00', 95.5],
    ['dark', 430, false, '10:17', 'pm', '2:00 am → 3:00 am', 95.5],
    ['dark', 430, true, '22:17', null, '02:00 → 03:00', 95.5],
    ['light', 320, false, '10:17', 'pm', '2:00 am → 3:00 am', 72],
    ['light', 320, true, '22:17', null, '02:00 → 03:00', 72],
    ['dark', 320, false, '10:17', 'pm', '2:00 am → 3:00 am', 72],
    ['dark', 320, true, '22:17', null, '02:00 → 03:00', 72],
  ] as const)(
    'keeps %s %ipx %s-hour clock as one responsive unit',
    (
      appearance,
      width,
      uses24hourClock,
      expectedClock,
      expectedMeridiem,
      expectedEventChange,
      expectedClockSize,
    ) => {
      jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(appearance);
      ReactNative.Dimensions.set({
        screen: { fontScale: 1, height: 789, scale: 1, width },
        window: { fontScale: 1, height: 789, scale: 1, width },
      });

      render(
        <StatusScreen
          now={new Date('2026-07-19T12:17:00.000Z')}
          reducedMotion
          uses24hourClock={uses24hourClock}
        />,
      );

      const clockLineStyle = ReactNative.StyleSheet.flatten(
        screen.getByTestId('clock-line').props.style,
      );
      const clock = screen.getByTestId('clock-value');
      const clockStyle = ReactNative.StyleSheet.flatten(clock.props.style);
      expect(clockLineStyle).toMatchObject({
        alignItems: 'baseline',
        flexDirection: 'row',
        flexWrap: 'nowrap',
      });
      expect(clock.props.children).toBe(expectedClock);
      expect(clock.props.maxFontSizeMultiplier).toBe(1.2);
      expect(clockStyle.fontSize).toBe(expectedClockSize);
      expect(clockStyle.color).toBe(daylightSaviourPalettes[appearance].ink);
      expect(screen.getByText(expectedEventChange)).toBeTruthy();

      if (expectedMeridiem === null) {
        expect(screen.queryByTestId('clock-meridiem')).toBeNull();
      } else {
        const meridiem = screen.getByTestId('clock-meridiem');
        expect(meridiem.props.children).toBe(expectedMeridiem);
        expect(meridiem.props.maxFontSizeMultiplier).toBe(1.2);
        expect(
          ReactNative.StyleSheet.flatten(meridiem.props.style),
        ).toMatchObject({
          color: daylightSaviourPalettes[appearance].ink,
          fontSize: expectedClockSize * 0.3,
        });
      }

      const accessibleClock = uses24hourClock ? '22:17' : '10:17 pm';
      expect(
        screen.getByLabelText(
          `Home Time Zone current time, ${accessibleClock}, AEST, UTC+10:00`,
        ),
      ).toBeTruthy();
    },
  );

  it('agrees with domain-derived app output and uses bundled data offline', () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const now = new Date('2026-07-19T00:00:00.000Z');
    const viewModel = createStatusViewModel('Australia/Sydney', now);
    const domainDecision = decideCivilTime(
      activateAustralianTimeZoneDataPack(bundledAustralianDataPack),
      'Australia/Sydney',
      now,
    );

    expect(viewModel.availability).toBe('ready');
    if (viewModel.availability !== 'ready') {
      throw new Error('Expected ready status');
    }
    expect(viewModel.status).toBe(domainDecision.daylightSavingStatus);
    expect(viewModel.event?.direction).toBe(
      domainDecision.nextChangeEvent?.direction,
    );
    expect(viewModel.event?.offsetChange).toBe('UTC+10:00 → UTC+11:00');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not start a live clock when an explicit instant is supplied', () => {
    const intervalSpy = jest.spyOn(globalThis, 'setInterval');

    render(
      <StatusScreen now={new Date('2026-07-19T00:00:00.000Z')} reducedMotion />,
    );

    expect(intervalSpy).not.toHaveBeenCalled();
    const clockFacts = screen.getByLabelText(
      'Home Time Zone current time, 10:00 am, AEST, UTC+10:00',
    );
    expect(clockFacts.props.accessibilityLiveRegion).toBe('none');
  });

  it('updates status atomically while production screen remains mounted', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-04T15:59:59.000Z'));

    render(<StatusScreen reducedMotion />);

    expect(
      screen.getByRole('header', { name: 'Daylight saving time applies' }),
    ).toBeTruthy();
    expect(screen.getByText('Backward Change')).toBeTruthy();

    act(() => jest.advanceTimersByTime(1_000));

    expect(
      screen.getByRole('header', { name: 'Standard time applies' }),
    ).toBeTruthy();
    expect(screen.getByText('Backward Change')).toBeTruthy();
    expect(
      screen.getByText('CHANGE RECORDED', { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(screen.getByText('Applied now')).toBeTruthy();
    expect(screen.queryByText('Forward Change')).toBeNull();
  });

  it('suppresses civil-time claims after the Validity Horizon', () => {
    render(
      <StatusScreen now={new Date('2031-01-01T00:00:00.000Z')} reducedMotion />,
    );

    expect(
      screen.getByRole('header', {
        name: 'Civil-time decision unavailable',
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/time applies$/)).toBeNull();
    expect(screen.queryByText(/UTC\+\d/)).toBeNull();
    expect(screen.queryByText(/Civil time may/)).toBeNull();
    expect(screen.getByTestId('expired-dossier')).toBeTruthy();
    expect(screen.queryByTestId('no-event-dossier')).toBeNull();
    expect(screen.getByLabelText(/validity expired/)).toBeTruthy();
  });

  it('does not misreport non-expiry decision failures as expired data', () => {
    render(
      <StatusScreen
        now={new Date('2026-07-19T00:00:00.000Z')}
        reducedMotion
        zoneId="Europe/London"
      />,
    );

    expect(screen.getByTestId('unavailable-dossier')).toBeTruthy();
    expect(screen.getByText('DECISION UNAVAILABLE')).toBeTruthy();
    expect(screen.getByText(/Home Time Zone is not supported/)).toBeTruthy();
    expect(screen.getByLabelText(/freshness not determined/)).toBeTruthy();
    expect(screen.queryByText('Validity Horizon passed')).toBeNull();
    expect(screen.queryByLabelText(/validity expired/)).toBeNull();
  });

  it.each(['light', 'dark'] as const)(
    'renders intentional no-event state in %s appearance',
    (appearance) => {
      jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(appearance);

      render(
        <StatusScreen
          now={new Date('2026-07-19T00:00:00.000Z')}
          reducedMotion
          zoneId="Australia/Brisbane"
        />,
      );

      expect(
        screen.getByRole('header', { name: 'Standard time applies' }),
      ).toBeTruthy();
      expect(screen.getByText(/AEST · UTC\+10:00/)).toBeTruthy();
      expect(
        screen.getByRole('header', {
          name: 'No Change Event scheduled within verified data',
        }),
      ).toBeTruthy();
      expect(screen.queryByText(/^In /)).toBeNull();
      expect(screen.getByText(/No countdown required/)).toBeTruthy();
      expect(screen.getByTestId('no-event-dossier')).toBeTruthy();
      expect(screen.queryByTestId('expired-dossier')).toBeNull();
      expect(screen.getByLabelText(/bundled data current/)).toBeTruthy();
    },
  );

  it('renders an external Antarctic territory without guessing by offset', () => {
    render(
      <StatusScreen
        now={new Date('2026-07-19T00:00:00.000Z')}
        reducedMotion
        zoneId="Antarctica/Casey"
      />,
    );

    expect(
      screen.getByLabelText(
        'Home Time Zone, Casey Station, Australian Antarctic Territory, Antarctica/Casey',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/\+08 · UTC\+08:00/)).toBeTruthy();
  });

  it.each([
    ['2026-09-05T15:59:59.000Z', 'ordinary-dossier', 'ON FILE'],
    ['2026-09-05T16:00:00.000Z', 'approaching-dossier', 'APPROACHING'],
    ['2026-09-26T16:00:00.000Z', 'reminder-week-dossier', 'REMINDER WEEK'],
    ['2026-10-02T16:00:00.000Z', 'reminder-day-dossier', 'REMINDER DAY'],
    ['2026-10-03T16:00:00.000Z', 'aftermath-dossier', 'CHANGE RECORDED'],
    ['2026-10-05T16:00:00.000Z', 'ordinary-dossier', 'ON FILE'],
  ] as const)(
    'renders deterministic phase at %s',
    (instant, dossierTestId, phaseLabel) => {
      render(
        <StatusScreen
          now={new Date(instant)}
          reducedMotion
          zoneId="Australia/Sydney"
        />,
      );

      expect(screen.getByTestId(dossierTestId)).toBeTruthy();
      expect(
        screen.getByText(phaseLabel, { includeHiddenElements: true }),
      ).toBeTruthy();
      expect(screen.queryByText(/underway/i)).toBeNull();
    },
  );

  it('uses directional one-shot motion and removes displacement for reduced motion', () => {
    const loopSpy = jest.spyOn(ReactNative.Animated, 'loop');
    const backward = render(
      <StatusScreen
        now={new Date('2026-04-04T15:59:59.000Z')}
        reducedMotion={false}
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
      <StatusScreen now={new Date('2026-10-02T16:00:00.000Z')} reducedMotion />,
    );
    expect(screen.getByTestId('motion-short-fade')).toBeTruthy();
    expect(screen.getByText('Forward Change')).toBeTruthy();
    expect(screen.getByText('2:00 am → 3:00 am')).toBeTruthy();
    expect(screen.queryAllByText('2:00 am → 3:00 am')).toHaveLength(1);
    expect(loopSpy).not.toHaveBeenCalled();
  });

  it('waits for async reduced-motion preference before choosing a motion recipe', async () => {
    let resolvePreference: ((enabled: boolean) => void) | undefined;
    jest
      .spyOn(ReactNative.AccessibilityInfo, 'isReduceMotionEnabled')
      .mockReturnValue(
        new Promise<boolean>((resolve) => {
          resolvePreference = resolve;
        }),
      );
    const timingSpy = jest.spyOn(ReactNative.Animated, 'timing');

    render(<StatusScreen now={new Date('2026-04-04T15:59:59.000Z')} />);

    expect(screen.getByTestId('motion-awaiting-preference')).toBeTruthy();
    expect(timingSpy).not.toHaveBeenCalled();
    expect(
      screen.getByTestId('semantic-event-content').props.style.opacity,
    ).toBe(1);
    expect(
      screen.getAllByText('3:00 am → 2:00 am', {
        includeHiddenElements: true,
      }),
    ).toHaveLength(1);

    await act(async () => resolvePreference?.(true));

    expect(screen.getByTestId('motion-short-fade')).toBeTruthy();
    expect(
      screen.getAllByText('3:00 am → 2:00 am', {
        includeHiddenElements: true,
      }),
    ).toHaveLength(1);
    const content = screen.getByTestId('semantic-event-content');
    expect(content.props.style.transform[0].translateX).toBe(0);
  });

  it('keeps event facts visible when reduced-motion lookup rejects', async () => {
    jest
      .spyOn(ReactNative.AccessibilityInfo, 'isReduceMotionEnabled')
      .mockRejectedValue(new Error('preference unavailable'));

    render(<StatusScreen now={new Date('2026-04-04T15:59:59.000Z')} />);
    await act(async () => undefined);

    expect(screen.getByTestId('motion-short-fade')).toBeTruthy();
    expect(screen.getByText('Backward Change')).toBeTruthy();
    expect(screen.getByText('3:00 am → 2:00 am')).toBeTruthy();
    expect(
      screen.getAllByText('3:00 am → 2:00 am', {
        includeHiddenElements: true,
      }),
    ).toHaveLength(1);
    expect(
      screen.getByTestId('semantic-event-content').props.style.transform[0]
        .translateX,
    ).toBe(0);
  });

  it('themes the decorative Backward echo in dark appearance', () => {
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue('dark');
    render(
      <StatusScreen
        now={new Date('2026-04-04T15:59:59.000Z')}
        reducedMotion={false}
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

  it('acknowledges first aftermath opening and skips it on repeat opening', () => {
    const acknowledge = jest.fn();
    const first = render(
      <StatusScreen
        now={new Date('2026-10-03T17:00:00.000Z')}
        onAcknowledgeAftermath={acknowledge}
        reducedMotion
      />,
    );
    expect(screen.getByTestId('aftermath-dossier')).toBeTruthy();
    expect(acknowledge).toHaveBeenCalledWith('2026-10-03T16:00:00.000Z');

    first.unmount();
    render(
      <StatusScreen
        acknowledgedEventAt="2026-10-03T16:00:00.000Z"
        now={new Date('2026-10-03T17:00:00.000Z')}
        onAcknowledgeAftermath={acknowledge}
        reducedMotion
      />,
    );
    expect(screen.getByTestId('ordinary-dossier')).toBeTruthy();
    expect(screen.queryByTestId('aftermath-dossier')).toBeNull();
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it('renders Lord Howe 30-minute Forward Change and absolute countdown', () => {
    render(
      <StatusScreen
        now={new Date('2026-10-02T15:30:00.000Z')}
        reducedMotion
        zoneId="Australia/Lord_Howe"
      />,
    );

    expect(screen.getByText('Forward Change')).toBeTruthy();
    expect(screen.getByText('2:00 am → 2:30 am')).toBeTruthy();
    expect(screen.getByText('UTC+10:30 → UTC+11:00')).toBeTruthy();
    expect(screen.getByText(/Clocks move 30 minutes/)).toBeTruthy();
    expect(screen.getByText('In 1 day')).toBeTruthy();
  });

  it('opens a bounded settings sheet from a real accessible control', () => {
    render(
      <StatusScreen now={new Date('2026-07-19T00:00:00.000Z')} reducedMotion />,
    );

    fireEvent.press(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('header', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByText(/Home Time Zone: Sydney/)).toBeTruthy();
    expect(screen.queryByText(/not available|version|arrive/i)).toBeNull();
    expect(
      screen.getByTestId('settings-modal-safe-area').props.edges,
    ).toMatchObject({ bottom: 'additive', top: 'off' });
    fireEvent.press(screen.getByRole('button', { name: 'Close settings' }));
    expect(screen.queryByRole('header', { name: 'Settings' })).toBeNull();
  });

  it('orders explicit semantics from zone through freshness before visual-header settings', () => {
    const result = render(
      <StatusScreen
        now={new Date('2026-10-02T16:00:00.000Z')}
        onChooseZone={jest.fn()}
        reducedMotion
      />,
    );
    const order = explicitAccessibilityOrder(result.toJSON() as RenderNode);
    const positions = [
      order.findIndex((label) => label.startsWith('Home Time Zone,')),
      order.findIndex((label) =>
        label.startsWith('Home Time Zone current time,'),
      ),
      order.indexOf('Standard time applies'),
      order.indexOf('4 October 2026'),
      order.indexOf('COUNTDOWN'),
      order.findIndex((label) => label.startsWith('Time-Zone Data Pack')),
      order.indexOf('Settings'),
    ];

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right),
    );
  });
});
