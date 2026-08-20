import {
  assertActivatedTimeZoneDataPack,
  type ActivatedTimeZoneDataPack,
} from '@daylight-saviour/contracts';

import {
  civilTimeInputAt,
  localDateTimeAt,
  stateAt,
  type ChangeDirection,
  type LocalDateTime,
} from './civil-time-helpers.ts';
import { normalizeAustralianZoneId } from './australian-zones.ts';

const dayMilliseconds = 24 * 60 * 60 * 1_000;

export type ChangeReminderTiming = 'one-week' | 'one-day';

export interface ChangeReminderPreferences {
  readonly oneDayEnabled: boolean;
  readonly oneWeekEnabled: boolean;
}

export interface ChangeReminderDeliveryPlan {
  readonly changeDirection: ChangeDirection;
  readonly changeEventAt: string;
  readonly deliveryWindow: {
    readonly endsAt: string;
    readonly startsAt: string;
  };
  readonly homeTimeZone: string;
  readonly timing: ChangeReminderTiming;
}

function sameLocalDateTime(left: LocalDateTime, right: LocalDateTime): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function instantAtLocalTime(
  zone: ActivatedTimeZoneDataPack['zones'][number],
  localDate: LocalDateTime,
): number {
  const localMilliseconds = Date.UTC(
    localDate.year,
    localDate.month - 1,
    localDate.day,
    localDate.hour,
    localDate.minute,
  );
  const offsets = new Set([
    zone.initial.utcOffsetSeconds,
    ...zone.transitions.map((transition) => transition.utcOffsetSeconds),
  ]);

  for (const offsetSeconds of offsets) {
    const instantMilliseconds = localMilliseconds - offsetSeconds * 1_000;
    const state = stateAt(zone.initial, zone.transitions, instantMilliseconds);
    if (
      state.utcOffsetSeconds === offsetSeconds &&
      sameLocalDateTime(
        localDateTimeAt(instantMilliseconds, offsetSeconds),
        localDate,
      )
    ) {
      return instantMilliseconds;
    }
  }

  throw new Error('Time-Zone Data Pack cannot resolve reminder local time');
}

function reminderLocalDate(
  eventLocalDate: LocalDateTime,
  daysBefore: number,
  hour: number,
): LocalDateTime {
  const date = new Date(
    Date.UTC(
      eventLocalDate.year,
      eventLocalDate.month - 1,
      eventLocalDate.day,
    ) -
      daysBefore * dayMilliseconds,
  );

  return {
    day: date.getUTCDate(),
    hour,
    minute: 0,
    month: date.getUTCMonth() + 1,
    year: date.getUTCFullYear(),
  };
}

/**
 * Returns only reminders that are eligible at `now`. Both 09:00 and 21:00
 * local are included; the first instant after 21:00 is stale. UTC calendar
 * arithmetic and offsets from the activated pack keep this independent of
 * host time-zone data.
 */
export function planChangeReminderDeliveries(
  pack: ActivatedTimeZoneDataPack,
  homeTimeZone: string,
  preferences: ChangeReminderPreferences,
  now: Date,
): readonly ChangeReminderDeliveryPlan[] {
  assertActivatedTimeZoneDataPack(pack);
  const zoneId = normalizeAustralianZoneId(homeTimeZone);
  if (zoneId === null) {
    return Object.freeze([]);
  }

  const { instantMilliseconds: nowMilliseconds, zone } = civilTimeInputAt(
    pack,
    zoneId,
    now,
  );
  const timings: readonly [ChangeReminderTiming, boolean, number][] = [
    ['one-week', preferences.oneWeekEnabled, 7],
    ['one-day', preferences.oneDayEnabled, 1],
  ];
  const plans: ChangeReminderDeliveryPlan[] = [];

  for (const event of zone.transitions) {
    const eventLocalDate = localDateTimeAt(
      Date.parse(event.at),
      event.offsetBeforeSeconds,
    );

    for (const [timing, enabled, daysBefore] of timings) {
      if (!enabled) continue;

      const startsAtMilliseconds = instantAtLocalTime(
        zone,
        reminderLocalDate(eventLocalDate, daysBefore, 9),
      );
      const endsAtMilliseconds = instantAtLocalTime(
        zone,
        reminderLocalDate(eventLocalDate, daysBefore, 21),
      );
      if (
        nowMilliseconds < startsAtMilliseconds ||
        nowMilliseconds > endsAtMilliseconds
      ) {
        continue;
      }

      plans.push(
        Object.freeze({
          changeDirection:
            event.utcOffsetSeconds > event.offsetBeforeSeconds
              ? 'Forward Change'
              : 'Backward Change',
          changeEventAt: event.at,
          deliveryWindow: Object.freeze({
            endsAt: new Date(endsAtMilliseconds).toISOString(),
            startsAt: new Date(startsAtMilliseconds).toISOString(),
          }),
          homeTimeZone: zoneId,
          timing,
        }),
      );
    }
  }

  return Object.freeze(plans);
}
