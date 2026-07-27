export const reminderSubscriptionPlatforms: readonly ['android', 'ios'];
export class ReminderSubscriptionValidationError extends Error {}
export class ChangeReminderNotificationValidationError extends Error {}
export interface ChangeReminderNotification {
  readonly changeDirection: 'forward' | 'backward';
  readonly changeEventAt: string;
  readonly homeTimeZone: string;
  readonly reminderKind: 'change-reminder';
  readonly reminderTiming: 'one-week' | 'one-day';
}
export function parseReminderSubscriptionRegistration(value: unknown): unknown;
export function parseReminderSubscriptionRegistrationResponse(
  value: unknown,
): unknown;
export function parseChangeReminderNotification(
  value: unknown,
): ChangeReminderNotification;
