import { bundledAustralianDataPack } from '@daylight-saviour/time-zone-data';

import type {
  DeviceLocalization,
  HomeTimeZoneAdapters,
} from './home-time-zone-adapters';
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
// Create inside tests, so a mutant that breaks the manager fails a test
// instead of crashing this file while it loads.
let baselinePack: TimeZoneDataPackSnapshot | undefined;
const baselinePackSnapshot = () =>
  (baselinePack ??= createTimeZoneDataPackManager({
    bundledPack: bundledAustralianDataPack,
    now: () => now,
    remoteConfig: null,
    storage: {
      load: async () => null,
      save: async () => undefined,
    },
  }).getSnapshot());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

// Lets every promise that can already settle do so, so that a test can show
// that nothing further happens.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  let localization: DeviceLocalization = {
    timeZone: deviceZone,
    uses24hourClock,
  };
  let packSnapshot = baselinePackSnapshot();
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
    localization: { read: jest.fn(() => localization) },
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
    // Changes what the device reports from the next read, as the settings app
    // would while this one is in the background.
    setLocalization(next: DeviceLocalization) {
      localization = next;
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
      kind: 'ready',
      openingAcknowledgedEventAt: '2026-04-04T16:00:00.000Z',
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

  it.each([
    ['outside Australian Coverage', 'Europe/London'],
    ['not reported', null],
  ] as const)(
    'forces chooser when the device zone is %s',
    async (_case, deviceZone) => {
      const harness = createHarness({ deviceZone });
      const session = createSession(harness.adapters);
      const stop = session.start();

      expect(
        await waitForSnapshot(
          session,
          (snapshot) => snapshot.kind === 'choose',
        ),
      ).toEqual({
        canCancel: false,
        kind: 'choose',
        notice: 'device-zone-outside-coverage',
        saveError: null,
        saving: false,
      });

      stop();
    },
  );

  it.each([
    ['an alias', 'Australia/West'],
    ['outside Australian Coverage', 'Europe/London'],
    ['empty', ''],
  ] as const)(
    'forces chooser when the saved zone is %s',
    async (_case, savedZone) => {
      const harness = createHarness({ savedZone });
      const session = createSession(harness.adapters);
      const stop = session.start();

      expect(
        await waitForSnapshot(
          session,
          (snapshot) => snapshot.kind === 'choose',
        ),
      ).toEqual({
        canCancel: false,
        kind: 'choose',
        notice: 'saved-zone-invalid',
        saveError: null,
        saving: false,
      });
      expect(
        harness.adapters.aftermathAcknowledgements.load,
      ).not.toHaveBeenCalled();

      stop();
    },
  );

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

  it('retries only after a load failure', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    const session = createSession(harness.adapters);
    const stop = session.start();
    const ready = await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'ready',
    );

    session.dispatch({ type: 'retry-load' });

    expect(session.getSnapshot()).toBe(ready);
    expect(harness.adapters.storage.load).toHaveBeenCalledTimes(1);

    stop();
  });

  it('shows the load error when the device localization cannot be read', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    jest
      .mocked(harness.adapters.localization.read)
      .mockImplementationOnce(() => {
        throw new Error('native read failed');
      });
    const session = createSession(harness.adapters);
    const stop = session.start();

    await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'load-error',
    );
    session.dispatch({ type: 'retry-load' });

    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready'),
    ).toMatchObject({ zoneId: 'Australia/Sydney' });

    stop();
  });

  it('ignores a seed that arrives after stop', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    const pendingSeed = deferred<string>();
    jest
      .mocked(harness.adapters.secondaryCopySeed.loadOrCreate)
      .mockReturnValue(pendingSeed.promise);
    const session = createSession(harness.adapters);
    const listener = jest.fn();
    session.subscribe(listener);
    const stop = session.start();
    await settle();

    stop();
    pendingSeed.resolve('late-seed');
    await settle();

    expect(session.getSnapshot()).toEqual({ kind: 'loading' });
    expect(listener).not.toHaveBeenCalled();
    expect(
      harness.adapters.aftermathAcknowledgements.load,
    ).not.toHaveBeenCalled();
  });

  it('ignores an acknowledgement that arrives after stop', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    const pendingAcknowledgement = deferred<string | null>();
    jest
      .mocked(harness.adapters.aftermathAcknowledgements.load)
      .mockReturnValue(pendingAcknowledgement.promise);
    const session = createSession(harness.adapters);
    const listener = jest.fn();
    session.subscribe(listener);
    const stop = session.start();
    await settle();
    expect(
      harness.adapters.aftermathAcknowledgements.load,
    ).toHaveBeenCalledWith('Australia/Sydney');

    stop();
    pendingAcknowledgement.resolve('2026-04-04T16:00:00.000Z');
    await settle();

    expect(session.getSnapshot()).toEqual({ kind: 'loading' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores a load failure that arrives after stop', async () => {
    const harness = createHarness();
    const pendingLoad = deferred<string | null>();
    // A mutant that never reads the zone must not leave this rejection
    // unhandled.
    pendingLoad.promise.catch(() => undefined);
    jest
      .mocked(harness.adapters.storage.load)
      .mockReturnValue(pendingLoad.promise);
    const session = createSession(harness.adapters);
    const listener = jest.fn();
    session.subscribe(listener);
    const stop = session.start();

    stop();
    pendingLoad.reject(new Error('storage unavailable'));
    await settle();

    expect(session.getSnapshot()).toEqual({ kind: 'loading' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores a restoration begun before a restart', async () => {
    const harness = createHarness({ savedZone: 'Australia/Brisbane' });
    const pendingLoad = deferred<string | null>();
    jest
      .mocked(harness.adapters.storage.load)
      .mockReturnValueOnce(pendingLoad.promise);
    const session = createSession(harness.adapters);
    const stopFirst = session.start();
    stopFirst();
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready');

    pendingLoad.resolve('Australia/Perth');
    await settle();

    expect(session.getSnapshot()).toMatchObject({
      kind: 'ready',
      zoneId: 'Australia/Brisbane',
    });

    stop();
  });

  it('starts again from loading with the current data pack', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    const session = createSession(harness.adapters);
    const stopFirst = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready');
    stopFirst();
    const checkingPack = {
      ...baselinePackSnapshot(),
      freshness: 'checking',
    } as const;
    harness.publishPack(checkingPack);

    const stop = session.start();

    expect(session.getSnapshot()).toEqual({ kind: 'loading' });
    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready'),
    ).toMatchObject({ dataPackSnapshot: checkingPack });

    stop();
  });

  it('restores although pack initialization fails', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    jest
      .mocked(harness.timeZoneDataPacks.initialize)
      .mockRejectedValue(new Error('initialization unavailable'));
    const session = createSession(harness.adapters);
    const stop = session.start();

    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready'),
    ).toMatchObject({ zoneId: 'Australia/Sydney' });
    expect(harness.timeZoneDataPacks.initialize).toHaveBeenCalledTimes(1);

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
      kind: 'ready',
      openingAcknowledgedEventAt: null,
      zoneId: 'Australia/Sydney',
    });
    expect(harness.storedZone()).toBe('Australia/Sydney');

    stop();
  });

  it('opens a newly selected zone with its saved acknowledgement', async () => {
    const harness = createHarness();
    jest
      .mocked(harness.adapters.aftermathAcknowledgements.load)
      .mockResolvedValue('2026-04-04T16:00:00.000Z');
    const session = createSession(harness.adapters);
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'confirm');

    session.dispatch({ type: 'select-zone', zoneId: 'Australia/Sydney' });

    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready'),
    ).toMatchObject({
      openingAcknowledgedEventAt: '2026-04-04T16:00:00.000Z',
      zoneId: 'Australia/Sydney',
    });
    expect(
      harness.adapters.aftermathAcknowledgements.load,
    ).toHaveBeenLastCalledWith('Australia/Sydney');

    stop();
  });

  it('opens a newly selected zone when its acknowledgement cannot be read', async () => {
    const harness = createHarness();
    jest
      .mocked(harness.adapters.aftermathAcknowledgements.load)
      .mockRejectedValue(new Error('acknowledgement unavailable'));
    const session = createSession(harness.adapters);
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'confirm');

    session.dispatch({ type: 'select-zone', zoneId: 'Australia/Sydney' });

    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready'),
    ).toMatchObject({
      openingAcknowledgedEventAt: null,
      zoneId: 'Australia/Sydney',
    });

    stop();
  });

  it('ignores a zone selected when none is being chosen', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    const session = createSession(harness.adapters);
    const stop = session.start();
    const loading = session.getSnapshot();

    session.dispatch({ type: 'select-zone', zoneId: 'Australia/Brisbane' });
    expect(session.getSnapshot()).toBe(loading);
    const ready = await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'ready',
    );
    session.dispatch({ type: 'select-zone', zoneId: 'Australia/Brisbane' });

    expect(session.getSnapshot()).toBe(ready);
    expect(harness.adapters.storage.save).not.toHaveBeenCalled();

    stop();
  });

  it('ignores another zone selected while one is being saved', async () => {
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

    session.dispatch({ type: 'select-zone', zoneId: 'Australia/Brisbane' });

    expect(session.getSnapshot()).toBe(saving);
    expect(harness.adapters.storage.save).toHaveBeenCalledTimes(1);
    pendingSave.resolve();
    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready'),
    ).toMatchObject({ zoneId: 'Australia/Sydney' });

    stop();
  });

  it('ignores a selected zone whose acknowledgement arrives after stop', async () => {
    const harness = createHarness();
    const pendingAcknowledgement = deferred<string | null>();
    jest
      .mocked(harness.adapters.aftermathAcknowledgements.load)
      .mockReturnValue(pendingAcknowledgement.promise);
    const session = createSession(harness.adapters);
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'confirm');
    session.dispatch({ type: 'select-zone', zoneId: 'Australia/Sydney' });
    const saving = session.getSnapshot();
    await settle();
    expect(
      harness.adapters.aftermathAcknowledgements.load,
    ).toHaveBeenCalledWith('Australia/Sydney');

    stop();
    pendingAcknowledgement.resolve('2026-04-04T16:00:00.000Z');
    await settle();

    expect(session.getSnapshot()).toBe(saving);
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
      kind: 'ready',
      openingAcknowledgedEventAt: '2026-04-04T16:00:00.000Z',
      zoneId: 'Australia/Brisbane',
    });
    expect(harness.adapters.storage.save).not.toHaveBeenCalled();
    expect(session.getSnapshot()).not.toBe(ready);

    stop();
  });

  it('opens the chooser from a confirmation that failed to save', async () => {
    const harness = createHarness();
    jest
      .mocked(harness.adapters.storage.save)
      .mockRejectedValue(new Error('storage unavailable'));
    const session = createSession(harness.adapters);
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'confirm');
    session.dispatch({ type: 'select-zone', zoneId: 'Australia/Sydney' });
    await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'confirm' && snapshot.saveError !== null,
    );

    session.dispatch({ type: 'choose-zone' });

    expect(session.getSnapshot()).toEqual({
      canCancel: false,
      kind: 'choose',
      notice: null,
      saveError: 'save-failed',
      saving: false,
    });

    stop();
  });

  it('keeps a confirmation on screen while its zone is being saved', async () => {
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

    session.dispatch({ type: 'choose-zone' });

    expect(session.getSnapshot()).toBe(saving);
    pendingSave.resolve();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready');

    stop();
  });

  it('opens the chooser only from a report or a confirmation', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    const session = createSession(harness.adapters);
    const stop = session.start();
    const loading = session.getSnapshot();
    session.dispatch({ type: 'choose-zone' });
    expect(session.getSnapshot()).toBe(loading);
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready');
    session.dispatch({ type: 'choose-zone' });
    const choosing = session.getSnapshot();

    session.dispatch({ type: 'choose-zone' });

    expect(session.getSnapshot()).toBe(choosing);
    expect(choosing).toMatchObject({ canCancel: true, kind: 'choose' });

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

    // The unsaved acknowledgement still ends the Aftermath on the next opening.
    session.dispatch({ type: 'foreground' });
    expect(session.getSnapshot()).toMatchObject({
      kind: 'ready',
      openingAcknowledgedEventAt: '2026-10-03T16:00:00.000Z',
    });

    stop();
  });

  it('keeps the opening acknowledgement until the app returns from the background', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    const session = createSession(harness.adapters);
    const stop = session.start();
    const loading = session.getSnapshot();
    session.dispatch({ type: 'foreground' });
    expect(session.getSnapshot()).toBe(loading);
    const ready = await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'ready',
    );

    session.dispatch({ type: 'foreground' });
    expect(session.getSnapshot()).toBe(ready);
    session.dispatch({
      eventAt: '2026-10-03T16:00:00.000Z',
      type: 'acknowledge-aftermath',
    });
    expect(
      harness.adapters.aftermathAcknowledgements.save,
    ).toHaveBeenCalledWith('Australia/Sydney', '2026-10-03T16:00:00.000Z');
    expect(session.getSnapshot()).toMatchObject({
      openingAcknowledgedEventAt: null,
    });

    session.dispatch({ type: 'foreground' });
    const reopened = session.getSnapshot();
    expect(reopened).toMatchObject({
      openingAcknowledgedEventAt: '2026-10-03T16:00:00.000Z',
    });
    session.dispatch({ type: 'foreground' });
    expect(session.getSnapshot()).toBe(reopened);

    stop();
  });

  it('acknowledges an Aftermath for the zone the chooser returns to', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    const session = createSession(harness.adapters);
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready');
    session.dispatch({ type: 'choose-zone' });

    session.dispatch({
      eventAt: '2026-10-03T16:00:00.000Z',
      type: 'acknowledge-aftermath',
    });
    const acknowledged = session.getSnapshot();
    session.dispatch({
      eventAt: '2026-10-03T16:00:00.000Z',
      type: 'acknowledge-aftermath',
    });

    expect(session.getSnapshot()).toBe(acknowledged);
    expect(
      harness.adapters.aftermathAcknowledgements.save,
    ).toHaveBeenCalledTimes(1);
    expect(
      harness.adapters.aftermathAcknowledgements.save,
    ).toHaveBeenCalledWith('Australia/Sydney', '2026-10-03T16:00:00.000Z');
    expect(harness.timeZoneDataPacks.refresh).not.toHaveBeenCalled();
    session.dispatch({ type: 'cancel-selection' });
    expect(session.getSnapshot()).toMatchObject({
      kind: 'ready',
      openingAcknowledgedEventAt: '2026-10-03T16:00:00.000Z',
      zoneId: 'Australia/Sydney',
    });

    stop();
  });

  it.each([
    ['loading', { savedZone: 'Australia/Sydney' }, 'loading'],
    ['a confirmation', {}, 'confirm'],
    ['a chooser with nothing to return to', { deviceZone: null }, 'choose'],
  ] as const)(
    'ignores an acknowledgement while showing %s',
    async (_case, options, kind) => {
      const harness = createHarness(options);
      const session = createSession(harness.adapters);
      const stop = session.start();
      await waitForSnapshot(session, (snapshot) => snapshot.kind === kind);
      const shown = session.getSnapshot();

      session.dispatch({
        eventAt: '2026-10-03T16:00:00.000Z',
        type: 'acknowledge-aftermath',
      });

      expect(session.getSnapshot()).toBe(shown);
      expect(
        harness.adapters.aftermathAcknowledgements.save,
      ).not.toHaveBeenCalled();

      stop();
    },
  );

  it('keeps the suggested zone while following the preference on the confirm screen', async () => {
    const harness = createHarness({ deviceZone: 'Australia/Sydney' });
    const session = createSession(harness.adapters);
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'confirm');

    harness.setLocalization({
      timeZone: 'Australia/Perth',
      uses24hourClock: true,
    });
    session.dispatch({ type: 'foreground' });

    expect(session.getSnapshot()).toMatchObject({
      currentTime: { clock: '10:00' },
      kind: 'confirm',
      zoneId: 'Australia/Sydney',
    });
    stop();
  });

  it('still refreshes data when the device preference cannot be read', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    const session = createSession(harness.adapters);
    const stop = session.start();
    const ready = await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'ready',
    );
    jest.mocked(harness.adapters.localization.read).mockImplementation(() => {
      throw new Error('native read failed');
    });

    expect(() => session.dispatch({ type: 'foreground' })).not.toThrow();

    expect(session.getSnapshot()).toBe(ready);
    expect(harness.adapters.timeZoneDataPacks.refresh).toHaveBeenCalledWith(
      'foreground',
    );
    stop();
  });

  it('follows a changed 12/24-hour preference when the app returns', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    const session = createSession(harness.adapters);
    const stop = session.start();
    const ready = await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'ready',
    );
    const listener = jest.fn();
    session.subscribe(listener);

    // A device that has moved to another zone leaves the saved zone alone.
    harness.setLocalization({
      timeZone: 'Australia/Perth',
      uses24hourClock: true,
    });
    session.dispatch({ type: 'foreground' });

    expect(session.getSnapshot()).not.toBe(ready);
    expect(session.getSnapshot()).toMatchObject({
      kind: 'ready',
      uses24hourClock: true,
      zoneId: 'Australia/Sydney',
    });
    expect(listener).toHaveBeenCalledTimes(1);

    harness.setLocalization({
      timeZone: 'Australia/Perth',
      uses24hourClock: false,
    });
    session.dispatch({ type: 'foreground' });

    expect(session.getSnapshot()).toMatchObject({ uses24hourClock: false });
    expect(listener).toHaveBeenCalledTimes(2);

    stop();
  });

  it.each([
    ['unchanged', true],
    ['unavailable', null],
  ] as const)(
    'publishes nothing when the 12/24-hour preference is %s',
    async (_case, reported) => {
      const harness = createHarness({
        savedZone: 'Australia/Sydney',
        uses24hourClock: true,
      });
      const session = createSession(harness.adapters);
      const stop = session.start();
      const ready = await waitForSnapshot(
        session,
        (snapshot) => snapshot.kind === 'ready',
      );
      const listener = jest.fn();
      session.subscribe(listener);

      harness.setLocalization({
        timeZone: 'Australia/Sydney',
        uses24hourClock: reported,
      });
      session.dispatch({ type: 'foreground' });

      // Once to restore and once for the return, so the read really happened.
      expect(harness.adapters.localization.read).toHaveBeenCalledTimes(2);
      expect(session.getSnapshot()).toBe(ready);
      expect(listener).not.toHaveBeenCalled();

      stop();
    },
  );

  it('uses 12-hour time until the device reports a preference', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    harness.setLocalization({ timeZone: null, uses24hourClock: null });
    const session = createSession(harness.adapters);
    const stop = session.start();
    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready'),
    ).toMatchObject({ uses24hourClock: false });

    harness.setLocalization({ timeZone: null, uses24hourClock: true });
    session.dispatch({ type: 'foreground' });
    expect(session.getSnapshot()).toMatchObject({ uses24hourClock: true });

    harness.setLocalization({ timeZone: null, uses24hourClock: null });
    session.dispatch({ type: 'foreground' });
    expect(session.getSnapshot()).toMatchObject({ uses24hourClock: true });

    stop();
  });

  it('updates the suggested time while the zone is being confirmed', async () => {
    const harness = createHarness();
    const session = createSession(harness.adapters);
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'confirm');
    expect(session.getSnapshot()).toMatchObject({
      currentTime: { clock: '10:00 am' },
    });

    harness.setLocalization({
      timeZone: 'Australia/Sydney',
      uses24hourClock: true,
    });
    session.dispatch({ type: 'foreground' });
    expect(session.getSnapshot()).toMatchObject({
      currentTime: { clock: '10:00' },
      kind: 'confirm',
      zoneId: 'Australia/Sydney',
    });

    session.dispatch({ type: 'select-zone', zoneId: 'Australia/Sydney' });
    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready'),
    ).toMatchObject({ uses24hourClock: true });

    stop();
  });

  it.each([
    ['cancelled', { type: 'cancel-selection' }, 'Australia/Sydney'],
    [
      'used to pick another zone',
      { type: 'select-zone', zoneId: 'Australia/Brisbane' },
      'Australia/Brisbane',
    ],
  ] as const)(
    'keeps a preference change made while the chooser is %s',
    async (_case, close, zoneId) => {
      const harness = createHarness({ savedZone: 'Australia/Sydney' });
      const session = createSession(harness.adapters);
      const stop = session.start();
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready');
      session.dispatch({ type: 'choose-zone' });

      harness.setLocalization({
        timeZone: 'Australia/Sydney',
        uses24hourClock: true,
      });
      session.dispatch({ type: 'foreground' });
      expect(session.getSnapshot()).toMatchObject({ kind: 'choose' });
      session.dispatch(close);

      expect(
        await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready'),
      ).toMatchObject({ uses24hourClock: true, zoneId });

      stop();
    },
  );

  it('keeps a preference change that arrives while a zone is being saved', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    const pendingSave = deferred<void>();
    jest
      .mocked(harness.adapters.storage.save)
      .mockReturnValue(pendingSave.promise);
    const session = createSession(harness.adapters);
    const stop = session.start();
    await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready');
    session.dispatch({ type: 'choose-zone' });
    session.dispatch({ type: 'select-zone', zoneId: 'Australia/Brisbane' });

    harness.setLocalization({
      timeZone: 'Australia/Sydney',
      uses24hourClock: true,
    });
    session.dispatch({ type: 'foreground' });
    pendingSave.resolve();

    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready'),
    ).toMatchObject({ uses24hourClock: true, zoneId: 'Australia/Brisbane' });

    stop();
  });

  it('keeps a preference change that arrives while restoring', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    const pendingSeed = deferred<string>();
    jest
      .mocked(harness.adapters.secondaryCopySeed.loadOrCreate)
      .mockReturnValue(pendingSeed.promise);
    const session = createSession(harness.adapters);
    const stop = session.start();
    // Restoration has read the preference by the time it asks for the seed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.adapters.secondaryCopySeed.loadOrCreate).toHaveBeenCalled();

    harness.setLocalization({
      timeZone: 'Australia/Sydney',
      uses24hourClock: true,
    });
    session.dispatch({ type: 'foreground' });
    expect(session.getSnapshot()).toEqual({ kind: 'loading' });
    pendingSeed.resolve('test-installation-seed');

    expect(
      await waitForSnapshot(session, (snapshot) => snapshot.kind === 'ready'),
    ).toMatchObject({ uses24hourClock: true });

    stop();
  });

  it('ignores a return to the foreground after stop', async () => {
    const harness = createHarness({ savedZone: 'Australia/Sydney' });
    const session = createSession(harness.adapters);
    const stop = session.start();
    const ready = await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'ready',
    );
    const listener = jest.fn();
    session.subscribe(listener);
    stop();

    harness.setLocalization({
      timeZone: 'Australia/Sydney',
      uses24hourClock: true,
    });
    session.dispatch({ type: 'foreground' });

    expect(harness.adapters.localization.read).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).toBe(ready);
    expect(listener).not.toHaveBeenCalled();
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
    expect(harness.timeZoneDataPacks.refresh).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(session.getSnapshot()).toBe(ready);

    const callsBeforeSamePack = listener.mock.calls.length;
    harness.publishPack(baselinePackSnapshot());
    expect(session.getSnapshot()).toBe(ready);
    expect(listener).toHaveBeenCalledTimes(callsBeforeSamePack);

    const checkingPack = {
      ...baselinePackSnapshot(),
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

  it('leaves the chooser alone when the data pack changes', async () => {
    const harness = createHarness({ deviceZone: null });
    const session = createSession(harness.adapters);
    const stop = session.start();
    const choosing = await waitForSnapshot(
      session,
      (snapshot) => snapshot.kind === 'choose',
    );
    const listener = jest.fn();
    session.subscribe(listener);

    harness.publishPack({ ...baselinePackSnapshot(), freshness: 'checking' });

    expect(session.getSnapshot()).toBe(choosing);
    expect(listener).not.toHaveBeenCalled();

    stop();
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
