import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

import { fcmTransportProofBuild } from './fcm-transport-proof-build';
import {
  createFcmTransportProofBackgroundHandler,
  fcmTransportProofBackgroundTaskName,
  synchronizeFcmTransportProofBackgroundTask,
} from './fcm-transport-proof-background-runtime';

const handle = createFcmTransportProofBackgroundHandler({
  proofBuild: fcmTransportProofBuild,
  schedule: (request) =>
    Notifications.scheduleNotificationAsync({
      ...request,
      content: {
        ...request.content,
        data: { ...request.content.data },
        priority: Notifications.AndroidNotificationPriority.HIGH,
      },
    }),
});

if (!TaskManager.isTaskDefined(fcmTransportProofBackgroundTaskName)) {
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(
    fcmTransportProofBackgroundTaskName,
    async ({ data, error }) => {
      const result = await handle({ data, error });
      return result === 'new-data'
        ? Notifications.BackgroundNotificationTaskResult.NewData
        : result === 'failed'
          ? Notifications.BackgroundNotificationTaskResult.Failed
          : Notifications.BackgroundNotificationTaskResult.NoData;
    },
  );
}

void synchronizeFcmTransportProofBackgroundTask({
  available: TaskManager.isAvailableAsync,
  isRegistered: () =>
    TaskManager.isTaskRegisteredAsync(fcmTransportProofBackgroundTaskName),
  proofBuild: fcmTransportProofBuild,
  register: () =>
    Notifications.registerTaskAsync(fcmTransportProofBackgroundTaskName),
  unregister: () =>
    Notifications.unregisterTaskAsync(fcmTransportProofBackgroundTaskName),
}).catch(() => undefined);
