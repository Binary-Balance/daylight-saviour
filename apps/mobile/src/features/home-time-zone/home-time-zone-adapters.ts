export interface HomeTimeZoneStorage {
  readonly load: () => Promise<string | null>;
  readonly save: (canonicalZoneId: string) => Promise<void>;
}

export interface DeviceLocalization {
  readonly timeZone: string | null;
  readonly uses24hourClock: boolean;
}

export interface DeviceLocalizationReader {
  readonly read: () => DeviceLocalization;
}

export interface HomeTimeZoneAdapters {
  readonly localization: DeviceLocalizationReader;
  readonly storage: HomeTimeZoneStorage;
}
