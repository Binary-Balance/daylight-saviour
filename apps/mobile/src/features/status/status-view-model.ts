import {
  activateAustralianTimeZoneDataPack,
  CivilTimeDecisionUnavailableError,
  decideCivilTime,
  getAustralianZone,
  type LocalDateTime,
} from '@daylight-saviour/domain';
import { bundledAustralianDataPack } from '@daylight-saviour/time-zone-data';

const activatedAustralianPack = activateAustralianTimeZoneDataPack(
  bundledAustralianDataPack,
);
const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function twoDigits(value: number) {
  return value.toString().padStart(2, '0');
}

function formatTime(local: LocalDateTime, uses24hourClock: boolean) {
  if (uses24hourClock) {
    return `${twoDigits(local.hour)}:${twoDigits(local.minute)}`;
  }

  const period = local.hour >= 12 ? 'pm' : 'am';
  const hour = local.hour % 12 || 12;
  return `${hour}:${twoDigits(local.minute)} ${period}`;
}

function formatDate(local: LocalDateTime) {
  return `${local.day} ${months[local.month - 1]} ${local.year}`;
}

function formatOffset(offsetSeconds: number) {
  const sign = offsetSeconds >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(offsetSeconds) / 60;
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `UTC${sign}${twoDigits(hours)}:${twoDigits(minutes)}`;
}

function plural(value: number, unit: string) {
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

function formatCountdown(totalSeconds: number) {
  let remaining = Math.floor(totalSeconds);
  if (remaining < 1) {
    return 'less than one second';
  }

  const parts: string[] = [];
  for (const [unit, size] of [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
    ['second', 1],
  ] as const) {
    const value = Math.floor(remaining / size);
    remaining %= size;
    if (value > 0) {
      parts.push(plural(value, unit));
    }
    if (parts.length === 2) {
      break;
    }
  }

  return parts.join(', ');
}

function formatDelta(offsetDeltaSeconds: number) {
  const absoluteMinutes = Math.abs(offsetDeltaSeconds) / 60;
  if (absoluteMinutes % 60 === 0) {
    return plural(absoluteMinutes / 60, 'hour');
  }
  return plural(absoluteMinutes, 'minute');
}

const packDetails = {
  packVersion: activatedAustralianPack.packVersion,
  validUntil: activatedAustralianPack.coverage.validUntil,
} as const;

export type StatusViewModel =
  | {
      readonly availability: 'ready';
      readonly abbreviation: string;
      readonly clock: string;
      readonly currentOffset: string;
      readonly event: {
        readonly countdown: string;
        readonly date: string;
        readonly direction: 'Forward Change' | 'Backward Change';
        readonly offsetAmount: string;
        readonly offsetChange: string;
        readonly wallTimeChange: string;
      } | null;
      readonly friendlyZoneLabel: string;
      readonly packVersion: string;
      readonly status: string;
      readonly validUntil: string;
      readonly zoneId: string;
    }
  | {
      readonly availability: 'unavailable';
      readonly friendlyZoneLabel: string;
      readonly message: string;
      readonly packVersion: string;
      readonly validUntil: string;
      readonly zoneId: string;
    };

export function createStatusViewModel(
  zoneId: string,
  now: Date,
  uses24hourClock = false,
): StatusViewModel {
  try {
    const decision = decideCivilTime(activatedAustralianPack, zoneId, now);
    const event = decision.nextChangeEvent;

    return {
      availability: 'ready',
      abbreviation: decision.abbreviation,
      clock: formatTime(decision.localDateTime, uses24hourClock),
      currentOffset: formatOffset(decision.utcOffsetSeconds),
      event:
        event === null
          ? null
          : {
              countdown: formatCountdown(event.secondsUntil),
              date: formatDate(event.localAfter),
              direction: event.direction,
              offsetAmount: formatDelta(event.offsetDeltaSeconds),
              offsetChange: `${formatOffset(event.offsetBeforeSeconds)} → ${formatOffset(event.offsetAfterSeconds)}`,
              wallTimeChange: `${formatTime(event.localBefore, uses24hourClock)} → ${formatTime(event.localAfter, uses24hourClock)}`,
            },
      friendlyZoneLabel: decision.friendlyZoneLabel,
      ...packDetails,
      status: decision.daylightSavingStatus,
      zoneId: decision.zoneId,
    };
  } catch (error) {
    if (!(error instanceof CivilTimeDecisionUnavailableError)) {
      throw error;
    }

    return {
      availability: 'unavailable',
      friendlyZoneLabel:
        getAustralianZone(zoneId)?.friendlyLabel ??
        'Unsupported Home Time Zone',
      message:
        'Time-zone data does not cover this instant. Refresh required before civil-time facts can be shown.',
      ...packDetails,
      zoneId,
    };
  }
}
