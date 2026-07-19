import { useEffect, useState } from 'react';
import {
  ScrollView,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { createStatusViewModel } from './status-view-model';

const palettes = {
  light: {
    accent: '#E5482D',
    background: '#F4EEDC',
    ink: '#111B2C',
    rule: '#A9A38F',
    secondaryInk: '#596273',
    surface: '#FFF9EA',
  },
  dark: {
    accent: '#FF6A4D',
    background: '#081426',
    ink: '#F6F0DE',
    rule: '#405067',
    secondaryInk: '#B6C0CF',
    surface: '#101F35',
  },
} as const;

interface StatusScreenProps {
  readonly now?: Date;
  readonly onChooseZone?: () => void;
  readonly uses24hourClock?: boolean;
  readonly zoneId?: string;
}

function useCurrentInstant(fixedNow: Date | undefined) {
  const [liveNow, setLiveNow] = useState(() => fixedNow ?? new Date());

  useEffect(() => {
    if (fixedNow !== undefined) {
      return;
    }

    const timer = setInterval(() => setLiveNow(new Date()), 1_000);
    return () => clearInterval(timer);
  }, [fixedNow]);

  return fixedNow ?? liveNow;
}

export default function StatusScreen({
  now,
  onChooseZone,
  uses24hourClock = false,
  zoneId = 'Australia/Sydney',
}: StatusScreenProps) {
  const appearance = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = palettes[appearance];
  const currentInstant = useCurrentInstant(now);
  const viewModel = createStatusViewModel(
    zoneId,
    currentInstant,
    uses24hourClock,
  );

  return (
    <SafeAreaView
      edges={['top', 'right', 'bottom', 'left']}
      style={[styles.safeArea, { backgroundColor: palette.background }]}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View
          accessibilityLabel="Daylight Saviour status document"
          style={[styles.utilityHeader, { borderBottomColor: palette.rule }]}
        >
          <Text style={[styles.documentLabel, { color: palette.secondaryInk }]}>
            DAYLIGHT SAVIOUR · STATUS RECORD
          </Text>
          <Text style={[styles.reference, { color: palette.accent }]}>
            WI—03
          </Text>
        </View>

        <Pressable
          accessibilityHint={
            onChooseZone === undefined
              ? undefined
              : 'Opens Australian Home Time Zone selection'
          }
          accessibilityLabel={`Home Time Zone, ${viewModel.friendlyZoneLabel}, ${viewModel.zoneId}`}
          accessibilityRole={onChooseZone === undefined ? undefined : 'button'}
          disabled={onChooseZone === undefined}
          onPress={onChooseZone}
          style={[styles.card, { backgroundColor: palette.surface }]}
        >
          <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
            HOME TIME ZONE
          </Text>
          <Text style={[styles.zone, { color: palette.ink }]}>
            {viewModel.friendlyZoneLabel}
          </Text>
          <Text style={[styles.identifier, { color: palette.secondaryInk }]}>
            {viewModel.zoneId}
          </Text>
        </Pressable>

        {viewModel.availability === 'ready' ? (
          <>
            <View style={styles.statusSection}>
              <Text style={[styles.clock, { color: palette.ink }]}>
                {viewModel.clock}
              </Text>
              <Text
                style={[styles.identifier, { color: palette.secondaryInk }]}
              >
                {viewModel.abbreviation} · {viewModel.currentOffset} · HOME TIME
                ZONE
              </Text>
              <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
                DAYLIGHT SAVING STATUS
              </Text>
              <Text
                accessibilityRole="header"
                style={[styles.status, { color: palette.ink }]}
              >
                {viewModel.status}
              </Text>
              <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[styles.rule, { backgroundColor: palette.accent }]}
              />
            </View>

            <View
              accessible
              accessibilityLabel={
                viewModel.event === null
                  ? 'No Change Event is scheduled within current verified data'
                  : `${viewModel.event.direction}, ${viewModel.event.date}, ${viewModel.event.wallTimeChange}, offset ${viewModel.event.offsetChange}, in ${viewModel.event.countdown}`
              }
              style={[styles.eventCard, { borderColor: palette.rule }]}
            >
              <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
                NEXT CHANGE EVENT
              </Text>
              {viewModel.event === null ? (
                <Text
                  accessibilityRole="header"
                  style={[styles.eventDate, { color: palette.ink }]}
                >
                  No Change Event scheduled within verified data
                </Text>
              ) : (
                <>
                  <Text
                    accessibilityRole="header"
                    style={[styles.eventDate, { color: palette.ink }]}
                  >
                    {viewModel.event.date}
                  </Text>
                  <Text style={[styles.direction, { color: palette.accent }]}>
                    {viewModel.event.direction}
                  </Text>
                  <Text style={[styles.eventFact, { color: palette.ink }]}>
                    {viewModel.event.wallTimeChange}
                  </Text>
                  <Text style={[styles.eventFact, { color: palette.ink }]}>
                    {viewModel.event.offsetChange}
                  </Text>
                  <Text style={[styles.body, { color: palette.secondaryInk }]}>
                    Clocks move {viewModel.event.offsetAmount.toLowerCase()} ·
                    Home Time Zone
                  </Text>
                  <Text style={[styles.countdown, { color: palette.ink }]}>
                    In {viewModel.event.countdown}
                  </Text>
                </>
              )}
            </View>
          </>
        ) : (
          <View style={styles.statusSection}>
            <Text
              accessibilityRole="header"
              style={[styles.status, { color: palette.ink }]}
            >
              Civil-time decision unavailable
            </Text>
            <Text style={[styles.body, { color: palette.ink }]}>
              {viewModel.message}
            </Text>
          </View>
        )}

        <View
          accessible
          accessibilityLabel={`Time-Zone Data Pack ${viewModel.packVersion}, valid until ${viewModel.validUntil}`}
          style={[styles.footer, { borderTopColor: palette.rule }]}
        >
          <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
            VERIFIED OFFLINE DATA
          </Text>
          <Text style={[styles.body, { color: palette.ink }]}>
            Pack {viewModel.packVersion}
          </Text>
          <Text style={[styles.identifier, { color: palette.secondaryInk }]}>
            Validity Horizon · {viewModel.validUntil}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: {
    fontSize: 17,
    lineHeight: 25,
  },
  card: {
    gap: 8,
    padding: 24,
  },
  clock: {
    fontSize: 80,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
    letterSpacing: -4,
    lineHeight: 88,
  },
  content: {
    gap: 32,
    paddingHorizontal: 24,
    paddingVertical: 24,
  },
  countdown: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 28,
    paddingTop: 8,
  },
  direction: {
    fontSize: 18,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  documentLabel: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  eventCard: {
    borderWidth: StyleSheet.hairlineWidth,
    gap: 12,
    padding: 24,
  },
  eventDate: {
    fontSize: 30,
    fontWeight: '700',
    lineHeight: 36,
  },
  eventFact: {
    fontSize: 24,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    lineHeight: 30,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
    paddingTop: 16,
  },
  identifier: {
    fontSize: 14,
  },
  metadata: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.1,
  },
  reference: {
    fontSize: 13,
    fontWeight: '800',
  },
  rule: {
    height: 4,
    width: 72,
  },
  safeArea: {
    flex: 1,
  },
  status: {
    fontSize: 38,
    fontWeight: '800',
    letterSpacing: -1,
    lineHeight: 44,
  },
  statusSection: {
    gap: 12,
  },
  utilityHeader: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 16,
    paddingBottom: 16,
  },
  zone: {
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 34,
  },
});
