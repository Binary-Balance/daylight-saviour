import type { AppSleepAdapters } from './app-sleep-adapters';

/** iOS and web have nothing that stops push for an unused app. */
export const productionAppSleepAdapters: AppSleepAdapters | null = null;
