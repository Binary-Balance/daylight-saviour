import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import type { DaylightSaviourPalette } from '../../theme';
import type {
  ChangeReminderAdapters,
  ChangeReminderEnableResult,
} from './change-reminder-adapters';

type State =
  | 'untouched'
  | 'explainer'
  | 'saving'
  | ChangeReminderEnableResult['kind'];

export default function ChangeReminderSection({
  adapters,
  homeTimeZone,
  palette,
}: {
  readonly adapters: ChangeReminderAdapters;
  readonly homeTimeZone: string;
  readonly palette: DaylightSaviourPalette;
}) {
  const [state, setState] = useState<State>('untouched');
  const enable = () => {
    setState('saving');
    void adapters.enable(homeTimeZone).then((result) => setState(result.kind));
  };
  const content =
    state === 'untouched'
      ? copy.changeReminders.untouched
      : state === 'explainer'
        ? copy.changeReminders.explainer
        : state === 'enabled'
          ? copy.changeReminders.enabled
          : state === 'os-blocked'
            ? copy.changeReminders.osBlocked
            : state === 'unavailable'
              ? copy.changeReminders.webUnavailable
              : state === 'saving'
                ? null
                : state === 'permission-denied'
                  ? copy.changeReminders.permissionDenied
                  : copy.changeReminders.failed;
  return (
    <View style={[styles.card, { borderColor: palette.rule }]}>
      <Text
        accessibilityRole="header"
        style={[styles.metadata, { color: palette.secondaryInk }]}
      >
        {copy.changeReminders.heading}
      </Text>
      {content === null ? (
        <Text style={[styles.body, { color: palette.ink }]}>
          {copy.changeReminders.saving}
        </Text>
      ) : (
        <>
          {'heading' in content ? (
            <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
              {content.heading}
            </Text>
          ) : null}
          <Text style={[styles.body, { color: palette.ink }]}>
            {content.body}
          </Text>
        </>
      )}
      {state === 'untouched' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityHint={copy.changeReminders.accessibility.enableHint}
          onPress={() => setState('explainer')}
          style={[styles.button, { borderColor: palette.controlBoundary }]}
        >
          <Text style={[styles.buttonText, { color: palette.ink }]}>
            {copy.changeReminders.untouched.action}
          </Text>
        </Pressable>
      ) : null}
      {state === 'explainer' ? (
        <Pressable
          accessibilityRole="button"
          onPress={enable}
          style={[styles.button, { backgroundColor: palette.actionFill }]}
        >
          <Text style={[styles.buttonText, { color: palette.onActionFill }]}>
            {copy.changeReminders.explainer.confirm}
          </Text>
        </Pressable>
      ) : null}
      {state === 'failed' || state === 'permission-denied' ? (
        <Pressable
          accessibilityRole="button"
          onPress={enable}
          style={[styles.button, { borderColor: palette.controlBoundary }]}
        >
          <Text style={[styles.buttonText, { color: palette.ink }]}>
            {state === 'failed'
              ? copy.changeReminders.failed.retry
              : copy.changeReminders.permissionDenied.retry}
          </Text>
        </Pressable>
      ) : null}
      {state === 'os-blocked' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityHint={
            copy.changeReminders.accessibility.openSettingsHint
          }
          onPress={() => void adapters.openSettings()}
          style={[styles.button, { borderColor: palette.controlBoundary }]}
        >
          <Text style={[styles.buttonText, { color: palette.ink }]}>
            {copy.changeReminders.osBlocked.openSettings}
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
