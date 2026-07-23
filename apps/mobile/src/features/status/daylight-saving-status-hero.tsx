import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
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
  readonly uses24hourClock: boolean;
}

export default function DaylightSavingStatusHero({
  facts,
  palette,
  uses24hourClock,
}: DaylightSavingStatusHeroProps) {
  const { width } = useWindowDimensions();
  const clockSize = Math.min(104, Math.max(72, (width - 48) * 0.25));
  const [clockValue, clockMeridiem = null] = uses24hourClock
    ? [facts.clock, null]
    : facts.clock.split(' ');

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
        <View accessible={false} style={styles.clockLine} testID="clock-line">
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
            abbreviation: facts.abbreviation,
            currentOffset: facts.currentOffset,
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
        {facts.status}
      </Text>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.stamp,
          {
            borderColor: palette.accent,
            transform: [{ rotate: '-3deg' }],
          },
        ]}
        testID="phase-stamp"
      >
        <Text style={[styles.stampText, { color: palette.accent }]}>
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
    flexWrap: 'nowrap',
    gap: 8,
  },
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
  statusSection: {
    gap: 12,
  },
});
