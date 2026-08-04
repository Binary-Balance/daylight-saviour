import { StyleSheet, Text, View } from 'react-native';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import type { DaylightSaviourPalette } from '../src/theme';
import type { ChangeReminderTapContext } from '../src/features/status/status-view-model';

function contentFor(context: ChangeReminderTapContext) {
  switch (context.kind) {
    case 'transport-proof':
      return copy.changeReminders.transportProof.opened;
    case 'transport-proof-report-unavailable':
      return copy.changeReminders.transportProof.reportUnavailable;
    case 'transport-proof-zone-mismatch':
      return copy.changeReminders.transportProof.zoneMismatch;
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

export default function ChangeReminderNotificationContext({
  context,
  palette,
}: {
  readonly context: ChangeReminderTapContext | null;
  readonly palette: DaylightSaviourPalette;
}) {
  if (context === null) return null;
  const content = contentFor(context);
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
