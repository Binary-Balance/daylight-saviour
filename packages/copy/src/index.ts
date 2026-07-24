import { dataFreshness } from './data-freshness.ts';
import { homeTimeZone } from './home-time-zone.ts';
import { civilTimeReport } from './civil-time-report.ts';
import { settings } from './settings.ts';
import { changeReminders } from './change-reminders.ts';

export type { DataFreshnessState, DataPackSource } from './data-freshness.ts';
export type {
  HomeTimeZoneErrorCode,
  HomeTimeZoneNoticeCode,
} from './home-time-zone.ts';
export type {
  HourCycleContext,
  SecondaryCopyInput,
} from './civil-time-report.ts';

export const australianEnglish = Object.freeze({
  dataFreshness,
  homeTimeZone,
  civilTimeReport,
  settings,
  changeReminders,
});
