import { changeReminderNotification } from './change-reminder-notification.ts';

export const changeReminders = Object.freeze({
  accessibility: Object.freeze({
    enableHint:
      'Explains reminder timing before asking for notification permission',
    openSettingsHint: 'Opens device notification settings',
    oneDayEnabled: 'One-day Change Reminder enabled',
    oneWeekEnabled: 'One-week Change Reminder enabled',
  }),
  disabled: Object.freeze({
    action: 'Enable Change Reminders',
    body: 'Change Reminders are disabled and this installation’s reminder registration has been deleted.',
    heading: 'CHANGE REMINDERS DISABLED',
  }),
  disableConfirmation: Object.freeze({
    body: 'Turning off both timings deletes this installation’s Change Reminder registration. This cannot be undone, but you can enable reminders again later.',
    cancel: 'Keep reminders',
    confirm: 'Disable and delete reminders',
    heading: 'DISABLE CHANGE REMINDERS?',
  }),
  disableFailed: Object.freeze({
    body: 'Change Reminders are still enabled because deletion did not finish. Check your connection and try again.',
    cancel: 'Keep reminders',
    confirm: 'Try deletion again',
    heading: 'REMINDER DELETION NOT CONFIRMED',
  }),
  disabling: 'Deleting Change Reminder registration…',
  enabled: (preferences: {
    readonly oneDayEnabled: boolean;
    readonly oneWeekEnabled: boolean;
  }) => ({
    body:
      preferences.oneWeekEnabled && preferences.oneDayEnabled
        ? 'One-week and one-day Change Reminders are enabled for your Home Time Zone.'
        : preferences.oneWeekEnabled
          ? 'One-week Change Reminders are enabled for your Home Time Zone.'
          : 'One-day Change Reminders are enabled for your Home Time Zone.',
    heading: 'CHANGE REMINDERS ENABLED',
  }),
  explainer: Object.freeze({
    body: 'One week and one day before a Change Event, following your Home Time Zone while you travel. Delivery is best effort. No account is needed; only this installation, its push token, zone, and timing preferences are stored.',
    confirm: 'Enable reminders',
    heading: 'WARN ME BEFORE TIME MISBEHAVES',
  }),
  failed: Object.freeze({
    body: 'Reminders are not enabled. Check your connection and try again.',
    heading: 'REMINDER REGISTRATION FAILED',
    retry: 'Try registration again',
  }),
  heading: 'CHANGE REMINDERS',
  loading: 'Checking reminder registration…',
  loadFailed: Object.freeze({
    body: 'Reminder status could not be read securely. Try again before changing registration.',
    heading: 'REMINDER STATUS UNAVAILABLE',
    retry: 'Check reminder status again',
  }),
  notification: changeReminderNotification,
  notificationContext: Object.freeze({
    opened: Object.freeze({
      heading: 'CHANGE REMINDER OPENED',
      past: 'This Civil Time Report shows the Change Event from your reminder.',
      upcoming:
        'This Civil Time Report shows the upcoming Change Event from your reminder.',
    }),
    agedOut: Object.freeze({
      body: "This reminder's Change Event passed 48 hours ago or more. Current Civil Time Report details are shown instead.",
      heading: 'REMINDER EVENT PASSED',
    }),
    eventMismatch: Object.freeze({
      body: 'This reminder does not match the verified Change Event. Current Civil Time Report details are shown instead.',
      heading: 'REMINDER EVENT MISMATCH',
    }),
    eventUnavailable: Object.freeze({
      body: 'This reminder refers to a Change Event no longer available in verified time-zone data. Current Civil Time Report details are shown instead.',
      heading: 'REMINDER EVENT UNAVAILABLE',
    }),
    reportUnavailable: Object.freeze({
      body: 'Verified Civil Time Report details are unavailable. Refresh time-zone data and try again.',
      heading: 'REMINDER REPORT UNAVAILABLE',
    }),
    zoneMismatch: Object.freeze({
      body: 'This reminder was sent for a different Home Time Zone. Current Civil Time Report details are shown instead.',
      heading: 'REMINDER HOME TIME ZONE CHANGED',
    }),
  }),
  osBlocked: Object.freeze({
    body: 'Notifications are blocked by your device settings. Reminders are not enabled.',
    heading: 'NOTIFICATIONS BLOCKED',
    openSettings: 'Open notification settings',
  }),
  permissionDenied: Object.freeze({
    body: 'Notification permission was not granted. Reminders are not enabled.',
    heading: 'NOTIFICATIONS NOT ALLOWED',
    retry: 'Ask again',
  }),
  permissionRevoked: Object.freeze({
    body: 'Change Reminders remain registered, but notifications are blocked by your device settings and cannot arrive.',
    heading: 'REGISTERED, NOT DELIVERABLE',
    openSettings: 'Open notification settings',
  }),
  preferencesFailed: Object.freeze({
    body: 'Your saved reminder timings are unchanged. Check your connection and try the timing change again.',
    cancel: 'Keep saved timings',
    heading: 'TIMING CHANGE NOT SAVED',
    retry: 'Try timing change again',
  }),
  retryPending: Object.freeze({
    body: 'Registration did not finish on this device. Reminders are not enabled until retry succeeds.',
    heading: 'REMINDER REGISTRATION UNCONFIRMED',
    retry: 'Retry registration',
  }),
  saving: 'Registering reminders…',
  savingPreferences: 'Saving reminder timings…',
  timing: Object.freeze({
    oneDay: 'One day before',
    oneWeek: 'One week before',
  }),
  untouched: Object.freeze({
    action: 'Warn me before time misbehaves',
    body: 'Get one-week and one-day warnings before your Home Time Zone changes.',
  }),
  zoneMismatch: Object.freeze({
    body: 'Saved Change Reminders still follow a different Home Time Zone. They are not enabled for this Home Time Zone.',
    heading: 'REMINDER ZONE CHANGED',
  }),
  webUnavailable: Object.freeze({
    body: 'Change Reminders require the Android or iOS app. Web preview does not request notification permission.',
    heading: 'REMINDERS UNAVAILABLE ON WEB',
  }),
});
