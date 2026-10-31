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

function renameKey(object, from, to) {
  object[to] = object[from];
  delete object[from];
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

  it('accepts offsets, deltas and transitions at their limits', () => {
    const pack = clonePack();
    pack.coverage.validUntil = '2025-04-05T16:00:00.000Z';
    pack.zones[1].initial.utcOffsetSeconds = -86_400;
    pack.zones[0].initial.utcOffsetSeconds = 46_800;
    pack.zones[0].transitions[0].offsetBeforeSeconds = 46_800;
    pack.source.files = ['australasia', 'northamerica'];

    const activated = activateTimeZoneDataPack(pack);

    assert.equal(activated.zones[1].initial.utcOffsetSeconds, -86_400);
    assert.equal(activated.zones[0].transitions[0].offsetBeforeSeconds, 46_800);
    assert.deepEqual(activated.source.files, ['australasia', 'northamerica']);
  });

  it('rejects packs that are not objects', () => {
    for (const value of [null, []]) {
      assert.throws(
        () => activateTimeZoneDataPack(value),
        (error) =>
          error instanceof TimeZoneDataPackValidationError &&
          /\$: expected an object/.test(error.message),
      );
    }
  });

  for (const [name, mutate, expected] of [
    ['unknown fields', (pack) => (pack.surprise = true), /expected keys/],
    [
      'renamed fields',
      (pack) => renameKey(pack, 'zones', 'zone'),
      /expected keys/,
    ],
    ['missing fields', (pack) => delete pack.zones, /expected keys/],
    [
      'unsupported schema',
      (pack) => (pack.schemaVersion = 3),
      /unsupported version 3/,
    ],
    [
      'fractional schema',
      (pack) => (pack.schemaVersion = 2.5),
      /expected a safe integer/,
    ],
    [
      'invalid instants',
      (pack) => (pack.coverage.startsAt = '2025-01-01'),
      /canonical ISO 8601/,
    ],
    [
      'invalid offsets',
      (pack) => (pack.zones[0].initial.utcOffsetSeconds = 86_401),
      /offset must be between/,
    ],
    [
      'discontinuous transitions',
      (pack) => (pack.zones[0].transitions[0].offsetBeforeSeconds = 36_000),
      /does not continue previous offset/,
    ],
    [
      'unordered transitions',
      (pack) => (pack.zones[0].transitions[0].at = pack.coverage.startsAt),
      /strictly ordered/,
    ],
    [
      'transitions beyond the Validity Horizon',
      (pack) => (pack.coverage.validUntil = '2025-04-05T15:59:59.999Z'),
      /exceeds Validity Horizon/,
    ],
    [
      'offset deltas over 3 hours',
      (pack) => {
        pack.zones[0].initial.utcOffsetSeconds = 46_801;
        pack.zones[0].transitions[0].offsetBeforeSeconds = 46_801;
      },
      /offset delta exceeds 3 hours/,
    ],
    [
      'wrong coverage bounds',
      (pack) => (pack.coverage.validUntil = pack.coverage.startsAt),
      /Validity Horizon must follow coverage start/,
    ],
    [
      'empty labels',
      (pack) => (pack.zones[0].friendlyLabel = ''),
      /non-empty string/,
    ],
    [
      'missing source files',
      (pack) => (pack.source.files = []),
      /at least one IANA source file/,
    ],
    [
      'unsorted source files',
      (pack) => (pack.source.files = ['northamerica', 'australasia']),
      /must be sorted/,
    ],
    ['missing zones', (pack) => (pack.zones = []), /at least one zone/],
    [
      'unknown initial state fields',
      (pack) => (pack.zones[0].initial.surprise = true),
      /\$\.zones\[0\]\.initial: expected keys/,
    ],
    [
      'unknown transition fields',
      (pack) => (pack.zones[0].transitions[0].surprise = true),
      /\$\.zones\[0\]\.transitions\[0\]: expected keys/,
    ],
    [
      'unknown zone fields',
      (pack) => (pack.zones[0].surprise = true),
      /\$\.zones\[0\]: expected keys/,
    ],
    [
      'unknown coverage fields',
      (pack) => (pack.coverage.surprise = true),
      /\$\.coverage: expected keys/,
    ],
    [
      'unknown source fields',
      (pack) => (pack.source.surprise = true),
      /\$\.source: expected keys/,
    ],
    [
      'invalid abbreviations',
      (pack) => (pack.zones[0].initial.abbreviation = 'aedt'),
      /expected a civil-time abbreviation/,
    ],
    [
      'transitions that are not arrays',
      (pack) => (pack.zones[0].transitions = {}),
      /transitions: expected an array/,
    ],
    [
      'transitions earlier than the previous transition',
      (pack) => {
        const later = {
          abbreviation: 'AEST',
          at: '2025-10-04T16:00:00.000Z',
          daylightSaving: false,
          offsetBeforeSeconds: 39_600,
          utcOffsetSeconds: 36_000,
        };
        const earlier = {
          abbreviation: 'AEDT',
          at: '2025-04-05T16:00:00.000Z',
          daylightSaving: true,
          offsetBeforeSeconds: 36_000,
          utcOffsetSeconds: 39_600,
        };
        pack.zones[0].transitions = [later, earlier];
      },
      /transitions\[1\]\.at: transitions must be strictly ordered/,
    ],
    [
      'transitions that change no offset',
      (pack) => (pack.zones[0].transitions[0].utcOffsetSeconds = 39_600),
      /transition changes no offset/,
    ],
    [
      'transitions that keep Daylight Saving Status',
      (pack) => (pack.zones[0].transitions[0].daylightSaving = true),
      /must change Daylight Saving Status/,
    ],
    [
      'uppercase archive digests',
      (pack) =>
        (pack.source.archiveSha256 = pack.source.archiveSha256.toUpperCase()),
      /expected a lowercase SHA-256 digest/,
    ],
    [
      'duplicate source files',
      (pack) => (pack.source.files = ['australasia', 'australasia']),
      /source files must be unique/,
    ],
    [
      'unsupported sources',
      (pack) => (pack.source.name = 'Other Time Zone Database'),
      /unsupported source/,
    ],
    [
      'invalid source versions',
      (pack) => (pack.source.version = '2026'),
      /expected an IANA release version/,
    ],
    [
      'source URLs for another version',
      (pack) =>
        (pack.source.versionUrl =
          'https://data.iana.org/time-zones/releases/tzdata2026d.tar.gz'),
      /URL does not match source version/,
    ],
    [
      'pack versions for another source version',
      (pack) => (pack.packVersion = '2026d-test-pack'),
      /version does not identify source version/,
    ],
    [
      'identifier without region',
      (pack) => (pack.zones[0].id = 'Sydney'),
      /IANA-style/,
    ],
    [
      'identifier with empty segment',
      (pack) => (pack.zones[0].id = 'Australia//Sydney'),
      /IANA-style/,
    ],
    [
      'identifier with traversal segment',
      (pack) => (pack.zones[0].id = 'Australia/../Sydney'),
      /IANA-style/,
    ],
    [
      'duplicate zones',
      (pack) => pack.zones.push(structuredClone(pack.zones[0])),
      /must be unique/,
    ],
  ]) {
    it(`rejects ${name}`, () => {
      const pack = clonePack();
      mutate(pack);

      assert.throws(
        () => activateTimeZoneDataPack(pack),
        (error) =>
          error instanceof TimeZoneDataPackValidationError &&
          expected.test(error.message),
      );
    });
  }
});
