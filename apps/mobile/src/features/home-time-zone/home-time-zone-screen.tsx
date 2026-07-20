import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  AppState,
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
  australianEnglish as copy,
  type HomeTimeZoneErrorCode,
  type HomeTimeZoneNoticeCode,
} from '@daylight-saviour/copy';
import {
  australianZoneGroups,
  searchAustralianZones,
  type AustralianZone,
} from '@daylight-saviour/domain';

import StatusScreen from '../status/status-screen';
import {
  daylightSaviourPalettes,
  type DaylightSaviourPalette,
} from '../../theme';
import type { HomeTimeZoneAdapters } from './home-time-zone-adapters';
import { createHomeTimeZoneSession } from './home-time-zone-session';

interface HomeTimeZoneScreenProps {
  readonly adapters: HomeTimeZoneAdapters;
  readonly now?: Date;
}

interface ChooserProps {
  readonly notice: HomeTimeZoneNoticeCode | null;
  readonly onCancel?: () => void;
  readonly onSelect: (zoneId: string) => void;
  readonly palette: DaylightSaviourPalette;
  readonly saveError: HomeTimeZoneErrorCode | null;
  readonly saving: boolean;
}

function ZoneChooser({
  notice,
  onCancel,
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
        title: copy.homeTimeZone.chooser.groupHeading(group.id),
      }))
      .filter((section) => section.data.length > 0);
  }, [query]);

  return (
    <SafeAreaView
      edges={['top', 'right', 'bottom', 'left']}
      style={[styles.safeArea, { backgroundColor: palette.background }]}
    >
      <View style={styles.chooserHeader}>
        {onCancel === undefined ? null : (
          <Pressable
            accessibilityHint={copy.homeTimeZone.accessibility.cancelHint}
            accessibilityLabel={copy.homeTimeZone.accessibility.cancelLabel}
            accessibilityRole="button"
            disabled={saving}
            onPress={onCancel}
            style={styles.cancelButton}
          >
            <Text style={[styles.buttonText, { color: palette.ink }]}>
              {copy.homeTimeZone.chooser.cancelButton}
            </Text>
          </Pressable>
        )}
        <Text
          accessibilityRole="header"
          style={[styles.title, { color: palette.ink }]}
        >
          {copy.homeTimeZone.chooser.heading}
        </Text>
        <Text style={[styles.body, { color: palette.secondaryInk }]}>
          {copy.homeTimeZone.chooser.introduction}
        </Text>
        {notice === null ? null : (
          <Text
            accessibilityRole="alert"
            style={[styles.body, { color: palette.ink }]}
          >
            {copy.homeTimeZone.notice(notice)}
          </Text>
        )}
        {saveError === null ? null : (
          <Text
            accessibilityRole="alert"
            style={[styles.body, { color: palette.ink }]}
          >
            {copy.homeTimeZone.errorMessage(saveError)}
          </Text>
        )}
        <TextInput
          accessibilityLabel={copy.homeTimeZone.accessibility.searchLabel}
          autoCapitalize="none"
          onChangeText={setQuery}
          placeholder={copy.homeTimeZone.chooser.searchPlaceholder}
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
            {copy.homeTimeZone.chooser.emptyResult}
          </Text>
        }
        renderItem={({ item }: { item: AustralianZone }) => (
          <Pressable
            accessibilityHint={copy.homeTimeZone.accessibility.zoneOptionHint}
            accessibilityLabel={copy.homeTimeZone.accessibility.zoneOption({
              friendlyLabel: item.friendlyLabel,
              zoneId: item.id,
            })}
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
  adapters,
  now,
}: HomeTimeZoneScreenProps) {
  const appearance = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = daylightSaviourPalettes[appearance];
  const session = useMemo(
    () =>
      createHomeTimeZoneSession(
        now === undefined ? { adapters } : { adapters, now: () => now },
      ),
    [adapters, now],
  );
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );

  useEffect(() => {
    const stop = session.start();
    const appStateSubscription = AppState.addEventListener(
      'change',
      (nextState) => {
        if (nextState === 'active') session.dispatch({ type: 'foreground' });
      },
    );
    return () => {
      appStateSubscription.remove();
      stop();
    };
  }, [session]);

  if (snapshot.kind === 'ready') {
    return (
      <StatusScreen
        acknowledgedEventAt={snapshot.acknowledgedEventAt}
        dataPackSnapshot={snapshot.dataPackSnapshot}
        key={snapshot.zoneId}
        now={now}
        onAcknowledgeAftermath={(eventAt) =>
          session.dispatch({ eventAt, type: 'acknowledge-aftermath' })
        }
        onChooseZone={() => session.dispatch({ type: 'choose-zone' })}
        onRetryDataPack={() => session.dispatch({ type: 'manual-refresh' })}
        secondaryCopySeed={snapshot.secondaryCopySeed}
        uses24hourClock={snapshot.uses24hourClock}
        zoneId={snapshot.zoneId}
      />
    );
  }

  if (snapshot.kind === 'choose') {
    return (
      <ZoneChooser
        notice={snapshot.notice}
        onCancel={
          !snapshot.canCancel
            ? undefined
            : () => session.dispatch({ type: 'cancel-selection' })
        }
        onSelect={(zoneId) => session.dispatch({ type: 'select-zone', zoneId })}
        palette={palette}
        saveError={snapshot.saveError}
        saving={snapshot.saving}
      />
    );
  }

  if (snapshot.kind === 'confirm') {
    return (
      <SafeAreaView
        edges={['top', 'right', 'bottom', 'left']}
        style={[styles.safeArea, { backgroundColor: palette.background }]}
      >
        <View style={styles.confirmation}>
          <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
            {copy.homeTimeZone.confirmation.heading}
          </Text>
          <Text
            accessibilityRole="header"
            style={[styles.title, { color: palette.ink }]}
          >
            {snapshot.friendlyZoneLabel}
          </Text>
          <Text style={[styles.identifier, { color: palette.secondaryInk }]}>
            {snapshot.zoneId}
          </Text>
          {snapshot.currentTime === null ? null : (
            <Text
              accessibilityLabel={copy.homeTimeZone.accessibility.currentTime({
                abbreviation: snapshot.currentTime.abbreviation,
                clock: snapshot.currentTime.clock,
              })}
              style={[styles.suggestedTime, { color: palette.ink }]}
            >
              {snapshot.currentTime.clock} {snapshot.currentTime.abbreviation}
            </Text>
          )}
          <Text style={[styles.body, { color: palette.ink }]}>
            {copy.homeTimeZone.confirmation.explanation}
          </Text>
          {snapshot.saveError === null ? null : (
            <Text
              accessibilityRole="alert"
              style={[styles.body, { color: palette.ink }]}
            >
              {copy.homeTimeZone.errorMessage(snapshot.saveError)}
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            disabled={snapshot.saving}
            onPress={() =>
              session.dispatch({
                type: 'select-zone',
                zoneId: snapshot.zoneId,
              })
            }
            style={[styles.primaryButton, { backgroundColor: palette.accent }]}
          >
            <Text style={styles.primaryButtonText}>
              {copy.homeTimeZone.confirmation.useSuggestedButton}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={snapshot.saving}
            onPress={() => session.dispatch({ type: 'choose-zone' })}
            style={[styles.secondaryButton, { borderColor: palette.rule }]}
          >
            <Text style={[styles.buttonText, { color: palette.ink }]}>
              {copy.homeTimeZone.confirmation.chooseAnotherButton}
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
          accessibilityRole={
            snapshot.kind === 'load-error' ? 'alert' : undefined
          }
          style={[styles.body, { color: palette.ink }]}
        >
          {snapshot.kind === 'load-error'
            ? copy.homeTimeZone.errorMessage('load-failed')
            : copy.homeTimeZone.loading.message}
        </Text>
        {snapshot.kind === 'load-error' ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => session.dispatch({ type: 'retry-load' })}
            style={[styles.secondaryButton, { borderColor: palette.rule }]}
          >
            <Text style={[styles.buttonText, { color: palette.ink }]}>
              {copy.homeTimeZone.loading.retryButton}
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
  cancelButton: { alignSelf: 'flex-start', minHeight: 44, paddingVertical: 10 },
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
