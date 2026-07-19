import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  activateTimeZoneDataPack,
  TimeZoneDataPackValidationError,
} from '../src/index.ts';

const validPack = {
  coverage: {
    startsAt: '2025-01-01T00:00:00.000Z',
    validUntil: '2027-01-01T00:00:00.000Z',
  },
  generatedAt: '2026-07-19T06:09:07.000Z',
  packVersion: '2026c-test-pack',
  schemaVersion: 1,
  source: {
    name: 'IANA Time Zone Database',
    rulesFile: 'australasia',
    version: '2026c',
    versionUrl: 'https://data.iana.org/time-zones/releases/tzdata2026c.tar.gz',
  },
  zones: [
    {
      friendlyLabel: 'Sydney, Canberra & most of NSW',
      id: 'Australia/Sydney',
      initial: {
        abbreviation: 'AEDT',
        daylightSaving: true,
        utcOffsetSeconds: 39_600,
      },
      transitions: [
        {
          abbreviation: 'AEST',
          at: '2025-04-05T16:00:00.000Z',
          daylightSaving: false,
          offsetBeforeSeconds: 39_600,
          utcOffsetSeconds: 36_000,
        },
      ],
    },
  ],
};

function clonePack() {
  return structuredClone(validPack);
}

describe('activateTimeZoneDataPack', () => {
  it('activates and freezes valid content', () => {
    const pack = activateTimeZoneDataPack(clonePack());

    assert.equal(pack.zones[0].id, 'Australia/Sydney');
    assert.equal(Object.isFrozen(pack), true);
    assert.equal(Object.isFrozen(pack.zones[0].transitions), true);
  });

  for (const [name, mutate] of [
    ['unknown fields', (pack) => (pack.surprise = true)],
    ['unsupported schema', (pack) => (pack.schemaVersion = 2)],
    ['invalid instants', (pack) => (pack.coverage.startsAt = '2025-01-01')],
    [
      'invalid offsets',
      (pack) => (pack.zones[0].initial.utcOffsetSeconds = 100_000),
    ],
    [
      'discontinuous transitions',
      (pack) => (pack.zones[0].transitions[0].offsetBeforeSeconds = 36_000),
    ],
    [
      'unordered transitions',
      (pack) => (pack.zones[0].transitions[0].at = pack.coverage.startsAt),
    ],
    [
      'transitions beyond the Validity Horizon',
      (pack) => (pack.zones[0].transitions[0].at = '2028-01-01T00:00:00.000Z'),
    ],
    [
      'wrong coverage bounds',
      (pack) => (pack.coverage.validUntil = pack.coverage.startsAt),
    ],
    ['inconsistent labels', (pack) => (pack.zones[0].friendlyLabel = 'Sydney')],
  ]) {
    it(`rejects ${name}`, () => {
      const pack = clonePack();
      mutate(pack);

      assert.throws(
        () => activateTimeZoneDataPack(pack),
        TimeZoneDataPackValidationError,
      );
    });
  }
});
