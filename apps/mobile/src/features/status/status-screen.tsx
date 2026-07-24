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
import CivilTimeReportHeader from './civil-time-report-header';
import DataFreshnessSection from './data-freshness-section';
import DaylightSavingStatusHero from './daylight-saving-status-hero';
import SettingsSheet from './settings-sheet';
import ChangeReminderSection from '../change-reminders/change-reminder-section';
import { productionChangeReminderAdapters } from '../change-reminders/change-reminder-production-adapters';
import { createStatusViewModel } from './status-view-model';
import type { TimeZoneDataPackSnapshot } from '../time-zone-data/time-zone-data-manager';

interface StatusScreenProps {
  readonly acknowledgedEventAt?: string | null;
  readonly dataPackSnapshot: TimeZoneDataPackSnapshot;
  readonly now?: Date;
  readonly onAcknowledgeAftermath?: (eventAt: string) => void;
  readonly onChooseZone?: () => void;
  readonly onRetryDataPack?: () => void | Promise<void>;
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
  acknowledgedEventAt = null,
  dataPackSnapshot,
  now,
  onAcknowledgeAftermath,
  onChooseZone,
  onRetryDataPack,
  reducedMotion: reducedMotionOverride,
  secondaryCopySeed,
  uses24hourClock = false,
  zoneId = 'Australia/Sydney',
}: StatusScreenProps) {
  const appearance = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = daylightSaviourPalettes[appearance];
  const currentInstant = useCurrentInstant(now);
  const reducedMotion = useReducedMotion(reducedMotionOverride);
  const [openingAcknowledgedEventAt] = useState(acknowledgedEventAt);
  const acknowledgedDuringOpening = useRef<string | null>(null);
  const viewModel = createStatusViewModel(
    dataPackSnapshot.pack,
    dataPackSnapshot.freshness,
    zoneId,
    currentInstant,
    uses24hourClock,
    secondaryCopySeed,
    openingAcknowledgedEventAt,
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

  return (
    <SafeAreaView
      edges={['top', 'right', 'bottom', 'left']}
      style={[styles.safeArea, { backgroundColor: palette.background }]}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        <CivilTimeReportHeader
          facts={{
            friendlyZoneLabel: viewModel.friendlyZoneLabel,
            packVersion: viewModel.packVersion,
            zoneId: viewModel.zoneId,
          }}
          onChooseZone={onChooseZone}
          palette={palette}
        />

        {viewModel.availability === 'ready' ? (
          <DaylightSavingStatusHero
            facts={viewModel}
            palette={palette}
            uses24hourClock={uses24hourClock}
          />
        ) : null}

        <ChangeEventSection
          palette={palette}
          reducedMotion={reducedMotion}
          report={viewModel}
        />

        <ChangeReminderSection
          adapters={productionChangeReminderAdapters}
          homeTimeZone={viewModel.zoneId}
          palette={palette}
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
