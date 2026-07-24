export const reminderSubscriptionPlatforms = Object.freeze(['android', 'ios']);

export class ReminderSubscriptionValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReminderSubscriptionValidationError';
  }
}

function object(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ReminderSubscriptionValidationError('Expected an object');
  return value;
}

function exactKeys(input, expected) {
  const actual = Object.keys(input).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    throw new ReminderSubscriptionValidationError(
      'Unexpected registration fields',
    );
}

export function parseReminderSubscriptionRegistration(value) {
  const input = object(value);
  exactKeys(input, [
    'attemptGeneration',
    'deviceToken',
    'homeTimeZone',
    'oneDayEnabled',
    'oneWeekEnabled',
    'platform',
    'registrationRequestId',
  ]);
  if (!reminderSubscriptionPlatforms.includes(input.platform))
    throw new ReminderSubscriptionValidationError('Unsupported platform');
  const validToken =
    typeof input.deviceToken === 'string' &&
    (input.platform === 'ios'
      ? /^[A-Fa-f0-9]{64}$/.test(input.deviceToken)
      : /^[A-Za-z0-9_:.-]{20,4096}$/.test(input.deviceToken));
  if (!validToken)
    throw new ReminderSubscriptionValidationError('Invalid device token');
  if (
    typeof input.registrationRequestId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.registrationRequestId)
  )
    throw new ReminderSubscriptionValidationError(
      'Invalid registration request ID',
    );
  if (
    !Number.isSafeInteger(input.attemptGeneration) ||
    input.attemptGeneration < 1 ||
    input.attemptGeneration > 2_147_483_647
  )
    throw new ReminderSubscriptionValidationError('Invalid attempt generation');
  if (
    typeof input.homeTimeZone !== 'string' ||
    !/^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)+$/.test(input.homeTimeZone)
  )
    throw new ReminderSubscriptionValidationError('Invalid Home Time Zone');
  if (
    typeof input.oneWeekEnabled !== 'boolean' ||
    typeof input.oneDayEnabled !== 'boolean' ||
    (!input.oneWeekEnabled && !input.oneDayEnabled)
  )
    throw new ReminderSubscriptionValidationError(
      'Invalid reminder preferences',
    );
  return input;
}

export function parseReminderSubscriptionRegistrationResponse(value) {
  const input = object(value);
  exactKeys(input, ['credential', 'installationId']);
  if (
    typeof input.installationId !== 'string' ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(input.installationId) ||
    typeof input.credential !== 'string' ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(input.credential)
  )
    throw new ReminderSubscriptionValidationError(
      'Invalid registration response',
    );
  return input;
}
