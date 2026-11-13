/** A one-time explanation of a setting that can stop reminders arriving. */
export type AppSleepPrompt = 'android-pause' | 'samsung-sleep';

/**
 * Settings that put an unused app to sleep, which stops push messages. Only
 * Android has them.
 */
export interface AppSleepAdapters {
  /** Android names the pause setting differently on each version. */
  readonly androidApiLevel: number;
  /** True while Android 12+ may pause the app for being unused. */
  readonly canPauseApp: () => Promise<boolean>;
  readonly openPauseSetting: () => Promise<void>;
  /** True on Samsung phones that can open the "Never sleeping apps" list. */
  readonly canOpenNeverSleepingApps: () => boolean;
  readonly openNeverSleepingApps: () => Promise<void>;
  readonly answeredPrompts: {
    readonly load: (prompt: AppSleepPrompt) => Promise<boolean>;
    readonly save: (prompt: AppSleepPrompt) => Promise<void>;
  };
}
