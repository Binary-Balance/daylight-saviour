import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import type { DaylightSaviourPalette } from '../../theme';
import type {
  FcmTransportProofDiagnostic as FcmTransportProofDiagnosticValue,
  FcmTransportProofDiagnosticReader,
} from './change-reminder-production-adapters';

export default function FcmTransportProofDiagnostic({
  homeTimeZone,
  palette,
  reader,
}: {
  readonly homeTimeZone: string;
  readonly palette: DaylightSaviourPalette;
  readonly reader: FcmTransportProofDiagnosticReader;
}) {
  const [diagnostic, setDiagnostic] =
    useState<FcmTransportProofDiagnosticValue | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  return (
    <View style={styles.container}>
      <Text style={[styles.heading, { color: palette.secondaryInk }]}>
        {copy.changeReminders.transportProof.diagnostic.heading}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void reader.read(homeTimeZone).then((next) => {
            setDiagnostic(next);
            setUnavailable(next === null);
          });
        }}
        style={[styles.button, { borderColor: palette.controlBoundary }]}
      >
        <Text style={[styles.buttonText, { color: palette.ink }]}>
          {copy.changeReminders.transportProof.diagnostic.action}
        </Text>
      </Pressable>
      {diagnostic === null ? null : (
        <View
          accessible
          accessibilityLabel={copy.changeReminders.transportProof.diagnostic.registration(
            diagnostic,
          )}
        >
          <Text selectable style={[styles.value, { color: palette.ink }]}>
            {diagnostic.installationId}
          </Text>
          <Text selectable style={[styles.value, { color: palette.ink }]}>
            {diagnostic.homeTimeZone}
          </Text>
        </View>
      )}
      {unavailable ? (
        <Text accessibilityRole="alert" style={{ color: palette.ink }}>
          {copy.changeReminders.transportProof.diagnostic.unavailable}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  buttonText: { fontSize: 14, fontWeight: '800' },
  container: { gap: 10 },
  heading: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.1,
    lineHeight: 18,
  },
  value: { fontFamily: 'monospace', fontSize: 14, lineHeight: 22 },
});
