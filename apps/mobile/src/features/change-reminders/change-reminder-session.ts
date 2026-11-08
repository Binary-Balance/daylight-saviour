import type {
  ChangeReminderAdapters,
  ChangeReminderEnableResult,
  ChangeReminderPreferences,
  ChangeReminderRestoreResult,
  ChangeReminderTokenRefreshResult,
} from './change-reminder-adapters';

type EnabledSnapshot = {
  readonly kind: 'enabled';
  readonly preferences: ChangeReminderPreferences;
};

type RestoreResultOf<Kind extends ChangeReminderRestoreResult['kind']> =
  Extract<ChangeReminderRestoreResult, { readonly kind: Kind }>;

const defaultPreferences: ChangeReminderPreferences = {
  oneDayEnabled: true,
  oneWeekEnabled: true,
};

export type ChangeReminderSessionSnapshot =
  | { readonly kind: 'loading' }
  | { readonly kind: 'load-failed' }
  | { readonly kind: 'untouched' }
  | { readonly kind: 'explainer' }
  | { readonly kind: 'saving' }
  | {
      readonly kind: 'saving-zone';
      readonly preferences: ChangeReminderPreferences;
    }
  | {
      readonly kind: 'zone-failed';
      readonly preferences: ChangeReminderPreferences;
    }
  | { readonly kind: 'retry-pending' }
  | { readonly kind: 'zone-mismatch' }
  | { readonly kind: 'permission-revoked' }
  | { readonly kind: 'disabled' }
  | {
      readonly kind: 'saving-preferences';
      readonly preferences: ChangeReminderPreferences;
      readonly proposedPreferences: ChangeReminderPreferences;
    }
  | {
      readonly kind: 'preferences-failed';
      readonly preferences: ChangeReminderPreferences;
      readonly proposedPreferences: ChangeReminderPreferences;
    }
  | {
      readonly kind: 'confirm-disable';
      readonly preferences: ChangeReminderPreferences;
    }
  | {
      readonly kind: 'disable-failed';
      readonly preferences: ChangeReminderPreferences;
    }
  | {
      readonly kind: 'disabling';
      readonly preferences: ChangeReminderPreferences;
    }
  | EnabledSnapshot
  | Exclude<
      ChangeReminderEnableResult,
      { readonly kind: 'enabled' } | { readonly kind: 'unregistered' }
    >;

export type ChangeReminderSessionEvent =
  | { readonly type: 'show-explainer' }
  | { readonly type: 'enable' }
  | { readonly type: 'retry-load' }
  | { readonly type: 'retry-zone' }
  | { readonly type: 'foreground' }
  | {
      readonly type: 'change-preferences';
      readonly preferences: ChangeReminderPreferences;
    }
  | { readonly type: 'retry-preferences' }
  | { readonly type: 'cancel-preferences' }
  | { readonly type: 'confirm-disable' }
  | { readonly type: 'cancel-disable' }
  | {
      readonly result: ChangeReminderTokenRefreshResult;
      readonly type: 'token-refresh';
    };

export interface ChangeReminderSession {
  readonly dispatch: (event: ChangeReminderSessionEvent) => void;
  readonly getSnapshot: () => ChangeReminderSessionSnapshot;
  readonly start: () => () => void;
  readonly subscribe: (listener: () => void) => () => void;
}

function preferencesOf(registration: {
  readonly oneDayEnabled: boolean;
  readonly oneWeekEnabled: boolean;
}): ChangeReminderPreferences {
  return {
    oneDayEnabled: registration.oneDayEnabled,
    oneWeekEnabled: registration.oneWeekEnabled,
  };
}

function enabledSnapshot(
  result: ChangeReminderEnableResult,
  fallback: ChangeReminderPreferences = defaultPreferences,
): EnabledSnapshot {
  return {
    kind: 'enabled',
    preferences:
      result.kind === 'enabled' && result.preferences !== undefined
        ? result.preferences
        : fallback,
  };
}

export function createChangeReminderSession({
  adapters,
  homeTimeZone,
  onPermissionDialog,
}: {
  readonly adapters: ChangeReminderAdapters;
  readonly homeTimeZone: string;
  readonly onPermissionDialog?: (() => void) | undefined;
}): ChangeReminderSession {
  let active = false;
  let generation = 0;
  let lastConfirmedPreferences: ChangeReminderPreferences | null = null;
  let restoreInFlightGeneration: number | null = null;
  let zonePermissionGranted = true;
  let snapshot: ChangeReminderSessionSnapshot = { kind: 'loading' };
  const listeners = new Set<() => void>();

  function publish(next: ChangeReminderSessionSnapshot) {
    if (next.kind === 'enabled') lastConfirmedPreferences = next.preferences;
    // Neither leaves a registration whose timings a new one should inherit.
    if (next.kind === 'disabled' || next.kind === 'untouched') {
      lastConfirmedPreferences = null;
    }
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  function current(expectedGeneration: number) {
    return active && generation === expectedGeneration;
  }

  function beginOperation() {
    generation += 1;
    return generation;
  }

  function reconcileHomeTimeZone(
    expectedGeneration: number,
    preferences: ChangeReminderPreferences,
    permissionGranted = zonePermissionGranted,
  ) {
    zonePermissionGranted = permissionGranted;
    if (adapters.updateHomeTimeZone === undefined) {
      if (current(expectedGeneration)) publish({ kind: 'zone-mismatch' });
      return;
    }
    publish({ kind: 'saving-zone', preferences });
    void adapters.updateHomeTimeZone(homeTimeZone).then(
      (result) => {
        if (!current(expectedGeneration)) return;
        publish(
          result.kind === 'enabled'
            ? zonePermissionGranted
              ? enabledSnapshot(result, preferences)
              : { kind: 'permission-revoked' }
            : result.kind === 'unregistered'
              ? { kind: 'untouched' }
              : { kind: 'zone-failed', preferences },
        );
      },
      () => {
        if (current(expectedGeneration))
          publish({ kind: 'zone-failed', preferences });
      },
    );
  }

  function retryHomeTimeZone() {
    if (snapshot.kind !== 'zone-failed') return;
    const expectedGeneration = beginOperation();
    reconcileHomeTimeZone(expectedGeneration, snapshot.preferences);
  }

  function restorePending(
    expectedGeneration: number,
    { pendingHomeTimeZone, pendingPreferences }: RestoreResultOf<'pending'>,
  ) {
    const preferences = pendingPreferences?.confirmed ?? defaultPreferences;
    // A pending timing write can leave the saved zone unchanged while a
    // previous selection is already queued. Re-submit the current zone
    // for every authenticated pending record so that this intent is kept
    // behind the queued mutation, even when the saved zone matches.
    if (adapters.updateHomeTimeZone !== undefined) {
      reconcileHomeTimeZone(expectedGeneration, preferences);
    } else if (pendingHomeTimeZone?.proposed === homeTimeZone) {
      publish({ kind: 'zone-failed', preferences });
    } else if (pendingPreferences === undefined) {
      publish({ kind: 'retry-pending' });
    } else {
      publish({
        kind: 'preferences-failed',
        preferences: pendingPreferences.confirmed,
        proposedPreferences: pendingPreferences.proposed,
      });
    }
  }

  function restoreRegistered(
    expectedGeneration: number,
    {
      notificationPermissionGranted,
      registration,
    }: RestoreResultOf<'registered'>,
  ) {
    // A delayed pending write can leave the saved zone unchanged while a
    // previous selection is already queued, so preserve this intent even
    // when the restored record appears to match the current zone.
    if (adapters.updateHomeTimeZone !== undefined) {
      reconcileHomeTimeZone(
        expectedGeneration,
        preferencesOf(registration),
        notificationPermissionGranted,
      );
    } else if (registration.homeTimeZone !== homeTimeZone) {
      publish({ kind: 'zone-mismatch' });
    } else if (!notificationPermissionGranted) {
      publish({ kind: 'permission-revoked' });
    } else {
      publish({ kind: 'enabled', preferences: preferencesOf(registration) });
    }
  }

  async function restore(expectedGeneration: number) {
    try {
      const result = await adapters.restore();
      if (!current(expectedGeneration)) return;
      switch (result.kind) {
        case 'unavailable':
          publish({ kind: 'unavailable' });
          break;
        case 'unregistered':
          publish({ kind: 'untouched' });
          break;
        case 'deleting':
          publish({ kind: 'disable-failed', preferences: result.preferences });
          break;
        case 'pending':
          restorePending(expectedGeneration, result);
          break;
        case 'registered':
          restoreRegistered(expectedGeneration, result);
          break;
      }
    } catch {
      if (current(expectedGeneration)) publish({ kind: 'load-failed' });
    }
  }

  function requestRestore(expectedGeneration: number) {
    if (restoreInFlightGeneration === expectedGeneration) return;
    restoreInFlightGeneration = expectedGeneration;
    void restore(expectedGeneration).finally(() => {
      if (restoreInFlightGeneration === expectedGeneration) {
        restoreInFlightGeneration = null;
      }
    });
  }

  function enable() {
    if (
      snapshot.kind !== 'explainer' &&
      snapshot.kind !== 'failed' &&
      snapshot.kind !== 'os-blocked' &&
      snapshot.kind !== 'permission-denied' &&
      snapshot.kind !== 'retry-pending'
    )
      return;
    const expectedGeneration = beginOperation();
    publish({ kind: 'saving' });
    void adapters
      .enable(homeTimeZone, onPermissionDialog)
      .then((result) => {
        if (current(expectedGeneration))
          publish(
            result.kind === 'enabled'
              ? enabledSnapshot(
                  result,
                  lastConfirmedPreferences ?? defaultPreferences,
                )
              : result.kind === 'unregistered'
                ? { kind: 'untouched' }
                : result,
          );
      })
      .catch(() => {
        if (current(expectedGeneration)) publish({ kind: 'failed' });
      });
  }

  function updatePreferences(
    preferences: ChangeReminderPreferences,
    confirmed: ChangeReminderPreferences,
    forceAttempt = false,
  ) {
    if (!preferences.oneDayEnabled && !preferences.oneWeekEnabled) {
      beginOperation();
      publish({ kind: 'confirm-disable', preferences: confirmed });
      return;
    }
    if (
      !forceAttempt &&
      preferences.oneDayEnabled === confirmed.oneDayEnabled &&
      preferences.oneWeekEnabled === confirmed.oneWeekEnabled
    )
      return;
    const expectedGeneration = beginOperation();
    publish({
      kind: 'saving-preferences',
      preferences: confirmed,
      proposedPreferences: preferences,
    });
    void adapters
      .updatePreferences(preferences)
      .then((result) => {
        if (!current(expectedGeneration)) return;
        publish(
          result.kind === 'enabled'
            ? enabledSnapshot(result, preferences)
            : result.kind === 'unregistered'
              ? { kind: 'untouched' }
              : {
                  kind: 'preferences-failed',
                  preferences: confirmed,
                  proposedPreferences: preferences,
                },
        );
      })
      .catch(() => {
        if (current(expectedGeneration))
          publish({
            kind: 'preferences-failed',
            preferences: confirmed,
            proposedPreferences: preferences,
          });
      });
  }

  function disable(preferences: ChangeReminderPreferences) {
    const expectedGeneration = beginOperation();
    publish({ kind: 'disabling', preferences });
    void adapters.disable().then(
      (result) => {
        if (current(expectedGeneration))
          publish(
            result.kind === 'disabled'
              ? result
              : { kind: 'disable-failed', preferences },
          );
      },
      () => {
        if (current(expectedGeneration))
          publish({ kind: 'disable-failed', preferences });
      },
    );
  }

  function showExplainer() {
    if (snapshot.kind === 'untouched' || snapshot.kind === 'disabled') {
      publish({ kind: 'explainer' });
    }
  }

  function retryLoad() {
    if (snapshot.kind !== 'load-failed') return;
    publish({ kind: 'loading' });
    requestRestore(generation);
  }

  function onForeground() {
    switch (snapshot.kind) {
      case 'saving':
      case 'saving-preferences':
      case 'saving-zone':
      case 'disabling':
        // The running operation settles the state itself. A restore now
        // could publish stored state from before it finished.
        break;
      case 'zone-failed':
        retryHomeTimeZone();
        break;
      case 'os-blocked':
        // Registering again is how a blocked permission is rechecked. The
        // section's announcements rely on this passing through `saving`.
        enable();
        break;
      default:
        requestRestore(generation);
    }
  }

  function changePreferences(preferences: ChangeReminderPreferences) {
    if (snapshot.kind === 'enabled') {
      updatePreferences(preferences, snapshot.preferences);
    }
  }

  function retryPreferences() {
    if (snapshot.kind === 'preferences-failed') {
      updatePreferences(
        snapshot.proposedPreferences,
        snapshot.preferences,
        true,
      );
    }
  }

  function cancelPreferences() {
    // A failed save may still have reached the service, so cancelling sends
    // the confirmed timings again rather than assuming nothing changed.
    if (snapshot.kind === 'preferences-failed') {
      updatePreferences(snapshot.preferences, snapshot.preferences, true);
    }
  }

  function confirmDisable() {
    if (
      snapshot.kind === 'confirm-disable' ||
      snapshot.kind === 'disable-failed'
    ) {
      disable(snapshot.preferences);
    }
  }

  function cancelDisable() {
    if (snapshot.kind === 'confirm-disable') {
      publish({ kind: 'enabled', preferences: snapshot.preferences });
    }
  }

  function applyTokenRefresh(result: ChangeReminderTokenRefreshResult) {
    if (snapshot.kind !== 'enabled' && snapshot.kind !== 'retry-pending') {
      return;
    }
    if (result.kind === 'unregistered') {
      publish({ kind: 'untouched' });
    } else if (
      result.kind === 'succeeded' &&
      lastConfirmedPreferences !== null
    ) {
      publish({ kind: 'enabled', preferences: lastConfirmedPreferences });
    } else {
      publish(
        result.kind === 'failed' && result.retryable
          ? { kind: 'retry-pending' }
          : { kind: 'failed' },
      );
    }
  }

  function dispatch(event: ChangeReminderSessionEvent) {
    if (!active) return;
    switch (event.type) {
      case 'show-explainer':
        return showExplainer();
      case 'enable':
        return enable();
      case 'retry-load':
        return retryLoad();
      case 'retry-zone':
        return retryHomeTimeZone();
      case 'foreground':
        return onForeground();
      case 'change-preferences':
        return changePreferences(event.preferences);
      case 'retry-preferences':
        return retryPreferences();
      case 'cancel-preferences':
        return cancelPreferences();
      case 'confirm-disable':
        return confirmDisable();
      case 'cancel-disable':
        return cancelDisable();
      case 'token-refresh':
        return applyTokenRefresh(event.result);
    }
  }

  const stop = () => {
    if (!active) return;
    active = false;
    generation += 1;
  };

  return {
    dispatch,
    getSnapshot: () => snapshot,
    start() {
      if (active) return stop;
      active = true;
      generation += 1;
      publish({ kind: 'loading' });
      requestRestore(generation);
      return stop;
    },
    subscribe(listener) {
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },
  };
}
