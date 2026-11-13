import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';

import type { AppSleepAdapters, AppSleepPrompt } from './app-sleep-adapters';

interface AppSleepModule {
  canPauseApp(): Promise<boolean>;
  openPauseSetting(): Promise<void>;
  canOpenNeverSleepingApps(): boolean;
  openNeverSleepingApps(): Promise<void>;
}

// The local Expo module in modules/app-sleep.
const appSleep = requireNativeModule<AppSleepModule>('AppSleep');

const answeredKey = (prompt: AppSleepPrompt) =>
  `app-sleep-prompt-answered:${prompt}`;

export const productionAppSleepAdapters: AppSleepAdapters | null = {
  androidApiLevel: Number(Platform.Version),
  answeredPrompts: {
    load: async (prompt) =>
      (await AsyncStorage.getItem(answeredKey(prompt))) !== null,
    save: (prompt) => AsyncStorage.setItem(answeredKey(prompt), 'true'),
  },
  canOpenNeverSleepingApps: () => appSleep.canOpenNeverSleepingApps(),
  canPauseApp: () => appSleep.canPauseApp(),
  openNeverSleepingApps: () => appSleep.openNeverSleepingApps(),
  openPauseSetting: () => appSleep.openPauseSetting(),
};
