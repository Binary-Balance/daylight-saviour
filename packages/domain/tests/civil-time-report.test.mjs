import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  activateAustralianTimeZoneDataPack,
  createCivilTimeReport,
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
const eventMs = Date.parse('2026-10-03T16:00:00.000Z');
const atSecondsBefore = (seconds) => new Date(eventMs - seconds * 1_000);
const atSecondsAfter = (seconds) => new Date(eventMs + seconds * 1_000);

describe('createCivilTimeReport', () => {
  for (const [description, secondsBefore, expected] of [
    ['ordinary beyond 28 days', 28 * 86_400 + 1, 'ordinary'],
    ['approaching at exactly 28 days', 28 * 86_400, 'approaching'],
    ['approaching beyond 7 days', 7 * 86_400 + 1, 'approaching'],
    ['reminder week at exactly 7 days', 7 * 86_400, 'reminder-week'],
    ['reminder week beyond 24 hours', 86_401, 'reminder-week'],
    ['reminder day at exactly 24 hours', 86_400, 'reminder-day'],
    ['reminder day before the event', 1, 'reminder-day'],
  ]) {
    it(description, () => {
      assert.equal(
        createCivilTimeReport(
          pack,
          'Australia/Sydney',
          atSecondsBefore(secondsBefore),
        ).phase,
        expected,
      );
    });
  }

  it('replaces facts atomically and begins aftermath at the event instant', () => {
    const before = createCivilTimeReport(
      pack,
      'Australia/Sydney',
      atSecondsBefore(0.001),
    );
    const exact = createCivilTimeReport(
      pack,
      'Australia/Sydney',
      atSecondsAfter(0),
    );

    assert.equal(before.phase, 'reminder-day');
    assert.equal(
      before.civilTime.daylightSavingStatus,
      'Standard time applies',
    );
    assert.equal(exact.phase, 'aftermath');
    assert.equal(
      exact.civilTime.daylightSavingStatus,
      'Daylight saving time applies',
    );
    assert.equal(exact.featuredEvent.at, '2026-10-03T16:00:00.000Z');
    assert.equal(exact.featuredEvent.secondsUntil, 0);
    assert.ok(!['underway', 'in-progress'].includes(exact.phase));
  });

  it('shows aftermath only for the first unacknowledged opening', () => {
    const instant = atSecondsAfter(3_600);
    const firstOpening = createCivilTimeReport(
      pack,
      'Australia/Sydney',
      instant,
    );
    const repeatOpening = createCivilTimeReport(
      pack,
      'Australia/Sydney',
      instant,
      { acknowledgedEventAt: '2026-10-03T16:00:00.000Z' },
    );
    const staleAcknowledgement = createCivilTimeReport(
      pack,
      'Australia/Sydney',
      instant,
      { acknowledgedEventAt: '2026-04-04T16:00:00.000Z' },
    );

    assert.equal(firstOpening.phase, 'aftermath');
    assert.equal(firstOpening.featuredEvent.at, '2026-10-03T16:00:00.000Z');
    assert.equal(repeatOpening.phase, 'ordinary');
    assert.equal(repeatOpening.featuredEvent.at, '2027-04-03T16:00:00.000Z');
    assert.equal(staleAcknowledgement.phase, 'aftermath');
  });

  it('keeps aftermath inside 48 hours and resumes normal report at 48 hours', () => {
    assert.equal(
      createCivilTimeReport(
        pack,
        'Australia/Sydney',
        atSecondsAfter(48 * 3_600 - 0.001),
      ).phase,
      'aftermath',
    );
    assert.equal(
      createCivilTimeReport(
        pack,
        'Australia/Sydney',
        atSecondsAfter(48 * 3_600),
      ).phase,
      'ordinary',
    );
  });

  it('derives Forward, Backward, Lord Howe, and no-event phases from pack data', () => {
    const forward = createCivilTimeReport(
      pack,
      'Australia/Sydney',
      atSecondsBefore(86_400),
    );
    const backward = createCivilTimeReport(
      pack,
      'Australia/Sydney',
      new Date('2026-04-03T16:00:00.000Z'),
    );
    const lordHowe = createCivilTimeReport(
      pack,
      'Australia/Lord_Howe',
      new Date('2026-10-02T15:30:00.000Z'),
    );
    const noEvent = createCivilTimeReport(
      pack,
      'Australia/Brisbane',
      new Date('2026-07-19T00:00:00.000Z'),
    );

    assert.equal(forward.featuredEvent.direction, 'Forward Change');
    assert.equal(forward.featuredEvent.offsetDeltaSeconds, 3_600);
    assert.equal(backward.featuredEvent.direction, 'Backward Change');
    assert.equal(backward.featuredEvent.offsetDeltaSeconds, -3_600);
    assert.equal(lordHowe.featuredEvent.direction, 'Forward Change');
    assert.equal(lordHowe.featuredEvent.offsetDeltaSeconds, 1_800);
    assert.equal(noEvent.phase, 'no-event');
    assert.equal(noEvent.featuredEvent, null);
  });
});
