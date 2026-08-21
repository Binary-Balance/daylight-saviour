import {
  createChangeReminderNotificationRuntime,
  createChangeReminderTapVisit,
  parseChangeReminderTap,
  type ChangeReminderNotificationContent,
} from './change-reminder-notification-runtime';
import { useProductionChangeReminderTap as useIosChangeReminderTap } from './change-reminder-notifications.ios';
import { useProductionChangeReminderTap as useNativeChangeReminderTap } from './change-reminder-notifications.native';

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

function response(overrides: Partial<ChangeReminderNotificationContent> = {}) {
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
          readonly request: {
            readonly content: ChangeReminderNotificationContent;
          };
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
  it('binds iOS to the reviewed native notification hook', () => {
    expect(useIosChangeReminderTap).toBe(useNativeChangeReminderTap);
  });

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

  it('keeps a warm response when an older cold response resolves later', async () => {
    let resolveCold!: (value: ReturnType<typeof response> | null) => void;
    const test = harness();
    test.notifications.getLastNotificationResponseAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCold = resolve;
        }),
    );
    const starting = test.runtime.start();
    test.emitResponse(
      response({
        data: { ...payload, reminderTiming: 'one-day' },
      }),
    );
    resolveCold(response());
    await starting;

    expect(test.taps).toEqual([
      expect.objectContaining({ reminderTiming: 'one-day' }),
    ]);
  });

  it('clears a tap while backgrounded and delivers a buffered response on activation', () => {
    const values: unknown[] = [];
    const visit = createChangeReminderTapVisit({
      onChange: (value) => values.push(value),
    });
    const tap = parseChangeReminderTap(payload);
    if (tap === null) throw new Error('Expected valid tap');

    visit.receive(tap);
    visit.setAppState('background');
    visit.receive(tap);
    visit.setAppState('active');

    expect(values).toEqual([tap, null, tap]);
  });

  it('delivers a response immediately when activation arrives first', () => {
    const values: unknown[] = [];
    const visit = createChangeReminderTapVisit({
      onChange: (value) => values.push(value),
    });
    const tap = parseChangeReminderTap(payload);
    if (tap === null) throw new Error('Expected valid tap');

    visit.setAppState('inactive');
    visit.setAppState('active');
    visit.receive(tap);

    expect(values).toEqual([null, tap]);
  });
});
