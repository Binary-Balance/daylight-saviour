import * as runtime from './reminder-subscription-runtime.js';

export type ReminderSubscriptionPlatform = 'android' | 'ios';
export interface ReminderSubscriptionRegistration {
  readonly attemptGeneration: number;
  readonly deviceToken: string;
  readonly homeTimeZone: string;
  readonly oneDayEnabled: boolean;
  readonly oneWeekEnabled: boolean;
  readonly platform: ReminderSubscriptionPlatform;
  readonly registrationRequestId: string;
}
export interface ReminderSubscriptionRegistrationResponse {
  readonly credential: string;
  readonly installationId: string;
}
export type ReminderSubscriptionUpdate = Omit<
  ReminderSubscriptionRegistration,
  'registrationRequestId'
>;
export interface ChangeReminderNotification {
  readonly changeDirection: 'forward' | 'backward';
  readonly changeEventAt: string;
  readonly homeTimeZone: string;
  readonly reminderKind: 'change-reminder';
  readonly reminderTiming: 'one-week' | 'one-day';
}
export const reminderSubscriptionPlatforms =
  runtime.reminderSubscriptionPlatforms as readonly ReminderSubscriptionPlatform[];
export const ReminderSubscriptionValidationError =
  runtime.ReminderSubscriptionValidationError;
export const parseReminderSubscriptionRegistration =
  runtime.parseReminderSubscriptionRegistration as (
    value: unknown,
  ) => ReminderSubscriptionRegistration;
export const parseReminderSubscriptionRegistrationResponse =
  runtime.parseReminderSubscriptionRegistrationResponse as (
    value: unknown,
  ) => ReminderSubscriptionRegistrationResponse;
export const parseReminderSubscriptionUpdate =
  runtime.parseReminderSubscriptionUpdate as (
    value: unknown,
  ) => ReminderSubscriptionUpdate;
export const ChangeReminderNotificationValidationError =
  runtime.ChangeReminderNotificationValidationError;
export const parseChangeReminderNotification =
  runtime.parseChangeReminderNotification as (
    value: unknown,
  ) => ChangeReminderNotification;
