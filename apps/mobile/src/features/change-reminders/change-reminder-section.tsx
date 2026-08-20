import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  AppState,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import type { DaylightSaviourPalette } from '../../theme';
import type {
  ChangeReminderAdapters,
  ChangeReminderPreferences,
} from './change-reminder-adapters';
import { createChangeReminderSession } from './change-reminder-session';

function TimingControls({
  preferences,
  onChange,
}: {
  readonly preferences: ChangeReminderPreferences;
  readonly onChange: (preferences: ChangeReminderPreferences) => void;
}) {
  return (
    <View style={styles.timings}>
      <View style={styles.timing}>
        <Text style={styles.timingLabel}>
          {copy.changeReminders.timing.oneWeek}
        </Text>
        <Switch
          accessibilityLabel={copy.changeReminders.accessibility.oneWeekEnabled}
          accessibilityRole="switch"
          onValueChange={(oneWeekEnabled) =>
            onChange({ ...preferences, oneWeekEnabled })
          }
          value={preferences.oneWeekEnabled}
        />
      </View>
      <View style={styles.timing}>
        <Text style={styles.timingLabel}>
          {copy.changeReminders.timing.oneDay}
        </Text>
        <Switch
          accessibilityLabel={copy.changeReminders.accessibility.oneDayEnabled}
          accessibilityRole="switch"
          onValueChange={(oneDayEnabled) =>
            onChange({ ...preferences, oneDayEnabled })
          }
          value={preferences.oneDayEnabled}
        />
      </View>
    </View>
  );
}

export default function ChangeReminderSection({
  adapters,
  homeTimeZone,
  palette,
  testBuild = false,
}: {
  readonly adapters: ChangeReminderAdapters;
  readonly homeTimeZone: string;
  readonly palette: DaylightSaviourPalette;
  readonly testBuild?: boolean;
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
  const [installationId, setInstallationId] = useState<string | null>(null);

  useEffect(() => session.start(), [session]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') session.dispatch({ type: 'foreground' });
    });
    return () => subscription.remove();
  }, [session]);
  useEffect(() => {
    if (snapshot.kind !== 'enabled') return;
    return adapters.startTokenRefresh(homeTimeZone, (result) => {
      session.dispatch({ result, type: 'token-refresh' });
    });
  }, [adapters, homeTimeZone, session, snapshot.kind]);
  useEffect(() => {
    if (
      !testBuild ||
      snapshot.kind !== 'enabled' ||
      adapters.readInstallationId === undefined
    )
      return;
    let active = true;
    void adapters
      .readInstallationId()
      .then((value) => {
        if (active) setInstallationId(value);
      })
      .catch(() => {
        if (active) setInstallationId(null);
      });
    return () => {
      active = false;
    };
  }, [adapters, snapshot, testBuild]);

  const content =
    snapshot.kind === 'untouched'
      ? copy.changeReminders.untouched
      : snapshot.kind === 'explainer'
        ? copy.changeReminders.explainer
        : snapshot.kind === 'enabled'
          ? copy.changeReminders.enabled(snapshot.preferences)
          : snapshot.kind === 'disabled'
            ? copy.changeReminders.disabled
            : snapshot.kind === 'confirm-disable'
              ? copy.changeReminders.disableConfirmation
              : snapshot.kind === 'disable-failed'
                ? copy.changeReminders.disableFailed
                : snapshot.kind === 'os-blocked'
                  ? copy.changeReminders.osBlocked
                  : snapshot.kind === 'permission-revoked'
                    ? copy.changeReminders.permissionRevoked
                    : snapshot.kind === 'zone-mismatch'
                      ? copy.changeReminders.zoneMismatch
                      : snapshot.kind === 'retry-pending'
                        ? copy.changeReminders.retryPending
                        : snapshot.kind === 'unavailable'
                          ? copy.changeReminders.webUnavailable
                          : snapshot.kind === 'loading' ||
                              snapshot.kind === 'saving' ||
                              snapshot.kind === 'saving-preferences' ||
                              snapshot.kind === 'disabling'
                            ? null
                            : snapshot.kind === 'load-failed'
                              ? copy.changeReminders.loadFailed
                              : snapshot.kind === 'preferences-failed'
                                ? copy.changeReminders.preferencesFailed
                                : snapshot.kind === 'permission-denied'
                                  ? copy.changeReminders.permissionDenied
                                  : copy.changeReminders.failed;
  const errorState =
    snapshot.kind === 'failed' ||
    snapshot.kind === 'load-failed' ||
    snapshot.kind === 'os-blocked' ||
    snapshot.kind === 'permission-denied' ||
    snapshot.kind === 'permission-revoked' ||
    snapshot.kind === 'disable-failed' ||
    snapshot.kind === 'preferences-failed' ||
    snapshot.kind === 'retry-pending' ||
    snapshot.kind === 'zone-mismatch';
  const pending =
    snapshot.kind === 'loading' ||
    snapshot.kind === 'saving' ||
    snapshot.kind === 'saving-preferences' ||
    snapshot.kind === 'disabling';

  return (
    <View
      accessibilityState={{ busy: pending }}
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
          accessibilityLiveRegion="none"
          style={[styles.body, { color: palette.ink }]}
        >
          {snapshot.kind === 'loading'
            ? copy.changeReminders.loading
            : snapshot.kind === 'saving'
              ? copy.changeReminders.saving
              : snapshot.kind === 'disabling'
                ? copy.changeReminders.disabling
                : copy.changeReminders.savingPreferences}
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
      {snapshot.kind === 'enabled' || snapshot.kind === 'preferences-failed' ? (
        <TimingControls
          onChange={(preferences) =>
            session.dispatch({ type: 'change-preferences', preferences })
          }
          preferences={snapshot.preferences}
        />
      ) : null}
      {snapshot.kind === 'untouched' || snapshot.kind === 'disabled' ? (
        <Pressable
          accessibilityHint={copy.changeReminders.accessibility.enableHint}
          accessibilityRole="button"
          onPress={() => session.dispatch({ type: 'show-explainer' })}
          style={[styles.button, { borderColor: palette.controlBoundary }]}
        >
          <Text style={[styles.buttonText, { color: palette.ink }]}>
            {snapshot.kind === 'disabled'
              ? copy.changeReminders.disabled.action
              : copy.changeReminders.untouched.action}
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
      {snapshot.kind === 'confirm-disable' ||
      snapshot.kind === 'disable-failed' ? (
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            onPress={() => session.dispatch({ type: 'cancel-disable' })}
            style={[styles.button, { borderColor: palette.controlBoundary }]}
          >
            <Text style={[styles.buttonText, { color: palette.ink }]}>
              {snapshot.kind === 'disable-failed'
                ? copy.changeReminders.disableFailed.cancel
                : copy.changeReminders.disableConfirmation.cancel}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => session.dispatch({ type: 'confirm-disable' })}
            style={[styles.button, { backgroundColor: palette.actionFill }]}
          >
            <Text style={[styles.buttonText, { color: palette.onActionFill }]}>
              {snapshot.kind === 'disable-failed'
                ? copy.changeReminders.disableFailed.confirm
                : copy.changeReminders.disableConfirmation.confirm}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {snapshot.kind === 'preferences-failed' ? (
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            onPress={() => session.dispatch({ type: 'retry-preferences' })}
            style={[styles.button, { borderColor: palette.controlBoundary }]}
          >
            <Text style={[styles.buttonText, { color: palette.ink }]}>
              {copy.changeReminders.preferencesFailed.retry}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => session.dispatch({ type: 'cancel-preferences' })}
            style={[styles.button, { borderColor: palette.controlBoundary }]}
          >
            <Text style={[styles.buttonText, { color: palette.ink }]}>
              {copy.changeReminders.preferencesFailed.cancel}
            </Text>
          </Pressable>
        </View>
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
      {snapshot.kind === 'retry-pending' ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => session.dispatch({ type: 'enable' })}
          style={[styles.button, { borderColor: palette.controlBoundary }]}
        >
          <Text style={[styles.buttonText, { color: palette.ink }]}>
            {copy.changeReminders.retryPending.retry}
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
      {testBuild && snapshot.kind === 'enabled' && installationId !== null ? (
        <Text
          selectable
          style={[styles.metadata, { color: palette.secondaryInk }]}
        >
          Test installation ID: {installationId}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
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
  timing: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  timingLabel: { fontSize: 17 },
  timings: { gap: 4 },
});
