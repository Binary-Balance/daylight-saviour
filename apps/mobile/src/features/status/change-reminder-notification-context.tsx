import { StyleSheet, Text, View } from 'react-native';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import type { DaylightSaviourPalette } from '../../theme';
import type { ChangeReminderTapContext } from './status-view-model';

export default function ChangeReminderNotificationContext({
  context,
  palette,
}: {
  readonly context: ChangeReminderTapContext | null;
  readonly palette: DaylightSaviourPalette;
}) {
  if (context === null) return null;
  const content =
    context.kind === 'matched'
      ? {
          body: copy.changeReminders.notificationContext.opened[
            context.relation
          ],
          heading: copy.changeReminders.notificationContext.opened.heading,
        }
      : context.kind === 'stale'
        ? copy.changeReminders.notificationContext.stale
        : copy.changeReminders.notificationContext.zoneMismatch;
  return (
    <View
      accessibilityRole="alert"
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
