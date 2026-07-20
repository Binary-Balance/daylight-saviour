import {
  getAustralianZone,
  normalizeAustralianZoneId,
} from '@daylight-saviour/domain';
import type {
  HomeTimeZoneErrorCode,
  HomeTimeZoneNoticeCode,
} from '@daylight-saviour/copy';

import type { StatusViewModel } from '../status/status-view-model';
import { createStatusViewModel } from '../status/status-view-model';
import type { TimeZoneDataPackSnapshot } from '../time-zone-data/time-zone-data-manager';
import type { HomeTimeZoneAdapters } from './home-time-zone-adapters';

export type HomeTimeZoneSessionSnapshot =
  | { readonly kind: 'loading' }
  | { readonly kind: 'load-error' }
  | {
      readonly currentTime: Pick<
        Extract<StatusViewModel, { readonly availability: 'ready' }>,
        'abbreviation' | 'clock'
      > | null;
      readonly friendlyZoneLabel: string;
      readonly kind: 'confirm';
      readonly saveError: HomeTimeZoneErrorCode | null;
      readonly saving: boolean;
      readonly zoneId: string;
    }
  | {
      readonly canCancel: boolean;
      readonly kind: 'choose';
      readonly notice: HomeTimeZoneNoticeCode | null;
      readonly saveError: HomeTimeZoneErrorCode | null;
      readonly saving: boolean;
    }
  | {
      readonly acknowledgedEventAt: string | null;
      readonly dataPackSnapshot: TimeZoneDataPackSnapshot;
      readonly kind: 'ready';
      readonly secondaryCopySeed: string;
      readonly uses24hourClock: boolean;
      readonly zoneId: string;
    };

export type HomeTimeZoneSessionEvent =
  | { readonly type: 'retry-load' }
  | { readonly type: 'choose-zone' }
  | { readonly type: 'cancel-selection' }
  | { readonly type: 'select-zone'; readonly zoneId: string }
  | { readonly type: 'acknowledge-aftermath'; readonly eventAt: string }
  | { readonly type: 'manual-refresh' }
  | { readonly type: 'foreground' };

export interface HomeTimeZoneSession {
  readonly dispatch: (event: HomeTimeZoneSessionEvent) => void;
  readonly getSnapshot: () => HomeTimeZoneSessionSnapshot;
  readonly start: () => () => void;
  readonly subscribe: (listener: () => void) => () => void;
}

interface HomeTimeZoneSessionOptions {
  readonly adapters: HomeTimeZoneAdapters;
  readonly now?: () => Date;
}

type FlowState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'load-error' }
  | {
      readonly kind: 'confirm';
      readonly saveError: HomeTimeZoneErrorCode | null;
      readonly saving: boolean;
      readonly secondaryCopySeed: string;
      readonly uses24hourClock: boolean;
      readonly zoneId: string;
    }
  | {
      readonly kind: 'choose';
      readonly notice: HomeTimeZoneNoticeCode | null;
      readonly returnAcknowledgedEventAt: string | null;
      readonly returnZoneId: string | null;
      readonly saveError: HomeTimeZoneErrorCode | null;
      readonly saving: boolean;
      readonly secondaryCopySeed: string;
      readonly uses24hourClock: boolean;
    }
  | {
      readonly acknowledgedEventAt: string | null;
      readonly kind: 'ready';
      readonly secondaryCopySeed: string;
      readonly uses24hourClock: boolean;
      readonly zoneId: string;
    };

export function createHomeTimeZoneSession({
  adapters,
  now = () => new Date(),
}: HomeTimeZoneSessionOptions): HomeTimeZoneSession {
  let active = false;
  let generation = 0;
  let flow: FlowState = { kind: 'loading' };
  let dataPackSnapshot = adapters.timeZoneDataPacks.getSnapshot();
  let stopDataPackSubscription: (() => void) | null = null;
  const subscriptions = new Set<{ readonly listener: () => void }>();

  function materialize(): HomeTimeZoneSessionSnapshot {
    if (flow.kind === 'loading' || flow.kind === 'load-error') return flow;

    if (flow.kind === 'confirm') {
      const zone = getAustralianZone(flow.zoneId)!;
      const report = createStatusViewModel(
        dataPackSnapshot.pack,
        dataPackSnapshot.freshness,
        flow.zoneId,
        now(),
        flow.uses24hourClock,
        flow.secondaryCopySeed,
      );
      return {
        currentTime:
          report.availability === 'ready'
            ? { abbreviation: report.abbreviation, clock: report.clock }
            : null,
        friendlyZoneLabel: zone.friendlyLabel,
        kind: 'confirm',
        saveError: flow.saveError,
        saving: flow.saving,
        zoneId: flow.zoneId,
      };
    }

    if (flow.kind === 'choose') {
      return {
        canCancel: flow.returnZoneId !== null,
        kind: 'choose',
        notice: flow.notice,
        saveError: flow.saveError,
        saving: flow.saving,
      };
    }

    return {
      acknowledgedEventAt: flow.acknowledgedEventAt,
      dataPackSnapshot,
      kind: 'ready',
      secondaryCopySeed: flow.secondaryCopySeed,
      uses24hourClock: flow.uses24hourClock,
      zoneId: flow.zoneId,
    };
  }

  let snapshot = materialize();

  function publish() {
    snapshot = materialize();
    for (const subscription of [...subscriptions]) subscription.listener();
  }

  function setFlow(next: FlowState) {
    flow = next;
    publish();
  }

  function current(expectedGeneration: number) {
    return active && generation === expectedGeneration;
  }

  async function restore(expectedGeneration: number) {
    try {
      const saved = await adapters.storage.load();
      if (!current(expectedGeneration)) return;
      const localization = adapters.localization.read();
      const secondaryCopySeed = await adapters.secondaryCopySeed
        .loadOrCreate()
        .catch(() => adapters.secondaryCopySeed.sessionFallback);
      if (!current(expectedGeneration)) return;

      if (saved !== null) {
        const canonical = normalizeAustralianZoneId(saved);
        if (canonical === saved) {
          let acknowledgedEventAt: string | null = null;
          try {
            acknowledgedEventAt =
              await adapters.aftermathAcknowledgements.load(canonical);
          } catch {
            // Noncritical acknowledgement failure may repeat one factual
            // aftermath opening but cannot block the report.
          }
          if (!current(expectedGeneration)) return;
          setFlow({
            acknowledgedEventAt,
            kind: 'ready',
            secondaryCopySeed,
            uses24hourClock: localization.uses24hourClock,
            zoneId: canonical,
          });
        } else {
          setFlow({
            kind: 'choose',
            notice: 'saved-zone-invalid',
            returnAcknowledgedEventAt: null,
            returnZoneId: null,
            saveError: null,
            saving: false,
            secondaryCopySeed,
            uses24hourClock: localization.uses24hourClock,
          });
        }
        return;
      }

      const suggested = localization.timeZone;
      const canonical =
        suggested === null ? null : normalizeAustralianZoneId(suggested);
      if (canonical === null) {
        setFlow({
          kind: 'choose',
          notice: 'device-zone-outside-coverage',
          returnAcknowledgedEventAt: null,
          returnZoneId: null,
          saveError: null,
          saving: false,
          secondaryCopySeed,
          uses24hourClock: localization.uses24hourClock,
        });
      } else {
        setFlow({
          kind: 'confirm',
          saveError: null,
          saving: false,
          secondaryCopySeed,
          uses24hourClock: localization.uses24hourClock,
          zoneId: canonical,
        });
      }
    } catch {
      if (current(expectedGeneration)) setFlow({ kind: 'load-error' });
    }
  }

  function selectZone(zoneId: string) {
    if ((flow.kind !== 'confirm' && flow.kind !== 'choose') || flow.saving) {
      return;
    }
    const zone = getAustralianZone(zoneId);
    if (zone === null || zone.id !== zoneId) return;

    const selectionFlow = flow;
    const expectedGeneration = generation;
    setFlow({ ...selectionFlow, saveError: null, saving: true });
    void (async () => {
      try {
        await adapters.storage.save(zone.id);
        if (!current(expectedGeneration)) return;
        let acknowledgedEventAt: string | null = null;
        try {
          acknowledgedEventAt = await adapters.aftermathAcknowledgements.load(
            zone.id,
          );
        } catch {
          // A successfully saved Home Time Zone remains usable when its
          // acknowledgement cannot be restored.
        }
        if (!current(expectedGeneration)) return;
        setFlow({
          acknowledgedEventAt,
          kind: 'ready',
          secondaryCopySeed: selectionFlow.secondaryCopySeed,
          uses24hourClock: selectionFlow.uses24hourClock,
          zoneId: zone.id,
        });
      } catch {
        if (!current(expectedGeneration)) return;
        setFlow({ ...selectionFlow, saveError: 'save-failed', saving: false });
      }
    })();
  }

  function acknowledgeAftermath(eventAt: string) {
    let zoneId: string | null = null;
    if (flow.kind === 'ready') {
      if (flow.acknowledgedEventAt === eventAt) return;
      zoneId = flow.zoneId;
      setFlow({ ...flow, acknowledgedEventAt: eventAt });
    } else if (flow.kind === 'choose' && flow.returnZoneId !== null) {
      if (flow.returnAcknowledgedEventAt === eventAt) return;
      zoneId = flow.returnZoneId;
      setFlow({ ...flow, returnAcknowledgedEventAt: eventAt });
    }
    if (zoneId !== null) {
      void adapters.aftermathAcknowledgements
        .save(zoneId, eventAt)
        .catch(() => undefined);
    }
  }

  function dispatch(event: HomeTimeZoneSessionEvent) {
    if (!active) return;

    switch (event.type) {
      case 'retry-load':
        if (flow.kind !== 'load-error') return;
        setFlow({ kind: 'loading' });
        void restore(generation);
        return;
      case 'choose-zone':
        if (flow.kind === 'ready') {
          setFlow({
            kind: 'choose',
            notice: null,
            returnAcknowledgedEventAt: flow.acknowledgedEventAt,
            returnZoneId: flow.zoneId,
            saveError: null,
            saving: false,
            secondaryCopySeed: flow.secondaryCopySeed,
            uses24hourClock: flow.uses24hourClock,
          });
          return;
        }
        if (flow.kind === 'confirm' && !flow.saving) {
          setFlow({
            kind: 'choose',
            notice: null,
            returnAcknowledgedEventAt: null,
            returnZoneId: null,
            saveError: flow.saveError,
            saving: false,
            secondaryCopySeed: flow.secondaryCopySeed,
            uses24hourClock: flow.uses24hourClock,
          });
        }
        return;
      case 'cancel-selection':
        if (
          flow.kind !== 'choose' ||
          flow.saving ||
          flow.returnZoneId === null
        ) {
          return;
        }
        setFlow({
          acknowledgedEventAt: flow.returnAcknowledgedEventAt,
          kind: 'ready',
          secondaryCopySeed: flow.secondaryCopySeed,
          uses24hourClock: flow.uses24hourClock,
          zoneId: flow.returnZoneId,
        });
        return;
      case 'select-zone':
        selectZone(event.zoneId);
        return;
      case 'acknowledge-aftermath':
        acknowledgeAftermath(event.eventAt);
        return;
      case 'manual-refresh':
        void adapters.timeZoneDataPacks
          .refresh('manual')
          .catch(() => undefined);
        return;
      case 'foreground':
        void adapters.timeZoneDataPacks
          .refresh('foreground')
          .catch(() => undefined);
    }
  }

  function onDataPackChange() {
    const next = adapters.timeZoneDataPacks.getSnapshot();
    if (next === dataPackSnapshot) return;
    dataPackSnapshot = next;
    if (flow.kind === 'confirm' || flow.kind === 'ready') publish();
  }

  function stop() {
    if (!active) return;
    active = false;
    generation += 1;
    stopDataPackSubscription?.();
    stopDataPackSubscription = null;
  }

  function start() {
    if (active) return stop;
    active = true;
    generation += 1;
    if (flow.kind !== 'loading') setFlow({ kind: 'loading' });
    dataPackSnapshot = adapters.timeZoneDataPacks.getSnapshot();
    stopDataPackSubscription =
      adapters.timeZoneDataPacks.subscribe(onDataPackChange);
    void adapters.timeZoneDataPacks.initialize().catch(() => undefined);
    void restore(generation);
    return stop;
  }

  function subscribe(listener: () => void) {
    const subscription = { listener };
    subscriptions.add(subscription);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      subscriptions.delete(subscription);
    };
  }

  return {
    dispatch,
    getSnapshot: () => snapshot,
    start,
    subscribe,
  };
}
