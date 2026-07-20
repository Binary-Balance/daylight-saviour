import { bundledAustralianDataPack } from '@daylight-saviour/time-zone-data';

import type { HomeTimeZoneAdapters } from './home-time-zone-adapters';
import {
  createHomeTimeZoneSession,
  type HomeTimeZoneSession,
  type HomeTimeZoneSessionSnapshot,
} from './home-time-zone-session';
import {
  createTimeZoneDataPackManager,
  type TimeZoneDataPackManager,
  type TimeZoneDataPackSnapshot,
} from '../time-zone-data/time-zone-data-manager';

const now = new Date('2026-07-19T00:00:00.000Z');
const baselinePackSnapshot = createTimeZoneDataPackManager({
  bundledPack: bundledAustralianDataPack,
  now: () => now,
  remoteConfig: null,
  storage: {
    load: async () => null,
    save: async () => undefined,
  },
}).getSnapshot();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

async function waitForSnapshot(
  session: HomeTimeZoneSession,
  predicate: (snapshot: HomeTimeZoneSessionSnapshot) => boolean,
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

function createHarness({
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
  let storedZone = savedZone;
  let packSnapshot = baselinePackSnapshot;
  const acknowledgements = new Map<string, string>();
  if (savedZone !== null && acknowledgedEventAt !== null) {
    acknowledgements.set(savedZone, acknowledgedEventAt);
  }
  const packListeners = new Set<() => void>();
  const stopPackSubscription = jest.fn();
  const timeZoneDataPacks: TimeZoneDataPackManager = {
    getSnapshot: jest.fn(() => packSnapshot),
    initialize: jest.fn(async () => undefined),
    refresh: jest.fn(async () => undefined),
    subscribe: jest.fn((listener) => {
      packListeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        packListeners.delete(listener);
        stopPackSubscription();
      };
    }),
  };
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
      load: jest.fn(async () => storedZone),
      save: jest.fn(async (canonicalZoneId) => {
        storedZone = canonicalZoneId;
      }),
    },
    timeZoneDataPacks,
  };

  return {
    adapters,
    publishPack(next: TimeZoneDataPackSnapshot) {
      packSnapshot = next;
      for (const listener of [...packListeners]) listener();
    },
    stopPackSubscription,
    storedZone: () => storedZone,
    timeZoneDataPacks,
  };
}

function createSession(adapters: HomeTimeZoneAdapters) {
  return createHomeTimeZoneSession({ adapters, now: () => now });
}

describe('Home Time Zone session', () => {
  it('restores saved state with stable snapshots and exact lifecycle cleanup', async () => {
    const harness = createHarness({
      acknowledgedEventAt: '2026-04-04T16:00:00.000Z',
      savedZone: 'Australia/Sydney',
      uses24hourClock: true,
    });
    const session = createSession(harness.adapters);
    const initial = session.getSnapshot();
    expect(session.getSnapshot()).toBe(initial);
    const listener = jest.fn();
    const unsubscribe = session.subscribe(listener);
    const unsubscribeDuplicate = session.subscribe(listener);

    const stop = session.start();
    expect(session.start()).toBe(stop);
    const ready = await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'ready',
    );

    expect(ready).toMatchObject({
      acknowledgedEventAt: '2026-04-04T16:00:00.000Z',
      kind: 'ready',
      secondaryCopySeed: 'test-installation-seed',
      uses24hourClock: true,
      zoneId: 'Australia/Sydney',
    });
    expect(session.getSnapshot()).toBe(ready);
    expect(harness.timeZoneDataPacks.initialize).toHaveBeenCalledTimes(1);
    expect(harness.timeZoneDataPacks.subscribe).toHaveBeenCalledTimes(1);

    unsubscribe();
    unsubscribe();
    const callsBeforeSingleSubscriptionChange = listener.mock.calls.length;
    session.dispatch({ type: 'choose-zone' });
    expect(listener).toHaveBeenCalledTimes(
      callsBeforeSingleSubscriptionChange + 1,
    );
    unsubscribeDuplicate();
    unsubscribeDuplicate();
    const callsBeforeUnsubscribedChange = listener.mock.calls.length;
    session.dispatch({ type: 'cancel-selection' });
    expect(listener).toHaveBeenCalledTimes(callsBeforeUnsubscribedChange);

    stop();
    stop();
    expect(harness.stopPackSubscription).toHaveBeenCalledTimes(1);
  });

  it('derives confirmation facts from an aliased device zone', async () => {
    const harness = createHarness({ deviceZone: 'Australia/ACT' });
    const session = createSession(harness.adapters);
    const stop = session.start();

    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'confirm'),
    ).toMatchObject({
      currentTime: { abbreviation: 'AEST', clock: '10:00 am' },
      friendlyZoneLabel: 'Sydney, Canberra & most of NSW',
      kind: 'confirm',
      zoneId: 'Australia/Sydney',
    });

    stop();
  });

  it('forces chooser when device localization is outside Australian Coverage', async () => {
    const harness = createHarness({ deviceZone: 'Europe/London' });
    const session = createSession(harness.adapters);
    const stop = session.start();

    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'choose'),
    ).toEqual({
      canCancel: false,
      kind: 'choose',
      notice: 'device-zone-outside-coverage',
      saveError: null,
      saving: false,
    });

    stop();
  });

  it('forces chooser for invalid saved state', async () => {
    const harness = createHarness({ savedZone: 'Australia/West' });
    const session = createSession(harness.adapters);
    const stop = session.start();

    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'choose'),
    ).toMatchObject({
      canCancel: false,
      notice: 'saved-zone-invalid',
    });

    stop();
  });

  it('retries restoration after load failure', async () => {
    const harness = createHarness();
    jest
      .mocked(harness.adapters.storage.load)
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce(null);
    const session = createSession(harness.adapters);
    const stop = session.start();

    await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'load-error',
    );
    const failed = session.getSnapshot();
    session.dispatch({ type: 'cancel-selection' });
    expect(session.getSnapshot()).toBe(failed);
    session.dispatch({ type: 'retry-load' });
    expect(session.getSnapshot()).toEqual({ kind: 'loading' });
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'confirm');
    expect(harness.adapters.storage.load).toHaveBeenCalledTimes(2);

    stop();
  });

  it('selects and persists a canonical zone', async () => {
    const harness = createHarness();
    const session = createSession(harness.adapters);
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'confirm');

    const confirmation = session.getSnapshot();
    session.dispatch({ type: 'select-zone', zoneId: 'Australia/ACT' });
    expect(session.getSnapshot()).toBe(confirmation);
    session.dispatch({ type: 'select-zone', zoneId: 'Australia/Sydney' });
    expect(session.getSnapshot()).toMatchObject({
      kind: 'confirm',
      saving: true,
    });
    const ready = await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'ready',
    );
    expect(ready).toMatchObject({
      acknowledgedEventAt: null,
      kind: 'ready',
      zoneId: 'Australia/Sydney',
    });
    expect(harness.storedZone()).toBe('Australia/Sydney');

    stop();
  });

  it('keeps selection available with a literal save failure', async () => {
    const harness = createHarness();
    jest
      .mocked(harness.adapters.storage.save)
      .mockRejectedValue(new Error('storage unavailable'));
    const session = createSession(harness.adapters);
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'confirm');

    session.dispatch({ type: 'select-zone', zoneId: 'Australia/Sydney' });
    expect(
      await waitForSnapshot(
        session,
        (snapshot) =>
          snapshot.kind === 'confirm' && snapshot.saveError !== null,
      ),
    ).toMatchObject({
      kind: 'confirm',
      saveError: 'save-failed',
      saving: false,
    });

    stop();
  });

  it('cancels chooser back to the prior report without persistence', async () => {
    const harness = createHarness({
      acknowledgedEventAt: '2026-04-04T16:00:00.000Z',
      savedZone: 'Australia/Brisbane',
    });
    const session = createSession(harness.adapters);
    const stop = session.start();
    const ready = await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'ready',
    );

    session.dispatch({ type: 'choose-zone' });
    expect(session.getSnapshot()).toMatchObject({
      canCancel: true,
      kind: 'choose',
    });
    session.dispatch({ type: 'cancel-selection' });
    expect(session.getSnapshot()).toMatchObject({
      acknowledgedEventAt: '2026-04-04T16:00:00.000Z',
      kind: 'ready',
      zoneId: 'Australia/Brisbane',
    });
    expect(harness.adapters.storage.save).not.toHaveBeenCalled();
    expect(session.getSnapshot()).not.toBe(ready);

    stop();
  });

  it('uses the session seed fallback without blocking restoration', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    jest
      .mocked(harness.adapters.secondaryCopySeed.loadOrCreate)
      .mockRejectedValue(new Error('seed storage unavailable'));
    const session = createSession(harness.adapters);
    const stop = session.start();

    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready'),
    ).toMatchObject({
      kind: 'ready',
      secondaryCopySeed: 'test-session-seed',
    });

    stop();
  });

  it('tolerates aftermath acknowledgement load and save failures', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    jest
      .mocked(harness.adapters.aftermathAcknowledgements.load)
      .mockRejectedValue(new Error('acknowledgement unavailable'));
    jest
      .mocked(harness.adapters.aftermathAcknowledgements.save)
      .mockRejectedValue(new Error('acknowledgement unavailable'));
    const session = createSession(harness.adapters);
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready');

    session.dispatch({
      eventAt: '2026-10-03T16:00:00.000Z',
      type: 'acknowledge-aftermath',
    });
    const acknowledged = session.getSnapshot();
    expect(acknowledged).toMatchObject({
      acknowledgedEventAt: '2026-10-03T16:00:00.000Z',
      kind: 'ready',
    });
    session.dispatch({
      eventAt: '2026-10-03T16:00:00.000Z',
      type: 'acknowledge-aftermath',
    });
    expect(session.getSnapshot()).toBe(acknowledged);
    expect(
      harness.adapters.aftermathAcknowledgements.save,
    ).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(session.getSnapshot().kind).toBe('ready');

    stop();
  });

  it('owns pack initialization, refresh, and snapshot propagation', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    const session = createSession(harness.adapters);
    const listener = jest.fn();
    session.subscribe(listener);
    const stop = session.start();
    const ready = await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'ready',
    );

    jest
      .mocked(harness.timeZoneDataPacks.refresh)
      .mockRejectedValue(new Error('refresh unavailable'));
    session.dispatch({ type: 'foreground' });
    session.dispatch({ type: 'manual-refresh' });
    expect(harness.timeZoneDataPacks.refresh).toHaveBeenNthCalledWith(
      1,
      'foreground',
    );
    expect(harness.timeZoneDataPacks.refresh).toHaveBeenNthCalledWith(
      2,
      'manual',
    );
    await Promise.resolve();
    expect(session.getSnapshot()).toBe(ready);

    const callsBeforeSamePack = listener.mock.calls.length;
    harness.publishPack(baselinePackSnapshot);
    expect(session.getSnapshot()).toBe(ready);
    expect(listener).toHaveBeenCalledTimes(callsBeforeSamePack);

    const checkingPack = {
      ...baselinePackSnapshot,
      freshness: 'checking',
    } as const;
    harness.publishPack(checkingPack);
    expect(session.getSnapshot()).not.toBe(ready);
    expect(session.getSnapshot()).toMatchObject({
      dataPackSnapshot: checkingPack,
      kind: 'ready',
    });

    stop();
    const stopped = session.getSnapshot();
    harness.publishPack({ ...checkingPack, freshness: 'expired' });
    expect(session.getSnapshot()).toBe(stopped);
  });

  it('blocks cancel while a save is pending', async () => {
    const harness = createHarness({ savedZone: 'Australia/Brisbane' });
    const pendingSave = deferred<void>();
    jest
      .mocked(harness.adapters.storage.save)
      .mockReturnValue(pendingSave.promise);
    const session = createSession(harness.adapters);
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready');
    session.dispatch({ type: 'choose-zone' });
    session.dispatch({ type: 'select-zone', zoneId: 'Australia/Lord_Howe' });
    const saving = session.getSnapshot();

    session.dispatch({ type: 'cancel-selection' });
    expect(session.getSnapshot()).toBe(saving);
    pendingSave.resolve();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready');
    expect(session.getSnapshot()).toMatchObject({
      kind: 'ready',
      zoneId: 'Australia/Lord_Howe',
    });

    stop();
  });

  it('ignores restoration completion after stop', async () => {
    const harness = createHarness();
    const pendingLoad = deferred<string | null>();
    jest
      .mocked(harness.adapters.storage.load)
      .mockReturnValue(pendingLoad.promise);
    const session = createSession(harness.adapters);
    const listener = jest.fn();
    session.subscribe(listener);
    const stop = session.start();
    const loading = session.getSnapshot();

    stop();
    pendingLoad.resolve('Australia/Sydney');
    await Promise.resolve();
    await Promise.resolve();
    expect(session.getSnapshot()).toBe(loading);
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores selection completion after stop', async () => {
    const harness = createHarness();
    const pendingSave = deferred<void>();
    jest
      .mocked(harness.adapters.storage.save)
      .mockReturnValue(pendingSave.promise);
    const session = createSession(harness.adapters);
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'confirm');
    session.dispatch({ type: 'select-zone', zoneId: 'Australia/Sydney' });
    const saving = session.getSnapshot();

    stop();
    pendingSave.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(session.getSnapshot()).toBe(saving);
  });
});
