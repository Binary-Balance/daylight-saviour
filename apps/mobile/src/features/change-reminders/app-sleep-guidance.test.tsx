import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { AppState } from 'react-native';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import { daylightSaviourPalettes } from '../../theme';
import type { AppSleepAdapters, AppSleepPrompt } from './app-sleep-adapters';
import type { ChangeReminderAdapters } from './change-reminder-adapters';
import ChangeReminderSection from './change-reminder-section';

const reminders = copy.changeReminders;
const enabledBody = reminders.enabled.body({
  oneDayEnabled: true,
  oneWeekEnabled: true,
});

function reminderAdapters(registered = true): ChangeReminderAdapters {
  return {
    disable: jest.fn(async () => ({ kind: 'disabled' as const })),
    enable: jest.fn(async () => ({ kind: 'enabled' as const })),
    openSettings: jest.fn(async () => undefined),
    restore: jest.fn(async () =>
      registered
        ? {
            kind: 'registered' as const,
            notificationPermissionGranted: true,
            registration: {
              attemptGeneration: 1,
              credential: 'c'.repeat(43),
              deviceToken: 'fcm-token:with_valid.characters-123',
              homeTimeZone: 'Australia/Sydney',
              installationId: 'i'.repeat(43),
              oneDayEnabled: true,
              oneWeekEnabled: true,
              registrationRequestId: 'a'.repeat(64),
              state: 'registered' as const,
              version: 4 as const,
            },
          }
        : { kind: 'unregistered' as const },
    ),
    startTokenRefresh: jest.fn(() => () => undefined),
    updatePreferences: jest.fn(async (preferences) => ({
      kind: 'enabled' as const,
      preferences,
    })),
  };
}

function sleepAdapters({
  answered = [],
  canPause = true,
  samsung = false,
  ...overrides
}: Partial<AppSleepAdapters> & {
  readonly answered?: readonly AppSleepPrompt[];
  readonly canPause?: boolean;
  readonly samsung?: boolean;
} = {}): AppSleepAdapters {
  return {
    androidApiLevel: 34,
    answeredPrompts: {
      load: jest.fn(async (prompt) => answered.includes(prompt)),
      save: jest.fn(async () => undefined),
    },
    canOpenNeverSleepingApps: jest.fn(() => samsung),
    canPauseApp: jest.fn(async () => canPause),
    openNeverSleepingApps: jest.fn(async () => undefined),
    openPauseSetting: jest.fn(async () => undefined),
    ...overrides,
  };
}

function renderSection(
  appSleepAdapters: AppSleepAdapters | null,
  adapters = reminderAdapters(),
) {
  return render(
    <ChangeReminderSection
      adapters={adapters}
      appSleepAdapters={appSleepAdapters}
      homeTimeZone="Australia/Sydney"
      palette={daylightSaviourPalettes.light}
    />,
  );
}

const androidLine = reminders.androidPause.line(34);
const button = (name: string) => screen.getByRole('button', { name });

let appStateListeners: ((state: string) => void)[];
const returnToApp = () =>
  act(async () => appStateListeners.forEach((listener) => listener('active')));

beforeEach(() => {
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
    appStateListeners.push(listener as (state: string) => void);
    return { remove: jest.fn() };
  });
});

afterEach(() => {
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(() => ({ remove: jest.fn() }));
});

it('shows nothing where no sleep setting exists', async () => {
  renderSection(null);
  // The file's first render takes about 2 s on a cold Jest cache, longer
  // than findBy's default wait, while React Native's lazy modules compile.
  await screen.findByText(enabledBody, {}, { timeout: 5_000 });
  expect(screen.queryByText(reminders.androidPause.heading)).toBeNull();
});

it('explains Android’s pause setting once reminders are on', async () => {
  const boundary = sleepAdapters();
  renderSection(boundary);

  expect(await screen.findByText(reminders.androidPause.body(34))).toBeTruthy();
  expect(screen.getByText(reminders.androidPause.heading)).toBeTruthy();
  expect(button(reminders.androidPause.open).props.accessibilityHint).toBe(
    reminders.accessibility.openAppSettingsHint,
  );

  fireEvent.press(button(reminders.androidPause.open));

  expect(boundary.answeredPrompts.save).toHaveBeenCalledWith('android-pause');
  expect(boundary.openPauseSetting).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(reminders.androidPause.heading)).toBeNull();
  expect(screen.getByText(androidLine)).toBeTruthy();
});

it('keeps a line in the card after “Not now”', async () => {
  const boundary = sleepAdapters();
  renderSection(boundary);
  await screen.findByText(reminders.androidPause.heading);

  fireEvent.press(button(reminders.appSleepNotNow));

  expect(boundary.answeredPrompts.save).toHaveBeenCalledWith('android-pause');
  expect(boundary.openPauseSetting).not.toHaveBeenCalled();
  expect(screen.getByText(androidLine)).toBeTruthy();

  fireEvent.press(button(reminders.androidPause.open));

  expect(boundary.openPauseSetting).toHaveBeenCalledTimes(1);
  expect(boundary.answeredPrompts.save).toHaveBeenCalledTimes(1);
});

it('shows only the line once the prompt has been answered', async () => {
  renderSection(sleepAdapters({ answered: ['android-pause'] }));
  expect(await screen.findByText(androidLine)).toBeTruthy();
  expect(screen.queryByText(reminders.androidPause.heading)).toBeNull();
});

it('drops the line once the user turns the setting off', async () => {
  let canPause = true;
  renderSection(
    sleepAdapters({
      answered: ['android-pause'],
      canPauseApp: async () => canPause,
    }),
  );
  await screen.findByText(androidLine);

  canPause = false;
  // Only a return to the app rereads the setting.
  await act(async () =>
    appStateListeners.forEach((listener) => listener('background')),
  );
  expect(screen.getByText(androidLine)).toBeTruthy();

  await returnToApp();

  expect(screen.queryByText(androidLine)).toBeNull();
});

it('says nothing when Android cannot pause the app', async () => {
  const boundary = sleepAdapters({ canPause: false });
  renderSection(boundary);
  await screen.findByText(enabledBody);
  await waitFor(() => expect(boundary.canPauseApp).toHaveBeenCalled());
  expect(screen.queryByText(reminders.androidPause.heading)).toBeNull();
  expect(screen.queryByText(androidLine)).toBeNull();
});

it('waits until reminders are on', async () => {
  const boundary = sleepAdapters({ samsung: true });
  renderSection(boundary, reminderAdapters(false));
  await screen.findByText(reminders.untouched.body);
  await waitFor(() => expect(boundary.canPauseApp).toHaveBeenCalled());
  expect(screen.queryByText(reminders.androidPause.heading)).toBeNull();
  expect(screen.queryByText(reminders.samsungSleep.line)).toBeNull();
});

const messagesAbout = /Daylight Saviour/;
const shownMessages = () =>
  screen
    .getAllByText(messagesAbout)
    .map((message) => String(message.props.children));

it('asks about Samsung after Android, then keeps both lines in that order', async () => {
  const boundary = sleepAdapters({ samsung: true });
  renderSection(boundary);
  await screen.findByText(reminders.androidPause.heading);
  expect(screen.queryByText(reminders.samsungSleep.heading)).toBeNull();

  fireEvent.press(button(reminders.appSleepNotNow));

  expect(shownMessages()).toEqual([androidLine, reminders.samsungSleep.body]);
  expect(screen.queryByText(reminders.androidPause.heading)).toBeNull();
  expect(screen.getByText(reminders.samsungSleep.heading)).toBeTruthy();
  expect(button(reminders.samsungSleep.open).props.accessibilityHint).toBe(
    reminders.accessibility.openNeverSleepingAppsHint,
  );

  fireEvent.press(button(reminders.samsungSleep.open));

  expect(boundary.answeredPrompts.save).toHaveBeenLastCalledWith(
    'samsung-sleep',
  );
  expect(boundary.openNeverSleepingApps).toHaveBeenCalledTimes(1);
  expect(boundary.openPauseSetting).not.toHaveBeenCalled();
  expect(shownMessages()).toEqual([androidLine, reminders.samsungSleep.line]);
  expect(screen.queryByText(reminders.samsungSleep.heading)).toBeNull();
});

it('always keeps the Samsung line, since its setting cannot be read', async () => {
  const boundary = sleepAdapters({
    answered: ['samsung-sleep'],
    canPause: false,
    samsung: true,
  });
  renderSection(boundary);
  expect(await screen.findByText(reminders.samsungSleep.line)).toBeTruthy();

  fireEvent.press(button(reminders.samsungSleep.open));

  expect(boundary.openNeverSleepingApps).toHaveBeenCalledTimes(1);
});

it('still asks when the saved answer cannot be read', async () => {
  renderSection(
    sleepAdapters({
      answeredPrompts: {
        load: async () => Promise.reject(new Error('storage')),
        save: async () => undefined,
      },
    }),
  );
  expect(await screen.findByText(reminders.androidPause.heading)).toBeTruthy();
});

it('moves on from an answered prompt even when saving or opening fails', async () => {
  const boundary = sleepAdapters({
    answeredPrompts: {
      load: async () => false,
      save: async () => Promise.reject(new Error('storage')),
    },
    openPauseSetting: async () => Promise.reject(new Error('no activity')),
  });
  renderSection(boundary);
  await screen.findByText(reminders.androidPause.heading);

  await act(async () => fireEvent.press(button(reminders.androidPause.open)));
  await returnToApp();

  expect(screen.queryByText(reminders.androidPause.heading)).toBeNull();
  expect(screen.getByText(androidLine)).toBeTruthy();
});

it('keeps what it knew when a later check fails', async () => {
  let fail = false;
  renderSection(
    sleepAdapters({
      answered: ['android-pause'],
      canOpenNeverSleepingApps: () => {
        if (fail) throw new Error('native');
        return false;
      },
    }),
  );
  await screen.findByText(androidLine);

  fail = true;
  await returnToApp();

  expect(screen.getByText(androidLine)).toBeTruthy();
});

it('treats a failed pause check as nothing to say', async () => {
  renderSection(
    sleepAdapters({
      canPauseApp: async () => Promise.reject(new Error('native')),
    }),
  );
  await screen.findByText(enabledBody);
  await act(async () => undefined);
  expect(screen.queryByText(reminders.androidPause.heading)).toBeNull();
});

it('still asks about Samsung when the pause check fails', async () => {
  renderSection(
    sleepAdapters({
      canPauseApp: async () => Promise.reject(new Error('native')),
      samsung: true,
    }),
  );
  expect(await screen.findByText(reminders.samsungSleep.heading)).toBeTruthy();
  expect(screen.queryByText(reminders.androidPause.heading)).toBeNull();
});

it('stops listening after unmounting', async () => {
  const remove = jest.fn();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(() => ({ remove }));
  const rendered = renderSection(sleepAdapters());
  await screen.findByText(reminders.androidPause.heading);

  rendered.unmount();

  // One listener for the reminder session and one for the sleep guidance.
  expect(remove).toHaveBeenCalledTimes(2);
});
