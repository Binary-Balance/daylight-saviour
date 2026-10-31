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
// ponytail: a zone past 5,000 subscriptions never reaches its later rows, as
// each run restarts at the first page. The page-limit event is the signal to
// add a durable cursor.
const maxPagesPerQuery = 50;
const packReadTimeoutMs = 10_000;
const maxManifestBytes = 64 * 1024;
const everyTiming = { oneDayEnabled: true, oneWeekEnabled: true };

type ReminderDispatchEvent =
  | 'reminder-dispatch-accepted'
  | 'reminder-dispatch-already-recorded'
  | 'reminder-dispatch-claimed'
  | 'reminder-dispatch-expired'
  | 'reminder-dispatch-invalid-token-cleanup-failed'
  | 'reminder-dispatch-no-event'
  | 'reminder-dispatch-not-due'
  | 'reminder-dispatch-operation-failed'
  | 'reminder-dispatch-pack-horizon-invalid'
  | 'reminder-dispatch-pack-unavailable'
  | 'reminder-dispatch-page-limit-reached'
  | 'reminder-dispatch-pending'
  | 'reminder-dispatch-permanent-failure'
  | 'reminder-dispatch-stale'
  | 'reminder-dispatch-transient-failure'
  | 'reminder-dispatch-uncertain';

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
  }));
}

async function forEachBounded<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
) {
  const remaining = items.values();
  const worker = async () => {
    for (const item of remaining) await work(item);
  };
  await Promise.all(Array.from({ length: sendConcurrency }, worker));
}

async function countResult(
  work: Promise<ReminderDispatchResult>,
  count: CountEvent,
) {
  try {
    const result = await work;
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

async function processPages<T>(
  pages: AsyncIterable<readonly T[]>,
  work: (item: T) => Promise<ReminderDispatchResult>,
  count: CountEvent,
) {
  let pagesRead = 0;
  try {
    for await (const page of pages) {
      await forEachBounded(page, (item) => countResult(work(item), count));
      pagesRead += 1;
      if (pagesRead === maxPagesPerQuery) {
        count('reminder-dispatch-page-limit-reached');
        return;
      }
    }
  } catch {
    count('reminder-dispatch-operation-failed');
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
      .map((zone) => zone.id)
      .filter(
        (zone) =>
          planChangeReminderDeliveries(pack, zone, everyTiming, plannedAt)
            .length > 0,
      );
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
  count: CountEvent,
) {
  const plannedAt = dependencies.clock();
  const due = await readDueZones(dependencies, plannedAt, count);
  if (due === null) return;
  const { pack, zones } = due;
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

  for (const zone of zones) {
    const pages = dependencies.subscriptions.listZoneSubscriptionPages(zone);
    await processPages(
      contextPages(pages, pack, plannedAt),
      (context) => operation.dispatch(context),
      count,
    );
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
  const counts = new Map<ReminderDispatchEvent, number>();
  const count: CountEvent = (event) => {
    counts.set(event, (counts.get(event) ?? 0) + 1);
  };

  await dispatchDueZones(dependencies, count);
  const operation = createOperation(dependencies, async () => null);
  await processPages(
    dependencies.ledger.listUnsettledPages(dependencies.clock()),
    (record) => operation.settle(record),
    count,
  );

  // One line for each event, so the log stays bounded however much fails.
  for (const [event, occurrences] of counts) {
    dependencies.log(`${event} count=${occurrences}`);
  }
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
