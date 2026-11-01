import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Consumers import by package name, so these resolve through package.json
// `exports` rather than through source paths.
import * as contracts from '@daylight-saviour/contracts';
import * as reminderSubscriptionRuntime from '@daylight-saviour/contracts/reminder-subscription-runtime';

describe('contracts package entry points', () => {
  it('exports the stable public API from the package root', () => {
    assert.deepEqual(Object.keys(contracts).sort(), [
      'ChangeReminderNotificationValidationError',
      'ReminderSubscriptionValidationError',
      'SignedTimeZoneDataPackValidationError',
      'TimeZoneDataPackValidationError',
      'activateSignedTimeZoneDataPackManifest',
      'activateSignedTimeZoneDataPackManifestBytes',
      'activateTimeZoneDataPack',
      'assertActivatedTimeZoneDataPack',
      'maximumTimeZoneDataPackBytes',
      'parseChangeReminderNotification',
      'parseReminderSubscriptionRegistration',
      'parseReminderSubscriptionRegistrationResponse',
      'parseReminderSubscriptionUpdate',
      'reminderSubscriptionPlatforms',
      'signedTimeZoneDataPackManifestVersion',
      'timeZoneDataPackSchemaVersion',
      'verifySignedTimeZoneDataPackBytes',
    ]);
  });

  it('exports the reminder validators from the runtime subpath', () => {
    assert.deepEqual(Object.keys(reminderSubscriptionRuntime).sort(), [
      'ChangeReminderNotificationValidationError',
      'ReminderSubscriptionValidationError',
      'parseChangeReminderNotification',
      'parseReminderSubscriptionRegistration',
      'parseReminderSubscriptionRegistrationResponse',
      'parseReminderSubscriptionUpdate',
      'reminderSubscriptionPlatforms',
    ]);
  });

  // The mobile app imports the root and the notification service imports the
  // subpath. Sharing the functions and error classes keeps `instanceof` and
  // validation behaviour identical on both sides.
  it('shares one reminder validation between the root and the subpath', () => {
    const root = { ...contracts };

    for (const [name, value] of Object.entries(reminderSubscriptionRuntime)) {
      assert.equal(root[name], value, name);
    }
  });
});
