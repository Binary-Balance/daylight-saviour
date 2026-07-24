import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import type { DaylightSaviourPalette } from '../../theme';
import type { ChangeReminderAdapters } from './change-reminder-adapters';
import { createChangeReminderSession } from './change-reminder-session';

export default function ChangeReminderSection({
  adapters,
  homeTimeZone,
  palette,
}: {
  readonly adapters: ChangeReminderAdapters;
  readonly homeTimeZone: string;
  readonly palette: DaylightSaviourPalette;
}) {
  const session = useMemo(
    () => createChangeReminderSession({ adapters, homeTimeZone }),
    [adapters, homeTimeZone],
  );
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );

  useEffect(() => session.start(), [session]);

  const content =
    snapshot.kind === 'untouched'
      ? copy.changeReminders.untouched
      : snapshot.kind === 'explainer'
        ? copy.changeReminders.explainer
        : snapshot.kind === 'enabled'
          ? copy.changeReminders.enabled
          : snapshot.kind === 'os-blocked'
            ? copy.changeReminders.osBlocked
            : snapshot.kind === 'permission-revoked'
              ? copy.changeReminders.permissionRevoked
              : snapshot.kind === 'zone-mismatch'
                ? copy.changeReminders.zoneMismatch
                : snapshot.kind === 'unavailable'
                  ? copy.changeReminders.webUnavailable
                  : snapshot.kind === 'loading'
                    ? null
                    : snapshot.kind === 'saving'
                      ? null
                      : snapshot.kind === 'load-failed'
                        ? copy.changeReminders.loadFailed
                        : snapshot.kind === 'permission-denied'
                          ? copy.changeReminders.permissionDenied
                          : copy.changeReminders.failed;
  const errorState =
    snapshot.kind === 'failed' ||
    snapshot.kind === 'load-failed' ||
    snapshot.kind === 'os-blocked' ||
    snapshot.kind === 'permission-denied' ||
    snapshot.kind === 'permission-revoked' ||
    snapshot.kind === 'zone-mismatch';

  return (
    <View
      accessibilityState={{
        busy: snapshot.kind === 'loading' || snapshot.kind === 'saving',
      }}
      style={[styles.card, { borderColor: palette.rule }]}
    >
      <Text
        accessibilityRole="header"
        style={[styles.metadata, { color: palette.secondaryInk }]}
      >
        {copy.changeReminders.heading}
      </Text>
      {content === null ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.body, { color: palette.ink }]}
        >
          {snapshot.kind === 'loading'
            ? copy.changeReminders.loading
            : copy.changeReminders.saving}
        </Text>
      ) : (
        <>
          {'heading' in content ? (
            <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
              {content.heading}
            </Text>
          ) : null}
          <Text
            accessibilityLiveRegion={errorState ? 'assertive' : 'none'}
            accessibilityRole={errorState ? 'alert' : undefined}
            style={[styles.body, { color: palette.ink }]}
          >
            {content.body}
          </Text>
        </>
      )}
      {snapshot.kind === 'untouched' ? (
        <Pressable
          accessibilityHint={copy.changeReminders.accessibility.enableHint}
          accessibilityRole="button"
          onPress={() => session.dispatch({ type: 'show-explainer' })}
          style={[styles.button, { borderColor: palette.controlBoundary }]}
        >
          <Text style={[styles.buttonText, { color: palette.ink }]}>
            {copy.changeReminders.untouched.action}
          </Text>
        </Pressable>
      ) : null}
      {snapshot.kind === 'explainer' ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => session.dispatch({ type: 'enable' })}
          style={[styles.button, { backgroundColor: palette.actionFill }]}
        >
          <Text style={[styles.buttonText, { color: palette.onActionFill }]}>
            {copy.changeReminders.explainer.confirm}
          </Text>
        </Pressable>
      ) : null}
      {snapshot.kind === 'failed' || snapshot.kind === 'permission-denied' ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => session.dispatch({ type: 'enable' })}
          style={[styles.button, { borderColor: palette.controlBoundary }]}
        >
          <Text style={[styles.buttonText, { color: palette.ink }]}>
            {snapshot.kind === 'failed'
              ? copy.changeReminders.failed.retry
              : copy.changeReminders.permissionDenied.retry}
          </Text>
        </Pressable>
      ) : null}
      {snapshot.kind === 'load-failed' ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => session.dispatch({ type: 'retry-load' })}
          style={[styles.button, { borderColor: palette.controlBoundary }]}
        >
          <Text style={[styles.buttonText, { color: palette.ink }]}>
            {copy.changeReminders.loadFailed.retry}
          </Text>
        </Pressable>
      ) : null}
      {snapshot.kind === 'os-blocked' ||
      snapshot.kind === 'permission-revoked' ? (
        <Pressable
          accessibilityHint={
            copy.changeReminders.accessibility.openSettingsHint
          }
          accessibilityRole="button"
          onPress={() => {
            void adapters.openSettings().catch(() => undefined);
          }}
          style={[styles.button, { borderColor: palette.controlBoundary }]}
        >
          <Text style={[styles.buttonText, { color: palette.ink }]}>
            {snapshot.kind === 'os-blocked'
              ? copy.changeReminders.osBlocked.openSettings
              : copy.changeReminders.permissionRevoked.openSettings}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 17, lineHeight: 25 },
  button: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  buttonText: { fontSize: 14, fontWeight: '800' },
  card: { borderTopWidth: StyleSheet.hairlineWidth, gap: 12, paddingTop: 16 },
  metadata: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.1,
    lineHeight: 18,
  },
});
