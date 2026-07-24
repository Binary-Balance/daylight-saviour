export const changeReminders = Object.freeze({
  accessibility: Object.freeze({
    enableHint:
      'Explains reminder timing before asking for notification permission',
    openSettingsHint: 'Opens device notification settings',
  }),
  enabled: Object.freeze({
    body: 'One-week and one-day Change Reminders are enabled for your Home Time Zone.',
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
  retryPending: Object.freeze({
    body: 'Registration did not finish on this device. Reminders are not enabled until retry succeeds.',
    heading: 'REMINDER REGISTRATION UNCONFIRMED',
    retry: 'Retry registration',
  }),
  saving: 'Registering reminders…',
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
