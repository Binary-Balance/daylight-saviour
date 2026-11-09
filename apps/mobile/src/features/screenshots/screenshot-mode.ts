/**
 * Screenshot mode swaps reminder registration for local fakes so automated
 * captures need no service, secret or notification permission. It works only
 * in development builds: Metro sets `__DEV__` to false in every release
 * bundle, so a store build cannot enable it whatever its environment.
 */
export function screenshotModeEnabled(
  development = __DEV__,
  value = process.env.EXPO_PUBLIC_SCREENSHOT_MODE,
) {
  return development && value === 'true';
}
