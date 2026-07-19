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
  schemaVersion: 2,
  source: {
    archiveSha256:
      'e4a178a4477f3d0ea77cc31828ff72aa38feff8d61aa13e7e99e142e9d902be4',
    files: ['australasia'],
    name: 'IANA Time Zone Database',
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
    {
      friendlyLabel: 'Brisbane & most of Queensland',
      id: 'Australia/Brisbane',
      initial: {
        abbreviation: 'AEST',
        daylightSaving: false,
        utcOffsetSeconds: 36_000,
      },
      transitions: [],
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

  it('accepts multi-segment canonical IANA identifiers', () => {
    const pack = clonePack();
    pack.zones[0].id = 'America/Argentina/Buenos_Aires';

    assert.equal(
      activateTimeZoneDataPack(pack).zones[0].id,
      'America/Argentina/Buenos_Aires',
    );
  });

  for (const [name, mutate] of [
    ['unknown fields', (pack) => (pack.surprise = true)],
    ['unsupported schema', (pack) => (pack.schemaVersion = 3)],
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
    ['empty labels', (pack) => (pack.zones[0].friendlyLabel = '')],
    ['identifier without region', (pack) => (pack.zones[0].id = 'Sydney')],
    [
      'identifier with empty segment',
      (pack) => (pack.zones[0].id = 'Australia//Sydney'),
    ],
    [
      'identifier with traversal segment',
      (pack) => (pack.zones[0].id = 'Australia/../Sydney'),
    ],
    [
      'duplicate zones',
      (pack) => pack.zones.push(structuredClone(pack.zones[0])),
    ],
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
