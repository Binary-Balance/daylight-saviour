import type {
  ChangeReminderAdapters,
  ChangeReminderEnableResult,
  ChangeReminderRestoreResult,
} from './change-reminder-adapters';
import {
  createChangeReminderSession,
  type ChangeReminderSession,
  type ChangeReminderSessionSnapshot,
} from './change-reminder-session';

const registration = {
  attemptGeneration: 1,
  credential: 'c'.repeat(43),
  homeTimeZone: 'Australia/Sydney',
  installationId: 'i'.repeat(43),
  oneDayEnabled: true,
  oneWeekEnabled: true,
  registrationRequestId: 'a'.repeat(64),
  state: 'registered' as const,
  version: 2 as const,
};

const registered = {
  kind: 'registered' as const,
  notificationPermissionGranted: true,
  registration,
};

// Saved for another Home Time Zone than the one the sessions below are in.
const registeredElsewhere = {
  ...registered,
  registration: { ...registration, homeTimeZone: 'Australia/Brisbane' },
};

const bothTimings = { oneDayEnabled: true, oneWeekEnabled: true };

async function waitForSnapshot(
  session: ChangeReminderSession,
  predicate: (snapshot: ChangeReminderSessionSnapshot) => boolean,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = session.getSnapshot();
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(
    `Session did not reach expected state: ${JSON.stringify(session.getSnapshot())}`,
  );
}

function adapters(
  overrides: Partial<ChangeReminderAdapters> = {},
): ChangeReminderAdapters {
  return {
    disable: jest.fn(async () => ({ kind: 'disabled' as const })),
    enable: jest.fn(async () => ({ kind: 'enabled' as const })),
    openSettings: jest.fn(async () => undefined),
    restore: jest.fn(async () => ({ kind: 'unregistered' as const })),
    startTokenRefresh: jest.fn(() => () => undefined),
    updatePreferences: jest.fn(async (preferences) => ({
      kind: 'enabled' as const,
      preferences,
    })),
    ...overrides,
  };
}

function createSession(overrides: Partial<ChangeReminderAdapters> = {}) {
  const boundary = adapters(overrides);
  const session = createChangeReminderSession({
    adapters: boundary,
    homeTimeZone: 'Australia/Sydney',
  });
  return { boundary, session };
}

async function startEnabledSession(
  overrides: Partial<ChangeReminderAdapters> = {},
) {
  const { boundary, session } = createSession({
    restore: jest.fn(async () => registered),
    ...overrides,
  });
  const stop = session.start();
  await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled');
  return { boundary, session, stop };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

// Lets promise callbacks that the session should ignore run before asserting.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Change Reminder session', () => {
  it('restores one stored registration on relaunch without registering again', async () => {
    const boundary = adapters({
      restore: jest.fn(async () => ({
        kind: 'registered' as const,
        notificationPermissionGranted: true,
        registration,
      })),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();

    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled'),
    ).toEqual({
      kind: 'enabled',
      preferences: { oneDayEnabled: true, oneWeekEnabled: true },
    });
    expect(boundary.restore).toHaveBeenCalledTimes(1);
    expect(boundary.enable).not.toHaveBeenCalled();
    stop();
  });

  it('requires explainer confirmation before enabling', async () => {
    const boundary = adapters();
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'untouched');

    session.dispatch({ type: 'enable' });
    expect(boundary.enable).not.toHaveBeenCalled();
    session.dispatch({ type: 'show-explainer' });
    expect(session.getSnapshot()).toEqual({ kind: 'explainer' });
    session.dispatch({ type: 'enable' });
    expect(session.getSnapshot()).toEqual({ kind: 'saving' });
    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled'),
    ).toEqual({
      kind: 'enabled',
      preferences: { oneDayEnabled: true, oneWeekEnabled: true },
    });
    expect(boundary.enable).toHaveBeenCalledWith('Australia/Sydney');
    stop();
  });

  it('starts one registration however often enable or foreground is dispatched', async () => {
    let finish!: (result: ChangeReminderEnableResult) => void;
    const boundary = adapters({
      enable: jest.fn(
        () =>
          new Promise<ChangeReminderEnableResult>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'untouched');
    session.dispatch({ type: 'show-explainer' });

    session.dispatch({ type: 'enable' });
    session.dispatch({ type: 'enable' });
    session.dispatch({ type: 'foreground' });

    expect(session.getSnapshot()).toEqual({ kind: 'saving' });
    expect(boundary.enable).toHaveBeenCalledTimes(1);
    expect(boundary.restore).toHaveBeenCalledTimes(1);
    finish({ kind: 'enabled' });
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled');
    stop();
  });

  it('ignores an enable that finishes after the session stops', async () => {
    let finish!: (result: ChangeReminderEnableResult) => void;
    const boundary = adapters({
      enable: jest.fn(
        () =>
          new Promise<ChangeReminderEnableResult>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'untouched');
    session.dispatch({ type: 'show-explainer' });
    session.dispatch({ type: 'enable' });
    stop();

    const restart = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'untouched');
    finish({ kind: 'failed' });
    await Promise.resolve();
    await Promise.resolve();

    expect(session.getSnapshot()).toEqual({ kind: 'untouched' });
    restart();
  });

  it('keeps pending registration retryable after Home Time Zone changes', async () => {
    const boundary = adapters({
      restore: jest.fn(async () => ({
        homeTimeZone: 'Australia/Brisbane',
        kind: 'pending' as const,
      })),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();

    expect(
      await waitForSnapshot(
        session,
        (snapshot) => snapshot.kind === 'retry-pending',
      ),
    ).toEqual({ kind: 'retry-pending' });
    session.dispatch({ type: 'enable' });
    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled'),
    ).toEqual({
      kind: 'enabled',
      preferences: { oneDayEnabled: true, oneWeekEnabled: true },
    });
    expect(boundary.enable).toHaveBeenCalledWith('Australia/Sydney');
    stop();
  });

  it('restores an uncertain timing change with confirmed and proposed values', async () => {
    const boundary = adapters({
      restore: jest.fn(async () => ({
        homeTimeZone: 'Australia/Sydney',
        kind: 'pending' as const,
        pendingPreferences: {
          confirmed: { oneDayEnabled: true, oneWeekEnabled: true },
          proposed: { oneDayEnabled: false, oneWeekEnabled: true },
        },
      })),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();

    expect(
      await waitForSnapshot(
        session,
        (snapshot) => snapshot.kind === 'preferences-failed',
      ),
    ).toEqual({
      kind: 'preferences-failed',
      preferences: { oneDayEnabled: true, oneWeekEnabled: true },
      proposedPreferences: { oneDayEnabled: false, oneWeekEnabled: true },
    });
    session.dispatch({ type: 'retry-preferences' });
    expect(boundary.updatePreferences).toHaveBeenCalledWith({
      oneDayEnabled: false,
      oneWeekEnabled: true,
    });
    stop();
  });

  it('recovers from load and rejected enable failures', async () => {
    const boundary = adapters({
      enable: jest.fn(async () => {
        throw new Error('adapter failed');
      }),
      restore: jest
        .fn()
        .mockRejectedValueOnce(new Error('SecureStore failed'))
        .mockResolvedValueOnce({ kind: 'unregistered' }),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();

    await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'load-failed',
    );
    session.dispatch({ type: 'retry-load' });
    expect(session.getSnapshot()).toEqual({ kind: 'loading' });
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'untouched');
    session.dispatch({ type: 'show-explainer' });
    session.dispatch({ type: 'enable' });
    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'failed'),
    ).toEqual({ kind: 'failed' });
    stop();
  });

  it('ignores late completions after stop', async () => {
    let resolveLoad!: (value: { readonly kind: 'unregistered' }) => void;
    const boundary = adapters({
      restore: jest.fn(
        () =>
          new Promise<{ readonly kind: 'unregistered' }>((resolve) => {
            resolveLoad = resolve;
          }),
      ),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();
    stop();
    resolveLoad({ kind: 'unregistered' });
    await Promise.resolve();
    expect(session.getSnapshot()).toEqual({ kind: 'loading' });
  });

  it('does not claim an old-zone registration covers the current Home Time Zone', async () => {
    const session = createChangeReminderSession({
      adapters: adapters({
        restore: jest.fn(async () => ({
          kind: 'registered' as const,
          notificationPermissionGranted: true,
          registration: {
            ...registration,
            homeTimeZone: 'Australia/Brisbane',
          },
        })),
      }),
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();

    expect(
      await waitForSnapshot(
        session,
        (snapshot) => snapshot.kind === 'zone-mismatch',
      ),
    ).toEqual({ kind: 'zone-mismatch' });
    stop();
  });

  it('silently reconciles an old-zone registration after Home Time Zone changes', async () => {
    const updateHomeTimeZone = jest.fn(async () => ({
      kind: 'enabled' as const,
    }));
    const session = createChangeReminderSession({
      adapters: adapters({
        restore: jest.fn(async () => ({
          kind: 'registered' as const,
          notificationPermissionGranted: true,
          registration: {
            ...registration,
            homeTimeZone: 'Australia/Brisbane',
          },
        })),
        updateHomeTimeZone,
      }),
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();

    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled'),
    ).toEqual({
      kind: 'enabled',
      preferences: { oneDayEnabled: true, oneWeekEnabled: true },
    });
    expect(updateHomeTimeZone).toHaveBeenCalledWith('Australia/Sydney');
    stop();
  });

  it('keeps an uncertain zone update retryable in the foreground', async () => {
    const updateHomeTimeZone = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'failed' as const })
      .mockResolvedValueOnce({ kind: 'enabled' as const });
    const session = createChangeReminderSession({
      adapters: adapters({
        restore: jest.fn(async () => ({
          kind: 'registered' as const,
          notificationPermissionGranted: true,
          registration: {
            ...registration,
            homeTimeZone: 'Australia/Brisbane',
          },
        })),
        updateHomeTimeZone,
      }),
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();

    expect(
      await waitForSnapshot(
        session,
        (snapshot) => snapshot.kind === 'zone-failed',
      ),
    ).toMatchObject({
      kind: 'zone-failed',
      preferences: { oneDayEnabled: true, oneWeekEnabled: true },
    });
    session.dispatch({ type: 'foreground' });
    expect(session.getSnapshot()).toMatchObject({ kind: 'saving-zone' });
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled');
    expect(updateHomeTimeZone).toHaveBeenCalledTimes(2);
    stop();
  });

  it('reconciles an older pending zone before rendering it enabled', async () => {
    const updateHomeTimeZone = jest.fn(async () => ({
      kind: 'enabled' as const,
    }));
    const session = createChangeReminderSession({
      adapters: adapters({
        restore: jest.fn(async () => ({
          homeTimeZone: 'Australia/Brisbane',
          kind: 'pending' as const,
          pendingHomeTimeZone: {
            confirmed: 'Australia/Melbourne',
            proposed: 'Australia/Brisbane',
          },
        })),
        updateHomeTimeZone,
      }),
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();

    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled'),
    ).toMatchObject({
      kind: 'enabled',
      preferences: { oneDayEnabled: true, oneWeekEnabled: true },
    });
    expect(updateHomeTimeZone).toHaveBeenCalledWith('Australia/Sydney');
    stop();
  });

  it('does not claim delivery after OS permission is revoked', async () => {
    const session = createChangeReminderSession({
      adapters: adapters({
        restore: jest.fn(async () => ({
          kind: 'registered' as const,
          notificationPermissionGranted: false,
          registration,
        })),
      }),
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();

    expect(
      await waitForSnapshot(
        session,
        (snapshot) => snapshot.kind === 'permission-revoked',
      ),
    ).toEqual({ kind: 'permission-revoked' });
    stop();
  });

  it('makes a failed attempted token refresh retryable and a successful one enabled', async () => {
    const session = createChangeReminderSession({
      adapters: adapters({
        restore: jest.fn(async () => ({
          kind: 'registered' as const,
          notificationPermissionGranted: true,
          registration,
        })),
      }),
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled');

    session.dispatch({
      result: { kind: 'failed', retryable: true },
      type: 'token-refresh',
    });
    expect(session.getSnapshot()).toEqual({ kind: 'retry-pending' });
    session.dispatch({ result: { kind: 'succeeded' }, type: 'token-refresh' });
    expect(session.getSnapshot()).toEqual({
      kind: 'enabled',
      preferences: { oneDayEnabled: true, oneWeekEnabled: true },
    });
    stop();
  });

  it('does not let token success override revoked notification permission', async () => {
    const session = createChangeReminderSession({
      adapters: adapters({
        restore: jest.fn(async () => ({
          kind: 'registered' as const,
          notificationPermissionGranted: false,
          registration,
        })),
      }),
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();
    await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'permission-revoked',
    );

    session.dispatch({ result: { kind: 'succeeded' }, type: 'token-refresh' });
    expect(session.getSnapshot()).toEqual({ kind: 'permission-revoked' });
    stop();
  });

  it('reconciles once on foreground after notification settings changes', async () => {
    let resolveForeground!: (value: {
      readonly kind: 'registered';
      readonly notificationPermissionGranted: boolean;
      readonly registration: typeof registration;
    }) => void;
    const boundary = adapters({
      restore: jest
        .fn()
        .mockResolvedValueOnce({
          kind: 'registered' as const,
          notificationPermissionGranted: true,
          registration,
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveForeground = resolve;
            }),
        )
        .mockResolvedValueOnce({ kind: 'unregistered' as const }),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled');

    session.dispatch({ type: 'foreground' });
    session.dispatch({ type: 'foreground' });
    expect(boundary.restore).toHaveBeenCalledTimes(2);
    resolveForeground({
      kind: 'registered',
      notificationPermissionGranted: false,
      registration,
    });
    await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'permission-revoked',
    );

    session.dispatch({ type: 'foreground' });
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'untouched');
    stop();
  });

  it('saves either timing independently and keeps confirmed timings after failure', async () => {
    let resolve!: (result: ChangeReminderEnableResult) => void;
    const boundary = adapters({
      restore: jest.fn(async () => ({
        kind: 'registered' as const,
        notificationPermissionGranted: true,
        registration,
      })),
      updatePreferences: jest.fn(
        () =>
          new Promise<ChangeReminderEnableResult>((done) => {
            resolve = done;
          }),
      ),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled');

    session.dispatch({
      type: 'change-preferences',
      preferences: { oneDayEnabled: false, oneWeekEnabled: true },
    });
    expect(session.getSnapshot()).toMatchObject({
      kind: 'saving-preferences',
      preferences: { oneDayEnabled: true, oneWeekEnabled: true },
    });
    await Promise.resolve();
    expect(boundary.updatePreferences).toHaveBeenCalledWith({
      oneDayEnabled: false,
      oneWeekEnabled: true,
    });
    resolve({ kind: 'failed' });
    expect(
      await waitForSnapshot(
        session,
        (snapshot) => snapshot.kind === 'preferences-failed',
      ),
    ).toMatchObject({
      preferences: { oneDayEnabled: true, oneWeekEnabled: true },
    });
    session.dispatch({ type: 'cancel-preferences' });
    expect(session.getSnapshot()).toMatchObject({
      kind: 'saving-preferences',
      preferences: { oneDayEnabled: true, oneWeekEnabled: true },
      proposedPreferences: { oneDayEnabled: true, oneWeekEnabled: true },
    });
    resolve({ kind: 'failed' });
    await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'preferences-failed',
    );
    session.dispatch({ type: 'retry-preferences' });
    expect(session.getSnapshot()).toMatchObject({
      kind: 'saving-preferences',
      preferences: { oneDayEnabled: true, oneWeekEnabled: true },
      proposedPreferences: { oneDayEnabled: true, oneWeekEnabled: true },
    });
    resolve({ kind: 'enabled' });
    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled'),
    ).toMatchObject({
      preferences: { oneDayEnabled: true, oneWeekEnabled: true },
    });
    stop();
  });

  it('confirms final disable before deleting and re-enables through ordinary opt-in', async () => {
    const boundary = adapters({
      restore: jest.fn(async () => ({
        kind: 'registered' as const,
        notificationPermissionGranted: true,
        registration,
      })),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled');

    session.dispatch({
      type: 'change-preferences',
      preferences: { oneDayEnabled: false, oneWeekEnabled: false },
    });
    expect(session.getSnapshot()).toMatchObject({ kind: 'confirm-disable' });
    expect(boundary.disable).not.toHaveBeenCalled();
    session.dispatch({ type: 'cancel-disable' });
    expect(session.getSnapshot()).toMatchObject({ kind: 'enabled' });
    session.dispatch({
      type: 'change-preferences',
      preferences: { oneDayEnabled: false, oneWeekEnabled: false },
    });
    session.dispatch({ type: 'confirm-disable' });
    expect(
      await waitForSnapshot(
        session,
        (snapshot) => snapshot.kind === 'disabled',
      ),
    ).toEqual({ kind: 'disabled' });
    session.dispatch({ type: 'show-explainer' });
    expect(session.getSnapshot()).toEqual({ kind: 'explainer' });
    stop();
  });

  it('keeps confirmed reminders recoverable when deletion fails', async () => {
    const boundary = adapters({
      disable: jest.fn(async () => ({ kind: 'failed' as const })),
      restore: jest.fn(async () => ({
        kind: 'registered' as const,
        notificationPermissionGranted: true,
        registration,
      })),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled');
    session.dispatch({
      type: 'change-preferences',
      preferences: { oneDayEnabled: false, oneWeekEnabled: false },
    });
    session.dispatch({ type: 'confirm-disable' });
    expect(
      await waitForSnapshot(
        session,
        (snapshot) => snapshot.kind === 'disable-failed',
      ),
    ).toMatchObject({
      preferences: { oneDayEnabled: true, oneWeekEnabled: true },
    });
    session.dispatch({ type: 'cancel-disable' });
    expect(session.getSnapshot()).toMatchObject({ kind: 'disable-failed' });
    stop();
  });

  it('restores an unconfirmed deletion as retryable without offering opt-in', async () => {
    const boundary = adapters({
      disable: jest.fn(async () => ({ kind: 'disabled' as const })),
      restore: jest.fn(async () => ({
        homeTimeZone: 'Australia/Sydney',
        kind: 'deleting' as const,
        preferences: { oneDayEnabled: false, oneWeekEnabled: true },
      })),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();
    expect(
      await waitForSnapshot(
        session,
        (snapshot) => snapshot.kind === 'disable-failed',
      ),
    ).toEqual({
      kind: 'disable-failed',
      preferences: { oneDayEnabled: false, oneWeekEnabled: true },
    });
    session.dispatch({ type: 'cancel-disable' });
    expect(session.getSnapshot()).toMatchObject({ kind: 'disable-failed' });
    session.dispatch({ type: 'confirm-disable' });
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'disabled');
    expect(boundary.disable).toHaveBeenCalledTimes(1);
    stop();
  });

  it('retries initial OS-blocked enablement after notification settings return', async () => {
    const boundary = adapters({
      enable: jest
        .fn()
        .mockResolvedValueOnce({ kind: 'os-blocked' as const })
        .mockResolvedValueOnce({ kind: 'enabled' as const }),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'untouched');
    session.dispatch({ type: 'show-explainer' });
    session.dispatch({ type: 'enable' });
    await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'os-blocked',
    );

    session.dispatch({ type: 'foreground' });
    expect(session.getSnapshot()).toEqual({ kind: 'saving' });
    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled'),
    ).toMatchObject({ kind: 'enabled' });
    expect(boundary.enable).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does not let stale foreground restores overwrite newer saved or disabled state', async () => {
    let resolvePreferenceRestore!: (value: {
      readonly kind: 'registered';
      readonly notificationPermissionGranted: true;
      readonly registration: typeof registration;
    }) => void;
    let resolveDisableRestore!: typeof resolvePreferenceRestore;
    const boundary = adapters({
      restore: jest
        .fn()
        .mockResolvedValueOnce({
          kind: 'registered' as const,
          notificationPermissionGranted: true,
          registration,
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePreferenceRestore = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveDisableRestore = resolve;
            }),
        ),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled');

    session.dispatch({ type: 'foreground' });
    session.dispatch({
      type: 'change-preferences',
      preferences: { oneDayEnabled: false, oneWeekEnabled: true },
    });
    await waitForSnapshot(
      session,
      (snapshot) =>
        snapshot.kind === 'enabled' && !snapshot.preferences.oneDayEnabled,
    );
    resolvePreferenceRestore({
      kind: 'registered',
      notificationPermissionGranted: true,
      registration,
    });
    await Promise.resolve();
    expect(session.getSnapshot()).toMatchObject({
      preferences: { oneDayEnabled: false, oneWeekEnabled: true },
    });

    session.dispatch({ type: 'foreground' });
    session.dispatch({
      type: 'change-preferences',
      preferences: { oneDayEnabled: false, oneWeekEnabled: false },
    });
    session.dispatch({ type: 'confirm-disable' });
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'disabled');
    resolveDisableRestore({
      kind: 'registered',
      notificationPermissionGranted: true,
      registration,
    });
    await Promise.resolve();
    expect(session.getSnapshot()).toEqual({ kind: 'disabled' });
    stop();
  });

  it('does not let a stale restore replace final-disable confirmation', async () => {
    let resolveRestore!: (value: {
      readonly kind: 'registered';
      readonly notificationPermissionGranted: true;
      readonly registration: typeof registration;
    }) => void;
    const boundary = adapters({
      restore: jest
        .fn()
        .mockResolvedValueOnce({
          kind: 'registered' as const,
          notificationPermissionGranted: true,
          registration,
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveRestore = resolve;
            }),
        ),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled');
    session.dispatch({ type: 'foreground' });
    session.dispatch({
      type: 'change-preferences',
      preferences: { oneDayEnabled: false, oneWeekEnabled: false },
    });
    expect(session.getSnapshot()).toMatchObject({ kind: 'confirm-disable' });
    resolveRestore({
      kind: 'registered',
      notificationPermissionGranted: true,
      registration,
    });
    await Promise.resolve();
    expect(session.getSnapshot()).toMatchObject({ kind: 'confirm-disable' });
    stop();
  });

  it('keeps confirmed one-timing state after a failed refresh retry', async () => {
    const oneTimingRegistration = {
      ...registration,
      oneDayEnabled: false,
      oneWeekEnabled: true,
    };
    const boundary = adapters({
      restore: jest.fn(async () => ({
        kind: 'registered' as const,
        notificationPermissionGranted: true,
        registration: oneTimingRegistration,
      })),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled');
    session.dispatch({
      result: { kind: 'failed', retryable: true },
      type: 'token-refresh',
    });
    session.dispatch({ type: 'enable' });
    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled'),
    ).toMatchObject({
      preferences: { oneDayEnabled: false, oneWeekEnabled: true },
    });
    stop();
  });

  it('returns to both default timings after confirmed deletion and fresh opt-in', async () => {
    const boundary = adapters({
      restore: jest.fn(async () => ({
        kind: 'registered' as const,
        notificationPermissionGranted: true,
        registration: { ...registration, oneDayEnabled: false },
      })),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled');
    session.dispatch({
      type: 'change-preferences',
      preferences: { oneDayEnabled: false, oneWeekEnabled: false },
    });
    session.dispatch({ type: 'confirm-disable' });
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'disabled');
    session.dispatch({ type: 'show-explainer' });
    session.dispatch({ type: 'enable' });
    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled'),
    ).toMatchObject({
      preferences: { oneDayEnabled: true, oneWeekEnabled: true },
    });
    stop();
  });

  it('ignores events before the session starts and after it stops', async () => {
    const { boundary, session } = createSession();
    session.dispatch({ type: 'foreground' });
    expect(boundary.restore).not.toHaveBeenCalled();

    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'untouched');
    stop();
    session.dispatch({ type: 'show-explainer' });
    session.dispatch({ type: 'foreground' });

    expect(session.getSnapshot()).toEqual({ kind: 'untouched' });
    expect(boundary.restore).toHaveBeenCalledTimes(1);
  });

  it('ignores events that do not apply to an enabled registration', async () => {
    const { boundary, session, stop } = await startEnabledSession();
    const before = session.getSnapshot();

    session.dispatch({ type: 'show-explainer' });
    session.dispatch({ type: 'enable' });
    session.dispatch({ type: 'retry-load' });
    session.dispatch({ type: 'retry-zone' });
    session.dispatch({ type: 'retry-preferences' });
    session.dispatch({ type: 'cancel-preferences' });
    session.dispatch({ type: 'confirm-disable' });
    session.dispatch({ type: 'cancel-disable' });

    expect(session.getSnapshot()).toBe(before);
    expect(boundary.restore).toHaveBeenCalledTimes(1);
    expect(boundary.enable).not.toHaveBeenCalled();
    expect(boundary.updatePreferences).not.toHaveBeenCalled();
    expect(boundary.disable).not.toHaveBeenCalled();
    stop();
  });

  it('ignores events other than enable while the explainer is open', async () => {
    const { boundary, session } = createSession();
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'untouched');
    session.dispatch({ type: 'show-explainer' });
    const before = session.getSnapshot();

    session.dispatch({ type: 'retry-load' });
    session.dispatch({ type: 'retry-zone' });
    session.dispatch({
      type: 'change-preferences',
      preferences: { oneDayEnabled: false, oneWeekEnabled: true },
    });
    session.dispatch({ type: 'retry-preferences' });
    session.dispatch({ type: 'cancel-preferences' });
    session.dispatch({ type: 'confirm-disable' });
    session.dispatch({ type: 'cancel-disable' });
    session.dispatch({ result: { kind: 'succeeded' }, type: 'token-refresh' });
    expect(session.getSnapshot()).toBe(before);

    // Coming back to the app rechecks the stored state; it never registers.
    session.dispatch({ type: 'foreground' });
    expect(boundary.restore).toHaveBeenCalledTimes(2);
    expect(boundary.enable).not.toHaveBeenCalled();
    stop();
  });

  it('reports reminders as unavailable when the device cannot register', async () => {
    const { session } = createSession({
      restore: jest.fn(async () => ({ kind: 'unavailable' as const })),
    });
    const stop = session.start();

    expect(
      await waitForSnapshot(
        session,
        (snapshot) => snapshot.kind === 'unavailable',
      ),
    ).toEqual({ kind: 'unavailable' });
    stop();
  });

  it('ignores a failed load that finishes after the session stops', async () => {
    const load = deferred<ChangeReminderRestoreResult>();
    const { session } = createSession({ restore: jest.fn(() => load.promise) });
    const stop = session.start();
    stop();
    load.reject(new Error('SecureStore failed'));
    await flush();

    expect(session.getSnapshot()).toEqual({ kind: 'loading' });
  });

  it('loads again when the session restarts', async () => {
    const { boundary, session } = createSession();
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'untouched');
    stop();

    const restart = session.start();
    expect(session.getSnapshot()).toEqual({ kind: 'loading' });
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'untouched');
    expect(boundary.restore).toHaveBeenCalledTimes(2);
    restart();
  });

  it('offers a retry when a pending Home Time Zone change cannot be sent', async () => {
    const { session } = createSession({
      restore: jest.fn(async () => ({
        homeTimeZone: 'Australia/Sydney',
        kind: 'pending' as const,
        pendingHomeTimeZone: {
          confirmed: 'Australia/Melbourne',
          proposed: 'Australia/Sydney',
        },
      })),
    });
    const stop = session.start();

    expect(
      await waitForSnapshot(
        session,
        (snapshot) => snapshot.kind === 'zone-failed',
      ),
    ).toEqual({ kind: 'zone-failed', preferences: bothTimings });
    // Without an adapter that updates the zone, a retry cannot resolve it.
    session.dispatch({ type: 'retry-zone' });
    expect(session.getSnapshot()).toEqual({ kind: 'zone-mismatch' });
    stop();
  });

  it('offers a retry when a Home Time Zone update is rejected', async () => {
    const updateHomeTimeZone = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ kind: 'enabled' as const });
    const { session } = createSession({
      restore: jest.fn(async () => registeredElsewhere),
      updateHomeTimeZone,
    });
    const stop = session.start();

    expect(
      await waitForSnapshot(
        session,
        (snapshot) => snapshot.kind === 'zone-failed',
      ),
    ).toEqual({ kind: 'zone-failed', preferences: bothTimings });
    session.dispatch({ type: 'retry-zone' });
    expect(session.getSnapshot()).toMatchObject({ kind: 'saving-zone' });
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled');
    expect(updateHomeTimeZone).toHaveBeenCalledTimes(2);
    stop();
  });

  it('ignores a Home Time Zone update that finishes after the session stops', async () => {
    const update = deferred<ChangeReminderEnableResult>();
    const { session } = createSession({
      restore: jest.fn(async () => registeredElsewhere),
      updateHomeTimeZone: jest.fn(() => update.promise),
    });
    const stop = session.start();
    await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'saving-zone',
    );
    stop();
    update.resolve({ kind: 'enabled' });
    await flush();

    expect(session.getSnapshot()).toMatchObject({ kind: 'saving-zone' });
  });

  it('keeps revoked notification permission across a Home Time Zone update retry', async () => {
    const { session } = createSession({
      restore: jest.fn(async () => ({
        ...registeredElsewhere,
        notificationPermissionGranted: false,
      })),
      updateHomeTimeZone: jest
        .fn()
        .mockResolvedValueOnce({ kind: 'failed' as const })
        .mockResolvedValueOnce({ kind: 'enabled' as const }),
    });
    const stop = session.start();
    await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'zone-failed',
    );

    session.dispatch({ type: 'retry-zone' });

    expect(
      await waitForSnapshot(
        session,
        (snapshot) => snapshot.kind === 'permission-revoked',
      ),
    ).toEqual({ kind: 'permission-revoked' });
    stop();
  });

  it('ignores a foreground while timings are being saved', async () => {
    const { boundary, session, stop } = await startEnabledSession({
      updatePreferences: jest.fn(
        () => new Promise<ChangeReminderEnableResult>(() => undefined),
      ),
    });
    session.dispatch({
      type: 'change-preferences',
      preferences: { oneDayEnabled: false, oneWeekEnabled: true },
    });

    session.dispatch({ type: 'foreground' });

    expect(session.getSnapshot()).toMatchObject({ kind: 'saving-preferences' });
    expect(boundary.restore).toHaveBeenCalledTimes(1);
    stop();
  });

  it('ignores a foreground while the Home Time Zone is being updated', async () => {
    const { boundary, session } = createSession({
      restore: jest.fn(async () => registeredElsewhere),
      updateHomeTimeZone: jest.fn(
        () => new Promise<ChangeReminderEnableResult>(() => undefined),
      ),
    });
    const stop = session.start();
    await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'saving-zone',
    );

    session.dispatch({ type: 'foreground' });

    expect(session.getSnapshot()).toMatchObject({ kind: 'saving-zone' });
    expect(boundary.restore).toHaveBeenCalledTimes(1);
    stop();
  });

  it('ignores a foreground while reminders are being deleted', async () => {
    const { boundary, session, stop } = await startEnabledSession({
      disable: jest.fn(
        () => new Promise<{ readonly kind: 'disabled' }>(() => undefined),
      ),
    });
    session.dispatch({
      type: 'change-preferences',
      preferences: { oneDayEnabled: false, oneWeekEnabled: false },
    });
    session.dispatch({ type: 'confirm-disable' });

    session.dispatch({ type: 'foreground' });

    expect(session.getSnapshot()).toMatchObject({ kind: 'disabling' });
    expect(boundary.restore).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not save timings that are already confirmed', async () => {
    const { boundary, session, stop } = await startEnabledSession();
    const before = session.getSnapshot();

    session.dispatch({ type: 'change-preferences', preferences: bothTimings });

    expect(session.getSnapshot()).toBe(before);
    expect(boundary.updatePreferences).not.toHaveBeenCalled();
    stop();
  });

  it('offers a retry when saving timings is rejected', async () => {
    const { session, stop } = await startEnabledSession({
      updatePreferences: jest.fn().mockRejectedValueOnce(new Error('offline')),
    });

    session.dispatch({
      type: 'change-preferences',
      preferences: { oneDayEnabled: false, oneWeekEnabled: true },
    });

    expect(
      await waitForSnapshot(
        session,
        (snapshot) => snapshot.kind === 'preferences-failed',
      ),
    ).toEqual({
      kind: 'preferences-failed',
      preferences: bothTimings,
      proposedPreferences: { oneDayEnabled: false, oneWeekEnabled: true },
    });
    stop();
  });

  it('ignores a timing save that finishes after the session stops', async () => {
    const save = deferred<ChangeReminderEnableResult>();
    const { session, stop } = await startEnabledSession({
      updatePreferences: jest.fn(() => save.promise),
    });
    session.dispatch({
      type: 'change-preferences',
      preferences: { oneDayEnabled: false, oneWeekEnabled: true },
    });
    stop();
    save.resolve({ kind: 'failed' });
    await flush();

    expect(session.getSnapshot()).toMatchObject({ kind: 'saving-preferences' });
  });

  it('keeps confirmed reminders recoverable when deletion is rejected', async () => {
    const { session, stop } = await startEnabledSession({
      disable: jest.fn().mockRejectedValueOnce(new Error('offline')),
    });
    session.dispatch({
      type: 'change-preferences',
      preferences: { oneDayEnabled: false, oneWeekEnabled: false },
    });

    session.dispatch({ type: 'confirm-disable' });
    expect(session.getSnapshot()).toEqual({
      kind: 'disabling',
      preferences: bothTimings,
    });

    expect(
      await waitForSnapshot(
        session,
        (snapshot) => snapshot.kind === 'disable-failed',
      ),
    ).toEqual({ kind: 'disable-failed', preferences: bothTimings });
    stop();
  });

  it('shows a failure when a token refresh fails for good', async () => {
    const { session, stop } = await startEnabledSession();

    session.dispatch({
      result: { kind: 'failed', retryable: false },
      type: 'token-refresh',
    });

    expect(session.getSnapshot()).toEqual({ kind: 'failed' });
    stop();
  });

  it('stops notifying a listener once it unsubscribes', async () => {
    const { session } = createSession();
    const listener = jest.fn();
    const unsubscribe = session.subscribe(listener);
    const stop = session.start();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'untouched');

    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it('keeps a listener that subscribed again when an old unsubscribe is repeated', () => {
    const { session } = createSession();
    const listener = jest.fn();
    const unsubscribe = session.subscribe(listener);
    unsubscribe();
    session.subscribe(listener);
    unsubscribe();

    const stop = session.start();

    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });
});
