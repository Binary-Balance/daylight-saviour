import {
  activateAustralianTimeZoneDataPack,
  decideCivilTime,
} from '@daylight-saviour/domain';
import { bundledAustralianDataPack } from '@daylight-saviour/time-zone-data';

import { createStatusViewModel } from './status-view-model';
import type { TimeZoneDataPackFreshness } from '../time-zone-data/time-zone-data-manager';

describe('createStatusViewModel', () => {
  it('agrees with domain-derived bundled output without network access', () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const now = new Date('2026-07-19T00:00:00.000Z');
    const pack = activateAustralianTimeZoneDataPack(bundledAustralianDataPack);
    const viewModel = createStatusViewModel(
      pack,
      'current',
      'Australia/Sydney',
      now,
      false,
      'test-installation',
    );
    const domainDecision = decideCivilTime(pack, 'Australia/Sydney', now);

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

  it.each([
    'current',
    'checking',
    'stale-valid',
    'offline-valid',
    'retry-failed',
    'expired',
  ] as const)(
    'propagates active pack version while freshness is %s',
    (freshness: TimeZoneDataPackFreshness) => {
      const pack = activateAustralianTimeZoneDataPack({
        ...bundledAustralianDataPack,
        packVersion: '2026c-solar-gold-test',
      });

      expect(
        createStatusViewModel(
          pack,
          freshness,
          'Australia/Sydney',
          new Date('2026-07-19T00:00:00.000Z'),
          false,
          'test-installation',
        ).packVersion,
      ).toBe('2026c-solar-gold-test');
    },
  );

  it('retains active pack version when civil-time decision is unavailable', () => {
    const pack = activateAustralianTimeZoneDataPack({
      ...bundledAustralianDataPack,
      packVersion: '2026c-solar-gold-test',
    });

    const viewModel = createStatusViewModel(
      pack,
      'current',
      'Europe/London',
      new Date('2026-07-19T00:00:00.000Z'),
      false,
      'test-installation',
    );

    expect(viewModel.availability).toBe('unavailable');
    expect(viewModel.packVersion).toBe('2026c-solar-gold-test');
  });
});
