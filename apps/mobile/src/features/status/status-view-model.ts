import {
  CivilTimeDecisionUnavailableError,
  createCivilTimeReport,
  getAustralianZone,
  resolveCivilTimeReportEvent,
  type ChangeDirection,
  type CivilTimeDecisionUnavailableReason,
  type DaylightSavingStatus,
  type CivilTimeReportPhase,
} from '@daylight-saviour/domain';
import type { ActivatedTimeZoneDataPack } from '@daylight-saviour/contracts';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import type { TimeZoneDataPackFreshness } from '../time-zone-data/time-zone-data-manager';
import type { ChangeReminderTap } from '../change-reminders/change-reminder-notification-runtime';

export type ChangeReminderTapContext =
  | { readonly kind: 'matched'; readonly relation: 'past' | 'upcoming' }
  | { readonly kind: 'aged-out' }
  | { readonly kind: 'event-mismatch' }
  | { readonly kind: 'event-unavailable' }
  | { readonly kind: 'zone-mismatch' };

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
      readonly phase: CivilTimeReportPhase;
      readonly phaseLabel: string;
      readonly notificationContext: ChangeReminderTapContext | null;
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
      readonly notificationContext: ChangeReminderTapContext | null;
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
  notificationTap: ChangeReminderTap | null = null,
): StatusViewModel {
  const packDetails = {
    packVersion: activePack.packVersion,
    validUntil: activePack.coverage.validUntil,
  } as const;
  try {
    let notificationContext: ChangeReminderTapContext | null = null;
    let requestedEventAt: string | null = null;
    if (notificationTap !== null) {
      if (notificationTap.homeTimeZone !== zoneId) {
        notificationContext = { kind: 'zone-mismatch' };
      } else {
        const expectedDirection =
          notificationTap.changeDirection === 'forward'
            ? 'Forward Change'
            : 'Backward Change';
        const resolution = resolveCivilTimeReportEvent(
          activePack,
          zoneId,
          notificationTap.changeEventAt,
          expectedDirection,
          now,
        );
        if (
          resolution.kind === 'upcoming' ||
          resolution.kind === 'recent-past'
        ) {
          requestedEventAt = notificationTap.changeEventAt;
          notificationContext = {
            kind: 'matched',
            relation: resolution.kind === 'recent-past' ? 'past' : 'upcoming',
          };
        } else if (resolution.kind === 'aged-out') {
          notificationContext = { kind: 'aged-out' };
        } else if (resolution.kind === 'direction-mismatch') {
          notificationContext = { kind: 'event-mismatch' };
        } else {
          notificationContext = { kind: 'event-unavailable' };
        }
      }
    }
    const report = createCivilTimeReport(activePack, zoneId, now, {
      acknowledgedEventAt,
      requestedEventAt,
    });
    const decision = report.civilTime;
    const event = report.featuredEvent;
    const completed = report.phase === 'aftermath';
    const hourCycleContext = {
      homeTimeZone: decision.zoneId,
      uses24hourClock,
    } as const;

    return {
      availability: 'ready',
      abbreviation: decision.abbreviation,
      clock: copy.civilTimeReport.clock.format({
        context: hourCycleContext,
        localDateTime: decision.localDateTime,
      }),
      currentOffset: copy.civilTimeReport.clock.utcOffset(
        decision.utcOffsetSeconds,
      ),
      event:
        event === null
          ? null
          : {
              countdown: completed
                ? null
                : copy.civilTimeReport.changeEvent.countdown(
                    event.secondsUntil,
                  ),
              countdownAccessibilityLabel: completed
                ? null
                : copy.civilTimeReport.accessibility.countdown(
                    event.secondsUntil,
                  ),
              date: copy.civilTimeReport.changeEvent.date(event.localAfter),
              direction: event.direction,
              elapsed: completed
                ? copy.civilTimeReport.changeEvent.elapsed(event.secondsUntil)
                : null,
              instant: event.at,
              clockMovement: copy.civilTimeReport.changeEvent.clocksMove(
                event.offsetDeltaSeconds,
              ),
              offsetChange: copy.civilTimeReport.changeEvent.offsetChange({
                afterSeconds: event.offsetAfterSeconds,
                beforeSeconds: event.offsetBeforeSeconds,
              }),
              relation: completed ? 'completed' : 'upcoming',
              wallTimeChange: copy.civilTimeReport.changeEvent.localTimeChange({
                after: event.localAfter,
                before: event.localBefore,
                context: hourCycleContext,
              }),
            },
      friendlyZoneLabel: decision.friendlyZoneLabel,
      freshness: dataFreshness,
      ...packDetails,
      notificationContext,
      phase: report.phase,
      phaseLabel: copy.civilTimeReport.phaseLabel(report.phase),
      secondaryLine: copy.civilTimeReport.secondary.select({
        event:
          event === null
            ? null
            : { direction: event.direction, instant: event.at },
        installationSeed,
        localDate: decision.localDateTime,
        phase: report.phase,
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
        copy.civilTimeReport.decisionUnavailable.fallbackZoneLabel,
      freshness,
      message: copy.civilTimeReport.decisionUnavailable.message(error.reason),
      ...packDetails,
      notificationContext:
        notificationTap === null ? null : { kind: 'event-unavailable' },
      unavailabilityReason: error.reason,
      zoneId,
    };
  }
}
