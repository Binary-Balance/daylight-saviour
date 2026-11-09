import type { ChangeReminderAdapters } from './change-reminder-adapters';

/** Local stand-ins for screenshot mode: every request succeeds on the device. */
export const screenshotChangeReminderAdapters: ChangeReminderAdapters = {
  disable: async () => ({ kind: 'disabled' }),
  enable: async () => ({ kind: 'enabled' }),
  openSettings: async () => undefined,
  restore: async () => ({ kind: 'unregistered' }),
  startTokenRefresh: () => () => undefined,
  updatePreferences: async (preferences) => ({ kind: 'enabled', preferences }),
};
