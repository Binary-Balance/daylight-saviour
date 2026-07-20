import type { TimeZoneDataPackManager } from '../time-zone-data/time-zone-data-manager';

export interface HomeTimeZoneStorage {
  readonly load: () => Promise<string | null>;
  readonly save: (canonicalZoneId: string) => Promise<void>;
}

export interface AftermathAcknowledgementStorage {
  readonly load: (canonicalZoneId: string) => Promise<string | null>;
  readonly save: (canonicalZoneId: string, eventAt: string) => Promise<void>;
}

export interface DeviceLocalization {
  readonly timeZone: string | null;
  readonly uses24hourClock: boolean;
}

export interface DeviceLocalizationReader {
  readonly read: () => DeviceLocalization;
}

export interface HomeTimeZoneAdapters {
  readonly aftermathAcknowledgements: AftermathAcknowledgementStorage;
  readonly localization: DeviceLocalizationReader;
  readonly storage: HomeTimeZoneStorage;
  readonly timeZoneDataPacks: TimeZoneDataPackManager;
}
