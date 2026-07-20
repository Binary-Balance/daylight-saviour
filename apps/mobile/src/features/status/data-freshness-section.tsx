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
  readonly onRetry?: () => void | Promise<void>;
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
    <View style={[styles.footer, { borderTopColor: palette.rule }]}>
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
          style={[styles.retryButton, { borderColor: palette.rule }]}
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
});
