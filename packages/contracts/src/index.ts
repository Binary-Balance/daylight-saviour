// Public entry point: exports and composition only. Modules import each other
// directly, never through this file.
import {
  activateTimeZoneDataPack,
  type ActivatedTimeZoneDataPack,
} from './time-zone-data-pack.ts';
import {
  verifySignedTimeZoneDataPackBytes as verifySignedBytes,
  type ActivatedSignedTimeZoneDataPackManifest,
  type TrustedTimeZoneDataPackKeyRing,
} from './signed-time-zone-data-pack.ts';

export {
  timeZoneDataPackSchemaVersion,
  type TimeZoneDataPackSchemaVersion,
} from './time-zone-data-pack-version.ts';
export {
  parseReminderSubscriptionRegistration,
  parseReminderSubscriptionRegistrationResponse,
  parseReminderSubscriptionUpdate,
  parseChangeReminderNotification,
  ChangeReminderNotificationValidationError,
  reminderSubscriptionPlatforms,
  ReminderSubscriptionValidationError,
  type ReminderSubscriptionPlatform,
  type ReminderSubscriptionRegistration,
  type ReminderSubscriptionRegistrationResponse,
  type ReminderSubscriptionUpdate,
  type ChangeReminderNotification,
} from './reminder-subscription.ts';
export {
  activateTimeZoneDataPack,
  assertActivatedTimeZoneDataPack,
  TimeZoneDataPackValidationError,
  type ActivatedTimeZoneDataPack,
  type TimeZoneData,
  type TimeZoneState,
  type TimeZoneTransition,
} from './time-zone-data-pack.ts';
export {
  activateSignedTimeZoneDataPackManifestBytes,
  activateSignedTimeZoneDataPackManifest,
  maximumTimeZoneDataPackBytes,
  signedTimeZoneDataPackManifestVersion,
  SignedTimeZoneDataPackValidationError,
  type ActivatedSignedTimeZoneDataPackManifest,
  type TrustedTimeZoneDataPackKeyRing,
} from './signed-time-zone-data-pack.ts';

// The signed verifier takes the pack activator as an argument, so it needs no
// knowledge of pack validation. This is where the two are joined.
export function verifySignedTimeZoneDataPackBytes(
  manifest: ActivatedSignedTimeZoneDataPackManifest,
  bytes: Uint8Array,
  trustedKeys: TrustedTimeZoneDataPackKeyRing,
): ActivatedTimeZoneDataPack {
  return verifySignedBytes(
    manifest,
    bytes,
    trustedKeys,
    activateTimeZoneDataPack,
  );
}
