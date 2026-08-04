export const reminderSubscriptionPlatforms: readonly ['android', 'ios'];
export class ReminderSubscriptionValidationError extends Error {}
export class ChangeReminderNotificationValidationError extends Error {}
export class FcmTransportProofNotificationValidationError extends Error {}
export interface ChangeReminderNotification {
  readonly changeDirection: 'forward' | 'backward';
  readonly changeEventAt: string;
  readonly homeTimeZone: string;
  readonly reminderKind: 'change-reminder';
  readonly reminderTiming: 'one-week' | 'one-day';
}
export interface FcmTransportProofNotification {
  readonly homeTimeZone: string;
  readonly notificationKind: 'fcm-transport-proof';
}
export function parseReminderSubscriptionRegistration(value: unknown): unknown;
export function parseReminderSubscriptionUpdate(value: unknown): unknown;
export function parseReminderSubscriptionRegistrationResponse(
  value: unknown,
): unknown;
export function parseChangeReminderNotification(
  value: unknown,
): ChangeReminderNotification;
export function parseFcmTransportProofNotification(
  value: unknown,
): FcmTransportProofNotification;
