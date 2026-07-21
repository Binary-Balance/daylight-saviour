import {
  activateAustralianTimeZoneDataPack,
  decideCivilTime,
} from '@daylight-saviour/domain';
import { bundledAustralianDataPack } from '@daylight-saviour/time-zone-data';

import { createStatusViewModel } from './status-view-model';

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
});
