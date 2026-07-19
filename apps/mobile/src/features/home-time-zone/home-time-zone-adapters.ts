import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCalendars } from 'expo-localization';

const storageKey = 'home-time-zone';

export interface HomeTimeZoneStorage {
  readonly load: () => Promise<string | null>;
  readonly save: (canonicalZoneId: string) => Promise<void>;
}

export interface DeviceTimeZoneReader {
  readonly read: () => string | null;
}

export interface HomeTimeZoneAdapters {
  readonly deviceTimeZone: DeviceTimeZoneReader;
  readonly storage: HomeTimeZoneStorage;
}

export const productionHomeTimeZoneAdapters: HomeTimeZoneAdapters = {
  deviceTimeZone: {
    read: () => getCalendars()[0]?.timeZone ?? null,
  },
  storage: {
    load: () => AsyncStorage.getItem(storageKey),
    save: (canonicalZoneId) =>
      AsyncStorage.setItem(storageKey, canonicalZoneId),
  },
};
