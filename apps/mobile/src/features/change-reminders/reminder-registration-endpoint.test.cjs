const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseReminderRegistrationEndpoint,
} = require('./reminder-registration-endpoint.cjs');

test('parses a credential-free HTTPS registration endpoint', () => {
  assert.equal(
    parseReminderRegistrationEndpoint(
      'https://reminders.example.invalid/registrations',
    ),
    'https://reminders.example.invalid/registrations',
  );
});

for (const endpoint of [
  undefined,
  '',
  'http://reminders.example.invalid/registrations',
  'https://user:password@reminders.example.invalid/registrations',
  'not a URL',
]) {
  test(`rejects invalid registration endpoint ${String(endpoint)}`, () => {
    assert.equal(parseReminderRegistrationEndpoint(endpoint), null);
  });
}
