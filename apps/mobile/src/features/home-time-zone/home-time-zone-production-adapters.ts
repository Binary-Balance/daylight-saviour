import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetch as expoFetch } from 'expo/fetch';
import { getCalendars } from 'expo-localization';
import { bundledAustralianDataPack } from '@daylight-saviour/time-zone-data';

import type { HomeTimeZoneAdapters } from './home-time-zone-adapters';
import {
  createTimeZoneDataPackManager,
  parseTimeZoneDataPackRemoteConfig,
} from '../time-zone-data/time-zone-data-manager';

const storageKey = 'home-time-zone';
const secondaryCopySeedStorageKey = 'secondary-copy-seed-v1';
const aftermathStorageKey = (canonicalZoneId: string) =>
  `living-dossier-aftermath:${canonicalZoneId}`;
const timeZoneDataPackStorageKey = 'time-zone-data-pack-cache-v1';

function createOpaqueSecondaryCopySeed() {
  return [Math.random(), Math.random(), Math.random(), Math.random()]
    .map((value) => value.toString(36).slice(2))
    .join('-');
}

const sessionSecondaryCopySeed = createOpaqueSecondaryCopySeed();

const timeZoneDataPacks = createTimeZoneDataPackManager({
  bundledPack: bundledAustralianDataPack,
  remoteConfig: parseTimeZoneDataPackRemoteConfig({
    manifestUrl: process.env.EXPO_PUBLIC_TIME_ZONE_DATA_MANIFEST_URL,
    trustedKeysJson: process.env.EXPO_PUBLIC_TIME_ZONE_DATA_TRUSTED_KEYS_JSON,
  }),
  request: (url, init) =>
    expoFetch(url, {
      headers: init.headers,
    }),
  storage: {
    load: () => AsyncStorage.getItem(timeZoneDataPackStorageKey),
    save: (value) => AsyncStorage.setItem(timeZoneDataPackStorageKey, value),
  },
});

export const productionHomeTimeZoneAdapters: HomeTimeZoneAdapters = {
  aftermathAcknowledgements: {
    load: (canonicalZoneId) =>
      AsyncStorage.getItem(aftermathStorageKey(canonicalZoneId)),
    save: (canonicalZoneId, eventAt) =>
      AsyncStorage.setItem(aftermathStorageKey(canonicalZoneId), eventAt),
  },
  localization: {
    read: () => {
      const calendar = getCalendars()[0];
      return {
        timeZone: calendar?.timeZone ?? null,
        uses24hourClock: calendar?.uses24hourClock ?? false,
      };
    },
  },
  secondaryCopySeed: {
    loadOrCreate: async () => {
      try {
        const saved = await AsyncStorage.getItem(secondaryCopySeedStorageKey);
        if (saved !== null && saved.length >= 16) return saved;
        await AsyncStorage.setItem(
          secondaryCopySeedStorageKey,
          sessionSecondaryCopySeed,
        );
      } catch {
        // Secondary copy variety cannot block saved Home Time Zone data.
        // Fallback stays local to this app session and is never transmitted.
      }
      return sessionSecondaryCopySeed;
    },
    sessionFallback: sessionSecondaryCopySeed,
  },
  storage: {
    load: () => AsyncStorage.getItem(storageKey),
    save: (canonicalZoneId) =>
      AsyncStorage.setItem(storageKey, canonicalZoneId),
  },
  timeZoneDataPacks,
};
