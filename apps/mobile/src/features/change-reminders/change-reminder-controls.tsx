import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import type { DaylightSaviourPalette } from '../../theme';
import type {
  ChangeReminderAdapters,
  ChangeReminderPreferences,
} from './change-reminder-adapters';
import type {
  ChangeReminderSessionEvent,
  ChangeReminderSessionSnapshot,
} from './change-reminder-session';

// What the buttons of a state need. Only StartActions reads `kind`.
export interface ActionProps {
  readonly adapters: ChangeReminderAdapters;
  readonly dispatch: (event: ChangeReminderSessionEvent) => void;
  readonly kind: ChangeReminderSessionSnapshot['kind'];
  readonly palette: DaylightSaviourPalette;
}

export function TimingControls({
  preferences,
  onChange,
  palette,
  disabled,
}: {
  readonly preferences: ChangeReminderPreferences;
  readonly onChange: (preferences: ChangeReminderPreferences) => void;
  readonly palette: DaylightSaviourPalette;
  readonly disabled: boolean;
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

export function ActionButton({
  hint,
  label,
  onPress,
  palette,
  primary = false,
}: {
  readonly hint?: string;
  readonly label: string;
  readonly onPress: () => void;
  readonly palette: DaylightSaviourPalette;
  readonly primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityHint={hint}
      accessibilityRole="button"
      onPress={onPress}
      style={[
        styles.button,
        primary
          ? { backgroundColor: palette.actionFill }
          : { borderColor: palette.controlBoundary },
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          { color: primary ? palette.onActionFill : palette.ink },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function openSettings(adapters: ChangeReminderAdapters) {
  void adapters.openSettings().catch(() => undefined);
}

// One component serves both states, so that the button stays in place when the
// disabled card becomes the untouched one on the next return to the app.
export function StartActions({ dispatch, kind, palette }: ActionProps) {
  return (
    <ActionButton
      hint={copy.changeReminders.accessibility.enableHint}
      label={
        kind === 'disabled'
          ? copy.changeReminders.disabled.action
          : copy.changeReminders.untouched.action
      }
      onPress={() => dispatch({ type: 'show-explainer' })}
      palette={palette}
    />
  );
}

export function ExplainerActions({ dispatch, palette }: ActionProps) {
  return (
    <ActionButton
      label={copy.changeReminders.explainer.confirm}
      onPress={() => dispatch({ type: 'enable' })}
      palette={palette}
      primary
    />
  );
}

export function ConfirmDisableActions({ dispatch, palette }: ActionProps) {
  return (
    <View style={styles.actions}>
      <ActionButton
        label={copy.changeReminders.disableConfirmation.cancel}
        onPress={() => dispatch({ type: 'cancel-disable' })}
        palette={palette}
      />
      <ActionButton
        label={copy.changeReminders.disableConfirmation.confirm}
        onPress={() => dispatch({ type: 'confirm-disable' })}
        palette={palette}
        primary
      />
    </View>
  );
}

export function DisableFailedActions({ dispatch, palette }: ActionProps) {
  return (
    <View style={styles.actions}>
      <ActionButton
        label={copy.changeReminders.disableFailed.confirm}
        onPress={() => dispatch({ type: 'confirm-disable' })}
        palette={palette}
        primary
      />
    </View>
  );
}

export function PreferencesFailedActions({ dispatch, palette }: ActionProps) {
  return (
    <View style={styles.actions}>
      <ActionButton
        label={copy.changeReminders.preferencesFailed.retry}
        onPress={() => dispatch({ type: 'retry-preferences' })}
        palette={palette}
      />
      <ActionButton
        label={copy.changeReminders.preferencesFailed.cancel}
        onPress={() => dispatch({ type: 'cancel-preferences' })}
        palette={palette}
      />
    </View>
  );
}

export function ZoneFailedActions({ dispatch, palette }: ActionProps) {
  return (
    <ActionButton
      label={copy.changeReminders.zoneFailed.retry}
      onPress={() => dispatch({ type: 'retry-zone' })}
      palette={palette}
    />
  );
}

export function FailedActions({ dispatch, palette }: ActionProps) {
  return (
    <ActionButton
      label={copy.changeReminders.failed.retry}
      onPress={() => dispatch({ type: 'enable' })}
      palette={palette}
    />
  );
}

export function PermissionDeniedActions({ dispatch, palette }: ActionProps) {
  return (
    <ActionButton
      label={copy.changeReminders.permissionDenied.retry}
      onPress={() => dispatch({ type: 'enable' })}
      palette={palette}
    />
  );
}

export function RetryPendingActions({ dispatch, palette }: ActionProps) {
  return (
    <ActionButton
      label={copy.changeReminders.retryPending.retry}
      onPress={() => dispatch({ type: 'enable' })}
      palette={palette}
    />
  );
}

export function LoadFailedActions({ dispatch, palette }: ActionProps) {
  return (
    <ActionButton
      label={copy.changeReminders.loadFailed.retry}
      onPress={() => dispatch({ type: 'retry-load' })}
      palette={palette}
    />
  );
}

export function OsBlockedActions({ adapters, palette }: ActionProps) {
  return (
    <ActionButton
      hint={copy.changeReminders.accessibility.openSettingsHint}
      label={copy.changeReminders.osBlocked.openSettings}
      onPress={() => openSettings(adapters)}
      palette={palette}
    />
  );
}

export function PermissionRevokedActions({ adapters, palette }: ActionProps) {
  return (
    <ActionButton
      hint={copy.changeReminders.accessibility.openSettingsHint}
      label={copy.changeReminders.permissionRevoked.openSettings}
      onPress={() => openSettings(adapters)}
      palette={palette}
    />
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  buttonText: { fontSize: 14, fontWeight: '800' },
  timing: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  timingLabel: { fontSize: 17 },
  timings: { gap: 4 },
});
