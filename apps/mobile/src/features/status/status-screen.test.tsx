import { render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import { activateTimeZoneDataPack } from '@daylight-saviour/contracts';
import { decideCivilTime } from '@daylight-saviour/domain';
import { bundledSydneyDataPack } from '@daylight-saviour/time-zone-data';

import { createSydneyStatusViewModel } from './status-view-model';
import StatusScreen from './status-screen';

describe('StatusScreen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
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
    const viewModel = createSydneyStatusViewModel(now);
    const domainDecision = decideCivilTime(
      activateTimeZoneDataPack(bundledSydneyDataPack),
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
});
