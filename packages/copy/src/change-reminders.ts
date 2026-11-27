import { changeReminderNotification } from './change-reminder-notification.ts';

interface PauseSettingDevice {
  readonly androidApiLevel: number;
  readonly samsung: boolean;
}

// The App info switch that lets Android pause an unused app, as labelled in
// AOSP Settings: Android 12 and 13 renamed it, and Android 15 renamed it again
// when app archiving arrived. Samsung uses its own name before Android 15
// (seen on Android 13; 12 and 14 assumed). Galaxy S25 owners report Android
// 15's.
function pauseSettingLabel({
  androidApiLevel,
  samsung,
}: PauseSettingDevice): string {
  if (androidApiLevel >= 35) return 'Manage app if unused';
  if (samsung) return 'Remove permissions if app is unused';
  if (androidApiLevel >= 33) return 'Pause app activity if unused';
  return 'Remove permissions and free up space';
}

export const changeReminders = Object.freeze({
  accessibility: Object.freeze({
    enableHint:
      'Explains reminder timing before asking for notification permission',
    openAppSettingsHint: 'Opens app info settings for Daylight Saviour',
    openNeverSleepingAppsHint: 'Opens Samsung’s list of never sleeping apps',
    openSettingsHint: 'Opens device notification settings',
    oneDay: 'One-day Change Reminder',
    oneWeek: 'One-week Change Reminder',
  }),
  androidPause: Object.freeze({
    body: (device: PauseSettingDevice) =>
      `Android pauses apps left unopened for a few months, and paused apps can’t receive reminders. To get reminders even when you haven’t opened Daylight Saviour in a while, turn off “${pauseSettingLabel(device)}”.`,
    heading: 'Keep daylight saving reminders arriving',
    line: (device: PauseSettingDevice) =>
      `Android may pause Daylight Saviour if it’s left unopened, which stops daylight saving reminders. Turn off “${pauseSettingLabel(device)}”.`,
    open: 'Open app settings',
  }),
  appSleepNotNow: 'Not now',
  disabled: Object.freeze({
    action: 'Enable Change Reminders',
    body: 'Change Reminders are disabled on this device.',
    heading: 'Change Reminders disabled',
  }),
  disableConfirmation: Object.freeze({
    body: 'Turning off both timings deletes this app’s Change Reminders registration. You can enable reminders again later.',
    cancel: 'Keep reminders',
    confirm: 'Disable and delete reminders',
    heading: 'Disable Change Reminders?',
  }),
  disableFailed: Object.freeze({
    body: 'Deletion could not be confirmed on this device. Check your connection and try again.',
    confirm: 'Try deletion again',
    heading: 'Reminder deletion not confirmed',
    throttledBody:
      'Too many reminder changes in a short time. Try deletion again in 10 minutes.',
  }),
  disabling: 'Deleting Change Reminder registration…',
  enabled: Object.freeze({
    body: (preferences: {
      readonly oneDayEnabled: boolean;
      readonly oneWeekEnabled: boolean;
    }) =>
      preferences.oneWeekEnabled && preferences.oneDayEnabled
        ? 'One-week and one-day Change Reminders are enabled for your Home Time Zone.'
        : preferences.oneWeekEnabled
          ? 'One-week Change Reminders are enabled for your Home Time Zone.'
          : 'One-day Change Reminders are enabled for your Home Time Zone.',
    heading: 'Change Reminders enabled',
  }),
  explainer: Object.freeze({
    body: 'One week and one day before your clocks change, following your Home Time Zone as you travel. Best effort, no account, and we store only what’s needed to send them and prevent abuse.',
    confirm: 'Enable reminders',
    heading: 'Warn me before time misbehaves',
  }),
  failed: Object.freeze({
    body: 'Reminders are not enabled. Check your connection and try again.',
    heading: 'Reminder registration failed',
    retry: 'Try registration again',
    throttledBody:
      'Too many reminder changes in a short time. Try again in 10 minutes.',
  }),
  heading: 'Change Reminders',
  loading: 'Checking reminder registration…',
  loadFailed: Object.freeze({
    body: 'Reminder status could not be read securely. Try again before changing registration.',
    heading: 'Reminder status unavailable',
    retry: 'Check reminder status again',
  }),
  noEvent:
    'No change scheduled. Keep reminders on and we’ll warn you if that changes.',
  notification: changeReminderNotification,
  notificationContext: Object.freeze({
    opened: Object.freeze({
      heading: 'Change Reminder opened',
      past: 'This Civil Time Report shows the Change Event from your reminder.',
      upcoming:
        'This Civil Time Report shows the upcoming Change Event from your reminder.',
    }),
    agedOut: Object.freeze({
      body: "This reminder's Change Event passed 48 hours ago or more. Current Civil Time Report details are shown instead.",
      heading: 'Reminder event passed',
    }),
    eventMismatch: Object.freeze({
      body: 'This reminder does not match the verified Change Event. Current Civil Time Report details are shown instead.',
      heading: 'Reminder event mismatch',
    }),
    eventUnavailable: Object.freeze({
      body: 'This reminder refers to a Change Event no longer available in verified time-zone data. Current Civil Time Report details are shown instead.',
      heading: 'Reminder event unavailable',
    }),
    reportUnavailable: Object.freeze({
      body: 'Verified Civil Time Report details are unavailable. Refresh time-zone data and try again.',
      heading: 'Reminder report unavailable',
    }),
    zoneMismatch: Object.freeze({
      body: 'This reminder was sent for a different Home Time Zone. Current Civil Time Report details are shown instead.',
      heading: 'Reminder Home Time Zone changed',
    }),
  }),
  osBlocked: Object.freeze({
    body: 'Notifications are blocked by your device settings. Reminders are not enabled.',
    heading: 'Notifications blocked',
    openSettings: 'Open notification settings',
  }),
  permissionDenied: Object.freeze({
    body: 'Notification permission was not granted. Reminders are not enabled.',
    heading: 'Notifications not allowed',
    retry: 'Ask again',
  }),
  permissionRevoked: Object.freeze({
    body: 'Change Reminders remain registered, but notifications are blocked by your device settings and cannot arrive.',
    heading: 'Registered, not deliverable',
    openSettings: 'Open notification settings',
  }),
  preferencesFailed: Object.freeze({
    body: 'Your timing change could not be confirmed. Remote reminder timings may differ from those shown. Try again to reconcile them.',
    cancel: 'Keep saved timings',
    heading: 'Timing change unconfirmed',
    retry: 'Try timing change again',
  }),
  retryPending: Object.freeze({
    body: 'Registration did not finish on this device. Reminders are not enabled until retry succeeds.',
    heading: 'Reminder registration unconfirmed',
    retry: 'Retry registration',
  }),
  saving: Object.freeze({
    body: 'Waiting for confirmation. Reminders are not enabled yet.',
    heading: 'Registering reminders',
  }),
  samsungSleep: Object.freeze({
    body: 'Samsung puts apps to sleep after a few weeks unopened, and sleeping apps can’t receive reminders. To get reminders even when you haven’t opened Daylight Saviour in a while, add it to “Never sleeping apps”.',
    heading: 'Keep daylight saving reminders arriving on Samsung',
    line: 'Check that Daylight Saviour is in “Never sleeping apps” so daylight saving reminders can arrive.',
    open: 'Open Never sleeping apps',
  }),
  savingPreferences: 'Saving reminder timings…',
  savingZone: 'Updating reminders for your Home Time Zone…',
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
    heading: 'Reminder zone changed',
  }),
  zoneFailed: Object.freeze({
    body: 'Your Home Time Zone is saved, but the reminder update could not be confirmed. Remote reminders may still follow the previous zone. Try again to reconcile them.',
    heading: 'Home Time Zone change unconfirmed',
    retry: 'Try Home Time Zone update again',
  }),
  webUnavailable: Object.freeze({
    body: 'Change Reminders require the Android or iOS app. Web preview does not request notification permission.',
    heading: 'Reminders unavailable on web',
  }),
});
