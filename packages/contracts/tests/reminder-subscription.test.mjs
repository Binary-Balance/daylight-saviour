import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ChangeReminderNotificationValidationError,
  parseChangeReminderNotification,
  parseReminderSubscriptionRegistration,
  parseReminderSubscriptionUpdate,
  ReminderSubscriptionValidationError,
} from '../src/reminder-subscription-runtime.js';

const androidRegistration = {
  attemptGeneration: 1,
  deviceToken: 'fcm-token:with_valid.characters-123',
  homeTimeZone: 'Australia/Sydney',
  oneDayEnabled: true,
  oneWeekEnabled: true,
  platform: 'android',
  registrationRequestId: 'a'.repeat(64),
};

describe('reminder subscription registration contract', () => {
  it('activates only exact fixed update fields without a client target', () => {
    const { registrationRequestId: _requestId, ...update } =
      androidRegistration;
    assert.deepEqual(parseReminderSubscriptionUpdate(update), update);
    assert.throws(
      () =>
        parseReminderSubscriptionUpdate({
          ...update,
          installationId: 'client-selectable-target',
        }),
      ReminderSubscriptionValidationError,
    );
    assert.throws(
      () => parseReminderSubscriptionUpdate({ ...update, credential: 'no' }),
      ReminderSubscriptionValidationError,
    );
  });
  it('activates only exact fixed Change Reminder fields', () => {
    const notification = {
      changeDirection: 'forward',
      changeEventAt: '2026-10-03T16:00:00.000Z',
      homeTimeZone: 'Australia/Sydney',
      reminderKind: 'change-reminder',
      reminderTiming: 'one-week',
    };
    assert.deepEqual(
      parseChangeReminderNotification(notification),
      notification,
    );
    assert.throws(
      () => parseChangeReminderNotification({ ...notification, extra: true }),
      ChangeReminderNotificationValidationError,
    );
    assert.throws(
      () => parseChangeReminderNotification(null),
      ChangeReminderNotificationValidationError,
    );
  });
  it('accepts native platform token shapes', () => {
    assert.deepEqual(
      parseReminderSubscriptionRegistration(androidRegistration),
      androidRegistration,
    );
    const iosRegistration = {
      ...androidRegistration,
      deviceToken: 'a'.repeat(64),
      platform: 'ios',
    };
    assert.deepEqual(
      parseReminderSubscriptionRegistration(iosRegistration),
      iosRegistration,
    );
  });

  for (const [name, registration] of [
    ['unknown fields', { ...androidRegistration, notificationText: 'No' }],
    ['unsupported platform', { ...androidRegistration, platform: 'web' }],
    [
      'short registration request ID',
      { ...androidRegistration, registrationRequestId: 'a'.repeat(63) },
    ],
    [
      'non-hex registration request ID',
      { ...androidRegistration, registrationRequestId: 'g'.repeat(64) },
    ],
    [
      'uppercase registration request ID',
      { ...androidRegistration, registrationRequestId: 'A'.repeat(64) },
    ],
    [
      'zero attempt generation',
      { ...androidRegistration, attemptGeneration: 0 },
    ],
    [
      'fractional attempt generation',
      { ...androidRegistration, attemptGeneration: 1.5 },
    ],
    [
      'oversized attempt generation',
      { ...androidRegistration, attemptGeneration: 2_147_483_648 },
    ],
    [
      'whitespace-only token',
      { ...androidRegistration, deviceToken: ' '.repeat(32) },
    ],
    [
      'token control characters',
      { ...androidRegistration, deviceToken: `valid-token-value-123\n` },
    ],
    [
      'malformed Android token',
      { ...androidRegistration, deviceToken: 'token/value/with/slashes' },
    ],
    [
      'malformed APNs token',
      { ...androidRegistration, deviceToken: 'g'.repeat(64), platform: 'ios' },
    ],
    [
      'short APNs token',
      { ...androidRegistration, deviceToken: 'a'.repeat(63), platform: 'ios' },
    ],
    ['malformed zone', { ...androidRegistration, homeTimeZone: 'Sydney' }],
    ['non-boolean timing', { ...androidRegistration, oneDayEnabled: 'true' }],
    [
      'both timings disabled',
      { ...androidRegistration, oneDayEnabled: false, oneWeekEnabled: false },
    ],
  ]) {
    it(`rejects ${name}`, () => {
      assert.throws(
        () => parseReminderSubscriptionRegistration(registration),
        ReminderSubscriptionValidationError,
      );
    });
  }
});
