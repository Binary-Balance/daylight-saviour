import {
  createFcmTransportProofBackgroundHandler,
  parseFcmTransportProofBackgroundData,
  synchronizeFcmTransportProofBackgroundTask,
} from './fcm-transport-proof-background-runtime';

const remoteData = {
  collapseKey: null,
  data: {
    dataString: null,
    homeTimeZone: 'Australia/Sydney',
    notificationKind: 'fcm-transport-proof',
  },
  from: '1234567890',
  messageId: 'proof-message-id',
  messageType: null,
  notification: null,
  originalPriority: 1,
  priority: 1,
  sentTime: 1_786_000_000_000,
  to: null,
  ttl: 2_419_200,
};

describe('FCM transport-proof background runtime', () => {
  it('presents exact Expo-serialized remote data in a proof build', async () => {
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
  });

  it('ordinary build never presents during stale task execution', async () => {
    const schedule = jest.fn(async () => undefined);
    const handler = createFcmTransportProofBackgroundHandler({
      proofBuild: false,
      schedule,
    });

    await expect(handler({ data: remoteData, error: null })).resolves.toBe(
      'no-data',
    );
    expect(schedule).not.toHaveBeenCalled();
  });

  it('accepts pinned Android serializer dataString as null or absent', () => {
    expect(parseFcmTransportProofBackgroundData(remoteData)).toEqual({
      homeTimeZone: 'Australia/Sydney',
      notificationKind: 'fcm-transport-proof',
    });
    expect(
      parseFcmTransportProofBackgroundData({
        data: {
          homeTimeZone: 'Australia/Sydney',
          notificationKind: 'fcm-transport-proof',
        },
        notification: null,
      }),
    ).toEqual({
      homeTimeZone: 'Australia/Sydney',
      notificationKind: 'fcm-transport-proof',
    });
  });

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

  it('rejects responses, body, non-null dataString, extras, and local replay', () => {
    for (const value of [
      { actionIdentifier: 'default', notification: {} },
      null,
      {
        data: {
          body: 'caller selected',
          dataString: null,
          homeTimeZone: 'Australia/Sydney',
          notificationKind: 'fcm-transport-proof',
        },
      },
      {
        data: {
          dataString: undefined,
          homeTimeZone: 'Australia/Sydney',
          notificationKind: 'fcm-transport-proof',
        },
      },
      {
        data: {
          dataString: JSON.stringify({
            homeTimeZone: 'Australia/Sydney',
            notificationKind: 'fcm-transport-proof',
          }),
          homeTimeZone: 'Australia/Sydney',
          notificationKind: 'fcm-transport-proof',
        },
      },
      {
        data: {
          copy: 'caller selected',
          dataString: null,
          homeTimeZone: 'Australia/Sydney',
          notificationKind: 'fcm-transport-proof',
        },
      },
      {
        data: {
          dataString: null,
          homeTimeZone: 'Australia/Sydney',
          notificationKind: 'fcm-transport-proof',
          presentationKind: 'local-notification',
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
