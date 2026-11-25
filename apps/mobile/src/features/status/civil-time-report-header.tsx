import { Fragment, type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import { displayTextMaxScale, type DaylightSaviourPalette } from '../../theme';

export interface CivilTimeReportHeaderFacts {
  readonly friendlyZoneLabel: string;
  readonly zoneId: string;
}

interface CivilTimeReportHeaderProps {
  readonly facts: CivilTimeReportHeaderFacts;
  /** Shown between the document label and the Home Time Zone card. */
  readonly notice?: ReactNode;
  readonly onChooseZone?: (() => void) | undefined;
  readonly palette: DaylightSaviourPalette;
}

export default function CivilTimeReportHeader({
  facts,
  notice,
  onChooseZone,
  palette,
}: CivilTimeReportHeaderProps) {
  const { fontScale } = useWindowDimensions();
  // From 1.5× the Settings button, drawn over the report's top right corner,
  // grows wider than the space kept beside this label, so the label moves
  // below the button instead.
  const belowSettings = fontScale >= 1.5;

  return (
    <Fragment>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.utilityHeader,
          belowSettings && styles.utilityHeaderBelowSettings,
          { borderBottomColor: palette.solarGoldStructure },
        ]}
        testID="utility-header"
      >
        <Text style={[styles.documentLabel, { color: palette.secondaryInk }]}>
          {copy.civilTimeReport.document.label}
        </Text>
      </View>

      {notice}

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
            borderColor: palette.controlBoundary,
            opacity: pressed ? 0.78 : 1,
          },
        ]}
      >
        <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
          {copy.civilTimeReport.homeTimeZoneHeading}
        </Text>
        <Text
          maxFontSizeMultiplier={displayTextMaxScale(styles.zone.fontSize)}
          style={[styles.zone, { color: palette.ink }]}
        >
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
    fontSize: 12,
    fontWeight: '800',
  },
  identifier: {
    fontSize: 14,
    lineHeight: 20,
  },
  metadata: {
    fontSize: 12,
    fontWeight: '800',
    lineHeight: 18,
  },
  utilityHeader: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 48,
    paddingBottom: 16,
    paddingRight: 92,
  },
  // The button sits 12 from the top of the report and is 48 tall, so this
  // starts the label 12 below it.
  utilityHeaderBelowSettings: { paddingRight: 0, paddingTop: 48 },
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
