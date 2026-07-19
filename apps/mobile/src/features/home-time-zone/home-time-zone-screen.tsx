import { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  australianZoneGroups,
  getAustralianZone,
  normalizeAustralianZoneId,
  searchAustralianZones,
  type AustralianZone,
} from '@daylight-saviour/domain';

import StatusScreen from '../status/status-screen';
import { createStatusViewModel } from '../status/status-view-model';
import {
  productionHomeTimeZoneAdapters,
  type HomeTimeZoneAdapters,
} from './home-time-zone-adapters';

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

type FlowState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'load-error' }
  | { readonly kind: 'confirm'; readonly zoneId: string }
  | { readonly kind: 'choose'; readonly notice?: string }
  | { readonly kind: 'ready'; readonly zoneId: string };

interface HomeTimeZoneScreenProps {
  readonly adapters?: HomeTimeZoneAdapters;
  readonly now?: Date;
}

interface ChooserProps {
  readonly notice?: string;
  readonly onSelect: (zoneId: string) => void;
  readonly palette: (typeof palettes)[keyof typeof palettes];
  readonly saveError: string | null;
  readonly saving: boolean;
}

function ZoneChooser({
  notice,
  onSelect,
  palette,
  saveError,
  saving,
}: ChooserProps) {
  const [query, setQuery] = useState('');
  const sections = useMemo(() => {
    const matches = searchAustralianZones(query);
    return australianZoneGroups
      .map((group) => ({
        data: matches.filter((zone) => zone.group === group.id),
        title: group.label,
      }))
      .filter((section) => section.data.length > 0);
  }, [query]);

  return (
    <SafeAreaView
      edges={['top', 'right', 'bottom', 'left']}
      style={[styles.safeArea, { backgroundColor: palette.background }]}
    >
      <View style={styles.chooserHeader}>
        <Text
          accessibilityRole="header"
          style={[styles.title, { color: palette.ink }]}
        >
          Choose Home Time Zone
        </Text>
        <Text style={[styles.body, { color: palette.secondaryInk }]}>
          Friendly geography first. Canonical IANA identifier shown for
          precision.
        </Text>
        {notice === undefined ? null : (
          <Text
            accessibilityRole="alert"
            style={[styles.body, { color: palette.ink }]}
          >
            {notice}
          </Text>
        )}
        {saveError === null ? null : (
          <Text
            accessibilityRole="alert"
            style={[styles.body, { color: palette.ink }]}
          >
            {saveError}
          </Text>
        )}
        <TextInput
          accessibilityLabel="Search Australian Home Time Zones"
          autoCapitalize="none"
          onChangeText={setQuery}
          placeholder="Search region or identifier"
          placeholderTextColor={palette.secondaryInk}
          style={[
            styles.search,
            {
              borderColor: palette.rule,
              color: palette.ink,
              backgroundColor: palette.surface,
            },
          ]}
          value={query}
        />
      </View>
      <SectionList
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <Text style={[styles.body, { color: palette.ink }]}>
            No matching Australian Home Time Zone.
          </Text>
        }
        renderItem={({ item }: { item: AustralianZone }) => (
          <Pressable
            accessibilityHint="Saves this canonical Home Time Zone"
            accessibilityLabel={`${item.friendlyLabel}, ${item.id}`}
            accessibilityRole="button"
            disabled={saving}
            onPress={() => onSelect(item.id)}
            style={[styles.zoneRow, { backgroundColor: palette.surface }]}
          >
            <Text style={[styles.zoneLabel, { color: palette.ink }]}>
              {item.friendlyLabel}
            </Text>
            <Text style={[styles.identifier, { color: palette.secondaryInk }]}>
              {item.id}
            </Text>
          </Pressable>
        )}
        renderSectionHeader={({ section: { title } }) => (
          <Text
            accessibilityRole="header"
            style={[
              styles.sectionHeading,
              { color: palette.ink, backgroundColor: palette.background },
            ]}
          >
            {title}
          </Text>
        )}
        sections={sections}
        stickySectionHeadersEnabled
      />
    </SafeAreaView>
  );
}

export default function HomeTimeZoneScreen({
  adapters = productionHomeTimeZoneAdapters,
  now,
}: HomeTimeZoneScreenProps) {
  const appearance = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = palettes[appearance];
  const [flow, setFlow] = useState<FlowState>({ kind: 'loading' });
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void adapters.storage
      .load()
      .then((saved) => {
        if (!active) return;

        if (saved !== null) {
          const canonical = normalizeAustralianZoneId(saved);
          if (canonical === saved) {
            setFlow({ kind: 'ready', zoneId: canonical });
          } else {
            setFlow({
              kind: 'choose',
              notice:
                'Saved Home Time Zone is unsupported or invalid. Choose a region again.',
            });
          }
          return;
        }

        const suggested = adapters.deviceTimeZone.read();
        const canonical =
          suggested === null ? null : normalizeAustralianZoneId(suggested);
        setFlow(
          canonical === null
            ? {
                kind: 'choose',
                notice:
                  'Device time zone is outside Australian Coverage. Choose without a location guess.',
              }
            : { kind: 'confirm', zoneId: canonical },
        );
      })
      .catch(() => {
        if (active) setFlow({ kind: 'load-error' });
      });

    return () => {
      active = false;
    };
  }, [adapters, retry]);

  async function selectZone(zoneId: string) {
    const zone = getAustralianZone(zoneId);
    if (zone === null || zone.id !== zoneId) return;

    setSaving(true);
    setSaveError(null);
    try {
      await adapters.storage.save(zone.id);
      setFlow({ kind: 'ready', zoneId: zone.id });
    } catch {
      setSaveError('Could not save Home Time Zone. Try again.');
    } finally {
      setSaving(false);
    }
  }

  if (flow.kind === 'ready') {
    return (
      <StatusScreen
        now={now}
        onChooseZone={() => {
          setSaveError(null);
          setFlow({ kind: 'choose' });
        }}
        zoneId={flow.zoneId}
      />
    );
  }

  if (flow.kind === 'choose') {
    return (
      <ZoneChooser
        notice={flow.notice}
        onSelect={(zoneId) => void selectZone(zoneId)}
        palette={palette}
        saveError={saveError}
        saving={saving}
      />
    );
  }

  if (flow.kind === 'confirm') {
    const zone = getAustralianZone(flow.zoneId)!;
    const status = createStatusViewModel(flow.zoneId, now ?? new Date());
    return (
      <SafeAreaView
        edges={['top', 'right', 'bottom', 'left']}
        style={[styles.safeArea, { backgroundColor: palette.background }]}
      >
        <View style={styles.confirmation}>
          <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
            SUGGESTED HOME TIME ZONE
          </Text>
          <Text
            accessibilityRole="header"
            style={[styles.title, { color: palette.ink }]}
          >
            {zone.friendlyLabel}
          </Text>
          <Text style={[styles.identifier, { color: palette.secondaryInk }]}>
            {zone.id}
          </Text>
          {status.availability === 'ready' ? (
            <Text style={[styles.suggestedTime, { color: palette.ink }]}>
              {status.clock} {status.abbreviation}
            </Text>
          ) : null}
          <Text style={[styles.body, { color: palette.ink }]}>
            No location permission needed. Suggestion comes from device
            civil-time settings.
          </Text>
          {saveError === null ? null : (
            <Text
              accessibilityRole="alert"
              style={[styles.body, { color: palette.ink }]}
            >
              {saveError}
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={() => void selectZone(zone.id)}
            style={[styles.primaryButton, { backgroundColor: palette.accent }]}
          >
            <Text style={styles.primaryButtonText}>
              Use this Home Time Zone
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={() => setFlow({ kind: 'choose' })}
            style={[styles.secondaryButton, { borderColor: palette.rule }]}
          >
            <Text style={[styles.buttonText, { color: palette.ink }]}>
              Choose another region
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      edges={['top', 'right', 'bottom', 'left']}
      style={[styles.safeArea, { backgroundColor: palette.background }]}
    >
      <View style={styles.confirmation}>
        <Text
          accessibilityRole={flow.kind === 'load-error' ? 'alert' : undefined}
          style={[styles.body, { color: palette.ink }]}
        >
          {flow.kind === 'load-error'
            ? 'Could not load saved Home Time Zone.'
            : 'Loading Home Time Zone…'}
        </Text>
        {flow.kind === 'load-error' ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setFlow({ kind: 'loading' });
              setRetry((value) => value + 1);
            }}
            style={[styles.secondaryButton, { borderColor: palette.rule }]}
          >
            <Text style={[styles.buttonText, { color: palette.ink }]}>
              Retry
            </Text>
          </Pressable>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 17, lineHeight: 25 },
  buttonText: { fontSize: 17, fontWeight: '700' },
  chooserHeader: { gap: 12, paddingHorizontal: 24, paddingTop: 24 },
  confirmation: { flex: 1, gap: 20, justifyContent: 'center', padding: 24 },
  identifier: { fontSize: 14 },
  listContent: { padding: 24 },
  metadata: { fontSize: 12, fontWeight: '700', letterSpacing: 1.1 },
  primaryButton: { alignItems: 'center', minHeight: 52, padding: 16 },
  primaryButtonText: { color: '#FFF9EA', fontSize: 17, fontWeight: '800' },
  safeArea: { flex: 1 },
  search: { borderWidth: 1, fontSize: 17, minHeight: 52, padding: 14 },
  secondaryButton: {
    alignItems: 'center',
    borderWidth: 1,
    minHeight: 52,
    padding: 16,
  },
  sectionHeading: { fontSize: 20, fontWeight: '800', paddingVertical: 12 },
  suggestedTime: { fontSize: 42, fontWeight: '800' },
  title: { fontSize: 36, fontWeight: '800', lineHeight: 42 },
  zoneLabel: { fontSize: 18, fontWeight: '700' },
  zoneRow: { gap: 6, marginBottom: 12, minHeight: 64, padding: 16 },
});
