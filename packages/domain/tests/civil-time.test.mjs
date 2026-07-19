import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { activateTimeZoneDataPack } from '@daylight-saviour/contracts';

import {
  CivilTimeDecisionUnavailableError,
  decideCivilTime,
} from '../src/index.ts';

const packJson = JSON.parse(
  await readFile(
    new URL(
      '../../time-zone-data/generated/australia-sydney.pack.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const pack = activateTimeZoneDataPack(packJson);

describe('decideCivilTime', () => {
  const boundary = '2026-04-04T16:00:00.000Z';

  it('keeps pre-transition state one second before a Sydney boundary', () => {
    const decision = decideCivilTime(
      pack,
      'Australia/Sydney',
      new Date('2026-04-04T15:59:59.000Z'),
    );

    assert.equal(decision.daylightSavingStatus, 'Daylight saving time applies');
    assert.equal(decision.utcOffsetSeconds, 39_600);
    assert.equal(decision.nextChangeEvent.at, boundary);
    assert.equal(decision.nextChangeEvent.direction, 'Backward Change');
    assert.equal(decision.nextChangeEvent.secondsUntil, 1);
    assert.deepEqual(decision.nextChangeEvent.localBefore, {
      day: 5,
      hour: 3,
      minute: 0,
      month: 4,
      year: 2026,
    });
    assert.deepEqual(decision.nextChangeEvent.localAfter, {
      day: 5,
      hour: 2,
      minute: 0,
      month: 4,
      year: 2026,
    });
  });

  it('applies transition atomically at the exact UTC instant', () => {
    const decision = decideCivilTime(
      pack,
      'Australia/Sydney',
      new Date(boundary),
    );

    assert.equal(decision.daylightSavingStatus, 'Standard time applies');
    assert.equal(decision.utcOffsetSeconds, 36_000);
    assert.equal(decision.localDateTime.hour, 2);
    assert.equal(decision.nextChangeEvent.direction, 'Forward Change');
    assert.equal(decision.nextChangeEvent.at, '2026-10-03T16:00:00.000Z');
  });

  it('keeps post-transition state one second after a Sydney boundary', () => {
    const decision = decideCivilTime(
      pack,
      'Australia/Sydney',
      new Date('2026-04-04T16:00:01.000Z'),
    );

    assert.equal(decision.daylightSavingStatus, 'Standard time applies');
    assert.equal(decision.utcOffsetSeconds, 36_000);
    assert.deepEqual(decision.localDateTime, {
      day: 5,
      hour: 2,
      minute: 0,
      month: 4,
      year: 2026,
    });
  });

  it('fails closed beyond the Validity Horizon', () => {
    assert.throws(
      () =>
        decideCivilTime(
          pack,
          'Australia/Sydney',
          new Date('2031-01-01T00:00:00.000Z'),
        ),
      CivilTimeDecisionUnavailableError,
    );
  });

  it('rejects a typed but unactivated pack', () => {
    assert.throws(
      () =>
        decideCivilTime(
          structuredClone(packJson),
          'Australia/Sydney',
          new Date(boundary),
        ),
      /must be activated/,
    );
  });
});
