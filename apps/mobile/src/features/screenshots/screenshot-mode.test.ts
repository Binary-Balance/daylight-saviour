import { screenshotModeEnabled } from './screenshot-mode';

it('enables screenshot mode only in development builds with the exact flag', () => {
  expect(screenshotModeEnabled(true, 'true')).toBe(true);
  expect(screenshotModeEnabled(false, 'true')).toBe(false);
  expect(screenshotModeEnabled(true, 'TRUE')).toBe(false);
  expect(screenshotModeEnabled(true, '')).toBe(false);
});
