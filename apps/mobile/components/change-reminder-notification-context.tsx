import { StyleSheet, Text, View } from 'react-native';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import type { DaylightSaviourPalette } from '../src/theme';
import type { ChangeReminderTapContext } from '../src/features/status/status-view-model';

export default function ChangeReminderNotificationContext({
  context,
  palette,
}: {
  readonly context: ChangeReminderTapContext | null;
  readonly palette: DaylightSaviourPalette;
}) {
  if (context === null) return null;
  const content =
    context.kind === 'transport-proof'
      ? copy.changeReminders.transportProof.opened
      : context.kind === 'matched'
        ? {
            body: copy.changeReminders.notificationContext.opened[
              context.relation
            ],
            heading: copy.changeReminders.notificationContext.opened.heading,
          }
        : context.kind === 'aged-out'
          ? copy.changeReminders.notificationContext.agedOut
          : context.kind === 'event-mismatch'
            ? copy.changeReminders.notificationContext.eventMismatch
            : context.kind === 'event-unavailable'
              ? copy.changeReminders.notificationContext.eventUnavailable
              : context.kind === 'report-unavailable'
                ? copy.changeReminders.notificationContext.reportUnavailable
                : copy.changeReminders.notificationContext.zoneMismatch;
  return (
    <View
      accessibilityLabel={`${content.heading}. ${content.body}`}
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
      <Text style={[styles.heading, { color: palette.decisionNoticeText }]}>
        {content.heading}
      </Text>
      <Text style={[styles.body, { color: palette.ink }]}>{content.body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 17, lineHeight: 25 },
  card: { borderWidth: 1, gap: 8, padding: 16 },
  heading: { fontSize: 12, fontWeight: '800', letterSpacing: 1.1 },
});
