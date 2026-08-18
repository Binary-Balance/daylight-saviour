import { changeReminderTestBuildEnabled } from './change-reminder-test-build';

describe('Change Reminder test build flag', () => {
  it('enables the installation diagnostic only for the exact external flag', () => {
    expect(changeReminderTestBuildEnabled('true')).toBe(true);
    expect(changeReminderTestBuildEnabled('TRUE')).toBe(false);
    expect(changeReminderTestBuildEnabled('false')).toBe(false);
    expect(changeReminderTestBuildEnabled(undefined)).toBe(false);
  });
});
