import { bundledAustralianDataPack } from '@daylight-saviour/time-zone-data';

import type * as ProductionAdapters from './home-time-zone-production-adapters';

interface DeviceCalendar {
  readonly timeZone: string | null;
  readonly uses24hourClock: boolean | null;
}

const mockGetItem = jest.fn<Promise<string | null>, [string]>();
const mockSetItem = jest.fn<Promise<void>, [string, string]>();
const mockGetCalendars = jest.fn<readonly DeviceCalendar[], []>();
const mockExpoFetch = jest.fn<Promise<never>, [string, unknown]>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: mockGetItem, setItem: mockSetItem },
}));
jest.mock('expo-localization', () => ({ getCalendars: mockGetCalendars }));
jest.mock('expo/fetch', () => ({ fetch: mockExpoFetch }));

// The module builds its adapters, and a session seed, when it loads, so each
// test imports it afresh instead of sharing one seed and one pack manager.
function loadAdapters() {
  jest.resetModules();
  return jest.requireActual<typeof ProductionAdapters>(
    './home-time-zone-production-adapters',
  ).productionHomeTimeZoneAdapters;
}

const manifestUrlVariable = 'EXPO_PUBLIC_TIME_ZONE_DATA_MANIFEST_URL';
const trustedKeysVariable = 'EXPO_PUBLIC_TIME_ZONE_DATA_TRUSTED_KEYS_JSON';
const seedKey = 'secondary-copy-seed-v1';
const packCacheKey = 'time-zone-data-pack-cache-v1';

describe('productionHomeTimeZoneAdapters', () => {
  beforeEach(() => {
    mockGetItem.mockReset().mockResolvedValue(null);
    mockSetItem.mockReset().mockResolvedValue();
    mockGetCalendars.mockReset().mockReturnValue([]);
    mockExpoFetch.mockReset();
  });

  afterEach(() => {
    delete process.env[manifestUrlVariable];
    delete process.env[trustedKeysVariable];
    jest.useRealTimers();
  });

  describe('Home Time Zone storage', () => {
    it.each(['Australia/Perth', null])(
      'loads the saved zone %s',
      async (saved) => {
        mockGetItem.mockResolvedValue(saved);
        const { storage } = loadAdapters();

        await expect(storage.load()).resolves.toBe(saved);
        expect(mockGetItem).toHaveBeenCalledWith('home-time-zone');
      },
    );

    it('saves the canonical zone', async () => {
      const { storage } = loadAdapters();

      await storage.save('Australia/Perth');

      expect(mockSetItem).toHaveBeenCalledWith(
        'home-time-zone',
        'Australia/Perth',
      );
    });

    it('lets a storage failure reach the session', async () => {
      mockGetItem.mockRejectedValue(new Error('storage down'));
      mockSetItem.mockRejectedValue(new Error('disk full'));
      const { storage } = loadAdapters();

      await expect(storage.load()).rejects.toThrow('storage down');
      await expect(storage.save('Australia/Perth')).rejects.toThrow(
        'disk full',
      );
    });
  });

  describe('Aftermath acknowledgements', () => {
    it('keeps one acknowledgement per zone', async () => {
      mockGetItem.mockResolvedValue('2026-10-03T16:00:00.000Z');
      const { aftermathAcknowledgements } = loadAdapters();

      await aftermathAcknowledgements.save(
        'Australia/Sydney',
        '2026-10-03T16:00:00.000Z',
      );
      await expect(
        aftermathAcknowledgements.load('Australia/Melbourne'),
      ).resolves.toBe('2026-10-03T16:00:00.000Z');

      expect(mockSetItem).toHaveBeenCalledWith(
        'civil-time-report-aftermath:Australia/Sydney',
        '2026-10-03T16:00:00.000Z',
      );
      expect(mockGetItem).toHaveBeenCalledWith(
        'civil-time-report-aftermath:Australia/Melbourne',
      );
    });

    it('reports no acknowledgement for a zone that has none', async () => {
      const { aftermathAcknowledgements } = loadAdapters();

      await expect(
        aftermathAcknowledgements.load('Australia/Sydney'),
      ).resolves.toBeNull();
    });
  });

  describe('device localization', () => {
    it.each([
      ['no calendar', [], null, null],
      ['an empty zone', [{ timeZone: '', uses24hourClock: null }], '', null],
      [
        'no preference',
        [{ timeZone: null, uses24hourClock: null }],
        null,
        null,
      ],
      [
        'a 12-hour clock',
        [{ timeZone: 'Australia/Perth', uses24hourClock: false }],
        'Australia/Perth',
        false,
      ],
      [
        'a 24-hour clock',
        [{ timeZone: 'Australia/Perth', uses24hourClock: true }],
        'Australia/Perth',
        true,
      ],
      [
        'several calendars',
        [
          { timeZone: 'Australia/Perth', uses24hourClock: true },
          { timeZone: 'Europe/London', uses24hourClock: false },
        ],
        'Australia/Perth',
        true,
      ],
    ] as const)(
      'reads %s from the first calendar',
      async (_case, calendars, timeZone, uses24hourClock) => {
        mockGetCalendars.mockReturnValue(calendars);
        const { localization } = loadAdapters();

        expect(localization.read()).toEqual({ timeZone, uses24hourClock });
      },
    );
  });

  describe('secondary copy seed', () => {
    it('builds a session seed that the next launch will accept', async () => {
      const { secondaryCopySeed } = loadAdapters();

      expect(secondaryCopySeed.sessionFallback).toMatch(
        /^[0-9a-z]+(-[0-9a-z]+){3}$/,
      );
      expect(secondaryCopySeed.sessionFallback.length).toBeGreaterThanOrEqual(
        16,
      );
    });

    it('reuses a saved seed without writing', async () => {
      mockGetItem.mockResolvedValue('0123456789abcdef');
      const { secondaryCopySeed } = loadAdapters();

      await expect(secondaryCopySeed.loadOrCreate()).resolves.toBe(
        '0123456789abcdef',
      );
      expect(mockGetItem).toHaveBeenCalledWith(seedKey);
      expect(mockSetItem).not.toHaveBeenCalled();
    });

    it.each([
      ['none is saved', null],
      ['the saved seed is too short', '0123456789abcde'],
      ['the saved seed is empty', ''],
    ])('saves and returns the session seed when %s', async (_case, saved) => {
      mockGetItem.mockResolvedValue(saved);
      const { secondaryCopySeed } = loadAdapters();

      await expect(secondaryCopySeed.loadOrCreate()).resolves.toBe(
        secondaryCopySeed.sessionFallback,
      );
      expect(mockSetItem).toHaveBeenCalledTimes(1);
      expect(mockSetItem).toHaveBeenCalledWith(
        seedKey,
        secondaryCopySeed.sessionFallback,
      );
    });

    it('falls back to the session seed when storage fails', async () => {
      mockGetItem.mockRejectedValueOnce(new Error('read failed'));
      const { secondaryCopySeed } = loadAdapters();

      await expect(secondaryCopySeed.loadOrCreate()).resolves.toBe(
        secondaryCopySeed.sessionFallback,
      );

      mockSetItem.mockRejectedValueOnce(new Error('write failed'));

      await expect(secondaryCopySeed.loadOrCreate()).resolves.toBe(
        secondaryCopySeed.sessionFallback,
      );
    });
  });

  describe('Time-Zone Data Pack manager', () => {
    it('serves the bundled pack and makes no request without remote configuration', async () => {
      const { timeZoneDataPacks } = loadAdapters();

      expect(timeZoneDataPacks.getSnapshot()).toMatchObject({
        remoteEnabled: false,
        source: 'bundled',
      });
      expect(timeZoneDataPacks.getSnapshot().pack.packVersion).toBe(
        bundledAustralianDataPack.packVersion,
      );

      await timeZoneDataPacks.initialize();

      expect(mockGetItem).toHaveBeenCalledWith(packCacheKey);
      expect(mockExpoFetch).not.toHaveBeenCalled();
    });

    it('requests the manifest through Expo fetch and records the attempt in its cache', async () => {
      // A check arms a 30-second deadline timer.
      jest.useFakeTimers();
      process.env[manifestUrlVariable] =
        'https://data.example.test/manifest.json';
      process.env[trustedKeysVariable] = JSON.stringify({
        'key-1': `${'A'.repeat(43)}=`,
      });
      mockExpoFetch.mockRejectedValue(new Error('offline'));
      const { timeZoneDataPacks } = loadAdapters();
      expect(timeZoneDataPacks.getSnapshot().remoteEnabled).toBe(true);

      await timeZoneDataPacks.refresh('manual');

      expect(mockExpoFetch).toHaveBeenCalledWith(
        'https://data.example.test/manifest.json',
        expect.objectContaining({ headers: { Accept: 'application/json' } }),
      );
      expect(mockSetItem).toHaveBeenCalledWith(
        packCacheKey,
        expect.stringContaining('"lastCheckedAt"'),
      );
      expect(timeZoneDataPacks.getSnapshot()).toMatchObject({
        freshness: 'retry-failed',
        source: 'bundled',
      });
    });
  });
});
