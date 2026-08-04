import { australianEnglish as copy } from '@daylight-saviour/copy';
import {
  parseChangeReminderNotification,
  parseFcmTransportProofNotification,
  type ChangeReminderNotification,
  type FcmTransportProofNotification,
} from '@daylight-saviour/contracts';
import { canonicalAustralianZoneId } from '@daylight-saviour/domain/australian-zone-runtime';

export type ChangeReminderTap = Omit<
  ChangeReminderNotification,
  'reminderKind'
>;
export type FcmTransportProofTap = FcmTransportProofNotification;
export type ReviewedNotificationTap = ChangeReminderTap | FcmTransportProofTap;

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

export function parseFcmTransportProofTap(
  value: unknown,
): FcmTransportProofTap | null {
  try {
    const notification = parseFcmTransportProofNotification(value);
    return canonicalAustralianZoneId(notification.homeTimeZone) ===
      notification.homeTimeZone
      ? notification
      : null;
  } catch {
    return null;
  }
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

function reviewedTap(
  content: ChangeReminderNotificationContent,
  transportProofBuild: boolean,
): ReviewedNotificationTap | null {
  const reminderTap = parseChangeReminderTap(content.data);
  if (
    reminderTap !== null &&
    content.title === copy.changeReminders.notification.title &&
    content.body === copy.changeReminders.notification.body
  ) {
    return reminderTap;
  }
  if (!transportProofBuild) return null;
  const proofTap = parseFcmTransportProofTap(content.data);
  return proofTap !== null &&
    content.title === copy.changeReminders.transportProof.notification.title &&
    content.body === copy.changeReminders.transportProof.notification.body
    ? proofTap
    : null;
}

export function createChangeReminderNotificationRuntime({
  notifications,
  onTap,
  transportProofBuild = false,
}: {
  readonly notifications: ChangeReminderNotifications;
  readonly onTap: (tap: ReviewedNotificationTap) => void;
  readonly transportProofBuild?: boolean;
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
    return reviewedTap(content, transportProofBuild) !== null
      ? showReviewedReminder
      : failClosed;
  }

  function respond(response: ChangeReminderNotificationResponse) {
    if (response.actionIdentifier !== notifications.defaultActionIdentifier)
      return;
    const content = response.notification.request.content;
    const tap = reviewedTap(content, transportProofBuild);
    if (tap !== null) onTap(tap);
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
