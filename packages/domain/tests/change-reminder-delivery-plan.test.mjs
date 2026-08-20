import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  activateAustralianTimeZoneDataPack,
  australianZones,
  CivilTimeDecisionUnavailableError,
  normalizeAustralianZoneId,
  planChangeReminderDeliveries,
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
const enabled = { oneDayEnabled: true, oneWeekEnabled: true };
const dayMilliseconds = 24 * 60 * 60 * 1_000;

function plan(homeTimeZone, now, preferences = enabled, dataPack = pack) {
  return planChangeReminderDeliveries(
    dataPack,
    homeTimeZone,
    preferences,
    new Date(now),
  );
}

function reminderFor(reminders, eventAt, timing) {
  return reminders.find(
    (reminder) =>
      reminder.changeEventAt === eventAt && reminder.timing === timing,
  );
}

describe('planChangeReminderDeliveries', () => {
  it('conforms every pack Change Event and proves aliases through the catalogue', () => {
    for (const zone of australianZones) {
      for (const alias of zone.aliases) {
        assert.equal(normalizeAustralianZoneId(alias), zone.id);
      }

      const packedZone = pack.zones.find(
        (candidate) => candidate.id === zone.id,
      );
      assert.ok(packedZone);
      const firstEvent = packedZone.transitions[0];
      if (firstEvent === undefined) {
        assert.deepEqual(plan(zone.id, '2026-02-01T00:00:00.000Z'), []);
        for (const alias of zone.aliases) {
          assert.deepEqual(plan(alias, '2026-02-01T00:00:00.000Z'), []);
        }
        continue;
      }

      const aliasInstant = Date.parse(firstEvent.at) - 8 * 3_600_000;
      const canonical = plan(zone.id, aliasInstant);
      assert.ok(reminderFor(canonical, firstEvent.at, 'one-day'));
      for (const alias of zone.aliases) {
        assert.deepEqual(plan(alias, aliasInstant), canonical);
      }

      for (const event of packedZone.transitions) {
        for (const [timing, probeOffsetMilliseconds] of [
          ['one-week', 6 * dayMilliseconds + 8 * 3_600_000],
          ['one-day', 8 * 3_600_000],
        ]) {
          const probe = plan(
            zone.id,
            Date.parse(event.at) - probeOffsetMilliseconds,
          );
          const reminder = reminderFor(probe, event.at, timing);
          assert.ok(reminder, `${zone.id} ${event.at} ${timing}`);

          const startsAt = Date.parse(reminder.deliveryWindow.startsAt);
          const endsAt = Date.parse(reminder.deliveryWindow.endsAt);
          assert.ok(endsAt <= Date.parse(pack.coverage.validUntil));
          assert.equal(
            reminderFor(plan(zone.id, startsAt - 1), event.at, timing),
            undefined,
          );
          assert.ok(reminderFor(plan(zone.id, startsAt), event.at, timing));
          assert.ok(reminderFor(plan(zone.id, endsAt), event.at, timing));
          assert.equal(
            reminderFor(plan(zone.id, endsAt + 1), event.at, timing),
            undefined,
          );
        }
      }
    }
  });

  it('returns immutable one-week and one-day facts at their local 09:00 starts', () => {
    const week = plan('Australia/Sydney', '2026-03-28T22:00:00.000Z');
    const day = plan('Australia/Canberra', '2026-04-03T22:00:00.000Z');
    const forward = plan('Australia/Sydney', '2026-10-02T23:00:00.000Z');

    assert.deepEqual(week, [
      {
        changeDirection: 'Backward Change',
        changeEventAt: '2026-04-04T16:00:00.000Z',
        deliveryWindow: {
          endsAt: '2026-03-29T10:00:00.000Z',
          startsAt: '2026-03-28T22:00:00.000Z',
        },
        homeTimeZone: 'Australia/Sydney',
        timing: 'one-week',
      },
    ]);
    assert.equal(day[0].timing, 'one-day');
    assert.equal(day[0].deliveryWindow.startsAt, '2026-04-03T22:00:00.000Z');
    assert.equal(day[0].deliveryWindow.endsAt, '2026-04-04T10:00:00.000Z');
    assert.ok(Object.isFrozen(day));
    assert.ok(Object.isFrozen(day[0]));
    assert.ok(Object.isFrozen(day[0].deliveryWindow));
    assert.equal(forward[0].changeDirection, 'Forward Change');
    assert.equal(forward[0].changeEventAt, '2026-10-03T16:00:00.000Z');
  });

  it('keeps timing preferences independent and never catches up stale windows', () => {
    assert.deepEqual(
      plan('Australia/Sydney', '2026-03-28T22:00:00.000Z', {
        oneDayEnabled: false,
        oneWeekEnabled: true,
      }).map((reminder) => reminder.timing),
      ['one-week'],
    );
    assert.deepEqual(
      plan('Australia/Sydney', '2026-04-03T22:00:00.000Z', {
        oneDayEnabled: true,
        oneWeekEnabled: false,
      }).map((reminder) => reminder.timing),
      ['one-day'],
    );
    assert.deepEqual(
      plan('Australia/Sydney', '2026-04-03T22:00:00.000Z', {
        oneDayEnabled: false,
        oneWeekEnabled: false,
      }),
      [],
    );
    assert.deepEqual(plan('Australia/Sydney', '2026-04-04T10:00:00.001Z'), []);
  });

  it('includes local 21:00 but excludes the first instant after it', () => {
    assert.equal(
      plan('Australia/Sydney', '2026-04-04T10:00:00.000Z')[0].timing,
      'one-day',
    );
    assert.deepEqual(plan('Australia/Sydney', '2026-04-04T10:00:00.001Z'), []);
  });

  it('derives Lord Howe windows from its 30-minute pack transition', () => {
    const reminders = plan('Australia/LHI', '2026-04-03T22:00:00.000Z');

    assert.equal(reminders[0].changeDirection, 'Backward Change');
    assert.equal(reminders[0].changeEventAt, '2026-04-04T15:00:00.000Z');
    assert.equal(
      reminders[0].deliveryWindow.startsAt,
      '2026-04-03T22:00:00.000Z',
    );
  });

  it('leaves no-event zones dormant and makes them eligible when a later pack adds an event', () => {
    assert.deepEqual(
      plan('Australia/Brisbane', '2026-10-02T23:00:00.000Z'),
      [],
    );

    const futurePackJson = structuredClone(packJson);
    const brisbane = futurePackJson.zones.find(
      (zone) => zone.id === 'Australia/Brisbane',
    );
    brisbane.transitions.push({
      abbreviation: 'AEDT',
      at: '2026-10-03T16:00:00.000Z',
      daylightSaving: true,
      offsetBeforeSeconds: 36_000,
      utcOffsetSeconds: 39_600,
    });
    const futurePack = activateAustralianTimeZoneDataPack(futurePackJson);
    const reminders = plan(
      'Australia/Queensland',
      '2026-10-02T23:00:00.000Z',
      enabled,
      futurePack,
    );

    assert.equal(reminders[0].timing, 'one-day');
    assert.equal(reminders[0].homeTimeZone, 'Australia/Brisbane');
  });

  it('plans a later close Change Event while an earlier event is still next', () => {
    const closeEventsPackJson = structuredClone(packJson);
    const brisbane = closeEventsPackJson.zones.find(
      (zone) => zone.id === 'Australia/Brisbane',
    );
    brisbane.transitions.push(
      {
        abbreviation: 'AEDT',
        at: '2026-10-03T16:00:00.000Z',
        daylightSaving: true,
        offsetBeforeSeconds: 36_000,
        utcOffsetSeconds: 39_600,
      },
      {
        abbreviation: 'AEST',
        at: '2026-10-06T16:00:00.000Z',
        daylightSaving: false,
        offsetBeforeSeconds: 39_600,
        utcOffsetSeconds: 36_000,
      },
    );
    const closeEventsPack =
      activateAustralianTimeZoneDataPack(closeEventsPackJson);
    const reminders = plan(
      'Australia/Brisbane',
      '2026-09-29T23:00:00.000Z',
      enabled,
      closeEventsPack,
    );

    assert.ok(reminderFor(reminders, '2026-10-06T16:00:00.000Z', 'one-week'));
  });

  it('fails closed before and after coverage, including invalid instants', () => {
    assert.doesNotThrow(() =>
      plan('Australia/Sydney', pack.coverage.validUntil),
    );

    for (const [now, reason] of [
      ['2024-12-31T23:59:59.000Z', 'before-coverage'],
      ['2031-01-01T00:00:00.000Z', 'validity-expired'],
      ['invalid', 'invalid-instant'],
    ]) {
      assert.throws(
        () => plan('Australia/Sydney', now),
        (error) =>
          error instanceof CivilTimeDecisionUnavailableError &&
          error.reason === reason,
      );
    }
  });
});
