import type { InvocationContext } from '@azure/functions';
import {
  activateSignedTimeZoneDataPackManifestBytes,
  verifySignedTimeZoneDataPackBytes,
  type ActivatedTimeZoneDataPack,
  type TrustedTimeZoneDataPackKeyRing,
} from '@daylight-saviour/contracts/node';
import {
  activateAustralianTimeZoneDataPack,
  CivilTimeDecisionUnavailableError,
  planChangeReminderDeliveries,
} from '@daylight-saviour/domain/node';

import type {
  ApnsChangeReminderResult,
  ApnsChangeReminderSender,
} from './apns-change-reminder-sender.ts';
import {
  composeApnsSender,
  composeFcmSender,
  invocation,
  invocationLogger,
  productionBoundaries,
  required,
  type ControlledReminderSmokeBoundaries,
} from './controlled-reminder-smoke.ts';
import {
  isRecord,
  parseJson,
  type FcmChangeReminderResult,
  type FcmChangeReminderSender,
} from './fcm-change-reminder-sender.ts';
import {
  createAzureReminderDispatchLedgerStore,
  type ReminderDispatchLedgerStore,
  type ReminderDispatchWindowReport,
} from './reminder-dispatch-ledger.ts';
import {
  createReminderDispatchOperation,
  effectiveExpiry,
  type ReminderDispatchContext,
  type ReminderDispatchOperationDependencies,
  type ReminderDispatchProvider,
  type ReminderDispatchProviderResult,
  type ReminderDispatchResult,
  type ReminderDispatchResultKind,
} from './reminder-dispatch.ts';
import {
  createAzureReminderSubscriptionStore,
  type ReminderSubscriptionSnapshot,
  type ReminderSubscriptionStore,
} from './reminder-subscriptions.ts';

const sendConcurrency = 8;
// Flex Consumption stops an execution after 30 minutes unless host.json sets
// functionTimeout. The zone sweeps, then settlement, may each start work for
// this long. That leaves most of the limit for the sends in flight and the
// closed-window check, and a run that settles quickly ends within the 10
// minutes a platform update waits for it. A bigger budget reaches a bigger
// zone, as each run restarts it at the first page and skips what is recorded.
const runBudgetMs = 8 * 60 * 1000;
// Each window lasts 12 hours, so a window open this long ago has closed, and its
// last run has had an hour to finish. Every run in the following 12 hours
// checks it, which outlasts a shorter pack or storage fault after it closes.
const closedWindowLookbackMs = 13 * 60 * 60 * 1000;
// ADR 0022 warns after 12 months without contact. A fixed 365 days keeps the
// rule exact in milliseconds, with no calendar arithmetic.
const warnAfterLastContactMs = 365 * 24 * 60 * 60 * 1000;
const packReadTimeoutMs = 10_000;
const maxManifestBytes = 64 * 1024;
const everyTiming = { oneDayEnabled: true, oneWeekEnabled: true };

type ReminderDispatchEvent =
  | 'reminder-dispatch-accepted'
  | 'reminder-dispatch-already-recorded'
  | 'reminder-dispatch-claimed'
  | 'reminder-dispatch-expired'
  | 'reminder-dispatch-invalid-token-cleanup-failed'
  | 'reminder-dispatch-ledger-row-invalid'
  | 'reminder-dispatch-no-event'
  | 'reminder-dispatch-not-due'
  | 'reminder-dispatch-operation-failed'
  | 'reminder-dispatch-pack-horizon-invalid'
  | 'reminder-dispatch-pack-unavailable'
  | 'reminder-dispatch-pending'
  | 'reminder-dispatch-permanent-failure'
  | 'reminder-dispatch-stale'
  | 'reminder-dispatch-time-budget-reached'
  | 'reminder-dispatch-transient-failure'
  | 'reminder-dispatch-uncertain'
  | `reminder-dispatch-window-${ReminderDispatchWindowReport}`;

const resultEvents: Record<ReminderDispatchResultKind, ReminderDispatchEvent> =
  {
    accepted: 'reminder-dispatch-accepted',
    claimed: 'reminder-dispatch-claimed',
    expired: 'reminder-dispatch-expired',
    'not-due': 'reminder-dispatch-not-due',
    pending: 'reminder-dispatch-pending',
    'permanent-failure': 'reminder-dispatch-permanent-failure',
    stale: 'reminder-dispatch-stale',
    'transient-failure': 'reminder-dispatch-transient-failure',
    uncertain: 'reminder-dispatch-uncertain',
  };

type ReminderDispatchStore = Pick<
  ReminderSubscriptionStore,
  | 'getSubscriptionSnapshot'
  | 'listZoneSubscriptionPages'
  | 'removeIfDeviceTokenAndGenerationMatches'
>;
type CountEvent = (event: ReminderDispatchEvent) => void;

interface ReminderDispatchRunDependencies {
  readonly clock: () => Date;
  readonly ledger: ReminderDispatchLedgerStore;
  readonly log: (event: string) => void;
  readonly provider: ReminderDispatchProvider;
  readonly readActivePack: () => Promise<ActivatedTimeZoneDataPack>;
  readonly subscriptions: ReminderDispatchStore;
}

export interface ReminderDispatchBoundaries extends Omit<
  ControlledReminderSmokeBoundaries,
  'createStore'
> {
  readonly createLedger: (
    environment: NodeJS.ProcessEnv,
  ) => ReminderDispatchLedgerStore;
  readonly createStore: (
    environment: NodeJS.ProcessEnv,
  ) => ReminderDispatchStore;
}

const productionDispatchBoundaries: ReminderDispatchBoundaries = {
  ...productionBoundaries,
  createLedger: createAzureReminderDispatchLedgerStore,
  createStore: createAzureReminderSubscriptionStore,
};

// The dispatcher removes a rejected token itself, fenced by the generation it
// sent. A sender's unfenced removal could delete a same-token re-registration.
const dispatcherOwnsCleanup = {
  removeIfDeviceTokenMatches: async () => 'not-found' as const,
};

/**
 * A row saved before last contact was recorded is judged on its registration
 * time. A missing time, or a date that cannot be read (NaN compares false),
 * gives no basis to warn.
 */
function isWarned(subscription: ReminderSubscriptionSnapshot, plannedAt: Date) {
  const contactAt = subscription.lastContactAt ?? subscription.registeredAt;
  return (
    contactAt !== undefined &&
    plannedAt.getTime() - contactAt.getTime() >= warnAfterLastContactMs
  );
}

function contextsFor(
  pack: ActivatedTimeZoneDataPack,
  subscription: ReminderSubscriptionSnapshot,
  plannedAt: Date,
): readonly ReminderDispatchContext[] {
  const packValidUntil = pack.coverage.validUntil;
  return planChangeReminderDeliveries(
    pack,
    subscription.homeTimeZone,
    subscription,
    plannedAt,
  ).map((delivery) => ({
    activePackValidUntil: packValidUntil,
    completeOperationDeadline: effectiveExpiry(
      new Date(delivery.deliveryWindow.endsAt),
      new Date(packValidUntil),
      new Date(delivery.changeEventAt),
    ).toISOString(),
    delivery,
    subscription,
    warned: isWarned(subscription, plannedAt),
  }));
}

function eventLog(log: (event: string) => void) {
  const counts = new Map<ReminderDispatchEvent, number>();
  const count: CountEvent = (event) => {
    counts.set(event, (counts.get(event) ?? 0) + 1);
  };
  // One line for each event, so the log stays bounded however much fails.
  // Logging as the run goes keeps counts from a run that is killed: the next
  // run counts an `expired` written by this one as `already-recorded`.
  const flush = (scope = '') => {
    for (const [event, occurrences] of counts) {
      log(`${event} ${scope}count=${occurrences}`);
    }
    counts.clear();
  };
  return { count, flush };
}

type EventLog = ReturnType<typeof eventLog>;
type BudgetSpent = () => boolean;

/** Returns a test for whether `runBudgetMs` has passed since `startedAt`. */
function budgetFrom(clock: () => Date, startedAt: Date): BudgetSpent {
  const endsAt = startedAt.getTime() + runBudgetMs;
  return () => clock().getTime() >= endsAt;
}

async function forEachBounded<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
  budgetSpent: BudgetSpent,
) {
  const remaining = items.values();
  // A spent budget starts no more items, and the ones in flight finish. The
  // rest are dropped: the next run reaches them from the first page.
  const worker = async () => {
    for (const item of remaining) {
      if (budgetSpent()) return;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: sendConcurrency }, worker));
}

async function countResult(
  work: () => Promise<ReminderDispatchResult>,
  count: CountEvent,
) {
  try {
    const result = await work();
    count(
      result.alreadyRecorded === true
        ? 'reminder-dispatch-already-recorded'
        : resultEvents[result.kind],
    );
    if (result.cleanupStatus === 'failed') {
      count('reminder-dispatch-invalid-token-cleanup-failed');
    }
  } catch {
    // One row's storage failure must not stop the rest of the page. The ledger
    // keeps it safe to retry in the next run.
    count('reminder-dispatch-operation-failed');
  }
}

/**
 * Returns whether the pages ran out, rather than a failure or the budget. An
 * empty page does not end a query, as Azure can return one with a continuation
 * token. A budget that ends just after the last page also returns false: the
 * next run finds those rows recorded and completes the zone.
 */
async function processPages<T>(
  pages: AsyncIterable<readonly T[]>,
  work: (item: T) => Promise<ReminderDispatchResult>,
  count: CountEvent,
  budgetSpent: BudgetSpent,
  afterPage?: () => void,
) {
  const stopped = () => {
    if (!budgetSpent()) return false;
    count('reminder-dispatch-time-budget-reached');
    return true;
  };
  try {
    // Checked before the first page too, so a spent budget starts no query.
    if (stopped()) return false;
    for await (const page of pages) {
      await forEachBounded(
        page,
        (item) => countResult(() => work(item), count),
        budgetSpent,
      );
      afterPage?.();
      if (stopped()) return false;
    }
    return true;
  } catch {
    count('reminder-dispatch-operation-failed');
    return false;
  }
}

function createOperation(
  dependencies: ReminderDispatchRunDependencies,
  readCurrentContext: ReminderDispatchOperationDependencies['readCurrentContext'],
) {
  return createReminderDispatchOperation({
    clock: dependencies.clock,
    ledger: dependencies.ledger,
    provider: dependencies.provider,
    readCurrentContext,
    subscriptionStore: dependencies.subscriptions,
  });
}

async function readDueZones(
  dependencies: ReminderDispatchRunDependencies,
  plannedAt: Date,
  count: CountEvent,
) {
  try {
    const pack = await dependencies.readActivePack();
    const zones = pack.zones
      .map((zone) => ({
        plans: planChangeReminderDeliveries(
          pack,
          zone.id,
          everyTiming,
          plannedAt,
        ),
        zone: zone.id,
      }))
      .filter(({ plans }) => plans.length > 0);
    if (zones.length === 0) count('reminder-dispatch-no-event');
    return { pack, zones };
  } catch (error) {
    count(
      error instanceof CivilTimeDecisionUnavailableError
        ? 'reminder-dispatch-pack-horizon-invalid'
        : 'reminder-dispatch-pack-unavailable',
    );
    return null;
  }
}

async function dispatchDueZones(
  dependencies: ReminderDispatchRunDependencies,
  { pack, zones }: NonNullable<Awaited<ReturnType<typeof readDueZones>>>,
  plannedAt: Date,
  events: EventLog,
) {
  // Rechecks plan with the run's fixed instant, so a window closing mid-run
  // reaches the dispatcher's own clock checks and expires, rather than looking
  // like a withdrawn plan. A new pack applies from the next run.
  const operation = createOperation(
    dependencies,
    async (installationId, identity) => {
      const subscription =
        await dependencies.subscriptions.getSubscriptionSnapshot(
          installationId,
        );
      if (subscription === null) return null;
      const contexts = contextsFor(pack, subscription, plannedAt);
      return (
        contexts.find(
          ({ delivery }) =>
            delivery.homeTimeZone === identity.homeTimeZone &&
            delivery.changeEventAt === identity.changeEventAt &&
            delivery.timing === identity.timing,
        ) ?? null
      );
    },
  );

  const budgetSpent = budgetFrom(dependencies.clock, plannedAt);
  // Zones run in pack order, and each run restarts every zone at its first
  // page. A zone the budget stops before it starts is recorded as incomplete
  // too, so `window-sweep-incomplete` reports the shortfall, not an outage.
  for (const { plans, zone } of zones) {
    const pages = dependencies.subscriptions.listZoneSubscriptionPages(zone);
    const reachedLastPage = await processPages(
      contextPages(pages, pack, plannedAt),
      (context) => operation.dispatch(context),
      events.count,
      budgetSpent,
    );
    try {
      for (const plan of plans) {
        await dependencies.ledger.recordSweep(plan, reachedLastPage, plannedAt);
      }
    } catch {
      events.count('reminder-dispatch-operation-failed');
    }
    events.flush(`zone=${zone} `);
  }
}

/**
 * A closed window has no plan, so an outage across all of it leaves no ledger
 * record to expire. Its sweep marker is the only sign of what happened.
 */
async function reportClosedWindows(
  dependencies: ReminderDispatchRunDependencies,
  pack: ActivatedTimeZoneDataPack,
  plannedAt: Date,
  events: EventLog,
) {
  const lookback = new Date(plannedAt.getTime() - closedWindowLookbackMs);
  try {
    const windows = pack.zones.flatMap((zone) =>
      planChangeReminderDeliveries(pack, zone.id, everyTiming, lookback),
    );
    for (const window of windows) {
      const report = await dependencies.ledger.reportClosedWindow(
        window,
        plannedAt,
      );
      if (report === null) continue;
      events.count(`reminder-dispatch-window-${report}`);
      events.flush(`zone=${window.homeTimeZone} timing=${window.timing} `);
    }
  } catch {
    // Storage, or a pack whose coverage starts inside the lookback. The next
    // run checks again.
    events.count('reminder-dispatch-operation-failed');
  }
}

async function* contextPages(
  pages: AsyncIterable<readonly ReminderSubscriptionSnapshot[]>,
  pack: ActivatedTimeZoneDataPack,
  plannedAt: Date,
): AsyncGenerator<readonly ReminderDispatchContext[], void, unknown> {
  for await (const page of pages) {
    yield page.flatMap((subscription) =>
      contextsFor(pack, subscription, plannedAt),
    );
  }
}

/** One run: dispatch due zones, then settle what planning can no longer reach. */
export async function runReminderDispatch(
  dependencies: ReminderDispatchRunDependencies,
) {
  const events = eventLog(dependencies.log);
  const plannedAt = dependencies.clock();
  const due = await readDueZones(dependencies, plannedAt, events.count);
  events.flush();
  if (due !== null) {
    await dispatchDueZones(dependencies, due, plannedAt, events);
    await reportClosedWindows(dependencies, due.pack, plannedAt, events);
  }

  const operation = createOperation(dependencies, async () => null);
  // Settlement gets a budget of its own, so zone sweeps that spent theirs
  // cannot starve it.
  const settlementStartedAt = dependencies.clock();
  await processPages(
    dependencies.ledger.listUnsettledPages(settlementStartedAt, () =>
      events.count('reminder-dispatch-ledger-row-invalid'),
    ),
    (record) => operation.settle(record),
    events.count,
    budgetFrom(dependencies.clock, settlementStartedAt),
    // Settlement runs last, so a timeout is most likely to land here.
    () => events.flush(),
  );
  events.flush();
}

function providerResult(
  result: FcmChangeReminderResult | ApnsChangeReminderResult,
): ReminderDispatchProviderResult {
  switch (result.kind) {
    case 'accepted':
    case 'not-authorized':
    case 'uncertain':
      return { kind: result.kind };
    case 'expired':
    case 'transient-rejection':
      return { kind: 'transient-failure' };
    case 'malformed-response':
      // The provider answered, but this may still be an acceptance.
      return { kind: 'uncertain' };
    case 'permanent-rejection':
      return { invalidToken: false, kind: 'permanent-failure' };
    case 'permanent-invalid-token':
      return {
        invalidToken: true,
        ...('invalidatedAt' in result
          ? { invalidatedAt: result.invalidatedAt }
          : {}),
        kind: 'permanent-failure',
      };
  }
}

export function createReminderDispatchProvider(senders: {
  readonly android: Pick<FcmChangeReminderSender, 'send'>;
  readonly ios: Pick<ApnsChangeReminderSender, 'send'>;
}): ReminderDispatchProvider {
  return {
    async send(request, authorizeBeforeExternalSend) {
      const { deviceToken, installationId, platform } = request.subscription;
      return providerResult(
        await senders[platform].send(
          { deviceToken, installationId },
          {
            changeDirection: request.changeDirection,
            changeEventAt: request.changeEventAt,
            homeTimeZone: request.homeTimeZone,
            timing: request.timing,
            warned: request.warned,
          },
          { expiresAt: request.providerExpiresAt, kind: 'until' },
          {
            authorizeBeforeExternalSend,
            completeOperationDeadline: request.completeOperationDeadline,
          },
        ),
      );
    },
  };
}

async function readBytes(
  fetch: typeof globalThis.fetch,
  url: string,
  signal: AbortSignal,
  maxBytes: number,
) {
  const response = await fetch(url, { signal });
  if (response.status !== 200) throw new Error('Pack request failed');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error('Pack response too large');
  return bytes;
}

/**
 * Reads the signed manifest and pack on every run, so a promoted pack applies
 * without a deployment. Any failure stops the run; the next one retries.
 */
export function createActivePackReader(
  manifestUrl: string,
  trustedKeys: TrustedTimeZoneDataPackKeyRing,
  fetch: typeof globalThis.fetch,
) {
  return async () => {
    const signal = AbortSignal.timeout(packReadTimeoutMs);
    const manifest = activateSignedTimeZoneDataPackManifestBytes(
      await readBytes(fetch, manifestUrl, signal, maxManifestBytes),
    );
    const bytes = await readBytes(
      fetch,
      new URL(manifest.pack.path, manifestUrl).toString(),
      signal,
      manifest.pack.byteLength,
    );
    return activateAustralianTimeZoneDataPack(
      verifySignedTimeZoneDataPackBytes(manifest, bytes, trustedKeys),
    );
  };
}

function trustedPackKeys(environment: NodeJS.ProcessEnv) {
  const keys = parseJson(
    required(environment, 'TIME_ZONE_DATA_TRUSTED_KEYS_JSON'),
  );
  if (!isRecord(keys)) throw new Error('Invalid configuration');
  return keys as TrustedTimeZoneDataPackKeyRing;
}

export function createReminderDispatchRunner(
  environment: NodeJS.ProcessEnv = process.env,
  boundaries: ReminderDispatchBoundaries = productionDispatchBoundaries,
) {
  const dependencies: ReminderDispatchRunDependencies = {
    clock: () => new Date(),
    ledger: boundaries.createLedger(environment),
    log: invocationLogger.write,
    provider: createReminderDispatchProvider({
      android: composeFcmSender(environment, boundaries, dispatcherOwnsCleanup),
      ios: composeApnsSender(environment, boundaries, dispatcherOwnsCleanup),
    }),
    readActivePack: createActivePackReader(
      required(environment, 'TIME_ZONE_DATA_MANIFEST_URL'),
      trustedPackKeys(environment),
      boundaries.fetch,
    ),
    subscriptions: boundaries.createStore(environment),
  };
  return (context: InvocationContext) =>
    invocation.run(context, () => runReminderDispatch(dependencies));
}
