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
    enable: jest.fn(async () => ({ kind: 'enabled' as const })),
    openSettings: jest.fn(async () => undefined),
    restore: jest.fn(async () => ({ kind: 'unregistered' as const })),
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
    ).toEqual({ kind: 'enabled' });
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
    ).toEqual({ kind: 'enabled' });
    expect(boundary.enable).toHaveBeenCalledWith('Australia/Sydney');
    stop();
  });

  it('restores pending registration as retryable and retries through the adapter', async () => {
    const boundary = adapters({
      restore: jest.fn(async () => ({
        homeTimeZone: 'Australia/Sydney',
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
    ).toEqual({ kind: 'enabled' });
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
});
