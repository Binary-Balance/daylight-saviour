import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

import appConfig from '../../../app.json';
import HomeTimeZoneScreen from './home-time-zone-screen';
import type { HomeTimeZoneAdapters } from './home-time-zone-adapters';

function createAdapters({
  deviceZone = 'Australia/Sydney',
  savedZone = null,
  uses24hourClock = false,
}: {
  readonly deviceZone?: string | null;
  readonly savedZone?: string | null;
  readonly uses24hourClock?: boolean;
} = {}) {
  let stored = savedZone;
  const adapters: HomeTimeZoneAdapters = {
    localization: {
      read: jest.fn(() => ({ timeZone: deviceZone, uses24hourClock })),
    },
    storage: {
      load: jest.fn(async () => stored),
      save: jest.fn(async (canonicalZoneId) => {
        stored = canonicalZoneId;
      }),
    },
  };
  return adapters;
}

const now = new Date('2026-07-19T00:00:00.000Z');

describe('HomeTimeZoneScreen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('confirms a supported aliased device zone without location permission', async () => {
    const adapters = createAdapters({ deviceZone: 'Australia/ACT' });

    render(<HomeTimeZoneScreen adapters={adapters} now={now} />);

    expect(
      await screen.findByRole('header', {
        name: 'Sydney, Canberra & most of NSW',
      }),
    ).toBeTruthy();
    expect(screen.getByText('Australia/Sydney')).toBeTruthy();
    expect(screen.getByText(/No location permission needed/)).toBeTruthy();

    fireEvent.press(
      screen.getByRole('button', { name: 'Use this Home Time Zone' }),
    );

    await waitFor(() =>
      expect(adapters.storage.save).toHaveBeenCalledWith('Australia/Sydney'),
    );
    expect(
      await screen.findByRole('header', { name: 'Standard time applies' }),
    ).toBeTruthy();
  });

  it('opens searchable grouped chooser for unsupported device zones', async () => {
    const adapters = createAdapters({ deviceZone: 'Europe/London' });

    render(<HomeTimeZoneScreen adapters={adapters} now={now} />);

    expect(
      await screen.findByRole('header', { name: 'Choose Home Time Zone' }),
    ).toBeTruthy();
    expect(screen.getByText('Mainland & state regions')).toBeTruthy();
    expect(screen.getByText(/outside Australian Coverage/)).toBeTruthy();
    expect(
      screen.queryByRole('button', {
        name: 'Cancel Home Time Zone selection',
      }),
    ).toBeNull();

    fireEvent.changeText(
      screen.getByLabelText('Search Australian Home Time Zones'),
      'keeling',
    );

    expect(screen.getByText('Islands & external territories')).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'Cocos (Keeling) Islands, Indian/Cocos',
      }),
    ).toBeTruthy();
    expect(screen.queryByText('Australia/Sydney')).toBeNull();
  });

  it('persists canonical selection and bypasses onboarding on reload', async () => {
    const adapters = createAdapters({ deviceZone: 'Australia/West' });
    const first = render(<HomeTimeZoneScreen adapters={adapters} now={now} />);
    await screen.findByRole('header', {
      name: 'Perth & most of Western Australia',
    });

    fireEvent.press(
      screen.getByRole('button', { name: 'Use this Home Time Zone' }),
    );
    await screen.findByRole('header', { name: 'Standard time applies' });
    expect(adapters.storage.save).toHaveBeenCalledWith('Australia/Perth');

    first.unmount();
    render(<HomeTimeZoneScreen adapters={adapters} now={now} />);

    expect(
      await screen.findByLabelText(
        'Home Time Zone, Perth & most of Western Australia, Australia/Perth',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('SUGGESTED HOME TIME ZONE')).toBeNull();
    expect(adapters.localization.read).toHaveBeenCalledTimes(2);
  });

  it.each([
    [false, '10:00 am'],
    [true, '10:00'],
  ] as const)(
    'uses device %s-hour preference for onboarding and saved dossier',
    async (uses24hourClock, expectedClock) => {
      const adapters = createAdapters({ uses24hourClock });
      const first = render(
        <HomeTimeZoneScreen adapters={adapters} now={now} />,
      );

      expect(
        await screen.findByLabelText(`${expectedClock} AEST`),
      ).toBeTruthy();
      fireEvent.press(
        screen.getByRole('button', { name: 'Use this Home Time Zone' }),
      );
      expect(await screen.findByText(expectedClock)).toBeTruthy();

      first.unmount();
      render(<HomeTimeZoneScreen adapters={adapters} now={now} />);

      expect(await screen.findByText(expectedClock)).toBeTruthy();
      expect(adapters.localization.read).toHaveBeenCalledTimes(2);
    },
  );

  it('returns corrupt saved selection safely to chooser', async () => {
    const adapters = createAdapters({ savedZone: 'Australia/West' });

    render(<HomeTimeZoneScreen adapters={adapters} now={now} />);

    expect(
      await screen.findByText(/Saved Home Time Zone is unsupported or invalid/),
    ).toBeTruthy();
    expect(
      screen.getByRole('header', { name: 'Choose Home Time Zone' }),
    ).toBeTruthy();
  });

  it('reopens chooser from Home Time Zone control and updates dossier', async () => {
    const adapters = createAdapters({ savedZone: 'Australia/Brisbane' });

    render(<HomeTimeZoneScreen adapters={adapters} now={now} />);

    fireEvent.press(
      await screen.findByRole('button', {
        name: 'Home Time Zone, Brisbane & most of Queensland, Australia/Brisbane',
      }),
    );
    fireEvent.changeText(
      screen.getByLabelText('Search Australian Home Time Zones'),
      'lord howe',
    );
    fireEvent.press(
      screen.getByRole('button', {
        name: 'Lord Howe Island, Australia/Lord_Howe',
      }),
    );

    expect(
      await screen.findByLabelText(
        'Home Time Zone, Lord Howe Island, Australia/Lord_Howe',
      ),
    ).toBeTruthy();
    expect(adapters.storage.save).toHaveBeenLastCalledWith(
      'Australia/Lord_Howe',
    );
    expect(screen.getAllByText(/UTC\+10:30/).length).toBeGreaterThan(0);
  });

  it('cancels dossier chooser without saving and restores prior zone', async () => {
    const adapters = createAdapters({ savedZone: 'Australia/Brisbane' });

    render(<HomeTimeZoneScreen adapters={adapters} now={now} />);

    const priorZone = await screen.findByRole('button', {
      name: 'Home Time Zone, Brisbane & most of Queensland, Australia/Brisbane',
    });
    fireEvent.press(priorZone);
    fireEvent.press(
      screen.getByRole('button', {
        name: 'Cancel Home Time Zone selection',
      }),
    );

    expect(
      await screen.findByRole('button', {
        name: 'Home Time Zone, Brisbane & most of Queensland, Australia/Brisbane',
      }),
    ).toBeTruthy();
    expect(adapters.storage.save).not.toHaveBeenCalled();
  });

  it('shows literal load and save errors', async () => {
    const loadFailure: HomeTimeZoneAdapters = {
      localization: {
        read: jest.fn(() => ({
          timeZone: 'Australia/Sydney',
          uses24hourClock: false,
        })),
      },
      storage: {
        load: jest.fn(async () => Promise.reject(new Error('storage down'))),
        save: jest.fn(async () => undefined),
      },
    };
    const first = render(
      <HomeTimeZoneScreen adapters={loadFailure} now={now} />,
    );
    expect(
      await screen.findByRole('alert', {
        name: 'Could not load saved Home Time Zone.',
      }),
    ).toBeTruthy();
    first.unmount();

    const baseAdapters = createAdapters();
    const saveFailure: HomeTimeZoneAdapters = {
      ...baseAdapters,
      storage: {
        ...baseAdapters.storage,
        save: jest.fn(async () => Promise.reject(new Error('storage down'))),
      },
    };
    render(<HomeTimeZoneScreen adapters={saveFailure} now={now} />);
    await screen.findByRole('header', {
      name: 'Sydney, Canberra & most of NSW',
    });
    fireEvent.press(
      screen.getByRole('button', { name: 'Use this Home Time Zone' }),
    );
    expect(
      await screen.findByRole('alert', {
        name: 'Could not save Home Time Zone. Try again.',
      }),
    ).toBeTruthy();
  });

  it('declares localization only and no GPS location permission', () => {
    const expo = appConfig.expo as typeof appConfig.expo & {
      android: { permissions?: string[] };
    };
    expect(expo.plugins).toContain('expo-localization');
    expect(expo.plugins).not.toContain('expo-location');
    expect(expo.android.permissions).toBeUndefined();
  });
});
