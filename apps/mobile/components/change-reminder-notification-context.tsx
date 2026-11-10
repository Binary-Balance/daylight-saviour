import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import type { DaylightSaviourPalette } from '../src/theme';
import type { ChangeReminderTapContext } from '../src/features/status/status-view-model';

function contentFor(context: ChangeReminderTapContext) {
  switch (context.kind) {
    case 'matched':
      return {
        body: copy.changeReminders.notificationContext.opened[context.relation],
        heading: copy.changeReminders.notificationContext.opened.heading,
      };
    case 'aged-out':
      return copy.changeReminders.notificationContext.agedOut;
    case 'event-mismatch':
      return copy.changeReminders.notificationContext.eventMismatch;
    case 'event-unavailable':
      return copy.changeReminders.notificationContext.eventUnavailable;
    case 'report-unavailable':
      return copy.changeReminders.notificationContext.reportUnavailable;
    case 'zone-mismatch':
      return copy.changeReminders.notificationContext.zoneMismatch;
  }
  const exhaustive: never = context;
  return exhaustive;
}

// The notice sits on every reminder tap, so it draws the eye once with a
// soft glow that fades back to the card's normal look. Nothing loops. The
// fade waits a moment so it isn't spent while iOS is still opening the app.
const glowDelayMs = 400;
const glowDurationMs = 1600;

export default function ChangeReminderNotificationContext({
  context,
  palette,
  reducedMotion,
}: {
  readonly context: ChangeReminderTapContext | null;
  readonly palette: DaylightSaviourPalette;
  readonly reducedMotion: boolean | null;
}) {
  if (context === null) return null;
  // Each tap mounts a fresh notice, because the tap is cleared while the app
  // is in the background. Glow and announcement therefore play on mount.
  return (
    <Notice
      content={contentFor(context)}
      palette={palette}
      reducedMotion={reducedMotion}
    />
  );
}

function Notice({
  content,
  palette,
  reducedMotion,
}: {
  readonly content: { readonly body: string; readonly heading: string };
  readonly palette: DaylightSaviourPalette;
  readonly reducedMotion: boolean | null;
}) {
  const label = `${content.heading}. ${content.body}`;
  const [glowOpacity] = useState(() => new Animated.Value(0));
  const glowPlayed = useRef(false);

  // The report re-renders every second, so this is keyed on the label
  // string, not the context object. iOS does not announce an alert role.
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(label);
  }, [label]);

  // On a cold start the tap can arrive before the reduced-motion preference
  // is known (null). Glow once when it first reads as off; never with it on.
  useEffect(() => {
    if (reducedMotion !== false || glowPlayed.current) return;
    glowPlayed.current = true;
    glowOpacity.setValue(1);
    Animated.timing(glowOpacity, {
      delay: glowDelayMs,
      duration: glowDurationMs,
      toValue: 0,
      useNativeDriver: true,
    }).start();
  }, [glowOpacity, reducedMotion]);

  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="alert"
      accessible
      style={[
        styles.card,
        {
          backgroundColor: palette.surface,
          borderColor: palette.decisionNoticeBorder,
        },
      ]}
    >
      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: palette.decisionNoticeGlow,
            opacity: glowOpacity,
          },
        ]}
        testID="reminder-notice-glow"
      />
      <View>
        <Text style={[styles.heading, { color: palette.decisionNoticeText }]}>
          {content.heading}
        </Text>
        {/* Fades with the glow, so the heading keeps its contrast on it. */}
        <Animated.Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.heading,
            StyleSheet.absoluteFill,
            { color: palette.decisionNoticeGlowText, opacity: glowOpacity },
          ]}
          testID="reminder-notice-glow-heading"
        >
          {content.heading}
        </Animated.Text>
      </View>
      <Text style={[styles.body, { color: palette.ink }]}>{content.body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 17, lineHeight: 25 },
  card: { borderWidth: 1, gap: 8, padding: 16 },
  heading: { fontSize: 12, fontWeight: '800', letterSpacing: 1.1 },
});
