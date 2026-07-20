import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as copyModule from '../src/index.ts';

const { australianEnglish } = copyModule;

function localDate(dayOffset) {
  const date = new Date(Date.UTC(2026, 0, 1 + dayOffset));
  return {
    day: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    year: date.getUTCFullYear(),
  };
}

const ordinaryInput = {
  event: {
    direction: 'Forward Change',
    instant: '2026-10-03T16:00:00.000Z',
  },
  installationSeed: 'installation-test-seed',
  localDate: localDate(0),
  phase: 'ordinary',
  status: 'Standard time applies',
  zoneId: 'Australia/Sydney',
};

describe('Australian-English copy catalogue', () => {
  it('exposes one deeply immutable concept facade', () => {
    assert.deepEqual(Object.keys(copyModule), ['australianEnglish']);
    assert.equal(Object.isFrozen(australianEnglish), true);
    assert.equal(Object.isFrozen(australianEnglish.homeTimeZone), true);
    assert.equal(Object.isFrozen(australianEnglish.civilTimeReport), true);
    assert.equal(Object.isFrozen(australianEnglish.dataFreshness), true);
    assert.equal(Object.isFrozen(australianEnglish.settings), true);
    assert.equal('notifications' in australianEnglish, false);
  });

  it('owns exact Home Time Zone wording and safe error fallbacks', () => {
    const { homeTimeZone } = australianEnglish;
    assert.equal(homeTimeZone.chooser.heading, 'Choose Home Time Zone');
    assert.equal(
      homeTimeZone.chooser.groupHeading('mainland-and-state-regions'),
      'Mainland & state regions',
    );
    assert.equal(
      homeTimeZone.accessibility.zoneOption({
        friendlyLabel: 'Lord Howe Island',
        zoneId: 'Australia/Lord_Howe',
      }),
      'Lord Howe Island, Australia/Lord_Howe',
    );
    assert.equal(
      homeTimeZone.notice('saved-zone-invalid'),
      'Saved Home Time Zone is unsupported or invalid. Choose a region again.',
    );
    assert.equal(
      homeTimeZone.errorMessage('save-failed'),
      'Could not save Home Time Zone. Try again.',
    );
    assert.equal(
      homeTimeZone.errorMessage('future-runtime-failure'),
      'Something went wrong with Home Time Zone settings. Try again.',
    );
  });

  it('formats Home Time Zone dates and times without ambient locale or zone', () => {
    const { changeEvent, clock } = australianEnglish.civilTimeReport;
    const midnight = { day: 5, hour: 0, minute: 4, month: 4, year: 2026 };
    const midday = { ...midnight, hour: 12 };
    const evening = { ...midnight, hour: 22, minute: 17 };
    const twelveHour = {
      homeTimeZone: 'Australia/Sydney',
      uses24hourClock: false,
    };
    const twentyFourHour = {
      homeTimeZone: 'Australia/Sydney',
      uses24hourClock: true,
    };

    assert.equal(
      clock.format({ context: twelveHour, localDateTime: midnight }),
      '12:04 am',
    );
    assert.equal(
      clock.format({ context: twelveHour, localDateTime: midday }),
      '12:04 pm',
    );
    assert.equal(
      clock.format({ context: twentyFourHour, localDateTime: evening }),
      '22:17',
    );
    assert.equal(changeEvent.date(midnight), '5 April 2026');
    assert.equal(
      changeEvent.localTimeChange({
        after: { ...midnight, hour: 2, minute: 30 },
        before: { ...midnight, hour: 2, minute: 0 },
        context: twelveHour,
      }),
      '2:00 am → 2:30 am',
    );
    assert.equal(clock.utcOffset(37_800), 'UTC+10:30');
    assert.equal(
      changeEvent.offsetChange({
        afterSeconds: 39_600,
        beforeSeconds: 37_800,
      }),
      'UTC+10:30 → UTC+11:00',
    );
  });

  it('owns duration pluralisation, punctuation, and complete relative wording', () => {
    const { accessibility, changeEvent } = australianEnglish.civilTimeReport;
    assert.equal(changeEvent.countdown(1), 'In 1 second');
    assert.equal(changeEvent.countdown(61), 'In 1 minute, 1 second');
    assert.equal(changeEvent.countdown(90_061), 'In 1 day, 1 hour');
    assert.equal(changeEvent.elapsed(0), 'Applied now');
    assert.equal(changeEvent.elapsed(-3_600), '1 hour ago');
    assert.equal(
      changeEvent.clocksMove(1_800),
      'Clocks move 30 minutes · Home Time Zone',
    );
    assert.equal(
      accessibility.countdown(7_200),
      'Countdown, 2 hours until Change Event',
    );
  });

  it('maps every known unavailable reason and unknown runtime values safely', () => {
    const decision = australianEnglish.civilTimeReport.decisionUnavailable;
    const expected = {
      'before-coverage':
        'The selected instant precedes this Time-Zone Data Pack coverage.',
      'invalid-instant':
        'The current instant is invalid. Civil-time facts are hidden.',
      'unsupported-zone':
        'This Home Time Zone is not supported. Choose an Australian Home Time Zone.',
      'validity-expired':
        'The Validity Horizon has passed. New verified data is required before civil-time facts can be shown.',
    };
    for (const [reason, message] of Object.entries(expected)) {
      assert.equal(decision.message(reason), message);
    }
    assert.equal(
      decision.message('unexpected-runtime-reason'),
      'Civil-time facts are unavailable. Choose a supported Home Time Zone or try again later.',
    );
  });

  it('owns exact freshness, settings, and separate accessibility wording', () => {
    const { dataFreshness, settings } = australianEnglish;
    const statuses = [
      ['checking', 'Checking for verified data…'],
      ['stale-valid', 'Verified data due for refresh'],
      ['offline-valid', 'Offline · verified data remains valid'],
      ['retry-failed', 'Refresh failed · verified data remains active'],
      ['expired', 'Validity Horizon passed · refresh required'],
      [
        'decision-unavailable',
        'Freshness not determined · decision unavailable',
      ],
      ['future-state', 'Freshness not determined · decision unavailable'],
    ];
    for (const [freshness, expected] of statuses) {
      assert.equal(
        dataFreshness.status({ freshness, source: 'cached' }),
        expected,
      );
    }
    assert.equal(
      dataFreshness.status({ freshness: 'current', source: 'bundled' }),
      'Bundled data current',
    );
    assert.equal(
      dataFreshness.status({ freshness: 'current', source: 'remote' }),
      'Verified data current',
    );
    assert.equal(
      dataFreshness.accessibility.pack({
        freshness: 'current',
        packVersion: '2026c-australian-v1',
        source: 'remote',
        uses24hourClock: false,
        validUntil: '2030-12-31T23:59:59.000Z',
      }),
      'Time-Zone Data Pack 2026c-australian-v1, verified data current, valid until 31 December 2030 at 11:59:59 pm UTC',
    );
    assert.equal(
      dataFreshness.accessibility.pack({
        freshness: 'expired',
        packVersion: '2026c-australian-v1',
        source: 'cached',
        uses24hourClock: true,
        validUntil: '2030-12-31T23:59:59.000Z',
      }),
      'Time-Zone Data Pack 2026c-australian-v1, validity expired, refresh required, valid until 31 December 2030 at 23:59:59 UTC',
    );
    assert.equal(
      dataFreshness.packDetails({
        packVersion: '2026c-australian-v1',
        uses24hourClock: true,
        validUntil: '2030-12-31T23:59:59.000Z',
      }),
      'Pack 2026c-australian-v1 · Valid through 31 December 2030 at 23:59:59 UTC',
    );
    assert.equal(
      dataFreshness.packDetails({
        packVersion: '2026c-australian-v1',
        uses24hourClock: false,
        validUntil: 'invalid-runtime-value',
      }),
      'Pack 2026c-australian-v1 · Valid through recorded UTC Validity Horizon',
    );
    assert.equal(
      settings.homeTimeZone('Sydney, Canberra & most of NSW'),
      'Home Time Zone: Sydney, Canberra & most of NSW',
    );
  });

  it('contains 152 unique reviewed secondary variants at required counts', () => {
    const { catalogue } = australianEnglish.civilTimeReport.secondary;
    const broadCounts = Object.fromEntries(
      Object.entries(catalogue.broad).map(([name, variants]) => [
        name,
        Object.keys(variants).length,
      ]),
    );
    assert.deepEqual(broadCounts, {
      daylightSaving: 30,
      noEvent: 30,
      standardTime: 30,
    });

    const regionalCount = Object.values(catalogue.regional).reduce(
      (total, variants) => total + Object.keys(variants).length,
      0,
    );
    const eventCount = Object.values(catalogue.event).reduce(
      (phaseTotal, directions) =>
        phaseTotal +
        Object.values(directions).reduce(
          (directionTotal, variants) =>
            directionTotal + Object.keys(variants).length,
          0,
        ),
      0,
    );
    assert.equal(regionalCount, 30);
    assert.equal(eventCount, 32);

    const allLines = [
      ...Object.values(catalogue.broad).flatMap(Object.values),
      ...Object.values(catalogue.regional).flatMap(Object.values),
      ...Object.values(catalogue.event).flatMap((directions) =>
        Object.values(directions).flatMap(Object.values),
      ),
    ];
    assert.equal(allLines.length, 152);
    assert.equal(new Set(allLines).size, 152);
  });

  it('selects deterministically and avoids repetition across 30 ordinary days', () => {
    const select = australianEnglish.civilTimeReport.secondary.select;
    assert.equal(select(ordinaryInput), select(structuredClone(ordinaryInput)));
    assert.equal(
      select(ordinaryInput),
      'Standard hours remain current. The clock is not participating in seasonal theatre.',
    );

    const thirtyDays = Array.from({ length: 30 }, (_, dayOffset) =>
      select({ ...ordinaryInput, localDate: localDate(dayOffset) }),
    );
    assert.equal(new Set(thirtyDays).size, 30);
  });

  it('applies regional eligibility and keeps event copy stable for its phase', () => {
    const { catalogue, select } = australianEnglish.civilTimeReport.secondary;
    const lordHoweLine = select({
      ...ordinaryInput,
      localDate: localDate(7),
      zoneId: 'Australia/Lord_Howe',
    });
    const lordHoweEligible = new Set([
      ...Object.values(catalogue.broad.standardTime),
      ...Object.values(catalogue.regional.lordHowe),
    ]);
    assert.equal(lordHoweEligible.has(lordHoweLine), true);
    const lordHoweCycle = Array.from({ length: 36 }, (_, dayOffset) =>
      select({
        ...ordinaryInput,
        localDate: localDate(dayOffset),
        zoneId: 'Australia/Lord_Howe',
      }),
    );
    assert.equal(
      Object.values(catalogue.regional.lordHowe).every((line) =>
        lordHoweCycle.includes(line),
      ),
      true,
    );

    const eventInput = {
      ...ordinaryInput,
      phase: 'reminder-week',
    };
    const eventLine = select(eventInput);
    assert.equal(
      Object.values(
        catalogue.event['reminder-week']['Forward Change'],
      ).includes(eventLine),
      true,
    );
    assert.equal(select({ ...eventInput, localDate: localDate(1) }), eventLine);
  });
});
