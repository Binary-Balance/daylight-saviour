import type {
  ChangeReminderAdapters,
  ChangeReminderEnableResult,
} from './change-reminder-adapters';

export type ChangeReminderSessionSnapshot =
  | { readonly kind: 'loading' }
  | { readonly kind: 'load-failed' }
  | { readonly kind: 'untouched' }
  | { readonly kind: 'explainer' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'retry-pending' }
  | { readonly kind: 'zone-mismatch' }
  | { readonly kind: 'permission-revoked' }
  | ChangeReminderEnableResult;

export type ChangeReminderSessionEvent =
  | { readonly type: 'show-explainer' }
  | { readonly type: 'enable' }
  | { readonly type: 'retry-load' };

export interface ChangeReminderSession {
  readonly dispatch: (event: ChangeReminderSessionEvent) => void;
  readonly getSnapshot: () => ChangeReminderSessionSnapshot;
  readonly start: () => () => void;
  readonly subscribe: (listener: () => void) => () => void;
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
  let snapshot: ChangeReminderSessionSnapshot = { kind: 'loading' };
  const listeners = new Set<() => void>();

  function publish(next: ChangeReminderSessionSnapshot) {
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
      if (result.kind === 'unavailable') {
        publish({ kind: 'unavailable' });
      } else if (result.kind === 'unregistered') {
        publish({ kind: 'untouched' });
      } else if (result.kind === 'pending') {
        publish({ kind: 'retry-pending' });
      } else if (result.registration.homeTimeZone !== homeTimeZone) {
        publish({ kind: 'zone-mismatch' });
      } else if (!result.notificationPermissionGranted) {
        publish({ kind: 'permission-revoked' });
      } else {
        publish({ kind: 'enabled' });
      }
    } catch {
      if (current(expectedGeneration)) publish({ kind: 'load-failed' });
    }
  }

  function enable() {
    if (
      snapshot.kind !== 'explainer' &&
      snapshot.kind !== 'failed' &&
      snapshot.kind !== 'permission-denied' &&
      snapshot.kind !== 'retry-pending'
    ) {
      return;
    }
    const expectedGeneration = generation;
    publish({ kind: 'saving' });
    void adapters
      .enable(homeTimeZone)
      .then((result) => {
        if (current(expectedGeneration)) publish(result);
      })
      .catch(() => {
        if (current(expectedGeneration)) publish({ kind: 'failed' });
      });
  }

  function dispatch(event: ChangeReminderSessionEvent) {
    if (!active) return;
    if (event.type === 'show-explainer') {
      if (snapshot.kind === 'untouched') publish({ kind: 'explainer' });
      return;
    }
    if (event.type === 'retry-load') {
      if (snapshot.kind !== 'load-failed') return;
      publish({ kind: 'loading' });
      void restore(generation);
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
      void restore(generation);
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
