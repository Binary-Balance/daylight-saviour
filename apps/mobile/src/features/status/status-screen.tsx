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
import { australianEnglish as copy } from '@daylight-saviour/copy';
import type { ChangeDirection } from '@daylight-saviour/domain';

import { daylightSaviourPalettes } from '../../theme';
import { createCivilTimeReportMotionRecipe } from './civil-time-report-motion';
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
  const [opacity] = useState(() => new Animated.Value(1));
  const [travel] = useState(() => new Animated.Value(0));
  const [echoOpacity] = useState(() => new Animated.Value(0));
  const recipe = useMemo(
    () =>
      reducedMotion === null
        ? null
        : createCivilTimeReportMotionRecipe(direction, reducedMotion),
    [direction, reducedMotion],
  );

  useEffect(() => {
    if (recipe === null) return;

    opacity.stopAnimation();
    travel.stopAnimation();
    echoOpacity.stopAnimation();
    opacity.setValue(recipe.kind === 'short-fade' ? 0.72 : 1);
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
  const { width } = useWindowDimensions();
  const clockSize = Math.min(104, Math.max(72, (width - 48) * 0.25));
  const viewModel = createStatusViewModel(
    dataPackSnapshot.pack,
    dataPackSnapshot.freshness,
    zoneId,
    currentInstant,
    uses24hourClock,
    secondaryCopySeed,
    openingAcknowledgedEventAt,
  );
  const [clockValue, clockMeridiem = null] = uses24hourClock
    ? [viewModel.availability === 'ready' ? viewModel.clock : '', null]
    : viewModel.availability === 'ready'
      ? viewModel.clock.split(' ')
      : ['', null];
  const [settingsOpen, setSettingsOpen] = useState(false);
  const acknowledgedDuringOpening = useRef<string | null>(null);
  const aftermathEventAt =
    viewModel.availability === 'ready' && viewModel.phase === 'aftermath'
      ? (viewModel.event?.instant ?? null)
      : null;
  const freshnessFacts = {
    freshness: viewModel.freshness,
    source: dataPackSnapshot.source,
  } as const;
  const freshnessText = copy.dataFreshness.status(freshnessFacts);

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
            {copy.civilTimeReport.document.label}
          </Text>
          <Text style={[styles.reference, { color: palette.accent }]}>
            {copy.civilTimeReport.document.reference}
          </Text>
        </View>

        <Pressable
          accessibilityHint={
            onChooseZone === undefined
              ? undefined
              : copy.civilTimeReport.accessibility.openZoneSelectionHint
          }
          accessibilityLabel={copy.civilTimeReport.accessibility.homeTimeZone({
            friendlyLabel: viewModel.friendlyZoneLabel,
            zoneId: viewModel.zoneId,
          })}
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
            {copy.civilTimeReport.homeTimeZoneHeading}
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
                accessibilityLabel={copy.civilTimeReport.accessibility.clock({
                  abbreviation: viewModel.abbreviation,
                  clock: viewModel.clock,
                  currentOffset: viewModel.currentOffset,
                })}
                accessibilityLiveRegion="none"
                accessible
              >
                <View
                  accessible={false}
                  style={styles.clockLine}
                  testID="clock-line"
                >
                  <Text
                    accessible={false}
                    maxFontSizeMultiplier={1.2}
                    style={[
                      styles.clock,
                      {
                        color: palette.ink,
                        fontSize: clockSize,
                        lineHeight: clockSize * 1.05,
                      },
                    ]}
                    testID="clock-value"
                  >
                    {clockValue}
                  </Text>
                  {clockMeridiem === null ? null : (
                    <Text
                      accessible={false}
                      maxFontSizeMultiplier={1.2}
                      style={[
                        styles.clockMeridiem,
                        {
                          color: palette.ink,
                          fontSize: clockSize * 0.3,
                          lineHeight: clockSize * 0.42,
                        },
                      ]}
                      testID="clock-meridiem"
                    >
                      {clockMeridiem}
                    </Text>
                  )}
                </View>
                <Text
                  accessible={false}
                  style={[styles.identifier, { color: palette.secondaryInk }]}
                >
                  {copy.civilTimeReport.clock.currentMetadata({
                    abbreviation: viewModel.abbreviation,
                    currentOffset: viewModel.currentOffset,
                  })}
                </Text>
              </View>
              <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
                {copy.civilTimeReport.daylightSavingStatusHeading}
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
                testID="no-event-civil-time-report"
              >
                <Text
                  style={[styles.metadata, { color: palette.secondaryInk }]}
                >
                  {copy.civilTimeReport.noEvent.label}
                </Text>
                <Text
                  accessibilityRole="header"
                  style={[styles.eventDate, { color: palette.ink }]}
                >
                  {copy.civilTimeReport.noEvent.heading}
                </Text>
                <Text style={[styles.body, { color: palette.ink }]}>
                  {copy.civilTimeReport.noEvent.body}
                </Text>
                <Text
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={[styles.noEventMark, { color: palette.accent }]}
                >
                  {copy.civilTimeReport.noEvent.mark}
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
                  testID={`${viewModel.phase}-civil-time-report`}
                >
                  <Text
                    style={[styles.metadata, { color: palette.secondaryInk }]}
                  >
                    {copy.civilTimeReport.changeEvent.heading(
                      viewModel.event.relation,
                    )}
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
                      {copy.civilTimeReport.changeEvent.directionArrow(
                        viewModel.event.direction,
                      )}
                    </Text>
                  </View>
                  <View style={styles.equationGroup}>
                    <Text
                      style={[
                        styles.equationLabel,
                        { color: palette.secondaryInk },
                      ]}
                    >
                      {copy.civilTimeReport.changeEvent.localTimeHeading}
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
                      {copy.civilTimeReport.changeEvent.utcOffsetHeading}
                    </Text>
                    <Text style={[styles.eventFact, { color: palette.ink }]}>
                      {viewModel.event.offsetChange}
                    </Text>
                    <Text
                      style={[styles.body, { color: palette.secondaryInk }]}
                    >
                      {viewModel.event.clockMovement}
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
                        {copy.civilTimeReport.changeEvent.completedHeading}
                      </Text>
                      <Text style={[styles.countdown, { color: palette.ink }]}>
                        {viewModel.event.elapsed}
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
                        {copy.civilTimeReport.changeEvent.countdownHeading}
                      </Text>
                      <Text
                        accessibilityLabel={
                          viewModel.event.countdownAccessibilityLabel ??
                          undefined
                        }
                        style={[styles.countdown, { color: palette.ink }]}
                      >
                        {viewModel.event.countdown}
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
                ? 'expired-civil-time-report'
                : 'unavailable-civil-time-report'
            }
          >
            <Text style={[styles.metadata, { color: palette.accent }]}>
              {copy.civilTimeReport.decisionUnavailable.label(
                viewModel.freshness,
              )}
            </Text>
            <Text
              accessibilityRole="header"
              style={[styles.status, { color: palette.ink }]}
            >
              {copy.civilTimeReport.decisionUnavailable.heading}
            </Text>
            <Text style={[styles.body, { color: palette.ink }]}>
              {viewModel.message}
            </Text>
          </View>
        )}

        <View style={[styles.footer, { borderTopColor: palette.rule }]}>
          <View
            accessible
            accessibilityLabel={copy.dataFreshness.accessibility.pack({
              ...freshnessFacts,
              packVersion: viewModel.packVersion,
              uses24hourClock,
              validUntil: viewModel.validUntil,
            })}
          >
            <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
              {copy.dataFreshness.heading}
            </Text>
            <Text style={[styles.body, { color: palette.ink }]}>
              {freshnessText}
            </Text>
            <Text style={[styles.identifier, { color: palette.secondaryInk }]}>
              {copy.dataFreshness.packDetails({
                packVersion: viewModel.packVersion,
                uses24hourClock,
                validUntil: viewModel.validUntil,
              })}
            </Text>
          </View>
          {onRetryDataPack === undefined ||
          !dataPackSnapshot.remoteEnabled ? null : (
            <Pressable
              accessibilityHint={copy.dataFreshness.accessibility.retryHint}
              accessibilityLabel={copy.dataFreshness.accessibility.retryLabel}
              accessibilityRole="button"
              disabled={viewModel.freshness === 'checking'}
              onPress={() => void onRetryDataPack()}
              style={[styles.retryButton, { borderColor: palette.rule }]}
            >
              <Text style={[styles.buttonText, { color: palette.ink }]}>
                {viewModel.freshness === 'checking'
                  ? copy.dataFreshness.retry.checkingButton
                  : copy.dataFreshness.retry.checkButton}
              </Text>
            </Pressable>
          )}
        </View>

        <Pressable
          accessibilityHint={copy.settings.accessibility.openHint}
          accessibilityLabel={copy.settings.accessibility.openLabel}
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
            {copy.settings.openButton}
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
                {copy.settings.appDetailsHeading}
              </Text>
              <Text
                accessibilityRole="header"
                style={[styles.eventDate, { color: palette.ink }]}
              >
                {copy.settings.heading}
              </Text>
              <Text style={[styles.body, { color: palette.ink }]}>
                {copy.settings.homeTimeZone(viewModel.friendlyZoneLabel)}
              </Text>
              <Text style={[styles.body, { color: palette.ink }]}>
                {copy.settings.timeZoneDataPack(viewModel.packVersion)}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setSettingsOpen(false)}
                style={[
                  styles.closeButton,
                  { backgroundColor: palette.accent },
                ]}
              >
                <Text style={styles.closeButtonText}>
                  {copy.settings.closeButton}
                </Text>
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
  buttonText: {
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  clock: {
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
    letterSpacing: -4,
  },
  clockLine: {
    alignItems: 'baseline',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'nowrap',
    gap: 8,
  },
  clockMeridiem: {
    fontWeight: '800',
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
  retryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
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
