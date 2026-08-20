import type { ChangeReminderAdapters } from './change-reminder-adapters';
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
    let resolve!: (result: { readonly kind: 'failed' }) => void;
    const boundary = adapters({
      restore: jest.fn(async () => ({
        kind: 'registered' as const,
        notificationPermissionGranted: true,
        registration,
      })),
      updatePreferences: jest.fn(
        () =>
          new Promise((done) => {
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
      kind: 'enabled',
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
    expect(session.getSnapshot()).toMatchObject({ kind: 'enabled' });
    stop();
  });
});
