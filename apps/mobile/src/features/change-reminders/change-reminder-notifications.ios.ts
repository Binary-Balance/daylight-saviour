import type { ChangeReminderTap } from './change-reminder-notification-runtime';

/** iOS push-tap activation is deferred until the reviewed PUB-60 scope. */
export function useProductionChangeReminderTap() {
  return {
    onAppStateChange: (_nextState: 'active' | 'background' | 'inactive') => {},
    tap: null as ChangeReminderTap | null,
  };
}
