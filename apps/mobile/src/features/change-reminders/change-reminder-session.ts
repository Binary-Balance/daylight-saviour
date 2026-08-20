import type {
  ChangeReminderAdapters,
  ChangeReminderEnableResult,
  ChangeReminderPreferences,
  ChangeReminderTokenRefreshResult,
} from './change-reminder-adapters';

type EnabledSnapshot = {
  readonly kind: 'enabled';
  readonly preferences: ChangeReminderPreferences;
};

export type ChangeReminderSessionSnapshot =
  | { readonly kind: 'loading' }
  | { readonly kind: 'load-failed' }
  | { readonly kind: 'untouched' }
  | { readonly kind: 'explainer' }
  | { readonly kind: 'saving' }
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
  | Exclude<ChangeReminderEnableResult, { readonly kind: 'enabled' }>;

export type ChangeReminderSessionEvent =
  | { readonly type: 'show-explainer' }
  | { readonly type: 'enable' }
  | { readonly type: 'retry-load' }
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
  fallback: ChangeReminderPreferences = {
    oneDayEnabled: true,
    oneWeekEnabled: true,
  },
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
}: {
  readonly adapters: ChangeReminderAdapters;
  readonly homeTimeZone: string;
}): ChangeReminderSession {
  let active = false;
  let generation = 0;
  let lastConfirmedPreferences: ChangeReminderPreferences | null = null;
  let restoreInFlightGeneration: number | null = null;
  let snapshot: ChangeReminderSessionSnapshot = { kind: 'loading' };
  const listeners = new Set<() => void>();

  function publish(next: ChangeReminderSessionSnapshot) {
    if (next.kind === 'enabled') lastConfirmedPreferences = next.preferences;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  function current(expectedGeneration: number) {
    return active && generation === expectedGeneration;
  }

  async function restore(expectedGeneration: number) {
    try {
      const result = await adapters.restore();
      if (!current(expectedGeneration)) return;
      if (result.kind === 'unavailable') publish({ kind: 'unavailable' });
      else if (result.kind === 'unregistered') publish({ kind: 'untouched' });
      else if (result.kind === 'pending') publish({ kind: 'retry-pending' });
      else if (result.registration.homeTimeZone !== homeTimeZone)
        publish({ kind: 'zone-mismatch' });
      else if (!result.notificationPermissionGranted)
        publish({ kind: 'permission-revoked' });
      else
        publish({
          kind: 'enabled',
          preferences: preferencesOf(result.registration),
        });
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
      snapshot.kind !== 'permission-denied' &&
      snapshot.kind !== 'retry-pending'
    )
      return;
    const expectedGeneration = generation;
    publish({ kind: 'saving' });
    void adapters
      .enable(homeTimeZone)
      .then((result) => {
        if (current(expectedGeneration))
          publish(result.kind === 'enabled' ? enabledSnapshot(result) : result);
      })
      .catch(() => {
        if (current(expectedGeneration)) publish({ kind: 'failed' });
      });
  }

  function updatePreferences(
    preferences: ChangeReminderPreferences,
    confirmed: ChangeReminderPreferences,
  ) {
    if (!preferences.oneDayEnabled && !preferences.oneWeekEnabled) {
      publish({ kind: 'confirm-disable', preferences: confirmed });
      return;
    }
    if (
      preferences.oneDayEnabled === confirmed.oneDayEnabled &&
      preferences.oneWeekEnabled === confirmed.oneWeekEnabled
    )
      return;
    const expectedGeneration = generation;
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
    const expectedGeneration = generation;
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

  function dispatch(event: ChangeReminderSessionEvent) {
    if (!active) return;
    if (event.type === 'show-explainer') {
      if (snapshot.kind === 'untouched' || snapshot.kind === 'disabled')
        publish({ kind: 'explainer' });
      return;
    }
    if (event.type === 'retry-load') {
      if (snapshot.kind !== 'load-failed') return;
      publish({ kind: 'loading' });
      requestRestore(generation);
      return;
    }
    if (event.type === 'foreground') {
      if (
        snapshot.kind === 'saving' ||
        snapshot.kind === 'saving-preferences' ||
        snapshot.kind === 'disabling'
      )
        return;
      requestRestore(generation);
      return;
    }
    if (event.type === 'change-preferences') {
      if (snapshot.kind === 'enabled')
        updatePreferences(event.preferences, snapshot.preferences);
      return;
    }
    if (event.type === 'retry-preferences') {
      if (snapshot.kind === 'preferences-failed')
        updatePreferences(snapshot.proposedPreferences, snapshot.preferences);
      return;
    }
    if (event.type === 'cancel-preferences') {
      if (snapshot.kind === 'preferences-failed')
        publish({ kind: 'enabled', preferences: snapshot.preferences });
      return;
    }
    if (event.type === 'confirm-disable') {
      if (
        snapshot.kind === 'confirm-disable' ||
        snapshot.kind === 'disable-failed'
      )
        disable(snapshot.preferences);
      return;
    }
    if (event.type === 'cancel-disable') {
      if (
        snapshot.kind === 'confirm-disable' ||
        snapshot.kind === 'disable-failed'
      )
        publish({ kind: 'enabled', preferences: snapshot.preferences });
      return;
    }
    if (event.type === 'token-refresh') {
      if (
        event.result.kind === 'succeeded' &&
        snapshot.kind === 'permission-revoked'
      )
        return;
      if (
        event.result.kind === 'succeeded' &&
        lastConfirmedPreferences !== null
      ) {
        publish({ kind: 'enabled', preferences: lastConfirmedPreferences });
      } else {
        publish(
          event.result.kind === 'failed' && event.result.retryable
            ? { kind: 'retry-pending' }
            : { kind: 'failed' },
        );
      }
      return;
    }
    enable();
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
