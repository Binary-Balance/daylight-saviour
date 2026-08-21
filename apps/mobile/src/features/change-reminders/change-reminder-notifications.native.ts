import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';

import {
  createChangeReminderNotificationRuntime,
  createChangeReminderTapVisit,
  type ReviewedNotificationTap,
} from './change-reminder-notification-runtime';

/** Native platforms share the reviewed Expo receipt and tap activation flow. */
export function useProductionChangeReminderTap() {
  const [tap, setTap] = useState<ReviewedNotificationTap | null>(null);
  const visit = useMemo(
    () => createChangeReminderTapVisit({ onChange: setTap }),
    [],
  );
  const runtime = useMemo(
    () =>
      createChangeReminderNotificationRuntime({
        notifications: {
          addNotificationResponseReceivedListener: (listener) =>
            Notifications.addNotificationResponseReceivedListener((response) =>
              listener(response),
            ),
          clearLastNotificationResponseAsync:
            Notifications.clearLastNotificationResponseAsync,
          defaultActionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
          getLastNotificationResponseAsync: async () =>
            Notifications.getLastNotificationResponseAsync(),
          setNotificationHandler: (handler) =>
            Notifications.setNotificationHandler(handler),
        },
        onTap: visit.receive,
      }),
    [visit],
  );

  useEffect(() => {
    visit.setAppState(
      AppState.currentState === 'active' ? 'active' : 'background',
    );
    const subscription = AppState.addEventListener('change', (nextState) => {
      visit.setAppState(nextState === 'active' ? 'active' : 'background');
    });
    return () => subscription.remove();
  }, [visit]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let active = true;
    void runtime
      .start()
      .then((nextStop) => {
        if (active) stop = nextStop;
        else nextStop();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      stop?.();
    };
  }, [runtime]);

  return { onAppStateChange: visit.setAppState, tap };
}
