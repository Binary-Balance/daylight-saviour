import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ScrollView,
  StyleSheet,
  useColorScheme,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { daylightSaviourPalettes } from '../../theme';
import ChangeEventSection from './change-event-section';
import ChangeReminderNotificationContext from '../../../components/change-reminder-notification-context';
import CivilTimeReportHeader from './civil-time-report-header';
import DataFreshnessSection from './data-freshness-section';
import DaylightSavingStatusHero from './daylight-saving-status-hero';
import SettingsSheet from './settings-sheet';
import ChangeReminderSection from '../change-reminders/change-reminder-section';
import { productionChangeReminderAdapters } from '../change-reminders/change-reminder-production-adapters';
import { screenshotChangeReminderAdapters } from '../change-reminders/change-reminder-screenshot-adapters';
import { changeReminderTestBuildEnabled } from '../change-reminders/change-reminder-test-build';
import { screenshotModeEnabled } from '../screenshots/screenshot-mode';
import { createStatusViewModel } from './status-view-model';
import type { TimeZoneDataPackSnapshot } from '../time-zone-data/time-zone-data-manager';
import type { ReviewedNotificationTap } from '../change-reminders/change-reminder-notification-runtime';

const changeReminderAdapters = screenshotModeEnabled()
  ? screenshotChangeReminderAdapters
  : productionChangeReminderAdapters;

interface StatusScreenProps {
  readonly dataPackSnapshot: TimeZoneDataPackSnapshot;
  readonly now?: Date | undefined;
  readonly notificationTap?: ReviewedNotificationTap | null;
  readonly onAcknowledgeAftermath?: (eventAt: string) => void;
  readonly onChooseZone?: () => void;
  readonly onPermissionDialog?: () => void;
  readonly onRetryDataPack?: () => void | Promise<void>;
  // The caller does not update this when an Aftermath is acknowledged, so the
  // Aftermath stays on screen.
  readonly openingAcknowledgedEventAt?: string | null;
  readonly reducedMotion?: boolean;
  readonly secondaryCopySeed: string;
  readonly uses24hourClock?: boolean;
  readonly zoneId?: string;
}

function useCurrentInstant(fixedNow: Date | undefined) {
  const [liveNow, setLiveNow] = useState(() => fixedNow ?? new Date());

  useEffect(() => {
    if (fixedNow !== undefined) return;

    const timer = setInterval(() => setLiveNow(new Date()), 1_000);
    return () => clearInterval(timer);
  }, [fixedNow]);

  return fixedNow ?? liveNow;
}

function useReducedMotion(override: boolean | undefined) {
  const [systemPreference, setSystemPreference] = useState<boolean | null>(
    null,
  );

  useEffect(() => {
    if (override !== undefined) return;

    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (active) setSystemPreference(enabled);
      })
      .catch(() => {
        if (active) setSystemPreference(true);
      });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setSystemPreference,
    );

    return () => {
      active = false;
      subscription.remove();
    };
  }, [override]);

  return override ?? systemPreference;
}

export default function StatusScreen({
  dataPackSnapshot,
  now,
  notificationTap = null,
  onAcknowledgeAftermath,
  onChooseZone,
  onPermissionDialog,
  onRetryDataPack,
  openingAcknowledgedEventAt = null,
  reducedMotion: reducedMotionOverride,
  secondaryCopySeed,
  uses24hourClock = false,
  zoneId = 'Australia/Sydney',
}: StatusScreenProps) {
  const appearance = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = daylightSaviourPalettes[appearance];
  const currentInstant = useCurrentInstant(now);
  const reducedMotion = useReducedMotion(reducedMotionOverride);
  const acknowledgedDuringOpening = useRef<string | null>(null);
  const scrollView = useRef<ScrollView>(null);
  const viewModel = createStatusViewModel(
    dataPackSnapshot.pack,
    dataPackSnapshot.freshness,
    zoneId,
    currentInstant,
    uses24hourClock,
    secondaryCopySeed,
    openingAcknowledgedEventAt,
    notificationTap,
  );
  const aftermathEventAt =
    viewModel.availability === 'ready' && viewModel.phase === 'aftermath'
      ? (viewModel.event?.instant ?? null)
      : null;

  useEffect(() => {
    if (
      aftermathEventAt !== null &&
      acknowledgedDuringOpening.current !== aftermathEventAt
    ) {
      acknowledgedDuringOpening.current = aftermathEventAt;
      onAcknowledgeAftermath?.(aftermathEventAt);
    }
  }, [aftermathEventAt, onAcknowledgeAftermath]);

  // The report keeps its scroll position while the app is in the background,
  // so a reminder tap would otherwise put its notice off screen.
  useEffect(() => {
    if (notificationTap !== null) {
      scrollView.current?.scrollTo({ animated: false, y: 0 });
    }
  }, [notificationTap]);

  return (
    <SafeAreaView
      edges={['top', 'right', 'bottom', 'left']}
      style={[styles.safeArea, { backgroundColor: palette.background }]}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        ref={scrollView}
      >
        <CivilTimeReportHeader
          facts={{
            friendlyZoneLabel: viewModel.friendlyZoneLabel,
            zoneId: viewModel.zoneId,
          }}
          onChooseZone={onChooseZone}
          palette={palette}
        />

        <ChangeReminderNotificationContext
          context={viewModel.notificationContext}
          palette={palette}
          reducedMotion={reducedMotion}
        />

        {viewModel.availability === 'ready' ? (
          <DaylightSavingStatusHero
            facts={viewModel}
            palette={palette}
            reducedMotion={reducedMotion}
            statusTransitionKey={`${viewModel.status}:${viewModel.event?.relation ?? 'none'}`}
            uses24hourClock={uses24hourClock}
          />
        ) : null}

        <ChangeEventSection
          palette={palette}
          reducedMotion={reducedMotion}
          report={viewModel}
        />

        <ChangeReminderSection
          adapters={changeReminderAdapters}
          homeTimeZone={viewModel.zoneId}
          onPermissionDialog={onPermissionDialog}
          palette={palette}
          testBuild={changeReminderTestBuildEnabled()}
          verifiedNoEvent={
            viewModel.availability === 'ready' && viewModel.phase === 'no-event'
          }
        />

        <DataFreshnessSection
          facts={{
            freshness: viewModel.freshness,
            packVersion: viewModel.packVersion,
            remoteEnabled: dataPackSnapshot.remoteEnabled,
            source: dataPackSnapshot.source,
            uses24hourClock,
            validUntil: viewModel.validUntil,
          }}
          onRetry={onRetryDataPack}
          palette={palette}
        />

        <SettingsSheet
          facts={{
            friendlyZoneLabel: viewModel.friendlyZoneLabel,
            packVersion: viewModel.packVersion,
          }}
          palette={palette}
          reducedMotion={reducedMotion}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 32,
    paddingBottom: 32,
    paddingHorizontal: 24,
    paddingTop: 24,
    position: 'relative',
  },
  safeArea: {
    flex: 1,
  },
});
