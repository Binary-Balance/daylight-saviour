import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  activateAustralianTimeZoneDataPack,
  decideLivingDossier,
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

describe('decideLivingDossier', () => {
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
        decideLivingDossier(
          pack,
          'Australia/Sydney',
          atSecondsBefore(secondsBefore),
        ).phase,
        expected,
      );
    });
  }

  it('replaces facts atomically and begins aftermath at the event instant', () => {
    const before = decideLivingDossier(
      pack,
      'Australia/Sydney',
      atSecondsBefore(0.001),
    );
    const exact = decideLivingDossier(
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

  it('keeps aftermath inside 48 hours and resumes normal dossier at 48 hours', () => {
    assert.equal(
      decideLivingDossier(
        pack,
        'Australia/Sydney',
        atSecondsAfter(48 * 3_600 - 0.001),
      ).phase,
      'aftermath',
    );
    assert.equal(
      decideLivingDossier(pack, 'Australia/Sydney', atSecondsAfter(48 * 3_600))
        .phase,
      'ordinary',
    );
  });

  it('derives Forward, Backward, Lord Howe, and no-event phases from pack data', () => {
    const forward = decideLivingDossier(
      pack,
      'Australia/Sydney',
      atSecondsBefore(86_400),
    );
    const backward = decideLivingDossier(
      pack,
      'Australia/Sydney',
      new Date('2026-04-03T16:00:00.000Z'),
    );
    const lordHowe = decideLivingDossier(
      pack,
      'Australia/Lord_Howe',
      new Date('2026-10-02T15:30:00.000Z'),
    );
    const noEvent = decideLivingDossier(
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
