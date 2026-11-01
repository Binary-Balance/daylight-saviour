import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  AccessibilityInfo,
  AppState,
  Platform,
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

// Announces registration starting and finishing, once each. Live regions do
// not suit this: iOS ignores them, and on Android the enabled text would be read
// on every launch and return to the app, because the card restores itself.
function useRegistrationAnnouncements(
  kind: string,
  outcome: string | undefined,
  outcomeReadByRegion: boolean,
) {
  const previousKind = useRef(kind);
  const recheckingBlock = useRef(false);
  useEffect(() => {
    const previous = previousKind.current;
    previousKind.current = kind;
    if (kind === 'saving') {
      // Every return to the app rechecks a blocked permission, usually with no
      // change, so only a new outcome is worth saying.
      recheckingBlock.current = previous === 'os-blocked';
      if (!recheckingBlock.current) {
        AccessibilityInfo.announceForAccessibility(
          copy.changeReminders.saving.body,
        );
      }
    } else if (
      previous === 'saving' &&
      outcome !== undefined &&
      !outcomeReadByRegion &&
      !(recheckingBlock.current && kind === 'os-blocked')
    ) {
      AccessibilityInfo.announceForAccessibility(outcome);
    }
  }, [kind, outcome, outcomeReadByRegion]);
}

function TimingControls({
  preferences,
  onChange,
  palette,
  disabled = false,
}: {
  readonly preferences: ChangeReminderPreferences;
  readonly onChange: (preferences: ChangeReminderPreferences) => void;
  readonly palette: DaylightSaviourPalette;
  readonly disabled?: boolean;
}) {
  return (
    <View style={styles.timings}>
      <View style={styles.timing}>
        <Text style={[styles.timingLabel, { color: palette.ink }]}>
          {copy.changeReminders.timing.oneWeek}
        </Text>
        <Switch
          accessibilityLabel={copy.changeReminders.accessibility.oneWeek}
          accessibilityRole="switch"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onValueChange={(oneWeekEnabled) =>
            onChange({ ...preferences, oneWeekEnabled })
          }
          value={preferences.oneWeekEnabled}
        />
      </View>
      <View style={styles.timing}>
        <Text style={[styles.timingLabel, { color: palette.ink }]}>
          {copy.changeReminders.timing.oneDay}
        </Text>
        <Switch
          accessibilityLabel={copy.changeReminders.accessibility.oneDay}
          accessibilityRole="switch"
          accessibilityState={{ disabled }}
          disabled={disabled}
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
  verifiedNoEvent = false,
}: {
  readonly adapters: ChangeReminderAdapters;
  readonly homeTimeZone: string;
  readonly palette: DaylightSaviourPalette;
  readonly testBuild?: boolean;
  readonly verifiedNoEvent?: boolean;
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
          ? {
              body: copy.changeReminders.enabled.body(snapshot.preferences),
              heading: copy.changeReminders.enabled.heading,
            }
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
                      : snapshot.kind === 'zone-failed'
                        ? copy.changeReminders.zoneFailed
                        : snapshot.kind === 'retry-pending'
                          ? copy.changeReminders.retryPending
                          : snapshot.kind === 'unavailable'
                            ? copy.changeReminders.webUnavailable
                            : snapshot.kind === 'loading' ||
                                snapshot.kind === 'saving' ||
                                snapshot.kind === 'saving-preferences' ||
                                snapshot.kind === 'saving-zone' ||
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
    snapshot.kind === 'zone-mismatch' ||
    snapshot.kind === 'zone-failed';
  const pendingText =
    snapshot.kind === 'loading'
      ? copy.changeReminders.loading
      : snapshot.kind === 'saving'
        ? copy.changeReminders.saving.body
        : snapshot.kind === 'disabling'
          ? copy.changeReminders.disabling
          : snapshot.kind === 'saving-zone'
            ? copy.changeReminders.savingZone
            : copy.changeReminders.savingPreferences;
  useRegistrationAnnouncements(
    snapshot.kind,
    content?.body,
    errorState && Platform.OS === 'android',
  );

  return (
    <View style={[styles.card, { borderColor: palette.rule }]}>
      <Text
        accessibilityRole="header"
        style={[styles.metadata, { color: palette.secondaryInk }]}
      >
        {copy.changeReminders.heading}
      </Text>
      {content === null ? (
        <>
          {snapshot.kind === 'saving' ? (
            <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
              {copy.changeReminders.saving.heading}
            </Text>
          ) : null}
          {/*
            Text, not a spinner: nothing in this design loops, so reduced
            motion keeps the same meaning. The label keeps Android from
            reading only "busy". The key stops the message that follows
            reusing this view, because Android keeps a reused view's busy
            state and would read "busy" for that message.
          */}
          <Text
            accessibilityLabel={pendingText}
            accessibilityLiveRegion="none"
            accessibilityState={{ busy: true }}
            key="pending"
            style={[styles.body, { color: palette.ink }]}
          >
            {pendingText}
          </Text>
        </>
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
      {snapshot.kind === 'enabled' && verifiedNoEvent ? (
        <Text style={[styles.body, { color: palette.ink }]}>
          {copy.changeReminders.noEvent}
        </Text>
      ) : null}
      {snapshot.kind === 'enabled' ||
      snapshot.kind === 'preferences-failed' ||
      snapshot.kind === 'disable-failed' ? (
        <TimingControls
          disabled={
            snapshot.kind === 'disable-failed' ||
            snapshot.kind === 'preferences-failed'
          }
          onChange={(preferences) =>
            session.dispatch({ type: 'change-preferences', preferences })
          }
          palette={palette}
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
          {snapshot.kind === 'confirm-disable' ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => session.dispatch({ type: 'cancel-disable' })}
              style={[styles.button, { borderColor: palette.controlBoundary }]}
            >
              <Text style={[styles.buttonText, { color: palette.ink }]}>
                {copy.changeReminders.disableConfirmation.cancel}
              </Text>
            </Pressable>
          ) : null}
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
      {snapshot.kind === 'zone-failed' ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => session.dispatch({ type: 'retry-zone' })}
          style={[styles.button, { borderColor: palette.controlBoundary }]}
        >
          <Text style={[styles.buttonText, { color: palette.ink }]}>
            {copy.changeReminders.zoneFailed.retry}
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
