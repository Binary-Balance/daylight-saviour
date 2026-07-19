import {
  assertActivatedTimeZoneDataPack,
  type ActivatedTimeZoneDataPack,
  type TimeZoneState,
  type TimeZoneTransition,
} from '@daylight-saviour/contracts';

export {
  activateAustralianTimeZoneDataPack,
  AustralianCoverageValidationError,
  australianZoneGroups,
  australianZones,
  getAustralianZone,
  normalizeAustralianZoneId,
  searchAustralianZones,
  type AustralianZone,
  type AustralianZoneGroup,
} from './australian-zones.ts';

export type DaylightSavingStatus =
  | 'Daylight saving time applies'
  | 'Standard time applies';

export type ChangeDirection = 'Forward Change' | 'Backward Change';

export interface LocalDateTime {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly month: number;
  readonly year: number;
}

export interface ChangeEvent {
  readonly abbreviationAfter: string;
  readonly at: string;
  readonly direction: ChangeDirection;
  readonly localAfter: LocalDateTime;
  readonly localBefore: LocalDateTime;
  readonly offsetAfterSeconds: number;
  readonly offsetBeforeSeconds: number;
  readonly offsetDeltaSeconds: number;
  readonly secondsUntil: number;
}

export type LivingDossierPhase =
  | 'ordinary'
  | 'approaching'
  | 'reminder-week'
  | 'reminder-day'
  | 'aftermath'
  | 'no-event';

export interface LivingDossierDecision {
  readonly civilTime: CivilTimeDecision;
  readonly featuredEvent: ChangeEvent | null;
  readonly phase: LivingDossierPhase;
}

export interface CivilTimeDecision {
  readonly abbreviation: string;
  readonly daylightSavingStatus: DaylightSavingStatus;
  readonly friendlyZoneLabel: string;
  readonly localDateTime: LocalDateTime;
  readonly nextChangeEvent: ChangeEvent | null;
  readonly utcOffsetSeconds: number;
  readonly zoneId: string;
}

export class CivilTimeDecisionUnavailableError extends Error {
  constructor(problem: string) {
    super(`Civil-time decision unavailable: ${problem}`);
    this.name = 'CivilTimeDecisionUnavailableError';
  }
}

function localDateTimeAt(
  instantMilliseconds: number,
  utcOffsetSeconds: number,
): LocalDateTime {
  const local = new Date(instantMilliseconds + utcOffsetSeconds * 1_000);

  return {
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    month: local.getUTCMonth() + 1,
    year: local.getUTCFullYear(),
  };
}

function activeState(
  initial: TimeZoneState,
  transitions: readonly TimeZoneTransition[],
  instantMilliseconds: number,
) {
  let state = initial;

  for (const transition of transitions) {
    if (Date.parse(transition.at) > instantMilliseconds) {
      break;
    }
    state = transition;
  }

  return state;
}

function nextTransition(
  transitions: readonly TimeZoneTransition[],
  instantMilliseconds: number,
) {
  return transitions.find(
    (transition) => Date.parse(transition.at) > instantMilliseconds,
  );
}

function changeEventFromTransition(
  transition: TimeZoneTransition,
  instantMilliseconds: number,
): ChangeEvent {
  return {
    abbreviationAfter: transition.abbreviation,
    at: transition.at,
    direction:
      transition.utcOffsetSeconds > transition.offsetBeforeSeconds
        ? 'Forward Change'
        : 'Backward Change',
    localAfter: localDateTimeAt(
      Date.parse(transition.at),
      transition.utcOffsetSeconds,
    ),
    localBefore: localDateTimeAt(
      Date.parse(transition.at),
      transition.offsetBeforeSeconds,
    ),
    offsetAfterSeconds: transition.utcOffsetSeconds,
    offsetBeforeSeconds: transition.offsetBeforeSeconds,
    offsetDeltaSeconds:
      transition.utcOffsetSeconds - transition.offsetBeforeSeconds,
    secondsUntil: (Date.parse(transition.at) - instantMilliseconds) / 1_000,
  };
}

export function decideCivilTime(
  pack: ActivatedTimeZoneDataPack,
  zoneId: string,
  now: Date,
): CivilTimeDecision {
  assertActivatedTimeZoneDataPack(pack);

  const instantMilliseconds = now.getTime();
  if (!Number.isFinite(instantMilliseconds)) {
    throw new CivilTimeDecisionUnavailableError('current instant is invalid');
  }

  const coverageStartMilliseconds = Date.parse(pack.coverage.startsAt);
  const validityHorizonMilliseconds = Date.parse(pack.coverage.validUntil);
  if (
    instantMilliseconds < coverageStartMilliseconds ||
    instantMilliseconds > validityHorizonMilliseconds
  ) {
    throw new CivilTimeDecisionUnavailableError(
      'instant falls outside pack coverage and Validity Horizon',
    );
  }

  const zone = pack.zones.find((candidate) => candidate.id === zoneId);
  if (zone === undefined) {
    throw new CivilTimeDecisionUnavailableError(`unsupported zone ${zoneId}`);
  }

  const state = activeState(
    zone.initial,
    zone.transitions,
    instantMilliseconds,
  );
  const transition = nextTransition(zone.transitions, instantMilliseconds);
  const nextChangeEvent =
    transition === undefined
      ? null
      : changeEventFromTransition(transition, instantMilliseconds);

  return {
    abbreviation: state.abbreviation,
    daylightSavingStatus: state.daylightSaving
      ? 'Daylight saving time applies'
      : 'Standard time applies',
    friendlyZoneLabel: zone.friendlyLabel,
    localDateTime: localDateTimeAt(instantMilliseconds, state.utcOffsetSeconds),
    nextChangeEvent,
    utcOffsetSeconds: state.utcOffsetSeconds,
    zoneId: zone.id,
  };
}

const daySeconds = 24 * 60 * 60;
const aftermathSeconds = 2 * daySeconds;
const approachingSeconds = 28 * daySeconds;
const reminderWeekSeconds = 7 * daySeconds;

/**
 * Selects one Living Dossier phase from activated pack transitions.
 *
 * Boundaries are deliberately asymmetric: an event is upcoming only while
 * secondsUntil is positive; 28 days, 7 days, and 24 hours belong to the phase
 * beginning at that boundary. The event instant begins aftermath, which lasts
 * while elapsed time is less than 48 hours. At exactly 48 hours the normal
 * next-event dossier resumes. There is no interval or "underway" phase.
 */
export function decideLivingDossier(
  pack: ActivatedTimeZoneDataPack,
  zoneId: string,
  now: Date,
): LivingDossierDecision {
  const civilTime = decideCivilTime(pack, zoneId, now);
  const instantMilliseconds = now.getTime();
  const zone = pack.zones.find(
    (candidate) => candidate.id === civilTime.zoneId,
  )!;
  const previousTransition = [...zone.transitions]
    .reverse()
    .find((transition) => Date.parse(transition.at) <= instantMilliseconds);

  if (previousTransition !== undefined) {
    const elapsedSeconds =
      (instantMilliseconds - Date.parse(previousTransition.at)) / 1_000;
    if (elapsedSeconds >= 0 && elapsedSeconds < aftermathSeconds) {
      return {
        civilTime,
        featuredEvent: changeEventFromTransition(
          previousTransition,
          instantMilliseconds,
        ),
        phase: 'aftermath',
      };
    }
  }

  const event = civilTime.nextChangeEvent;
  if (event === null) {
    return { civilTime, featuredEvent: null, phase: 'no-event' };
  }

  const phase: LivingDossierPhase =
    event.secondsUntil <= daySeconds
      ? 'reminder-day'
      : event.secondsUntil <= reminderWeekSeconds
        ? 'reminder-week'
        : event.secondsUntil <= approachingSeconds
          ? 'approaching'
          : 'ordinary';

  return { civilTime, featuredEvent: event, phase };
}
