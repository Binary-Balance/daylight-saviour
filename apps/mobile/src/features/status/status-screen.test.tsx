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
    [false, '2:59 am', '3:00 am → 2:00 am'],
    [true, '02:59', '03:00 → 02:00'],
  ] as const)(
    'formats current and event times for uses24hourClock=%s',
    (uses24hourClock, expectedClock, expectedChange) => {
      render(
        <StatusScreen
          now={new Date('2026-04-04T15:59:59.000Z')}
          reducedMotion
          uses24hourClock={uses24hourClock}
        />,
      );

      expect(screen.getByText(expectedClock)).toBeTruthy();
      expect(screen.getByText(expectedChange)).toBeTruthy();
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
    expect(screen.queryByText(/reminders enabled/i)).toBeNull();
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
