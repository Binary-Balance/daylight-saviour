import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCalendars } from 'expo-localization';

import type { HomeTimeZoneAdapters } from './home-time-zone-adapters';

const storageKey = 'home-time-zone';

export const productionHomeTimeZoneAdapters: HomeTimeZoneAdapters = {
  localization: {
    read: () => {
      const calendar = getCalendars()[0];
      return {
        timeZone: calendar?.timeZone ?? null,
        uses24hourClock: calendar?.uses24hourClock ?? false,
      };
    },
  },
  storage: {
    load: () => AsyncStorage.getItem(storageKey),
    save: (canonicalZoneId) =>
      AsyncStorage.setItem(storageKey, canonicalZoneId),
  },
};
