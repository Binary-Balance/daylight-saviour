import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ChangeDirection } from '@daylight-saviour/domain';

import { daylightSaviourPalettes } from '../../theme';
import { createDossierMotionRecipe } from './dossier-motion';
import { createStatusViewModel } from './status-view-model';

interface StatusScreenProps {
  readonly acknowledgedEventAt?: string | null;
  readonly now?: Date;
  readonly onAcknowledgeAftermath?: (eventAt: string) => void;
  readonly onChooseZone?: () => void;
  readonly reducedMotion?: boolean;
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

function useReducedMotion(override: boolean | undefined) {
  const [systemPreference, setSystemPreference] = useState<boolean | null>(
    null,
  );

  useEffect(() => {
    if (override !== undefined) return;

    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) setSystemPreference(enabled);
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

function SemanticEventMotion({
  children,
  direction,
  eventKey,
  reducedMotion,
  echo,
  echoColor,
}: {
  readonly children: ReactNode;
  readonly direction: ChangeDirection;
  readonly echo: string;
  readonly echoColor: string;
  readonly eventKey: string;
  readonly reducedMotion: boolean | null;
}) {
  const [opacity] = useState(() => new Animated.Value(0));
  const [travel] = useState(() => new Animated.Value(0));
  const [echoOpacity] = useState(() => new Animated.Value(0));
  const recipe = useMemo(
    () =>
      reducedMotion === null
        ? null
        : createDossierMotionRecipe(direction, reducedMotion),
    [direction, reducedMotion],
  );

  useEffect(() => {
    if (recipe === null) return;

    opacity.stopAnimation();
    travel.stopAnimation();
    echoOpacity.stopAnimation();
    opacity.setValue(0);
    travel.setValue(recipe.travel);
    echoOpacity.setValue(recipe.decorativeEcho ? 0.35 : 0);

    const animations = [
      Animated.timing(opacity, {
        duration: recipe.durationMs,
        toValue: 1,
        useNativeDriver: true,
      }),
      Animated.timing(travel, {
        duration: recipe.durationMs,
        toValue: 0,
        useNativeDriver: true,
      }),
    ];
    if (recipe.decorativeEcho) {
      animations.push(
        Animated.timing(echoOpacity, {
          duration: recipe.durationMs,
          toValue: 0,
          useNativeDriver: true,
        }),
      );
    }

    const animation = Animated.parallel(animations);
    animation.start();
    return () => animation.stop();
  }, [echoOpacity, eventKey, opacity, recipe, travel]);

  return (
    <View
      style={styles.motionFrame}
      testID={
        recipe === null ? 'motion-awaiting-preference' : `motion-${recipe.kind}`
      }
    >
      {recipe?.decorativeEcho ? (
        <Animated.Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.decorativeEcho,
            {
              color: echoColor,
              opacity: echoOpacity,
              transform: [{ translateX: travel }],
            },
          ]}
        >
          {echo}
        </Animated.Text>
      ) : null}
      <Animated.View
        testID="semantic-event-content"
        style={{
          opacity,
          transform: [
            direction === 'Forward Change'
              ? { translateY: travel }
              : { translateX: travel },
          ],
        }}
      >
        {children}
      </Animated.View>
    </View>
  );
}

export default function StatusScreen({
  acknowledgedEventAt = null,
  now,
  onAcknowledgeAftermath,
  onChooseZone,
  reducedMotion: reducedMotionOverride,
  uses24hourClock = false,
  zoneId = 'Australia/Sydney',
}: StatusScreenProps) {
  const appearance = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = daylightSaviourPalettes[appearance];
  const currentInstant = useCurrentInstant(now);
  const reducedMotion = useReducedMotion(reducedMotionOverride);
  const { width } = useWindowDimensions();
  const clockSize = Math.min(104, Math.max(72, (width - 48) * 0.25));
  const viewModel = createStatusViewModel(
    zoneId,
    currentInstant,
    uses24hourClock,
    acknowledgedEventAt,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const acknowledgedDuringOpening = useRef<string | null>(null);
  const aftermathEventAt =
    viewModel.availability === 'ready' && viewModel.phase === 'aftermath'
      ? (viewModel.event?.instant ?? null)
      : null;
  const freshnessDescription =
    viewModel.freshness === 'current'
      ? 'bundled data current'
      : viewModel.freshness === 'expired'
        ? 'validity expired'
        : 'freshness not determined, civil-time decision unavailable';

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
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.utilityHeader, { borderBottomColor: palette.rule }]}
        >
          <Text style={[styles.documentLabel, { color: palette.secondaryInk }]}>
            DAYLIGHT SAVIOUR · CIVIL TIME RECORD
          </Text>
          <Text style={[styles.reference, { color: palette.accent }]}>
            DS—04
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
          style={({ pressed }) => [
            styles.zoneControl,
            {
              backgroundColor: palette.surface,
              borderColor: palette.rule,
              opacity: pressed ? 0.78 : 1,
            },
          ]}
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
              <View
                accessibilityLabel={`Home Time Zone current time, ${viewModel.clock}, ${viewModel.abbreviation}, ${viewModel.currentOffset}`}
                accessibilityLiveRegion="none"
                accessible
              >
                <Text
                  accessible={false}
                  style={[
                    styles.clock,
                    {
                      color: palette.ink,
                      fontSize: clockSize,
                      lineHeight: clockSize * 1.05,
                    },
                  ]}
                >
                  {viewModel.clock}
                </Text>
                <Text
                  accessible={false}
                  style={[styles.identifier, { color: palette.secondaryInk }]}
                >
                  {viewModel.abbreviation} · {viewModel.currentOffset} · HOME
                  TIME ZONE
                </Text>
              </View>
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
                style={[
                  styles.stamp,
                  {
                    borderColor: palette.accent,
                    transform: [{ rotate: '-1deg' }],
                  },
                ]}
              >
                <Text style={[styles.stampText, { color: palette.accent }]}>
                  {viewModel.phaseLabel}
                </Text>
              </View>
              <Text
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[styles.secondaryLine, { color: palette.secondaryInk }]}
              >
                {viewModel.secondaryLine}
              </Text>
            </View>

            {viewModel.event === null ? (
              <View
                style={[
                  styles.noEventCard,
                  {
                    backgroundColor: palette.surface,
                    borderColor: palette.rule,
                  },
                ]}
                testID="no-event-dossier"
              >
                <Text
                  style={[styles.metadata, { color: palette.secondaryInk }]}
                >
                  CHANGE EVENT RECORD
                </Text>
                <Text
                  accessibilityRole="header"
                  style={[styles.eventDate, { color: palette.ink }]}
                >
                  No Change Event scheduled within verified data
                </Text>
                <Text style={[styles.body, { color: palette.ink }]}>
                  No countdown required. Your Home Time Zone remains on its
                  recorded offset.
                </Text>
                <Text
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={[styles.noEventMark, { color: palette.accent }]}
                >
                  ✓ CIVIL TIME LEFT IN PEACE
                </Text>
              </View>
            ) : (
              <SemanticEventMotion
                direction={viewModel.event.direction}
                echo={viewModel.event.wallTimeChange}
                echoColor={palette.secondaryInk}
                eventKey={`${viewModel.event.instant}:${viewModel.event.relation}`}
                reducedMotion={reducedMotion}
              >
                <View
                  style={[styles.eventCard, { borderColor: palette.rule }]}
                  testID={`${viewModel.phase}-dossier`}
                >
                  <Text
                    style={[styles.metadata, { color: palette.secondaryInk }]}
                  >
                    {viewModel.event.relation === 'completed'
                      ? 'RECENT CHANGE EVENT'
                      : 'NEXT CHANGE EVENT'}
                  </Text>
                  <Text
                    accessibilityRole="header"
                    style={[styles.eventDate, { color: palette.ink }]}
                  >
                    {viewModel.event.date}
                  </Text>
                  <View style={styles.directionRow}>
                    <Text style={[styles.direction, { color: palette.accent }]}>
                      {viewModel.event.direction}
                    </Text>
                    <Text
                      accessibilityElementsHidden
                      importantForAccessibility="no-hide-descendants"
                      style={[styles.direction, { color: palette.accent }]}
                    >
                      {viewModel.event.direction === 'Forward Change'
                        ? '→'
                        : '←'}
                    </Text>
                  </View>
                  <View style={styles.equationGroup}>
                    <Text
                      style={[
                        styles.equationLabel,
                        { color: palette.secondaryInk },
                      ]}
                    >
                      LOCAL TIME
                    </Text>
                    <Text style={[styles.eventFact, { color: palette.ink }]}>
                      {viewModel.event.wallTimeChange}
                    </Text>
                    <Text
                      style={[
                        styles.equationLabel,
                        { color: palette.secondaryInk },
                      ]}
                    >
                      UTC OFFSET
                    </Text>
                    <Text style={[styles.eventFact, { color: palette.ink }]}>
                      {viewModel.event.offsetChange}
                    </Text>
                    <Text
                      style={[styles.body, { color: palette.secondaryInk }]}
                    >
                      Clocks move {viewModel.event.offsetAmount.toLowerCase()} ·
                      Home Time Zone
                    </Text>
                  </View>
                  {viewModel.event.countdown === null ? (
                    <View style={styles.aftermathFact}>
                      <Text
                        style={[
                          styles.metadata,
                          { color: palette.secondaryInk },
                        ]}
                      >
                        CHANGE COMPLETED
                      </Text>
                      <Text style={[styles.countdown, { color: palette.ink }]}>
                        {viewModel.event.elapsed === 'now'
                          ? 'Applied now'
                          : `${viewModel.event.elapsed} ago`}
                      </Text>
                    </View>
                  ) : (
                    <View>
                      <Text
                        accessibilityRole="header"
                        style={[
                          styles.metadata,
                          { color: palette.secondaryInk },
                        ]}
                      >
                        COUNTDOWN
                      </Text>
                      <Text
                        accessibilityLabel={`Countdown, ${viewModel.event.countdown} until Change Event`}
                        style={[styles.countdown, { color: palette.ink }]}
                      >
                        In {viewModel.event.countdown}
                      </Text>
                    </View>
                  )}
                </View>
              </SemanticEventMotion>
            )}
          </>
        ) : (
          <View
            accessibilityRole="alert"
            style={[
              styles.expiredCard,
              { backgroundColor: palette.surface, borderColor: palette.accent },
            ]}
            testID={
              viewModel.freshness === 'expired'
                ? 'expired-dossier'
                : 'unavailable-dossier'
            }
          >
            <Text style={[styles.metadata, { color: palette.accent }]}>
              {viewModel.freshness === 'expired'
                ? 'REFRESH REQUIRED'
                : 'DECISION UNAVAILABLE'}
            </Text>
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
          accessibilityLabel={`Time-Zone Data Pack ${viewModel.packVersion}, ${freshnessDescription}, valid until ${viewModel.validUntil}`}
          style={[styles.footer, { borderTopColor: palette.rule }]}
        >
          <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
            DATA FRESHNESS
          </Text>
          <Text style={[styles.body, { color: palette.ink }]}>
            {viewModel.freshness === 'expired'
              ? 'Validity Horizon passed'
              : viewModel.freshness === 'decision-unavailable'
                ? 'Freshness not determined · decision unavailable'
                : 'Bundled data current'}
          </Text>
          <Text style={[styles.identifier, { color: palette.secondaryInk }]}>
            Pack {viewModel.packVersion} · Valid through {viewModel.validUntil}
          </Text>
        </View>

        <Pressable
          accessibilityHint="Opens compact app and data details"
          accessibilityLabel="Settings"
          accessibilityRole="button"
          onPress={() => setSettingsOpen(true)}
          style={({ pressed }) => [
            styles.settingsButton,
            {
              borderColor: palette.rule,
              backgroundColor: palette.background,
              opacity: pressed ? 0.72 : 1,
            },
          ]}
        >
          <Text style={[styles.settingsButtonText, { color: palette.ink }]}>
            SETTINGS
          </Text>
        </Pressable>
      </ScrollView>

      <Modal
        animationType={reducedMotion === false ? 'fade' : 'none'}
        onRequestClose={() => setSettingsOpen(false)}
        transparent
        visible={settingsOpen}
      >
        <SafeAreaView
          edges={['right', 'bottom', 'left']}
          style={styles.modalSafeArea}
          testID="settings-modal-safe-area"
        >
          <View style={styles.modalBackdrop}>
            <View
              accessibilityViewIsModal
              style={[
                styles.settingsSheet,
                { backgroundColor: palette.surface },
              ]}
            >
              <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
                APP DETAILS
              </Text>
              <Text
                accessibilityRole="header"
                style={[styles.eventDate, { color: palette.ink }]}
              >
                Settings
              </Text>
              <Text style={[styles.body, { color: palette.ink }]}>
                Home Time Zone: {viewModel.friendlyZoneLabel}
              </Text>
              <Text style={[styles.body, { color: palette.ink }]}>
                Time-Zone Data Pack: {viewModel.packVersion}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setSettingsOpen(false)}
                style={[
                  styles.closeButton,
                  { backgroundColor: palette.accent },
                ]}
              >
                <Text style={styles.closeButtonText}>Close settings</Text>
              </Pressable>
            </View>
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  aftermathFact: {
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 4,
    paddingTop: 16,
  },
  body: {
    fontSize: 17,
    lineHeight: 25,
  },
  clock: {
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
    letterSpacing: -4,
  },
  closeButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 20,
  },
  closeButtonText: {
    color: '#FFF9EA',
    fontSize: 17,
    fontWeight: '800',
  },
  content: {
    gap: 32,
    paddingBottom: 32,
    paddingHorizontal: 24,
    paddingTop: 24,
    position: 'relative',
  },
  countdown: {
    fontSize: 28,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
    lineHeight: 34,
    paddingTop: 6,
  },
  decorativeEcho: {
    fontSize: 24,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
    left: 24,
    position: 'absolute',
    top: 144,
    zIndex: 0,
  },
  direction: {
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 24,
    textTransform: 'uppercase',
  },
  directionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  documentLabel: {
    flex: 1,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  equationGroup: {
    gap: 6,
    paddingTop: 4,
  },
  equationLabel: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    paddingTop: 6,
  },
  eventCard: {
    borderLeftWidth: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 12,
    padding: 24,
    zIndex: 1,
  },
  eventDate: {
    fontSize: 30,
    fontWeight: '700',
    lineHeight: 37,
  },
  eventFact: {
    fontSize: 24,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    lineHeight: 31,
  },
  expiredCard: {
    borderWidth: 2,
    gap: 16,
    padding: 24,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 6,
    paddingTop: 16,
  },
  identifier: {
    fontSize: 14,
    lineHeight: 20,
  },
  metadata: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.1,
    lineHeight: 18,
  },
  modalBackdrop: {
    backgroundColor: 'rgba(8, 20, 38, 0.72)',
    flex: 1,
    justifyContent: 'flex-end',
    padding: 16,
  },
  modalSafeArea: {
    flex: 1,
  },
  motionFrame: {
    position: 'relative',
  },
  noEventCard: {
    borderBottomWidth: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 16,
    padding: 24,
  },
  noEventMark: {
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0.8,
    paddingTop: 8,
  },
  reference: {
    fontSize: 13,
    fontWeight: '900',
  },
  safeArea: {
    flex: 1,
  },
  secondaryLine: {
    fontSize: 17,
    fontStyle: 'italic',
    lineHeight: 25,
    maxWidth: 560,
  },
  settingsButton: {
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 72,
    paddingHorizontal: 10,
    position: 'absolute',
    right: 24,
    top: 12,
  },
  settingsButtonText: {
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  settingsSheet: {
    gap: 16,
    padding: 24,
  },
  stamp: {
    alignSelf: 'flex-start',
    borderWidth: 2,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  stampText: {
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 1,
  },
  status: {
    fontSize: 38,
    fontWeight: '800',
    letterSpacing: -1,
    lineHeight: 45,
  },
  statusSection: {
    gap: 12,
  },
  utilityHeader: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 16,
    minHeight: 48,
    paddingBottom: 16,
    paddingRight: 92,
  },
  zone: {
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 35,
  },
  zoneControl: {
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
    minHeight: 44,
    padding: 24,
  },
});
