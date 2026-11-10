import { australianEnglish as copy } from '@daylight-saviour/copy';
import {
  parseChangeReminderNotification,
  type ChangeReminderNotification,
} from '@daylight-saviour/contracts';
import { canonicalAustralianZoneId } from '@daylight-saviour/domain/australian-zone-runtime';

export type ChangeReminderTap = Omit<
  ChangeReminderNotification,
  'reminderKind'
>;
export type ReviewedNotificationTap = ChangeReminderTap;

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

export interface ChangeReminderNotifications {
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

export function parseChangeReminderTap(
  value: unknown,
): ChangeReminderTap | null {
  try {
    const notification = parseChangeReminderNotification(value);
    return canonicalAustralianZoneId(notification.homeTimeZone) ===
      notification.homeTimeZone
      ? {
          changeDirection: notification.changeDirection,
          changeEventAt: notification.changeEventAt,
          homeTimeZone: notification.homeTimeZone,
          reminderTiming: notification.reminderTiming,
        }
      : null;
  } catch {
    return null;
  }
}

// The service sends the warned body in place of the body once a subscription
// has been silent for a year, so both are reviewed copy.
function hasReviewedCopy(content: ChangeReminderNotificationContent) {
  const { body, title, warnedBody } = copy.changeReminders.notification;
  return (
    content.title === title &&
    (content.body === body || content.body === warnedBody)
  );
}

function reviewedTap(
  content: ChangeReminderNotificationContent,
): ReviewedNotificationTap | null {
  const reminderTap = parseChangeReminderTap(content.data);
  if (reminderTap !== null && hasReviewedCopy(content)) {
    return reminderTap;
  }
  return null;
}

const reminderFields = [
  'changeDirection',
  'changeEventAt',
  'homeTimeZone',
  'reminderKind',
  'reminderTiming',
] as const satisfies readonly (keyof ChangeReminderNotification)[];

// An Android tray tap reaches the app through its launch intent. Firebase
// keeps the notification's title and body out of that intent and adds its
// own keys beside the reminder fields (PUB-246), so the copy cannot be
// checked. Only a tap that carries no copy at all is judged on the reminder
// fields alone.
function trayTap(
  content: ChangeReminderNotificationContent,
): ReviewedNotificationTap | null {
  if (content.title != null || content.body != null) return null;
  if (typeof content.data !== 'object' || content.data === null) return null;
  const data = content.data as Record<string, unknown>;
  return parseChangeReminderTap(
    Object.fromEntries(reminderFields.map((field) => [field, data[field]])),
  );
}

export function createChangeReminderNotificationRuntime({
  notifications,
  onTap,
  trayTapsLackCopy,
}: {
  readonly notifications: ChangeReminderNotifications;
  readonly onTap: (tap: ReviewedNotificationTap) => void;
  /** True on Android, where a tap from the tray arrives without its copy. */
  readonly trayTapsLackCopy: boolean;
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
  let liveResponseSeen = false;

  function receive(
    content: ChangeReminderNotificationContent,
  ): typeof failClosed | typeof showReviewedReminder {
    return reviewedTap(content) !== null ? showReviewedReminder : failClosed;
  }

  function respond(response: ChangeReminderNotificationResponse) {
    if (response.actionIdentifier !== notifications.defaultActionIdentifier)
      return;
    const content = response.notification.request.content;
    const tap =
      reviewedTap(content) ?? (trayTapsLackCopy ? trayTap(content) : null);
    if (tap !== null) {
      onTap(tap);
    }
  }

  return {
    async start() {
      notifications.setNotificationHandler({
        handleNotification: async (notification) =>
          receive(notification.request.content),
      });
      const responseSubscription =
        notifications.addNotificationResponseReceivedListener((response) => {
          liveResponseSeen = true;
          respond(response);
        });
      try {
        const coldResponse =
          await notifications.getLastNotificationResponseAsync();
        if (coldResponse !== null) {
          try {
            await notifications.clearLastNotificationResponseAsync();
          } catch {
            // A failed clear cannot make an untrusted response actionable.
          }
          if (!liveResponseSeen) respond(coldResponse);
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

export function createChangeReminderTapVisit({
  onChange,
}: {
  readonly onChange: (tap: ReviewedNotificationTap | null) => void;
}) {
  let active = true;
  let pending: ReviewedNotificationTap | null = null;
  return {
    receive(tap: ReviewedNotificationTap) {
      if (active) {
        onChange(tap);
      } else {
        pending = tap;
      }
    },
    setAppState(nextState: 'active' | 'background' | 'inactive') {
      active = nextState === 'active';
      if (!active) {
        onChange(null);
        return;
      }
      if (pending !== null) {
        const tap = pending;
        pending = null;
        onChange(tap);
      }
    },
  };
}
