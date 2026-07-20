import { dataFreshness } from './data-freshness.ts';
import { homeTimeZone } from './home-time-zone.ts';
import { livingDossier } from './living-dossier.ts';
import { settings } from './settings.ts';

export type { DataFreshnessState, DataPackSource } from './data-freshness.ts';
export type {
  HomeTimeZoneErrorCode,
  HomeTimeZoneNoticeCode,
} from './home-time-zone.ts';
export type { HourCycleContext, SecondaryCopyInput } from './living-dossier.ts';

export const australianEnglish = Object.freeze({
  dataFreshness,
  homeTimeZone,
  livingDossier,
  settings,
});
