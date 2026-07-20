import { Fragment, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import type { DaylightSaviourPalette } from '../../theme';

export interface SettingsSheetFacts {
  readonly friendlyZoneLabel: string;
  readonly packVersion: string;
}

interface SettingsSheetProps {
  readonly facts: SettingsSheetFacts;
  readonly palette: DaylightSaviourPalette;
  readonly reducedMotion: boolean | null;
}

export default function SettingsSheet({
  facts,
  palette,
  reducedMotion,
}: SettingsSheetProps) {
  const [open, setOpen] = useState(false);

  return (
    <Fragment>
      <Pressable
        accessibilityHint={copy.settings.accessibility.openHint}
        accessibilityLabel={copy.settings.accessibility.openLabel}
        accessibilityRole="button"
        onPress={() => setOpen(true)}
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

      <Modal
        animationType={reducedMotion === false ? 'fade' : 'none'}
        onRequestClose={() => setOpen(false)}
        transparent
        visible={open}
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
                style={[styles.heading, { color: palette.ink }]}
              >
                {copy.settings.heading}
              </Text>
              <Text style={[styles.body, { color: palette.ink }]}>
                {copy.settings.homeTimeZone(facts.friendlyZoneLabel)}
              </Text>
              <Text style={[styles.body, { color: palette.ink }]}>
                {copy.settings.timeZoneDataPack(facts.packVersion)}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setOpen(false)}
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
    </Fragment>
  );
}

const styles = StyleSheet.create({
  body: {
    fontSize: 17,
    lineHeight: 25,
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
  heading: {
    fontSize: 30,
    fontWeight: '700',
    lineHeight: 37,
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
});
