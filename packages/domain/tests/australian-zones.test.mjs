import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  activateAustralianTimeZoneDataPack,
  AustralianCoverageValidationError,
  australianZones,
  normalizeAustralianZoneId,
  searchAustralianZones,
} from '../src/index.ts';

const aliases = {
  'Australia/ACT': 'Australia/Sydney',
  'Australia/Canberra': 'Australia/Sydney',
  'Australia/NSW': 'Australia/Sydney',
  'Australia/LHI': 'Australia/Lord_Howe',
  'Australia/North': 'Australia/Darwin',
  'Australia/Queensland': 'Australia/Brisbane',
  'Australia/South': 'Australia/Adelaide',
  'Australia/Tasmania': 'Australia/Hobart',
  'Australia/Currie': 'Australia/Hobart',
  'Australia/Victoria': 'Australia/Melbourne',
  'Australia/West': 'Australia/Perth',
  'Australia/Yancowinna': 'Australia/Broken_Hill',
};

const packJson = JSON.parse(
  await readFile(
    new URL(
      '../../time-zone-data/generated/australian-coverage.pack.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

describe('Australian zone catalogue', () => {
  it('owns exactly 18 unique canonical zones in reviewed groups', () => {
    assert.equal(australianZones.length, 18);
    assert.equal(new Set(australianZones.map((zone) => zone.id)).size, 18);
    assert.equal(
      australianZones.filter(
        (zone) => zone.group === 'mainland-and-state-regions',
      ).length,
      10,
    );
    assert.equal(
      australianZones.filter(
        (zone) => zone.group === 'islands-and-external-territories',
      ).length,
      8,
    );
    for (const zone of australianZones) {
      assert.equal(new Set(zone.searchTerms).size, zone.searchTerms.length);
    }
  });

  it('normalizes every current supported backward alias', () => {
    for (const [alias, canonicalId] of Object.entries(aliases)) {
      assert.equal(normalizeAustralianZoneId(alias), canonicalId);
    }
    for (const zone of australianZones) {
      assert.equal(normalizeAustralianZoneId(zone.id), zone.id);
    }
    assert.equal(normalizeAustralianZoneId('Europe/London'), null);
  });

  it('searches reviewed geography, aliases, and regional exceptions', () => {
    assert.deepEqual(
      searchAustralianZones('yancowinna').map((zone) => zone.id),
      ['Australia/Broken_Hill'],
    );
    assert.deepEqual(
      searchAustralianZones('NSW').map((zone) => zone.id),
      ['Australia/Sydney', 'Australia/Broken_Hill'],
    );
    assert.deepEqual(
      searchAustralianZones('keeling').map((zone) => zone.id),
      ['Indian/Cocos'],
    );
    assert.deepEqual(searchAustralianZones('no such region'), []);
  });

  it('activates only complete packs with reviewed labels', () => {
    const pack = activateAustralianTimeZoneDataPack(structuredClone(packJson));
    assert.equal(pack.zones.length, 18);

    const wrongLabel = structuredClone(packJson);
    wrongLabel.zones[0].friendlyLabel = 'Sydney';
    assert.throws(
      () => activateAustralianTimeZoneDataPack(wrongLabel),
      AustralianCoverageValidationError,
    );

    const incomplete = structuredClone(packJson);
    incomplete.zones.pop();
    assert.throws(
      () => activateAustralianTimeZoneDataPack(incomplete),
      AustralianCoverageValidationError,
    );
  });
});
