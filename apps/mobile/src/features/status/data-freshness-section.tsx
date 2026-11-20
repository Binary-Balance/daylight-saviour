import { Pressable, StyleSheet, Text, View } from 'react-native';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import type { DaylightSaviourPalette } from '../../theme';
import type { StatusViewModel } from './status-view-model';
import type { TimeZoneDataPackSource } from '../time-zone-data/time-zone-data-manager';

export interface DataFreshnessFacts {
  readonly freshness: StatusViewModel['freshness'];
  readonly packVersion: string;
  readonly remoteEnabled: boolean;
  readonly source: TimeZoneDataPackSource;
  readonly uses24hourClock: boolean;
  readonly validUntil: string;
}

interface DataFreshnessSectionProps {
  readonly facts: DataFreshnessFacts;
  readonly onRetry?: (() => void | Promise<void>) | undefined;
  readonly palette: DaylightSaviourPalette;
}

export default function DataFreshnessSection({
  facts,
  onRetry,
  palette,
}: DataFreshnessSectionProps) {
  const freshnessFacts = {
    freshness: facts.freshness,
    source: facts.source,
  } as const;

  return (
    <View style={[styles.section, { borderTopColor: palette.rule }]}>
      <View
        accessible
        accessibilityLabel={copy.dataFreshness.accessibility.pack({
          ...freshnessFacts,
          packVersion: facts.packVersion,
          uses24hourClock: facts.uses24hourClock,
          validUntil: facts.validUntil,
        })}
      >
        <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
          {copy.dataFreshness.heading}
        </Text>
        <Text style={[styles.body, { color: palette.ink }]}>
          {copy.dataFreshness.status(freshnessFacts)}
        </Text>
        <Text style={[styles.identifier, { color: palette.secondaryInk }]}>
          {copy.dataFreshness.packDetails({
            packVersion: facts.packVersion,
            uses24hourClock: facts.uses24hourClock,
            validUntil: facts.validUntil,
          })}
        </Text>
      </View>
      {onRetry === undefined || !facts.remoteEnabled ? null : (
        <Pressable
          accessibilityHint={copy.dataFreshness.accessibility.retryHint}
          accessibilityLabel={copy.dataFreshness.accessibility.retryLabel}
          accessibilityRole="button"
          disabled={facts.freshness === 'checking'}
          onPress={() => void onRetry()}
          style={[styles.retryButton, { borderColor: palette.controlBoundary }]}
        >
          <Text style={[styles.buttonText, { color: palette.ink }]}>
            {facts.freshness === 'checking'
              ? copy.dataFreshness.retry.checkingButton
              : copy.dataFreshness.retry.checkButton}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

interface DataFreshnessNoticeProps {
  readonly facts: Pick<DataFreshnessFacts, 'freshness' | 'source'>;
  readonly palette: DaylightSaviourPalette;
}

// The report's short warning, shown only once data is out of date: the owner
// judged warnings about due or failed checks of still-valid data as noise.
// Details and the manual retry live in Settings.
export function DataFreshnessNotice({
  facts,
  palette,
}: DataFreshnessNoticeProps) {
  if (facts.freshness !== 'expired') return null;

  return (
    <View
      accessible
      style={[styles.notice, { borderColor: palette.decisionNoticeBorder }]}
      testID="data-freshness-notice"
    >
      <Text style={[styles.metadata, { color: palette.decisionNoticeText }]}>
        {copy.dataFreshness.heading}
      </Text>
      <Text style={[styles.body, { color: palette.ink }]}>
        {copy.dataFreshness.status(facts)}
      </Text>
      <Text style={[styles.identifier, { color: palette.secondaryInk }]}>
        {copy.dataFreshness.seeSettings}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    fontSize: 17,
    lineHeight: 25,
  },
  buttonText: {
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.8,
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
  notice: {
    borderWidth: 2,
    gap: 6,
    padding: 16,
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
  section: {
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 6,
    paddingTop: 16,
  },
});
