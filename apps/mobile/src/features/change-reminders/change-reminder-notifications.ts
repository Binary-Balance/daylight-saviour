import { useEffect, useMemo, useState } from 'react';
import * as Notifications from 'expo-notifications';
import { australianEnglish as copy } from '@daylight-saviour/copy';
import { canonicalAustralianZoneId } from '@daylight-saviour/domain/australian-zone-runtime';

const payloadKeys = [
  'changeDirection',
  'changeEventAt',
  'homeTimeZone',
  'reminderKind',
  'reminderTiming',
] as const;

export interface ChangeReminderTap {
  readonly changeDirection: 'forward' | 'backward';
  readonly changeEventAt: string;
  readonly homeTimeZone: string;
  readonly reminderTiming: 'one-day' | 'one-week';
}

export interface ChangeReminderNotificationContent {
  readonly body: string | null;
  readonly data?: unknown;
  readonly title: string | null;
}

export interface ChangeReminderNotificationResponse {
  readonly actionIdentifier: string;
  readonly notification: {
    readonly request: { readonly content: ChangeReminderNotificationContent };
  };
}

interface EventSubscription {
  readonly remove: () => void;
}

interface ChangeReminderNotifications {
  readonly addNotificationResponseReceivedListener: (
    listener: (response: ChangeReminderNotificationResponse) => void,
  ) => EventSubscription;
  readonly clearLastNotificationResponseAsync: () => Promise<void>;
  readonly defaultActionIdentifier: string;
  readonly getLastNotificationResponseAsync: () => Promise<ChangeReminderNotificationResponse | null>;
  readonly setNotificationHandler: (
    handler: {
      readonly handleNotification: (notification: {
        readonly request: {
          readonly content: ChangeReminderNotificationContent;
        };
      }) => Promise<{
        readonly shouldPlaySound: boolean;
        readonly shouldSetBadge: boolean;
        readonly shouldShowBanner: boolean;
        readonly shouldShowList: boolean;
      }>;
    } | null,
  ) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyPayloadKeys(value: Record<string, unknown>) {
  const keys = Object.keys(value).sort();
  return (
    keys.length === payloadKeys.length &&
    keys.every((key, index) => key === payloadKeys[index])
  );
}

export function parseChangeReminderTap(
  value: unknown,
): ChangeReminderTap | null {
  if (!isRecord(value) || !hasOnlyPayloadKeys(value)) return null;
  if (
    value.reminderKind !== 'change-reminder' ||
    (value.changeDirection !== 'forward' &&
      value.changeDirection !== 'backward') ||
    (value.reminderTiming !== 'one-week' &&
      value.reminderTiming !== 'one-day') ||
    typeof value.changeEventAt !== 'string' ||
    typeof value.homeTimeZone !== 'string'
  ) {
    return null;
  }
  const eventAt = new Date(value.changeEventAt);
  if (
    Number.isNaN(eventAt.getTime()) ||
    eventAt.toISOString() !== value.changeEventAt ||
    canonicalAustralianZoneId(value.homeTimeZone) !== value.homeTimeZone
  ) {
    return null;
  }
  return {
    changeDirection: value.changeDirection,
    changeEventAt: value.changeEventAt,
    homeTimeZone: value.homeTimeZone,
    reminderTiming: value.reminderTiming,
  };
}

export function isReviewedChangeReminderReceipt(
  content: ChangeReminderNotificationContent,
) {
  return (
    content.title === copy.changeReminders.notification.title &&
    content.body === copy.changeReminders.notification.body &&
    parseChangeReminderTap(content.data) !== null
  );
}

export function createChangeReminderNotificationRuntime({
  notifications,
  onTap,
}: {
  readonly notifications: ChangeReminderNotifications;
  readonly onTap: (tap: ChangeReminderTap) => void;
}) {
  const failClosed = {
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: false,
    shouldShowList: false,
  } as const;
  const showReviewedReminder = {
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  } as const;

  function receive(
    content: ChangeReminderNotificationContent,
  ): typeof failClosed | typeof showReviewedReminder {
    return isReviewedChangeReminderReceipt(content)
      ? showReviewedReminder
      : failClosed;
  }

  function respond(response: ChangeReminderNotificationResponse) {
    if (response.actionIdentifier !== notifications.defaultActionIdentifier)
      return;
    const content = response.notification.request.content;
    if (!isReviewedChangeReminderReceipt(content)) return;
    const tap = parseChangeReminderTap(content.data);
    if (tap !== null) onTap(tap);
  }

  return {
    async start() {
      notifications.setNotificationHandler({
        handleNotification: async (notification) =>
          receive(notification.request.content),
      });
      const responseSubscription =
        notifications.addNotificationResponseReceivedListener(respond);
      try {
        const coldResponse =
          await notifications.getLastNotificationResponseAsync();
        if (coldResponse !== null) {
          try {
            await notifications.clearLastNotificationResponseAsync();
          } catch {
            // A failed clear cannot make an untrusted response actionable.
          }
          respond(coldResponse);
        }
      } catch {
        // Notification response availability must not block the Civil Time Report.
      }
      return () => {
        responseSubscription.remove();
        notifications.setNotificationHandler(null);
      };
    },
  };
}

export function useProductionChangeReminderTap() {
  const [tap, setTap] = useState<ChangeReminderTap | null>(null);
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
        onTap: setTap,
      }),
    [],
  );

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

  return tap;
}
