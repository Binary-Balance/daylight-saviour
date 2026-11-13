import type * as ReactNative from 'react-native';

import type * as ProductionAdapters from './app-sleep-production-adapters.android';

const mockGetItem = jest.fn<Promise<string | null>, [string]>();
const mockSetItem = jest.fn<Promise<void>, [string, string]>();
const mockAppSleep = {
  canOpenNeverSleepingApps: jest.fn(() => true),
  canPauseApp: jest.fn(async () => true),
  openNeverSleepingApps: jest.fn(async () => undefined),
  openPauseSetting: jest.fn(async () => undefined),
};
const mockRequireNativeModule = jest.fn((_name: string) => mockAppSleep);

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: mockGetItem, setItem: mockSetItem },
}));
jest.mock('expo', () => ({ requireNativeModule: mockRequireNativeModule }));

// Jest runs as iOS, so load the Android file directly.
function loadAdapters() {
  const adapters = jest.requireActual<typeof ProductionAdapters>(
    './app-sleep-production-adapters.android',
  ).productionAppSleepAdapters;
  if (adapters === null) throw new Error('Android has app sleep adapters');
  return adapters;
}

it('binds the local AppSleep module and the Android version', () => {
  jest.isolateModules(() => {
    // The isolated registry loads its own React Native.
    jest
      .spyOn(
        jest.requireActual<typeof ReactNative>('react-native').Platform,
        'Version',
        'get',
      )
      .mockReturnValue(35);
    expect(loadAdapters().androidApiLevel).toBe(35);
  });
  expect(mockRequireNativeModule).toHaveBeenCalledWith('AppSleep');
});

it('passes each check and setting through to the module', async () => {
  const adapters = loadAdapters();

  await expect(adapters.canPauseApp()).resolves.toBe(true);
  expect(adapters.canOpenNeverSleepingApps()).toBe(true);
  await adapters.openPauseSetting();
  await adapters.openNeverSleepingApps();

  expect(mockAppSleep.openPauseSetting).toHaveBeenCalledTimes(1);
  expect(mockAppSleep.openNeverSleepingApps).toHaveBeenCalledTimes(1);
});

it('remembers each answered prompt under its own key', async () => {
  const { answeredPrompts } = loadAdapters();
  mockSetItem.mockResolvedValue();
  mockGetItem.mockImplementation(async (key) =>
    key === 'app-sleep-prompt-answered:samsung-sleep' ? 'true' : null,
  );

  await answeredPrompts.save('android-pause');

  expect(mockSetItem).toHaveBeenCalledWith(
    'app-sleep-prompt-answered:android-pause',
    'true',
  );
  await expect(answeredPrompts.load('android-pause')).resolves.toBe(false);
  await expect(answeredPrompts.load('samsung-sleep')).resolves.toBe(true);
});
