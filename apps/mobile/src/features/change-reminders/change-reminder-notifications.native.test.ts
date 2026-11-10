import { act, renderHook } from '@testing-library/react-native';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import { useProductionChangeReminderTap } from './change-reminder-notifications.native';

jest.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  addNotificationResponseReceivedListener: jest.fn(),
  clearLastNotificationResponseAsync: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
}));

interface ResponseLike {
  readonly actionIdentifier: string;
  readonly notification: {
    readonly request: {
      readonly content: {
        readonly body: string | null;
        readonly data: unknown;
        readonly title: string | null;
      };
    };
  };
}

const notifications = jest.requireMock<{
  readonly DEFAULT_ACTION_IDENTIFIER: string;
  readonly addNotificationResponseReceivedListener: jest.Mock<
    { remove: () => void },
    [(response: ResponseLike) => void]
  >;
  readonly clearLastNotificationResponseAsync: jest.Mock<Promise<void>, []>;
  readonly getLastNotificationResponseAsync: jest.Mock<
    Promise<ResponseLike | null>,
    []
  >;
  readonly setNotificationHandler: jest.Mock<void, [unknown]>;
}>('expo-notifications');

const reminderPayload = {
  changeDirection: 'forward',
  changeEventAt: '2026-10-03T16:00:00.000Z',
  homeTimeZone: 'Australia/Sydney',
  reminderKind: 'change-reminder',
  reminderTiming: 'one-week',
} as const;

const expectedTap = {
  changeDirection: 'forward',
  changeEventAt: '2026-10-03T16:00:00.000Z',
  homeTimeZone: 'Australia/Sydney',
  reminderTiming: 'one-week',
};

function reminderResponse(
  actionIdentifier = notifications.DEFAULT_ACTION_IDENTIFIER,
): ResponseLike {
  return {
    actionIdentifier,
    notification: {
      request: {
        content: {
          body: copy.changeReminders.notification.body,
          data: reminderPayload,
          title: copy.changeReminders.notification.title,
        },
      },
    },
  };
}

describe('useProductionChangeReminderTap', () => {
  const originalAppState = AppState.currentState;
  const removeResponseListener = jest.fn();
  const removeAppStateListener = jest.fn();
  let respond: (response: ResponseLike) => void;
  let changeAppState: (state: AppStateStatus) => void;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    notifications.addNotificationResponseReceivedListener.mockImplementation(
      (listener) => {
        respond = listener;
        return { remove: removeResponseListener };
      },
    );
    notifications.clearLastNotificationResponseAsync.mockResolvedValue();
    notifications.getLastNotificationResponseAsync.mockResolvedValue(null);
    jest
      .mocked(AppState.addEventListener)
      .mockImplementation((_type, listener) => {
        changeAppState = listener;
        return { remove: removeAppStateListener };
      });
    AppState.currentState = 'active';
  });

  afterEach(() => {
    // Jest's AppState mock is shared, so put its defaults back.
    jest
      .mocked(AppState.addEventListener)
      .mockImplementation(() => ({ remove: jest.fn() }));
    AppState.currentState = originalAppState;
    jest.restoreAllMocks();
  });

  async function mount() {
    const mounted = renderHook(() => useProductionChangeReminderTap());
    await act(async () => undefined);
    return mounted;
  }

  it('registers the reviewed handler and listener for as long as it is mounted', async () => {
    const { unmount } = await mount();

    expect(notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
    expect(notifications.setNotificationHandler).toHaveBeenLastCalledWith(
      expect.objectContaining({ handleNotification: expect.any(Function) }),
    );
    expect(
      notifications.addNotificationResponseReceivedListener,
    ).toHaveBeenCalledTimes(1);
    expect(AppState.addEventListener).toHaveBeenCalledWith(
      'change',
      expect.any(Function),
    );
    expect(removeResponseListener).not.toHaveBeenCalled();
    expect(removeAppStateListener).not.toHaveBeenCalled();

    unmount();

    expect(removeResponseListener).toHaveBeenCalledTimes(1);
    expect(removeAppStateListener).toHaveBeenCalledTimes(1);
    expect(notifications.setNotificationHandler).toHaveBeenLastCalledWith(null);
  });

  it('opens the tap that launched the app and clears it from the system', async () => {
    notifications.getLastNotificationResponseAsync.mockResolvedValue(
      reminderResponse(),
    );

    const { result } = await mount();

    expect(result.current.tap).toEqual(expectedTap);
    expect(
      notifications.clearLastNotificationResponseAsync,
    ).toHaveBeenCalledTimes(1);
  });

  it('opens a tap received while the app is running', async () => {
    const { result } = await mount();
    expect(result.current.tap).toBeNull();

    act(() => respond(reminderResponse()));

    expect(result.current.tap).toEqual(expectedTap);
  });

  it.each([
    ['android', expectedTap],
    ['ios', null],
  ] as const)(
    'on %s, judges a tap without copy on its reminder fields alone',
    async (os, expected) => {
      jest.replaceProperty(Platform, 'OS', os);
      const { result } = await mount();
      const tray = reminderResponse();

      act(() =>
        respond({
          ...tray,
          notification: {
            request: {
              content: {
                body: null,
                data: { ...reminderPayload, 'google.message_id': '0:1' },
                title: null,
              },
            },
          },
        }),
      );

      expect(result.current.tap).toEqual(expected);
    },
  );

  it('ignores a response to anything but the default notification action', async () => {
    const { result } = await mount();

    act(() => respond(reminderResponse('dismiss')));

    expect(result.current.tap).toBeNull();
  });

  it.each(['background', 'inactive'] as const)(
    'holds a tap until the app is active when it starts %s',
    async (state) => {
      AppState.currentState = state;
      notifications.getLastNotificationResponseAsync.mockResolvedValue(
        reminderResponse(),
      );

      const { result } = await mount();
      expect(result.current.tap).toBeNull();

      act(() => changeAppState('active'));

      expect(result.current.tap).toEqual(expectedTap);
    },
  );

  it.each(['background', 'inactive'] as const)(
    'holds a tap received while the app is %s and clears one already open',
    async (state) => {
      const { result } = await mount();
      act(() => respond(reminderResponse()));
      expect(result.current.tap).toEqual(expectedTap);

      act(() => changeAppState(state));
      expect(result.current.tap).toBeNull();

      act(() => respond(reminderResponse()));
      expect(result.current.tap).toBeNull();

      act(() => changeAppState('active'));
      expect(result.current.tap).toEqual(expectedTap);
    },
  );

  it('lets the caller report an app state change', async () => {
    const { result } = await mount();
    act(() => respond(reminderResponse()));
    expect(result.current.tap).toEqual(expectedTap);

    act(() => result.current.onAppStateChange('background'));

    expect(result.current.tap).toBeNull();
  });

  it('releases what it registered when it unmounts before startup finishes', async () => {
    let finishStartup: (response: ResponseLike | null) => void = () => {};
    notifications.getLastNotificationResponseAsync.mockReturnValue(
      new Promise((resolve) => {
        finishStartup = resolve;
      }),
    );
    const { unmount } = await mount();

    unmount();
    expect(removeResponseListener).not.toHaveBeenCalled();

    await act(async () => finishStartup(null));

    expect(removeResponseListener).toHaveBeenCalledTimes(1);
    expect(notifications.setNotificationHandler).toHaveBeenLastCalledWith(null);
  });
});
