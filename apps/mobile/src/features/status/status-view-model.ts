import {
  activateAustralianTimeZoneDataPack,
  CivilTimeDecisionUnavailableError,
  decideLivingDossier,
  getAustralianZone,
  type CivilTimeDecisionUnavailableReason,
  type LivingDossierPhase,
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

export function formatAbsoluteDuration(totalSeconds: number) {
  let remaining = Math.floor(Math.abs(totalSeconds));
  if (remaining < 1) {
    return 'now';
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

const phasePresentation: Record<
  LivingDossierPhase,
  { readonly label: string; readonly secondaryLine: string }
> = {
  ordinary: {
    label: 'ON FILE',
    secondaryLine: 'Next adjustment recorded. Civil time continues meanwhile.',
  },
  approaching: {
    label: 'APPROACHING',
    secondaryLine: 'Clock adjustment approaching. Paperwork remains composed.',
  },
  'reminder-week': {
    label: 'REMINDER WEEK',
    secondaryLine: 'Change due within one week. The clock has been notified.',
  },
  'reminder-day': {
    label: 'REMINDER DAY',
    secondaryLine:
      'Change due within 24 hours. Temporal administration is ready.',
  },
  aftermath: {
    label: 'CHANGE RECORDED',
    secondaryLine:
      'New civil time now applies. The clock has filed its amendment.',
  },
  'no-event': {
    label: 'NO CHANGE FILED',
    secondaryLine:
      'No clock adjustment is scheduled. Civil time may rest unbothered.',
  },
};

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
        readonly countdown: string | null;
        readonly date: string;
        readonly direction: 'Forward Change' | 'Backward Change';
        readonly elapsed: string | null;
        readonly instant: string;
        readonly offsetAmount: string;
        readonly offsetChange: string;
        readonly relation: 'completed' | 'upcoming';
        readonly wallTimeChange: string;
      } | null;
      readonly friendlyZoneLabel: string;
      readonly freshness: 'current';
      readonly packVersion: string;
      readonly phase: LivingDossierPhase;
      readonly phaseLabel: string;
      readonly secondaryLine: string;
      readonly status: string;
      readonly validUntil: string;
      readonly zoneId: string;
    }
  | {
      readonly availability: 'unavailable';
      readonly friendlyZoneLabel: string;
      readonly freshness: 'decision-unavailable' | 'expired';
      readonly message: string;
      readonly packVersion: string;
      readonly unavailabilityReason: CivilTimeDecisionUnavailableReason;
      readonly validUntil: string;
      readonly zoneId: string;
    };

export function createStatusViewModel(
  zoneId: string,
  now: Date,
  uses24hourClock = false,
  acknowledgedEventAt: string | null = null,
): StatusViewModel {
  try {
    const dossier = decideLivingDossier(activatedAustralianPack, zoneId, now, {
      acknowledgedEventAt,
    });
    const decision = dossier.civilTime;
    const event = dossier.featuredEvent;
    const presentation = phasePresentation[dossier.phase];
    const completed = dossier.phase === 'aftermath';

    return {
      availability: 'ready',
      abbreviation: decision.abbreviation,
      clock: formatTime(decision.localDateTime, uses24hourClock),
      currentOffset: formatOffset(decision.utcOffsetSeconds),
      event:
        event === null
          ? null
          : {
              countdown: completed
                ? null
                : formatAbsoluteDuration(event.secondsUntil),
              date: formatDate(event.localAfter),
              direction: event.direction,
              elapsed: completed
                ? formatAbsoluteDuration(event.secondsUntil)
                : null,
              instant: event.at,
              offsetAmount: formatDelta(event.offsetDeltaSeconds),
              offsetChange: `${formatOffset(event.offsetBeforeSeconds)} → ${formatOffset(event.offsetAfterSeconds)}`,
              relation: completed ? 'completed' : 'upcoming',
              wallTimeChange: `${formatTime(event.localBefore, uses24hourClock)} → ${formatTime(event.localAfter, uses24hourClock)}`,
            },
      friendlyZoneLabel: decision.friendlyZoneLabel,
      freshness: 'current',
      ...packDetails,
      phase: dossier.phase,
      phaseLabel: presentation.label,
      secondaryLine: presentation.secondaryLine,
      status: decision.daylightSavingStatus,
      zoneId: decision.zoneId,
    };
  } catch (error) {
    if (!(error instanceof CivilTimeDecisionUnavailableError)) {
      throw error;
    }

    const unavailablePresentation: Record<
      CivilTimeDecisionUnavailableReason,
      {
        readonly freshness: 'decision-unavailable' | 'expired';
        readonly message: string;
      }
    > = {
      'before-coverage': {
        freshness: 'decision-unavailable',
        message:
          'The selected instant precedes this Time-Zone Data Pack coverage.',
      },
      'invalid-instant': {
        freshness: 'decision-unavailable',
        message: 'The current instant is invalid. Civil-time facts are hidden.',
      },
      'unsupported-zone': {
        freshness: 'decision-unavailable',
        message:
          'This Home Time Zone is not supported. Choose an Australian Home Time Zone.',
      },
      'validity-expired': {
        freshness: 'expired',
        message:
          'The Validity Horizon has passed. New verified data is required before civil-time facts can be shown.',
      },
    };
    const unavailable = unavailablePresentation[error.reason];

    return {
      availability: 'unavailable',
      friendlyZoneLabel:
        getAustralianZone(zoneId)?.friendlyLabel ??
        'Unsupported Home Time Zone',
      freshness: unavailable.freshness,
      message: unavailable.message,
      ...packDetails,
      unavailabilityReason: error.reason,
      zoneId,
    };
  }
}
