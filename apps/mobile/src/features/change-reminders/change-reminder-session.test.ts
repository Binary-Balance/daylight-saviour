import type { ChangeReminderAdapters } from './change-reminder-adapters';
import {
  createChangeReminderSession,
  type ChangeReminderSession,
  type ChangeReminderSessionSnapshot,
} from './change-reminder-session';

const registration = {
  credential: 'c'.repeat(43),
  homeTimeZone: 'Australia/Sydney',
  installationId: 'i'.repeat(43),
  oneDayEnabled: true,
  oneWeekEnabled: true,
  version: 1 as const,
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
    load: jest.fn(async () => null),
    openSettings: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe('Change Reminder session', () => {
  it('restores one stored registration on relaunch without registering again', async () => {
    const boundary = adapters({
      load: jest.fn(async () => registration),
    });
    const session = createChangeReminderSession({
      adapters: boundary,
      homeTimeZone: 'Australia/Sydney',
    });
    const stop = session.start();

    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'enabled'),
    ).toEqual({ kind: 'enabled' });
    expect(boundary.load).toHaveBeenCalledTimes(1);
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

  it('recovers from load and rejected enable failures', async () => {
    const boundary = adapters({
      enable: jest.fn(async () => {
        throw new Error('adapter failed');
      }),
      load: jest
        .fn()
        .mockRejectedValueOnce(new Error('SecureStore failed'))
        .mockResolvedValueOnce(null),
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
    let resolveLoad!: (value: null) => void;
    const boundary = adapters({
      load: jest.fn(
        () =>
          new Promise<null>((resolve) => {
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
    resolveLoad(null);
    await Promise.resolve();
    expect(session.getSnapshot()).toEqual({ kind: 'loading' });
  });
});
