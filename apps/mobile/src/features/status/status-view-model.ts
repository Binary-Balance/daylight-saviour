import {
  CivilTimeDecisionUnavailableError,
  decideLivingDossier,
  getAustralianZone,
  type ChangeDirection,
  type CivilTimeDecisionUnavailableReason,
  type DaylightSavingStatus,
  type LivingDossierPhase,
} from '@daylight-saviour/domain';
import type { ActivatedTimeZoneDataPack } from '@daylight-saviour/contracts';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import type { TimeZoneDataPackFreshness } from '../time-zone-data/time-zone-data-manager';

export type StatusViewModel =
  | {
      readonly availability: 'ready';
      readonly abbreviation: string;
      readonly clock: string;
      readonly currentOffset: string;
      readonly event: {
        readonly countdown: string | null;
        readonly countdownAccessibilityLabel: string | null;
        readonly date: string;
        readonly direction: ChangeDirection;
        readonly elapsed: string | null;
        readonly instant: string;
        readonly clockMovement: string;
        readonly offsetChange: string;
        readonly relation: 'completed' | 'upcoming';
        readonly wallTimeChange: string;
      } | null;
      readonly friendlyZoneLabel: string;
      readonly freshness: TimeZoneDataPackFreshness;
      readonly packVersion: string;
      readonly phase: LivingDossierPhase;
      readonly phaseLabel: string;
      readonly secondaryLine: string;
      readonly status: DaylightSavingStatus;
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
  activePack: ActivatedTimeZoneDataPack,
  dataFreshness: TimeZoneDataPackFreshness,
  zoneId: string,
  now: Date,
  uses24hourClock: boolean,
  installationSeed: string,
  acknowledgedEventAt: string | null = null,
): StatusViewModel {
  const packDetails = {
    packVersion: activePack.packVersion,
    validUntil: activePack.coverage.validUntil,
  } as const;
  try {
    const dossier = decideLivingDossier(activePack, zoneId, now, {
      acknowledgedEventAt,
    });
    const decision = dossier.civilTime;
    const event = dossier.featuredEvent;
    const completed = dossier.phase === 'aftermath';
    const hourCycleContext = {
      homeTimeZone: decision.zoneId,
      uses24hourClock,
    } as const;

    return {
      availability: 'ready',
      abbreviation: decision.abbreviation,
      clock: copy.livingDossier.clock.format({
        context: hourCycleContext,
        localDateTime: decision.localDateTime,
      }),
      currentOffset: copy.livingDossier.clock.utcOffset(
        decision.utcOffsetSeconds,
      ),
      event:
        event === null
          ? null
          : {
              countdown: completed
                ? null
                : copy.livingDossier.changeEvent.countdown(event.secondsUntil),
              countdownAccessibilityLabel: completed
                ? null
                : copy.livingDossier.accessibility.countdown(
                    event.secondsUntil,
                  ),
              date: copy.livingDossier.changeEvent.date(event.localAfter),
              direction: event.direction,
              elapsed: completed
                ? copy.livingDossier.changeEvent.elapsed(event.secondsUntil)
                : null,
              instant: event.at,
              clockMovement: copy.livingDossier.changeEvent.clocksMove(
                event.offsetDeltaSeconds,
              ),
              offsetChange: copy.livingDossier.changeEvent.offsetChange({
                afterSeconds: event.offsetAfterSeconds,
                beforeSeconds: event.offsetBeforeSeconds,
              }),
              relation: completed ? 'completed' : 'upcoming',
              wallTimeChange: copy.livingDossier.changeEvent.localTimeChange({
                after: event.localAfter,
                before: event.localBefore,
                context: hourCycleContext,
              }),
            },
      friendlyZoneLabel: decision.friendlyZoneLabel,
      freshness: dataFreshness,
      ...packDetails,
      phase: dossier.phase,
      phaseLabel: copy.livingDossier.phaseLabel(dossier.phase),
      secondaryLine: copy.livingDossier.secondary.select({
        event:
          event === null
            ? null
            : { direction: event.direction, instant: event.at },
        installationSeed,
        localDate: decision.localDateTime,
        phase: dossier.phase,
        status: decision.daylightSavingStatus,
        zoneId: decision.zoneId,
      }),
      status: decision.daylightSavingStatus,
      zoneId: decision.zoneId,
    };
  } catch (error) {
    if (!(error instanceof CivilTimeDecisionUnavailableError)) {
      throw error;
    }

    const unavailableFreshness: Record<
      CivilTimeDecisionUnavailableReason,
      'decision-unavailable' | 'expired'
    > = {
      'before-coverage': 'decision-unavailable',
      'invalid-instant': 'decision-unavailable',
      'unsupported-zone': 'decision-unavailable',
      'validity-expired': 'expired',
    };
    const freshness = unavailableFreshness[error.reason];

    return {
      availability: 'unavailable',
      friendlyZoneLabel:
        getAustralianZone(zoneId)?.friendlyLabel ??
        copy.livingDossier.decisionUnavailable.fallbackZoneLabel,
      freshness,
      message: copy.livingDossier.decisionUnavailable.message(error.reason),
      ...packDetails,
      unavailabilityReason: error.reason,
      zoneId,
    };
  }
}
