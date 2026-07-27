import type { ChangeReminderTap } from './change-reminder-notification-runtime';

/** Web preview deliberately never binds native notification APIs. */
export function useProductionChangeReminderTap() {
  return {
    onAppStateChange: (_nextState: 'active' | 'background' | 'inactive') => {},
    tap: null as ChangeReminderTap | null,
  };
}
