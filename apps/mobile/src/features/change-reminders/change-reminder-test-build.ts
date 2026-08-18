export function changeReminderTestBuildEnabled(
  value = process.env.EXPO_PUBLIC_CHANGE_REMINDER_TEST_BUILD,
) {
  return value === 'true';
}
