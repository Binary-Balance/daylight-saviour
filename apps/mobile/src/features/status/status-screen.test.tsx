import { act, render, screen } from '@testing-library/react-native';
import type { ComponentProps } from 'react';
import * as ReactNative from 'react-native';
import { activateAustralianTimeZoneDataPack } from '@daylight-saviour/domain';
import { bundledAustralianDataPack } from '@daylight-saviour/time-zone-data';

import { daylightSaviourPalettes } from '../../theme';
import RawStatusScreen from './status-screen';

jest.mock('../change-reminders/change-reminder-production-adapters', () => ({
  productionChangeReminderAdapters: {
    enable: jest.fn(),
    load: jest.fn(() => new Promise(() => undefined)),
    openSettings: jest.fn(),
  },
}));

const bundledSnapshot = {
  freshness: 'current',
  lastCheckedAt: null,
  lastError: null,
  pack: activateAustralianTimeZoneDataPack(bundledAustralianDataPack),
  remoteEnabled: false,
  source: 'bundled',
} as const;

function StatusScreen(
  props: Omit<
    ComponentProps<typeof RawStatusScreen>,
    'dataPackSnapshot' | 'secondaryCopySeed'
  >,
) {
  return (
    <RawStatusScreen
      dataPackSnapshot={bundledSnapshot}
      secondaryCopySeed="test-installation"
      {...props}
    />
  );
}

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

describe('StatusScreen facade', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each(['light', 'dark'] as const)(
    'composes deterministic Sydney report in %s appearance',
    (appearance) => {
      jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(appearance);

      render(
        <StatusScreen
          now={new Date('2026-04-04T15:59:59.000Z')}
          reducedMotion
        />,
      );

      expect(
        screen.getByLabelText(
          'Home Time Zone, Sydney, Canberra & most of NSW, Australia/Sydney',
        ),
      ).toBeTruthy();
      const status = screen.getByRole('header', {
        name: 'Daylight saving time applies',
      });
      expect(status).toBeTruthy();
      expect(ReactNative.StyleSheet.flatten(status.props.style).color).toBe(
        daylightSaviourPalettes[appearance].ink,
      );
      expect(screen.getByRole('header', { name: '5 April 2026' })).toBeTruthy();
      expect(screen.getByText('Backward Change')).toBeTruthy();
      expect(screen.getByText('In 1 second')).toBeTruthy();
      expect(screen.getByLabelText(/bundled data current/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    },
  );

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

  it('updates status atomically while mounted', () => {
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

  it('composes unavailable report without civil-time claims', () => {
    render(
      <StatusScreen now={new Date('2031-01-01T00:00:00.000Z')} reducedMotion />,
    );

    expect(
      screen.getByRole('header', { name: 'Civil-time decision unavailable' }),
    ).toBeTruthy();
    expect(screen.queryByText(/time applies$/)).toBeNull();
    expect(screen.queryByText(/UTC\+\d/)).toBeNull();
    expect(screen.getByTestId('expired-civil-time-report')).toBeTruthy();
    expect(screen.getByLabelText(/validity expired/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
  });

  it.each([
    [
      '2026-09-05T15:59:59.000Z',
      'ordinary-civil-time-report',
      'NO CHANGE IMMINENT',
    ],
    [
      '2026-09-05T16:00:00.000Z',
      'approaching-civil-time-report',
      'CHANGE APPROACHING',
    ],
    [
      '2026-09-26T16:00:00.000Z',
      'reminder-week-civil-time-report',
      'CHANGE WITHIN 7 DAYS',
    ],
    [
      '2026-10-02T16:00:00.000Z',
      'reminder-day-civil-time-report',
      'CHANGE WITHIN 24 HOURS',
    ],
    [
      '2026-10-03T16:00:00.000Z',
      'aftermath-civil-time-report',
      'CHANGE RECORDED',
    ],
    [
      '2026-10-05T16:00:00.000Z',
      'ordinary-civil-time-report',
      'NO CHANGE IMMINENT',
    ],
  ] as const)(
    'composes deterministic phase at %s',
    (instant, reportTestId, phaseLabel) => {
      render(
        <StatusScreen
          now={new Date(instant)}
          reducedMotion
          zoneId="Australia/Sydney"
        />,
      );

      expect(screen.getByTestId(reportTestId)).toBeTruthy();
      expect(
        screen.getByText(phaseLabel, { includeHiddenElements: true }),
      ).toBeTruthy();
      expect(screen.queryByText(/underway/i)).toBeNull();
    },
  );

  it('waits for async reduced-motion preference before composing motion', async () => {
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

    await act(async () => resolvePreference?.(true));

    expect(screen.getByTestId('motion-short-fade')).toBeTruthy();
    expect(
      screen.getAllByText('3:00 am → 2:00 am', {
        includeHiddenElements: true,
      }),
    ).toHaveLength(1);
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
      screen.getByTestId('semantic-event-content').props.style.transform[0]
        .translateX,
    ).toBe(0);
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
    expect(screen.getByTestId('aftermath-civil-time-report')).toBeTruthy();
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
    expect(screen.getByTestId('ordinary-civil-time-report')).toBeTruthy();
    expect(screen.queryByTestId('aftermath-civil-time-report')).toBeNull();
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it('orders zone through freshness before visual-header settings', () => {
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
