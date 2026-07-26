import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { australianEnglish as copy } from '@daylight-saviour/copy';
import type { ChangeDirection } from '@daylight-saviour/domain';

import type { DaylightSaviourPalette } from '../../theme';
import { createCivilTimeReportMotionRecipe } from './civil-time-report-motion';
import type { StatusViewModel } from './status-view-model';

type ReadyStatusViewModel = Extract<
  StatusViewModel,
  { readonly availability: 'ready' }
>;
type UnavailableStatusViewModel = Extract<
  StatusViewModel,
  { readonly availability: 'unavailable' }
>;

export type ChangeEventSectionReport =
  | Pick<ReadyStatusViewModel, 'availability' | 'event' | 'phase'>
  | Pick<UnavailableStatusViewModel, 'availability' | 'freshness' | 'message'>;

interface ChangeEventSectionProps {
  readonly palette: DaylightSaviourPalette;
  readonly reducedMotion: boolean | null;
  readonly report: ChangeEventSectionReport;
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

function CountdownTransition({
  accessibilityLabel,
  reducedMotion,
  value,
}: {
  readonly accessibilityLabel?: string;
  readonly reducedMotion: boolean | null;
  readonly value: string;
}) {
  const [currentOpacity] = useState(() => new Animated.Value(1));
  const [previousOpacity] = useState(() => new Animated.Value(0));
  const [previousValue, setPreviousValue] = useState<string | null>(null);
  const lastValue = useRef(value);

  useEffect(() => {
    if (lastValue.current === value) return;
    setPreviousValue(lastValue.current);
    lastValue.current = value;
    if (reducedMotion === null) {
      setPreviousValue(null);
      return;
    }

    currentOpacity.setValue(reducedMotion ? 0.85 : 0.7);
    previousOpacity.setValue(1);
    const animation = Animated.parallel([
      Animated.timing(previousOpacity, {
        duration: reducedMotion ? 90 : 140,
        toValue: 0,
        useNativeDriver: true,
      }),
      Animated.timing(currentOpacity, {
        duration: reducedMotion ? 90 : 140,
        toValue: 1,
        useNativeDriver: true,
      }),
    ]);
    animation.start(() => {
      setPreviousValue(null);
    });
    return () => animation.stop();
  }, [currentOpacity, previousOpacity, reducedMotion, value]);

  return (
    <View style={styles.countdownTransition}>
      {previousValue === null ? null : (
        <Animated.Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.countdown,
            styles.countdownPrevious,
            { opacity: previousOpacity },
          ]}
        >
          {previousValue}
        </Animated.Text>
      )}
      <Animated.Text
        accessibilityLabel={accessibilityLabel}
        accessibilityLiveRegion="none"
        style={[styles.countdown, { opacity: currentOpacity }]}
        testID="countdown-current"
      >
        {value}
      </Animated.Text>
    </View>
  );
}

export default function ChangeEventSection({
  palette,
  reducedMotion,
  report,
}: ChangeEventSectionProps) {
  if (report.availability === 'unavailable') {
    return (
      <View
        accessibilityRole="alert"
        style={[
          styles.expiredCard,
          {
            backgroundColor: palette.surface,
            borderColor: palette.decisionNoticeBorder,
          },
        ]}
        testID={
          report.freshness === 'expired'
            ? 'expired-civil-time-report'
            : 'unavailable-civil-time-report'
        }
      >
        <Text style={[styles.metadata, { color: palette.decisionNoticeText }]}>
          {copy.civilTimeReport.decisionUnavailable.label(report.freshness)}
        </Text>
        <Text
          accessibilityRole="header"
          style={[styles.status, { color: palette.ink }]}
        >
          {copy.civilTimeReport.decisionUnavailable.heading}
        </Text>
        <Text style={[styles.body, { color: palette.ink }]}>
          {report.message}
        </Text>
      </View>
    );
  }

  if (report.event === null) {
    return (
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
        <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
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
          style={[styles.noEventMark, { color: palette.noEventMark }]}
        >
          {copy.civilTimeReport.noEvent.mark}
        </Text>
      </View>
    );
  }

  return (
    <SemanticEventMotion
      direction={report.event.direction}
      echo={report.event.wallTimeChange}
      echoColor={palette.secondaryInk}
      eventKey={`${report.event.instant}:${report.event.relation}`}
      reducedMotion={reducedMotion}
    >
      <View
        style={[styles.eventCard, { borderColor: palette.solarGoldStructure }]}
        testID={`${report.phase}-civil-time-report`}
      >
        <Text
          accessibilityRole="header"
          style={[styles.metadata, { color: palette.secondaryInk }]}
        >
          {copy.civilTimeReport.changeEvent.heading(report.event.relation)}
        </Text>
        <Text style={[styles.eventDate, { color: palette.ink }]}>
          {report.event.date}
        </Text>
        <View style={styles.directionRow}>
          <Text style={[styles.direction, { color: palette.solarGold }]}>
            {report.event.direction}
          </Text>
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.direction, { color: palette.solarGold }]}
          >
            {copy.civilTimeReport.changeEvent.directionArrow(
              report.event.direction,
            )}
          </Text>
        </View>
        <View style={styles.equationGroup}>
          <Text style={[styles.equationLabel, { color: palette.secondaryInk }]}>
            {copy.civilTimeReport.changeEvent.localTimeHeading}
          </Text>
          <Text style={[styles.eventFact, { color: palette.ink }]}>
            {report.event.wallTimeChange}
          </Text>
          <Text style={[styles.equationLabel, { color: palette.secondaryInk }]}>
            {copy.civilTimeReport.changeEvent.utcOffsetHeading}
          </Text>
          <Text style={[styles.eventFact, { color: palette.ink }]}>
            {report.event.offsetChange}
          </Text>
          <Text style={[styles.body, { color: palette.secondaryInk }]}>
            {report.event.clockMovement}
          </Text>
        </View>
        {report.event.countdown === null ? (
          <View style={styles.aftermathFact}>
            <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
              {copy.civilTimeReport.changeEvent.completedHeading}
            </Text>
            <Text style={[styles.countdown, { color: palette.ink }]}>
              {report.event.elapsed}
            </Text>
          </View>
        ) : (
          <View>
            <Text
              accessibilityRole="header"
              style={[styles.metadata, { color: palette.secondaryInk }]}
            >
              {copy.civilTimeReport.changeEvent.countdownHeading}
            </Text>
            <CountdownTransition
              accessibilityLabel={
                report.event.countdownAccessibilityLabel ?? undefined
              }
              reducedMotion={reducedMotion}
              value={report.event.countdown}
            />
          </View>
        )}
      </View>
    </SemanticEventMotion>
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
  countdown: {
    fontSize: 28,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
    lineHeight: 34,
    paddingTop: 6,
  },
  countdownPrevious: { left: 0, position: 'absolute', top: 6 },
  countdownTransition: { minHeight: 40, paddingTop: 0, position: 'relative' },
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
  metadata: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.1,
    lineHeight: 18,
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
  status: {
    fontSize: 38,
    fontWeight: '800',
    letterSpacing: -1,
    lineHeight: 45,
  },
});
