import {
  assertActivatedTimeZoneDataPack,
  type ActivatedTimeZoneDataPack,
  type TimeZoneData,
  type TimeZoneState,
  type TimeZoneTransition,
} from '@daylight-saviour/contracts';

export interface LocalDateTime {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly month: number;
  readonly year: number;
}

export type ChangeDirection = 'Forward Change' | 'Backward Change';

export class CivilTimeDecisionUnavailableError extends Error {
  readonly reason: CivilTimeDecisionUnavailableReason;

  constructor(reason: CivilTimeDecisionUnavailableReason, problem: string) {
    super(`Civil-time decision unavailable: ${problem}`);
    this.name = 'CivilTimeDecisionUnavailableError';
    this.reason = reason;
  }
}

export type CivilTimeDecisionUnavailableReason =
  | 'invalid-instant'
  | 'before-coverage'
  | 'validity-expired'
  | 'unsupported-zone';

export function civilTimeInputAt(
  pack: ActivatedTimeZoneDataPack,
  zoneId: string,
  now: Date,
): { readonly instantMilliseconds: number; readonly zone: TimeZoneData } {
  assertActivatedTimeZoneDataPack(pack);

  const instantMilliseconds = now.getTime();
  if (!Number.isFinite(instantMilliseconds)) {
    throw new CivilTimeDecisionUnavailableError(
      'invalid-instant',
      'current instant is invalid',
    );
  }

  const coverageStartMilliseconds = Date.parse(pack.coverage.startsAt);
  const validityHorizonMilliseconds = Date.parse(pack.coverage.validUntil);
  if (instantMilliseconds < coverageStartMilliseconds) {
    throw new CivilTimeDecisionUnavailableError(
      'before-coverage',
      'instant falls before pack coverage',
    );
  }
  if (instantMilliseconds > validityHorizonMilliseconds) {
    throw new CivilTimeDecisionUnavailableError(
      'validity-expired',
      'instant falls after the Validity Horizon',
    );
  }

  const zone = pack.zones.find((candidate) => candidate.id === zoneId);
  if (zone === undefined) {
    throw new CivilTimeDecisionUnavailableError(
      'unsupported-zone',
      `unsupported zone ${zoneId}`,
    );
  }

  return { instantMilliseconds, zone };
}

export function localDateTimeAt(
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

export function stateAt(
  initial: TimeZoneState,
  transitions: readonly TimeZoneTransition[],
  instantMilliseconds: number,
): TimeZoneState {
  let state = initial;

  for (const transition of transitions) {
    if (Date.parse(transition.at) > instantMilliseconds) break;
    state = transition;
  }

  return state;
}

export function nextTransition(
  transitions: readonly TimeZoneTransition[],
  instantMilliseconds: number,
): TimeZoneTransition | undefined {
  return transitions.find(
    (transition) => Date.parse(transition.at) > instantMilliseconds,
  );
}
