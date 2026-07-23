import { Fragment } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import type { DaylightSaviourPalette } from '../../theme';

export interface CivilTimeReportHeaderFacts {
  readonly friendlyZoneLabel: string;
  readonly packVersion: string;
  readonly zoneId: string;
}

interface CivilTimeReportHeaderProps {
  readonly facts: CivilTimeReportHeaderFacts;
  readonly onChooseZone?: () => void;
  readonly palette: DaylightSaviourPalette;
}

export default function CivilTimeReportHeader({
  facts,
  onChooseZone,
  palette,
}: CivilTimeReportHeaderProps) {
  return (
    <Fragment>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.utilityHeader,
          { borderBottomColor: palette.solarGoldStructure },
        ]}
      >
        <Text style={[styles.documentLabel, { color: palette.secondaryInk }]}>
          {copy.civilTimeReport.document.label}
        </Text>
        <Text style={[styles.reference, { color: palette.solarGold }]}>
          {facts.packVersion}
        </Text>
      </View>

      <Pressable
        accessibilityHint={
          onChooseZone === undefined
            ? undefined
            : copy.civilTimeReport.accessibility.openZoneSelectionHint
        }
        accessibilityLabel={copy.civilTimeReport.accessibility.homeTimeZone({
          friendlyLabel: facts.friendlyZoneLabel,
          zoneId: facts.zoneId,
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
          {facts.friendlyZoneLabel}
        </Text>
        <Text style={[styles.identifier, { color: palette.secondaryInk }]}>
          {facts.zoneId}
        </Text>
      </Pressable>
    </Fragment>
  );
}

const styles = StyleSheet.create({
  documentLabel: {
    flex: 1,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
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
  reference: {
    fontSize: 13,
    fontWeight: '900',
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
