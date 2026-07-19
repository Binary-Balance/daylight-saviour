import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  activateAustralianTimeZoneDataPack,
  CivilTimeDecisionUnavailableError,
  decideCivilTime,
} from '../src/index.ts';

const packJson = JSON.parse(
  await readFile(
    new URL(
      '../../time-zone-data/generated/australian-coverage.pack.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const pack = activateAustralianTimeZoneDataPack(packJson);

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

  it('applies every generated Change Event atomically', () => {
    for (const zone of pack.zones) {
      for (const transition of zone.transitions) {
        const transitionMs = Date.parse(transition.at);
        const before = decideCivilTime(
          pack,
          zone.id,
          new Date(transitionMs - 1_000),
        );
        const exact = decideCivilTime(pack, zone.id, new Date(transitionMs));
        const after = decideCivilTime(
          pack,
          zone.id,
          new Date(transitionMs + 1_000),
        );

        assert.equal(before.utcOffsetSeconds, transition.offsetBeforeSeconds);
        assert.equal(before.nextChangeEvent.at, transition.at);
        assert.equal(exact.utcOffsetSeconds, transition.utcOffsetSeconds);
        assert.notEqual(exact.nextChangeEvent?.at, transition.at);
        assert.equal(after.utcOffsetSeconds, transition.utcOffsetSeconds);
        assert.equal(
          exact.daylightSavingStatus,
          transition.daylightSaving
            ? 'Daylight saving time applies'
            : 'Standard time applies',
        );
      }
    }
  });

  it('covers non-hour, unusual-offset, no-event, and external regions', () => {
    const instant = new Date('2026-07-19T00:00:00.000Z');
    const lordHowe = decideCivilTime(pack, 'Australia/Lord_Howe', instant);
    const eucla = decideCivilTime(pack, 'Australia/Eucla', instant);
    const brisbane = decideCivilTime(pack, 'Australia/Brisbane', instant);
    const norfolk = decideCivilTime(pack, 'Pacific/Norfolk', instant);
    const casey = decideCivilTime(pack, 'Antarctica/Casey', instant);

    assert.equal(Math.abs(lordHowe.nextChangeEvent.offsetDeltaSeconds), 1_800);
    assert.equal(eucla.utcOffsetSeconds, 31_500);
    assert.equal(eucla.nextChangeEvent, null);
    assert.equal(brisbane.nextChangeEvent, null);
    assert.equal(norfolk.nextChangeEvent.direction, 'Forward Change');
    assert.equal(casey.utcOffsetSeconds, 28_800);
    assert.equal(casey.nextChangeEvent, null);
  });
});
