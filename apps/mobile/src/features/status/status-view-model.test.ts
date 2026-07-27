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

  it('reopens exact upcoming and recent past reminder events', () => {
    const pack = activateAustralianTimeZoneDataPack(bundledAustralianDataPack);
    const tap = {
      changeDirection: 'forward' as const,
      changeEventAt: '2026-10-03T16:00:00.000Z',
      homeTimeZone: 'Australia/Sydney',
      reminderTiming: 'one-week' as const,
    };
    const upcoming = createStatusViewModel(
      pack,
      'current',
      'Australia/Sydney',
      new Date('2026-09-26T16:00:00.000Z'),
      false,
      'test-installation',
      null,
      tap,
    );
    const past = createStatusViewModel(
      pack,
      'current',
      'Australia/Sydney',
      new Date('2026-10-03T16:00:00.000Z'),
      false,
      'test-installation',
      '2026-10-03T16:00:00.000Z',
      tap,
    );

    expect(upcoming).toMatchObject({
      notificationContext: { kind: 'matched', relation: 'upcoming' },
      phase: 'reminder-week',
    });
    expect(past).toMatchObject({
      notificationContext: { kind: 'matched', relation: 'past' },
      phase: 'aftermath',
    });
  });

  it('keeps current report for changed zones and stale reminder events', () => {
    const pack = activateAustralianTimeZoneDataPack(bundledAustralianDataPack);
    const base = [
      pack,
      'current' as const,
      'Australia/Sydney',
      new Date('2026-09-26T16:00:00.000Z'),
      false,
      'test-installation',
      null,
    ] as const;
    expect(
      createStatusViewModel(...base, {
        changeDirection: 'forward',
        changeEventAt: '2026-10-03T16:00:00.000Z',
        homeTimeZone: 'Australia/Brisbane',
        reminderTiming: 'one-week',
      }),
    ).toMatchObject({ notificationContext: { kind: 'zone-mismatch' } });
    expect(
      createStatusViewModel(...base, {
        changeDirection: 'forward',
        changeEventAt: '2028-10-03T16:00:00.000Z',
        homeTimeZone: 'Australia/Sydney',
        reminderTiming: 'one-week',
      }),
    ).toMatchObject({ notificationContext: { kind: 'stale' } });
  });
});
