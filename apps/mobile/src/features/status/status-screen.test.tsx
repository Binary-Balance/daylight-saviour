import { act, render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import {
  activateAustralianTimeZoneDataPack,
  decideCivilTime,
} from '@daylight-saviour/domain';
import { bundledAustralianDataPack } from '@daylight-saviour/time-zone-data';

import { createStatusViewModel } from './status-view-model';
import StatusScreen from './status-screen';

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

      render(<StatusScreen now={now} />);

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

    render(<StatusScreen now={new Date('2026-07-19T00:00:00.000Z')} />);

    expect(intervalSpy).not.toHaveBeenCalled();
  });

  it('updates status atomically while production screen remains mounted', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-04T15:59:59.000Z'));

    render(<StatusScreen />);

    expect(
      screen.getByRole('header', { name: 'Daylight saving time applies' }),
    ).toBeTruthy();
    expect(screen.getByText('Backward Change')).toBeTruthy();

    act(() => jest.advanceTimersByTime(1_000));

    expect(
      screen.getByRole('header', { name: 'Standard time applies' }),
    ).toBeTruthy();
    expect(screen.getByText('Forward Change')).toBeTruthy();
  });

  it('suppresses civil-time claims after the Validity Horizon', () => {
    render(<StatusScreen now={new Date('2031-01-01T00:00:00.000Z')} />);

    expect(
      screen.getByRole('header', {
        name: 'Civil-time decision unavailable',
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/time applies$/)).toBeNull();
    expect(screen.queryByText(/UTC\+\d/)).toBeNull();
  });

  it.each(['light', 'dark'] as const)(
    'renders intentional no-event state in %s appearance',
    (appearance) => {
      jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(appearance);

      render(
        <StatusScreen
          now={new Date('2026-07-19T00:00:00.000Z')}
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
    },
  );

  it('renders an external Antarctic territory without guessing by offset', () => {
    render(
      <StatusScreen
        now={new Date('2026-07-19T00:00:00.000Z')}
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
});
