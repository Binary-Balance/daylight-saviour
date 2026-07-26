import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { australianEnglish as copy } from '@daylight-saviour/copy';
import type { DaylightSavingStatus } from '@daylight-saviour/domain';

import type { DaylightSaviourPalette } from '../../theme';

export interface DaylightSavingStatusHeroFacts {
  readonly abbreviation: string;
  readonly clock: string;
  readonly currentOffset: string;
  readonly phaseLabel: string;
  readonly secondaryLine: string;
  readonly status: DaylightSavingStatus;
}

interface DaylightSavingStatusHeroProps {
  readonly facts: DaylightSavingStatusHeroFacts;
  readonly palette: DaylightSaviourPalette;
  readonly reducedMotion?: boolean | null;
  readonly statusTransitionKey?: string;
  readonly uses24hourClock: boolean;
}

export default function DaylightSavingStatusHero({
  facts,
  palette,
  reducedMotion = null,
  statusTransitionKey = facts.status,
  uses24hourClock,
}: DaylightSavingStatusHeroProps) {
  const { fontScale, width } = useWindowDimensions();
  const baseClockSize = Math.min(104, Math.max(72, (width - 48) * 0.25));
  const [currentStatus, setCurrentStatus] = useState(facts.status);
  const [previousStatus, setPreviousStatus] = useState<string | null>(null);
  const [currentOpacity] = useState(() => new Animated.Value(1));
  const [previousOpacity] = useState(() => new Animated.Value(0));
  const lastStatusTransitionKey = useRef(statusTransitionKey);
  const largeText = fontScale >= 1.5;
  const clockSize = baseClockSize;
  const [clockValue, clockMeridiem = null] = uses24hourClock
    ? [facts.clock, null]
    : facts.clock.split(' ');

  useEffect(() => {
    if (
      reducedMotion === null ||
      lastStatusTransitionKey.current === statusTransitionKey
    ) {
      return;
    }
    lastStatusTransitionKey.current = statusTransitionKey;
    setPreviousStatus(currentStatus);
    setCurrentStatus(facts.status);
    currentOpacity.setValue(reducedMotion ? 0.85 : 0.7);
    previousOpacity.setValue(1);
    const animation = Animated.parallel([
      Animated.timing(previousOpacity, {
        duration: reducedMotion ? 90 : 180,
        toValue: 0,
        useNativeDriver: true,
      }),
      Animated.timing(currentOpacity, {
        duration: reducedMotion ? 90 : 180,
        toValue: 1,
        useNativeDriver: true,
      }),
    ]);
    animation.start(() => setPreviousStatus(null));
    return () => animation.stop();
  }, [
    currentOpacity,
    currentStatus,
    facts.status,
    previousOpacity,
    reducedMotion,
    statusTransitionKey,
  ]);

  return (
    <View style={styles.statusSection}>
      <View
        accessibilityLabel={copy.civilTimeReport.accessibility.clock({
          abbreviation: facts.abbreviation,
          clock: facts.clock,
          currentOffset: facts.currentOffset,
        })}
        accessibilityLiveRegion="none"
        accessible
      >
        <View
          accessible={false}
          style={[styles.clockLine, largeText && styles.clockLineLarge]}
          testID="clock-line"
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
            testID="clock-value"
          >
            {clockValue}
          </Text>
          {clockMeridiem === null ? null : (
            <Text
              accessible={false}
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
            abbreviation: facts.abbreviation,
            currentOffset: facts.currentOffset,
          })}
        </Text>
      </View>
      <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
        {copy.civilTimeReport.daylightSavingStatusHeading}
      </Text>
      <Animated.View
        accessibilityLiveRegion="none"
        style={styles.statusTransition}
        testID={
          reducedMotion === null
            ? 'status-motion-awaiting-preference'
            : reducedMotion
              ? 'status-motion-short-fade'
              : 'status-motion-lock-in'
        }
      >
        {previousStatus === null ? null : (
          <Animated.Text
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
              styles.status,
              styles.previousStatus,
              { color: palette.ink, opacity: previousOpacity },
            ]}
          >
            {previousStatus}
          </Animated.Text>
        )}
        <Animated.Text
          accessibilityRole="header"
          style={[
            styles.status,
            { color: palette.ink, opacity: currentOpacity },
          ]}
        >
          {currentStatus}
        </Animated.Text>
      </Animated.View>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.stamp,
          {
            borderColor: palette.signalRed,
            transform: [{ rotate: '-3deg' }],
          },
        ]}
        testID="phase-stamp"
      >
        <Text style={[styles.stampText, { color: palette.signalRed }]}>
          {facts.phaseLabel}
        </Text>
      </View>
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.secondaryLine, { color: palette.secondaryInk }]}
      >
        {facts.secondaryLine}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  clock: {
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
    letterSpacing: -4,
  },
  clockLine: {
    alignItems: 'baseline',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  clockLineLarge: { alignItems: 'flex-start', flexDirection: 'column', gap: 0 },
  clockMeridiem: {
    fontWeight: '800',
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
  secondaryLine: {
    fontSize: 17,
    fontStyle: 'italic',
    lineHeight: 25,
    maxWidth: 560,
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
  previousStatus: { left: 0, position: 'absolute', top: 0 },
  statusSection: {
    gap: 12,
  },
  statusTransition: { minHeight: 45, position: 'relative' },
});
