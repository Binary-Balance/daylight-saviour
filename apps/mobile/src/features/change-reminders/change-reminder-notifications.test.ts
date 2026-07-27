import {
  createChangeReminderNotificationRuntime,
  parseChangeReminderTap,
  type ChangeReminderNotificationContent,
} from './change-reminder-notifications';

const payload = {
  changeDirection: 'forward',
  changeEventAt: '2026-10-03T16:00:00.000Z',
  homeTimeZone: 'Australia/Sydney',
  reminderKind: 'change-reminder',
  reminderTiming: 'one-week',
} as const;

const content: ChangeReminderNotificationContent = {
  body: 'Your Home Time Zone changes soon.',
  data: payload,
  title: 'Change Reminder',
};

function response(overrides: Partial<typeof content> = {}) {
  return {
    actionIdentifier: 'default',
    notification: { request: { content: { ...content, ...overrides } } },
  };
}

function harness({
  coldResponse = null,
}: {
  readonly coldResponse?: ReturnType<typeof response> | null;
} = {}) {
  let responseListener:
    | ((next: ReturnType<typeof response>) => void)
    | undefined;
  let notificationHandler:
    | {
        readonly handleNotification: (notification: {
          readonly request: { readonly content: typeof content };
        }) => Promise<unknown>;
      }
    | undefined;
  const remove = jest.fn();
  const notifications = {
    addNotificationResponseReceivedListener: jest.fn((listener) => {
      responseListener = listener;
      return { remove };
    }),
    clearLastNotificationResponseAsync: jest.fn(async () => undefined),
    defaultActionIdentifier: 'default',
    getLastNotificationResponseAsync: jest.fn(async () => coldResponse),
    setNotificationHandler: jest.fn((handler) => {
      notificationHandler = handler;
    }),
  };
  const taps: unknown[] = [];
  return {
    emitResponse: (next: ReturnType<typeof response>) =>
      responseListener?.(next),
    notificationHandler: () => notificationHandler,
    notifications,
    runtime: createChangeReminderNotificationRuntime({
      notifications,
      onTap: (tap) => taps.push(tap),
    }),
    taps,
    remove,
  };
}

describe('Change Reminder notification runtime', () => {
  it('accepts only exact fixed reminder fields', () => {
    expect(parseChangeReminderTap(payload)).toEqual({
      changeDirection: 'forward',
      changeEventAt: '2026-10-03T16:00:00.000Z',
      homeTimeZone: 'Australia/Sydney',
      reminderTiming: 'one-week',
    });
    expect(parseChangeReminderTap({ ...payload, extra: 'nope' })).toBeNull();
    expect(
      parseChangeReminderTap({ ...payload, homeTimeZone: 'Australia/ACT' }),
    ).toBeNull();
    expect(
      parseChangeReminderTap({ ...payload, changeEventAt: '2026-10-03' }),
    ).toBeNull();
  });

  it('fails closed for malformed or unreviewed foreground receipt copy', async () => {
    const test = harness();
    const stop = await test.runtime.start();
    const handler = test.notificationHandler();
    if (handler === undefined) throw new Error('Expected notification handler');

    await expect(
      handler.handleNotification({ request: { content } }),
    ).resolves.toEqual({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    });
    await expect(
      handler.handleNotification({
        request: { content: { ...content, body: 'Unreviewed body' } },
      }),
    ).resolves.toEqual({
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: false,
      shouldShowList: false,
    });
    stop();
    expect(test.remove).toHaveBeenCalledTimes(1);
    expect(test.notifications.setNotificationHandler).toHaveBeenLastCalledWith(
      null,
    );
  });

  it('consumes one cold-start response and opens only valid default taps', async () => {
    const test = harness({ coldResponse: response() });
    await test.runtime.start();

    expect(
      test.notifications.clearLastNotificationResponseAsync,
    ).toHaveBeenCalledTimes(1);
    expect(test.taps).toEqual([
      {
        changeDirection: 'forward',
        changeEventAt: '2026-10-03T16:00:00.000Z',
        homeTimeZone: 'Australia/Sydney',
        reminderTiming: 'one-week',
      },
    ]);
    test.emitResponse({ ...response(), actionIdentifier: 'dismiss' });
    test.emitResponse(response({ title: 'Unreviewed title' }));
    expect(test.taps).toHaveLength(1);
  });
});
