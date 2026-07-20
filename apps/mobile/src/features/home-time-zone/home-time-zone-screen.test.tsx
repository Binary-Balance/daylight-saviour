import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { AccessibilityInfo, AppState, type AppStateStatus } from 'react-native';
import { bundledAustralianDataPack } from '@daylight-saviour/time-zone-data';

import appConfig from '../../../app.json';
import HomeTimeZoneScreen from './home-time-zone-screen';
import type { HomeTimeZoneAdapters } from './home-time-zone-adapters';
import { createTimeZoneDataPackManager } from '../time-zone-data/time-zone-data-manager';

function createAdapters({
  acknowledgedEventAt = null,
  deviceZone = 'Australia/Sydney',
  savedZone = null,
  uses24hourClock = false,
}: {
  readonly acknowledgedEventAt?: string | null;
  readonly deviceZone?: string | null;
  readonly savedZone?: string | null;
  readonly uses24hourClock?: boolean;
} = {}) {
  let stored = savedZone;
  const acknowledgements = new Map<string, string>();
  if (savedZone !== null && acknowledgedEventAt !== null) {
    acknowledgements.set(savedZone, acknowledgedEventAt);
  }
  const adapters: HomeTimeZoneAdapters = {
    aftermathAcknowledgements: {
      load: jest.fn(
        async (canonicalZoneId) =>
          acknowledgements.get(canonicalZoneId) ?? null,
      ),
      save: jest.fn(async (canonicalZoneId, eventAt) => {
        acknowledgements.set(canonicalZoneId, eventAt);
      }),
    },
    localization: {
      read: jest.fn(() => ({ timeZone: deviceZone, uses24hourClock })),
    },
    secondaryCopySeed: {
      loadOrCreate: jest.fn(async () => 'test-installation-seed'),
      sessionFallback: 'test-session-seed',
    },
    storage: {
      load: jest.fn(async () => stored),
      save: jest.fn(async (canonicalZoneId) => {
        stored = canonicalZoneId;
      }),
    },
    timeZoneDataPacks: createTimeZoneDataPackManager({
      bundledPack: bundledAustralianDataPack,
      now: () => now,
      remoteConfig: null,
      storage: {
        load: jest.fn(async () => null),
        save: jest.fn(async () => undefined),
      },
    }),
  };
  return adapters;
}

const now = new Date('2026-07-19T00:00:00.000Z');

describe('HomeTimeZoneScreen', () => {
  beforeEach(() => {
    jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockReturnValue(new Promise<boolean>(() => undefined));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('starts cold-launch refresh and forwards active lifecycle events', async () => {
    const adapters = createAdapters({ savedZone: 'Australia/Sydney' });
    const initialize = jest.spyOn(adapters.timeZoneDataPacks, 'initialize');
    const refresh = jest.spyOn(adapters.timeZoneDataPacks, 'refresh');
    let appStateHandler: ((state: AppStateStatus) => void) | undefined;
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_type, listener) => {
        appStateHandler = listener;
        return { remove: jest.fn() };
      });

    render(<HomeTimeZoneScreen adapters={adapters} now={now} />);
    await screen.findByText('Standard time applies');

    expect(initialize).toHaveBeenCalledTimes(1);
    act(() => appStateHandler?.('background'));
    expect(refresh).not.toHaveBeenCalledWith('foreground');
    act(() => appStateHandler?.('active'));
    expect(refresh).toHaveBeenCalledWith('foreground');
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

  it('uses session-only secondary copy when seed persistence fails', async () => {
    const adapters = createAdapters({ savedZone: 'Australia/Sydney' });
    jest
      .mocked(adapters.secondaryCopySeed.loadOrCreate)
      .mockRejectedValue(new Error('seed storage unavailable'));

    const first = render(<HomeTimeZoneScreen adapters={adapters} now={now} />);
    expect(
      await screen.findByRole('header', { name: 'Standard time applies' }),
    ).toBeTruthy();
    expect(
      screen.queryByText('Could not load saved Home Time Zone.'),
    ).toBeNull();

    first.unmount();
    render(<HomeTimeZoneScreen adapters={adapters} now={now} />);
    expect(
      await screen.findByRole('header', { name: 'Standard time applies' }),
    ).toBeTruthy();
    expect(adapters.secondaryCopySeed.loadOrCreate).toHaveBeenCalledTimes(2);
  });

  it.each([
    [false, '10:00 am'],
    [true, '10:00'],
  ] as const)(
    'uses device %s-hour preference for onboarding and saved report',
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
      const clockLabel = `Home Time Zone current time, ${expectedClock}, AEST, UTC+10:00`;
      expect(await screen.findByLabelText(clockLabel)).toBeTruthy();

      first.unmount();
      render(<HomeTimeZoneScreen adapters={adapters} now={now} />);

      expect(await screen.findByLabelText(clockLabel)).toBeTruthy();
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

  it('reopens chooser from Home Time Zone control and updates report', async () => {
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

  it('cancels report chooser without saving and restores prior zone', async () => {
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

  it('prevents cancel from racing a pending zone save', async () => {
    const adapters = createAdapters({ savedZone: 'Australia/Brisbane' });
    let resolveSave: (() => void) | undefined;
    jest.mocked(adapters.storage.save).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

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

    const cancel = screen.getByRole('button', {
      name: 'Cancel Home Time Zone selection',
    });
    expect(cancel).toBeDisabled();
    fireEvent.press(cancel);
    expect(
      screen.getByRole('header', { name: 'Choose Home Time Zone' }),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText(
        'Home Time Zone, Brisbane & most of Queensland, Australia/Brisbane',
      ),
    ).toBeNull();

    await act(async () => resolveSave?.());

    expect(
      await screen.findByLabelText(
        'Home Time Zone, Lord Howe Island, Australia/Lord_Howe',
      ),
    ).toBeTruthy();
  });

  it('persists per-event aftermath acknowledgement and resumes normal report', async () => {
    const adapters = createAdapters({ savedZone: 'Australia/Sydney' });
    const aftermathNow = new Date('2026-10-03T17:00:00.000Z');
    const first = render(
      <HomeTimeZoneScreen adapters={adapters} now={aftermathNow} />,
    );

    expect(
      await screen.findByTestId('aftermath-civil-time-report'),
    ).toBeTruthy();
    await waitFor(() =>
      expect(adapters.aftermathAcknowledgements.save).toHaveBeenCalledWith(
        'Australia/Sydney',
        '2026-10-03T16:00:00.000Z',
      ),
    );

    first.unmount();
    render(<HomeTimeZoneScreen adapters={adapters} now={aftermathNow} />);

    expect(
      await screen.findByTestId('ordinary-civil-time-report'),
    ).toBeTruthy();
    expect(screen.queryByTestId('aftermath-civil-time-report')).toBeNull();
  });

  it('does not replay acknowledged Aftermath after chooser cancel in same opening', async () => {
    const adapters = createAdapters({ savedZone: 'Australia/Sydney' });
    render(
      <HomeTimeZoneScreen
        adapters={adapters}
        now={new Date('2026-10-03T17:00:00.000Z')}
      />,
    );

    expect(
      await screen.findByTestId('aftermath-civil-time-report'),
    ).toBeTruthy();
    await waitFor(() =>
      expect(adapters.aftermathAcknowledgements.save).toHaveBeenCalled(),
    );
    fireEvent.press(
      screen.getByRole('button', {
        name: 'Home Time Zone, Sydney, Canberra & most of NSW, Australia/Sydney',
      }),
    );
    fireEvent.press(
      screen.getByRole('button', {
        name: 'Cancel Home Time Zone selection',
      }),
    );

    expect(
      await screen.findByTestId('ordinary-civil-time-report'),
    ).toBeTruthy();
    expect(screen.queryByTestId('aftermath-civil-time-report')).toBeNull();
  });

  it('degrades saved-zone acknowledgement read failure to unacknowledged state', async () => {
    const adapters = createAdapters({ savedZone: 'Australia/Sydney' });
    jest
      .mocked(adapters.aftermathAcknowledgements.load)
      .mockRejectedValue(new Error('acknowledgement unavailable'));

    render(<HomeTimeZoneScreen adapters={adapters} now={now} />);

    expect(
      await screen.findByRole('header', { name: 'Standard time applies' }),
    ).toBeTruthy();
    expect(
      screen.queryByText('Could not load saved Home Time Zone.'),
    ).toBeNull();
  });

  it('shows literal load and save errors', async () => {
    const loadFailure: HomeTimeZoneAdapters = {
      ...createAdapters(),
      aftermathAcknowledgements: {
        load: jest.fn(async () => null),
        save: jest.fn(async () => undefined),
      },
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
