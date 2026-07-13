import { foundationStatus } from '@daylight-saviour/domain';
import {
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const palettes = {
  light: {
    accent: '#E5482D',
    background: '#F4EEDC',
    ink: '#111B2C',
    rule: '#A9A38F',
    secondaryInk: '#596273',
    surface: '#FFF9EA',
  },
  dark: {
    accent: '#FF6A4D',
    background: '#081426',
    ink: '#F6F0DE',
    rule: '#405067',
    secondaryInk: '#B6C0CF',
    surface: '#101F35',
  },
} as const;

export default function StatusScreen() {
  const appearance = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = palettes[appearance];

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
          accessibilityLabel="Daylight Saviour foundation dossier"
          style={[styles.utilityHeader, { borderBottomColor: palette.rule }]}
        >
          <Text style={[styles.documentLabel, { color: palette.secondaryInk }]}>
            DAYLIGHT SAVIOUR · FOUNDATION DOSSIER
          </Text>
          <Text style={[styles.reference, { color: palette.accent }]}>
            WI—01
          </Text>
        </View>

        <View
          accessible
          accessibilityLabel={`Home Time Zone, ${foundationStatus.homeTimeZone}`}
          style={[styles.card, { backgroundColor: palette.surface }]}
        >
          <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
            HOME TIME ZONE
          </Text>
          <Text style={[styles.zone, { color: palette.ink }]}>
            Sydney & Canberra
          </Text>
          <Text style={[styles.identifier, { color: palette.secondaryInk }]}>
            {foundationStatus.homeTimeZone}
          </Text>
        </View>

        <View style={styles.statusSection}>
          <Text
            accessibilityRole="header"
            style={[styles.status, { color: palette.ink }]}
          >
            {foundationStatus.status}
          </Text>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.rule, { backgroundColor: palette.accent }]}
          />
          <Text style={[styles.body, { color: palette.secondaryInk }]}>
            {foundationStatus.explanation}
          </Text>
        </View>

        <View
          accessibilityLabel="Foundation validation pending"
          style={[styles.footer, { borderTopColor: palette.rule }]}
        >
          <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
            VALIDATION
          </Text>
          <Text style={[styles.body, { color: palette.ink }]}>
            Scaffold ready for deterministic civil-time data.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: {
    fontSize: 17,
    lineHeight: 25,
  },
  card: {
    gap: 8,
    padding: 24,
  },
  content: {
    gap: 32,
    paddingHorizontal: 24,
    paddingVertical: 24,
  },
  documentLabel: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
    paddingTop: 16,
  },
  identifier: {
    fontSize: 14,
  },
  metadata: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.1,
  },
  reference: {
    fontSize: 13,
    fontWeight: '800',
  },
  rule: {
    height: 4,
    width: 72,
  },
  safeArea: {
    flex: 1,
  },
  status: {
    fontSize: 38,
    fontWeight: '800',
    letterSpacing: -1,
    lineHeight: 44,
  },
  statusSection: {
    gap: 16,
  },
  utilityHeader: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 16,
    paddingBottom: 16,
  },
  zone: {
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 34,
  },
});
