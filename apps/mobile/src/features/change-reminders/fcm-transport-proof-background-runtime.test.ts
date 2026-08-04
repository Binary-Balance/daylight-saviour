import {
  createFcmTransportProofBackgroundHandler,
  parseFcmTransportProofBackgroundData,
  synchronizeFcmTransportProofBackgroundTask,
} from './fcm-transport-proof-background-runtime';

const remoteData = {
  data: {
    dataString: JSON.stringify({
      homeTimeZone: 'Australia/Sydney',
      notificationKind: 'fcm-transport-proof',
    }),
  },
};

describe('FCM transport-proof background runtime', () => {
  it.each(['active', 'background', 'terminated'])(
    'presents exact remote data during %s task execution in proof build',
    async () => {
      const schedule = jest.fn(async () => 'local-notification-id');
      const handler = createFcmTransportProofBackgroundHandler({
        proofBuild: true,
        schedule,
      });

      await expect(handler({ data: remoteData, error: null })).resolves.toBe(
        'new-data',
      );
      expect(schedule).toHaveBeenCalledWith({
        content: {
          body: 'Test only. No Change Reminder is due.',
          data: {
            homeTimeZone: 'Australia/Sydney',
            notificationKind: 'fcm-transport-proof',
            presentationKind: 'local-notification',
          },
          sound: 'default',
          title: 'FCM transport test',
        },
        trigger: { channelId: 'change-reminders' },
      });
    },
  );

  it.each(['active', 'background', 'terminated'])(
    'ordinary build never presents during %s stale task execution',
    async () => {
      const schedule = jest.fn(async () => undefined);
      const handler = createFcmTransportProofBackgroundHandler({
        proofBuild: false,
        schedule,
      });

      await expect(handler({ data: remoteData, error: null })).resolves.toBe(
        'no-data',
      );
      expect(schedule).not.toHaveBeenCalled();
    },
  );

  it('accepts task payloads when Expo omits the error field', async () => {
    const schedule = jest.fn(async () => undefined);
    const handler = createFcmTransportProofBackgroundHandler({
      proofBuild: true,
      schedule,
    });

    await expect(handler({ data: remoteData, error: undefined })).resolves.toBe(
      'new-data',
    );
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('rejects responses, malformed data, arbitrary fields, and local replay', () => {
    for (const value of [
      { actionIdentifier: 'default', notification: {} },
      null,
      { data: { dataString: '{bad' } },
      {
        data: {
          dataString: JSON.stringify({
            homeTimeZone: 'Australia/Sydney',
            notificationKind: 'fcm-transport-proof',
            presentationKind: 'local-notification',
          }),
        },
      },
      {
        data: {
          dataString: JSON.stringify({
            copy: 'caller selected',
            homeTimeZone: 'Australia/Sydney',
            notificationKind: 'fcm-transport-proof',
          }),
        },
      },
    ]) {
      expect(parseFcmTransportProofBackgroundData(value)).toBeNull();
    }
  });

  it('registers proof task and unregisters stale ordinary-build task', async () => {
    const register = jest.fn(async () => undefined);
    const unregister = jest.fn(async () => undefined);
    await synchronizeFcmTransportProofBackgroundTask({
      available: async () => true,
      isRegistered: async () => false,
      proofBuild: true,
      register,
      unregister,
    });
    expect(register).toHaveBeenCalledTimes(1);
    expect(unregister).not.toHaveBeenCalled();

    register.mockClear();
    await synchronizeFcmTransportProofBackgroundTask({
      available: async () => true,
      isRegistered: async () => true,
      proofBuild: false,
      register,
      unregister,
    });
    expect(register).not.toHaveBeenCalled();
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});
