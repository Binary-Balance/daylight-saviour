import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { ManagedIdentityCredential } from '@azure/identity';
import { odata, TableClient } from '@azure/data-tables';
import type {
  HttpFunctionOptions,
  HttpRequest,
  HttpResponseInit,
  TimerFunctionOptions,
} from '@azure/functions';
import {
  parseReminderSubscriptionRegistration,
  parseReminderSubscriptionUpdate,
} from '@daylight-saviour/contracts/reminder-subscription-runtime';
import { canonicalAustralianZoneId } from '@daylight-saviour/domain/australian-zone-runtime';

const maxRequestBytes = 8 * 1024;
const throttleWindowMs = 10 * 60 * 1000;
const throttleRetentionMs = 30 * 24 * 60 * 60 * 1000;
const throttleLimit = 5;
const tableMutationRetryLimit = 12;
const subscriptionPartitionKey = 'subscriptions-v1';

interface ReminderSubscriptionRegistration {
  readonly attemptGeneration: number;
  readonly deviceToken: string;
  readonly homeTimeZone: string;
  readonly oneDayEnabled: boolean;
  readonly oneWeekEnabled: boolean;
  readonly platform: 'android' | 'ios';
  readonly registrationRequestId: string;
}

type ReminderSubscriptionUpdate = Omit<
  ReminderSubscriptionRegistration,
  'registrationRequestId'
>;

interface ReminderSubscriptionRecord extends Omit<
  ReminderSubscriptionRegistration,
  'registrationRequestId'
> {
  readonly credentialHash: string;
  readonly installationId: string;
  readonly registeredAt: Date;
}

interface SubscriptionEntity {
  readonly attemptGeneration: number;
  readonly credentialHash?: string | undefined;
  readonly deviceToken: string;
  readonly etag: string;
  readonly homeTimeZone?: string | undefined;
  readonly oneDayEnabled?: boolean | undefined;
  readonly oneWeekEnabled?: boolean | undefined;
  readonly platform?: 'android' | 'ios' | undefined;
  readonly partitionKey: string;
  readonly registeredAt?: Date | undefined;
  readonly rowKey: string;
}

interface SubscriptionTable {
  readonly create: (entity: Record<string, unknown>) => Promise<void>;
  readonly delete: (
    partitionKey: string,
    rowKey: string,
    etag: string,
  ) => Promise<void>;
  readonly get: (
    partitionKey: string,
    rowKey: string,
  ) => Promise<SubscriptionEntity>;
  readonly replace: (
    entity: Record<string, unknown>,
    etag: string,
  ) => Promise<void>;
}

interface ThrottleEntity {
  readonly count: number;
  readonly etag: string;
  readonly partitionKey: string;
  readonly rowKey: string;
}

interface ThrottleTable {
  readonly create: (entity: Record<string, unknown>) => Promise<void>;
  readonly delete: (partitionKey: string, rowKey: string) => Promise<void>;
  readonly get: (
    partitionKey: string,
    rowKey: string,
  ) => Promise<ThrottleEntity>;
  readonly listExpired: (now: Date) => AsyncIterable<ThrottleEntity>;
  readonly replace: (
    entity: Record<string, unknown>,
    etag: string,
  ) => Promise<void>;
}

interface AzureReminderSubscriptionStoreDependencies {
  readonly createCredential: (
    clientId: string,
  ) => Pick<ManagedIdentityCredential, 'getToken'>;
  readonly createTableClient: (
    endpoint: string,
    tableName: string,
    credential: Pick<ManagedIdentityCredential, 'getToken'>,
  ) => TableClient;
}

export interface ReminderSubscriptionStore {
  readonly removeIfDeviceTokenMatches: (
    subscription: Pick<
      StoredReminderSubscription,
      'deviceToken' | 'installationId'
    >,
    invalidatedAt?: Date,
  ) => Promise<'removed' | 'not-found' | 'token-replaced'>;
  readonly getSubscription: (
    installationId: string,
  ) => Promise<StoredReminderSubscription | null>;
  readonly purgeExpiredThrottleRecords: (now: Date) => Promise<void>;
  readonly createSubscription: (
    record: ReminderSubscriptionRecord,
  ) => Promise<'accepted' | 'stale' | 'conflict'>;
  readonly updateSubscription: (
    record: Omit<ReminderSubscriptionRecord, 'credentialHash'>,
    credentialHash: string,
  ) => Promise<'accepted' | 'not-found' | 'stale' | 'unauthorized'>;
  readonly takeInstallationAllowance: (
    installationId: string,
    now: Date,
  ) => Promise<boolean>;
  readonly takeSourceAllowance: (
    sourceHash: string,
    now: Date,
  ) => Promise<boolean>;
}

/** Stored platform is selected only after the owner-gated smoke request arrives. */
export interface StoredReminderSubscription {
  readonly deviceToken: string;
  readonly installationId: string;
  readonly platform: 'android' | 'ios';
}

export function hashOpaqueValue(value: string) {
  return createHash('sha256').update(value).digest('base64url');
}

export function opaqueRandomValue() {
  return randomBytes(32).toString('base64url');
}

function equalOpaqueValues(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function deriveInstallationId(registrationRequestId: string) {
  return hashOpaqueValue(
    `daylight-saviour:reminder-registration:v1:${registrationRequestId}`,
  );
}

export function normalizeClientAddress(value: string | null) {
  if (value === null) return null;
  let candidate = value.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(candidate);
  if (bracketed?.[1] !== undefined) {
    candidate = bracketed[1];
  } else {
    const ipv4WithPort = /^([^:]+):\d+$/.exec(candidate);
    if (ipv4WithPort?.[1] !== undefined && isIP(ipv4WithPort[1]) === 4) {
      candidate = ipv4WithPort[1];
    }
  }

  const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(candidate);
  if (mappedIpv4?.[1] !== undefined && isIP(mappedIpv4[1]) === 4) {
    return mappedIpv4[1];
  }
  if (isIP(candidate) === 4) return candidate;
  if (isIP(candidate) === 6) {
    const hostname = new URL(`http://[${candidate}]/`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  }
  return null;
}

export function sourceAddressHash(request: HttpRequest) {
  const source = normalizeClientAddress(request.headers.get('client-ip'));
  if (source === null) {
    throw new Error('Trusted client address unavailable');
  }
  return hashOpaqueValue(source);
}

function response(
  status: number,
  message: string,
  retryAfter?: number,
): HttpResponseInit {
  return {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...(retryAfter === undefined
        ? {}
        : { 'Retry-After': String(retryAfter) }),
    },
    jsonBody: { error: message },
  };
}

class ReminderSubscriptionRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBoundedBody(request: HttpRequest) {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new ReminderSubscriptionRequestError(400, 'Invalid Content-Length');
    }
    if (length > maxRequestBytes) {
      throw new ReminderSubscriptionRequestError(413, 'Request too large');
    }
  }

  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        throw new ReminderSubscriptionRequestError(400, 'Invalid request body');
      }
      total += chunk.value.byteLength;
      if (total > maxRequestBytes) {
        await reader.cancel();
        throw new ReminderSubscriptionRequestError(413, 'Request too large');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new ReminderSubscriptionRequestError(400, 'Invalid request body');
  }
}

async function readRegistration(request: HttpRequest) {
  const contentType = request.headers.get('content-type')?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new ReminderSubscriptionRequestError(
      415,
      'Expected application/json',
    );
  }
  const text = await readBoundedBody(request);
  try {
    const input = parseReminderSubscriptionRegistration(
      JSON.parse(text),
    ) as ReminderSubscriptionRegistration;
    if (canonicalAustralianZoneId(input.homeTimeZone) === null)
      throw new Error();
    return input;
  } catch {
    throw new ReminderSubscriptionRequestError(
      400,
      'Invalid registration request',
    );
  }
}

async function readUpdate(request: HttpRequest) {
  const contentType = request.headers.get('content-type')?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new ReminderSubscriptionRequestError(
      415,
      'Expected application/json',
    );
  }
  try {
    const input = parseReminderSubscriptionUpdate(
      JSON.parse(await readBoundedBody(request)),
    ) as ReminderSubscriptionUpdate;
    if (canonicalAustralianZoneId(input.homeTimeZone) === null)
      throw new Error();
    return input;
  } catch (error) {
    if (error instanceof ReminderSubscriptionRequestError) throw error;
    throw new ReminderSubscriptionRequestError(
      400,
      'Invalid registration update',
    );
  }
}

function readBearerCredential(request: HttpRequest) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
    request.headers.get('authorization') ?? '',
  );
  return match?.[1] ?? null;
}

function readInstallationId(value: string | undefined) {
  return value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value)
    ? value
    : null;
}

export async function registerReminderSubscription(
  request: HttpRequest,
  store: ReminderSubscriptionStore,
  now = new Date(),
): Promise<HttpResponseInit> {
  try {
    const sourceHash = sourceAddressHash(request);
    if (!(await store.takeSourceAllowance(sourceHash, now))) {
      return response(
        429,
        'Try again later',
        Math.ceil(throttleWindowMs / 1000),
      );
    }
    const registration = await readRegistration(request);
    const installationId = deriveInstallationId(
      registration.registrationRequestId,
    );
    const credential = opaqueRandomValue();
    const saveResult = await store.createSubscription({
      attemptGeneration: registration.attemptGeneration,
      credentialHash: hashOpaqueValue(credential),
      deviceToken: registration.deviceToken,
      homeTimeZone: registration.homeTimeZone,
      installationId,
      oneDayEnabled: registration.oneDayEnabled,
      oneWeekEnabled: registration.oneWeekEnabled,
      platform: registration.platform,
      registeredAt: now,
    });
    if (saveResult === 'stale') {
      return response(409, 'Registration attempt superseded');
    }
    if (saveResult === 'conflict') {
      return response(409, 'Registration unavailable');
    }
    return {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: { credential, installationId },
    };
  } catch (error) {
    if (error instanceof ReminderSubscriptionRequestError) {
      return response(error.status, error.message);
    }
    return response(503, 'Registration unavailable');
  }
}

export async function updateReminderSubscription(
  request: HttpRequest,
  store: ReminderSubscriptionStore,
  installationId: string | undefined,
  now = new Date(),
): Promise<HttpResponseInit> {
  try {
    const credential = readBearerCredential(request);
    const target = readInstallationId(installationId);
    if (credential === null || target === null)
      return response(401, 'Unauthorized');
    const sourceHash = sourceAddressHash(request);
    if (!(await store.takeSourceAllowance(sourceHash, now))) {
      return response(
        429,
        'Try again later',
        Math.ceil(throttleWindowMs / 1000),
      );
    }
    if (!(await store.takeInstallationAllowance(target, now))) {
      return response(
        429,
        'Try again later',
        Math.ceil(throttleWindowMs / 1000),
      );
    }
    const update = await readUpdate(request);
    const result = await store.updateSubscription(
      {
        ...update,
        installationId: target,
        registeredAt: now,
      },
      hashOpaqueValue(credential),
    );
    if (result === 'not-found')
      return response(404, 'Registration unavailable');
    if (result === 'unauthorized') return response(401, 'Unauthorized');
    if (result === 'stale') return response(409, 'Update superseded');
    return { status: 204, headers: { 'Cache-Control': 'no-store' } };
  } catch (error) {
    if (error instanceof ReminderSubscriptionRequestError) {
      return response(error.status, error.message);
    }
    return response(503, 'Registration unavailable');
  }
}

function statusCode(error: unknown) {
  if (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
  ) {
    return error.statusCode;
  }
  return undefined;
}

function preservesPostInvalidationRegistration(
  registeredAt: Date | undefined,
  invalidatedAt: Date | undefined,
) {
  if (invalidatedAt === undefined) return false;
  const invalidation = invalidatedAt.getTime();
  const registration = registeredAt?.getTime();
  return (
    !Number.isFinite(invalidation) ||
    registration === undefined ||
    !Number.isFinite(registration) ||
    registration > invalidation
  );
}

export function createTableReminderSubscriptionStore(
  subscriptions: SubscriptionTable,
  throttles: ThrottleTable,
): ReminderSubscriptionStore {
  return {
    async getSubscription(installationId) {
      try {
        const existing = await subscriptions.get(
          subscriptionPartitionKey,
          installationId,
        );
        return existing.platform === 'android' || existing.platform === 'ios'
          ? {
              deviceToken: existing.deviceToken,
              installationId,
              platform: existing.platform,
            }
          : null;
      } catch (error) {
        if (statusCode(error) === 404) return null;
        throw error;
      }
    },
    async removeIfDeviceTokenMatches(subscription, invalidatedAt) {
      for (let attempt = 0; attempt < tableMutationRetryLimit; attempt += 1) {
        let existing: SubscriptionEntity;
        try {
          existing = await subscriptions.get(
            subscriptionPartitionKey,
            subscription.installationId,
          );
        } catch (error) {
          if (statusCode(error) === 404) return 'not-found';
          throw error;
        }
        if (existing.deviceToken !== subscription.deviceToken) {
          return 'token-replaced';
        }
        if (
          preservesPostInvalidationRegistration(
            existing.registeredAt,
            invalidatedAt,
          )
        ) {
          return 'token-replaced';
        }
        try {
          await subscriptions.delete(
            subscriptionPartitionKey,
            subscription.installationId,
            existing.etag,
          );
          return 'removed';
        } catch (error) {
          const deleteStatus = statusCode(error);
          if (
            deleteStatus !== 404 &&
            deleteStatus !== 409 &&
            deleteStatus !== 412
          ) {
            throw error;
          }
        }
      }
      throw new Error('Subscription removal contention exceeded retry limit');
    },
    async createSubscription(record) {
      const entity = {
        partitionKey: subscriptionPartitionKey,
        rowKey: record.installationId,
        attemptGeneration: record.attemptGeneration,
        credentialHash: record.credentialHash,
        deviceToken: record.deviceToken,
        homeTimeZone: record.homeTimeZone,
        oneDayEnabled: record.oneDayEnabled,
        oneWeekEnabled: record.oneWeekEnabled,
        platform: record.platform,
        registeredAt: record.registeredAt,
      };

      for (let attempt = 0; attempt < tableMutationRetryLimit; attempt += 1) {
        let existing: SubscriptionEntity;
        try {
          existing = await subscriptions.get(
            subscriptionPartitionKey,
            record.installationId,
          );
        } catch (error) {
          if (statusCode(error) !== 404) throw error;
          try {
            await subscriptions.create(entity);
            return 'accepted';
          } catch (createError) {
            if (statusCode(createError) !== 409) throw createError;
            continue;
          }
        }
        const sameInitialFields =
          existing.deviceToken === record.deviceToken &&
          existing.homeTimeZone === record.homeTimeZone &&
          existing.oneDayEnabled === record.oneDayEnabled &&
          existing.oneWeekEnabled === record.oneWeekEnabled &&
          existing.platform === record.platform;
        if (!sameInitialFields) return 'conflict';
        if (existing.attemptGeneration >= record.attemptGeneration) {
          return 'stale';
        }
        try {
          await subscriptions.replace(entity, existing.etag);
          return 'accepted';
        } catch (updateError) {
          const updateStatus = statusCode(updateError);
          if (updateStatus !== 409 && updateStatus !== 412) throw updateError;
        }
      }
      throw new Error('Subscription creation contention exceeded retry limit');
    },
    async updateSubscription(record, credentialHash) {
      for (let attempt = 0; attempt < tableMutationRetryLimit; attempt += 1) {
        let existing: SubscriptionEntity;
        try {
          existing = await subscriptions.get(
            subscriptionPartitionKey,
            record.installationId,
          );
        } catch (error) {
          if (statusCode(error) === 404) return 'not-found';
          throw error;
        }
        if (
          existing.credentialHash === undefined ||
          !equalOpaqueValues(existing.credentialHash, credentialHash)
        ) {
          return 'unauthorized';
        }
        if (existing.attemptGeneration >= record.attemptGeneration)
          return 'stale';
        try {
          await subscriptions.replace(
            {
              partitionKey: subscriptionPartitionKey,
              rowKey: record.installationId,
              ...record,
              credentialHash: existing.credentialHash,
            },
            existing.etag,
          );
          return 'accepted';
        } catch (error) {
          const updateStatus = statusCode(error);
          if (updateStatus !== 409 && updateStatus !== 412) throw error;
        }
      }
      throw new Error('Subscription update contention exceeded retry limit');
    },
    async takeSourceAllowance(sourceHash, now) {
      return takeThrottleAllowance(
        throttles,
        hashOpaqueValue(`daylight-saviour:reminder-source:v1:${sourceHash}`),
        now,
      );
    },
    async takeInstallationAllowance(installationId, now) {
      return takeThrottleAllowance(
        throttles,
        hashOpaqueValue(
          `daylight-saviour:reminder-installation:v1:${installationId}`,
        ),
        now,
      );
    },
    async purgeExpiredThrottleRecords(now) {
      for await (const entity of throttles.listExpired(now)) {
        try {
          await throttles.delete(entity.partitionKey, entity.rowKey);
        } catch (error) {
          if (statusCode(error) !== 404) throw error;
        }
      }
    },
  };
}

async function takeThrottleAllowance(
  throttles: ThrottleTable,
  subjectHash: string,
  now: Date,
) {
  const window = Math.floor(now.getTime() / throttleWindowMs);
  const rowKey = String(window);
  const expiresAt = new Date(window * throttleWindowMs + throttleRetentionMs);

  for (let attempt = 0; attempt < tableMutationRetryLimit; attempt += 1) {
    let entity: ThrottleEntity;
    try {
      entity = await throttles.get(subjectHash, rowKey);
    } catch (error) {
      if (statusCode(error) !== 404) throw error;
      try {
        await throttles.create({
          partitionKey: subjectHash,
          rowKey,
          count: 1,
          expiresAt,
        });
        return true;
      } catch (createError) {
        if (statusCode(createError) !== 409) throw createError;
        continue;
      }
    }

    if (entity.count >= throttleLimit) return false;
    try {
      await throttles.replace(
        {
          partitionKey: subjectHash,
          rowKey,
          count: entity.count + 1,
          expiresAt,
        },
        entity.etag,
      );
      return true;
    } catch (updateError) {
      const updateStatus = statusCode(updateError);
      if (updateStatus !== 409 && updateStatus !== 412) throw updateError;
    }
  }
  throw new Error('Throttle update contention exceeded retry limit');
}

const azureReminderSubscriptionStoreDependencies: AzureReminderSubscriptionStoreDependencies =
  {
    createCredential: (clientId) => new ManagedIdentityCredential(clientId),
    createTableClient: (endpoint, tableName, credential) =>
      new TableClient(endpoint, tableName, credential),
  };

export function createAzureReminderSubscriptionStore(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: AzureReminderSubscriptionStoreDependencies = azureReminderSubscriptionStoreDependencies,
): ReminderSubscriptionStore {
  const accountName = environment.REMINDER_STORAGE_ACCOUNT_NAME?.trim();
  if (accountName === undefined || accountName.length === 0) {
    throw new Error('REMINDER_STORAGE_ACCOUNT_NAME is required');
  }
  const managedIdentityClientId =
    environment.REMINDER_MANAGED_IDENTITY_CLIENT_ID?.trim();
  if (
    managedIdentityClientId === undefined ||
    managedIdentityClientId.length === 0
  ) {
    throw new Error('REMINDER_MANAGED_IDENTITY_CLIENT_ID is required');
  }
  const endpoint = `https://${accountName}.table.core.windows.net`;
  const credential = dependencies.createCredential(managedIdentityClientId);
  const subscriptions = dependencies.createTableClient(
    endpoint,
    'ReminderSubscriptions',
    credential,
  );
  const throttles = dependencies.createTableClient(
    endpoint,
    'ReminderRegistrationThrottle',
    credential,
  );
  return createTableReminderSubscriptionStore(
    {
      create: async (entity) => {
        await subscriptions.createEntity(entity as never);
      },
      get: async (partitionKey, rowKey) => {
        const entity = await subscriptions.getEntity<{
          attemptGeneration: number;
          credentialHash: string;
          deviceToken: string;
          homeTimeZone: string;
          oneDayEnabled: boolean;
          oneWeekEnabled: boolean;
          platform: 'android' | 'ios';
          registeredAt?: unknown;
        }>(partitionKey, rowKey);
        if (typeof entity.deviceToken !== 'string') {
          throw new Error('Stored subscription record is invalid');
        }
        return {
          attemptGeneration: entity.attemptGeneration,
          credentialHash:
            typeof entity.credentialHash === 'string'
              ? entity.credentialHash
              : undefined,
          deviceToken: entity.deviceToken,
          etag: entity.etag,
          homeTimeZone:
            typeof entity.homeTimeZone === 'string'
              ? entity.homeTimeZone
              : undefined,
          oneDayEnabled:
            typeof entity.oneDayEnabled === 'boolean'
              ? entity.oneDayEnabled
              : undefined,
          oneWeekEnabled:
            typeof entity.oneWeekEnabled === 'boolean'
              ? entity.oneWeekEnabled
              : undefined,
          partitionKey,
          platform:
            entity.platform === 'android' || entity.platform === 'ios'
              ? entity.platform
              : undefined,
          registeredAt:
            entity.registeredAt instanceof Date
              ? entity.registeredAt
              : undefined,
          rowKey,
        };
      },
      replace: async (entity, etag) => {
        await subscriptions.updateEntity(entity as never, 'Replace', { etag });
      },
      delete: async (partitionKey, rowKey, etag) => {
        await subscriptions.deleteEntity(partitionKey, rowKey, { etag });
      },
    },
    {
      create: async (entity) => {
        await throttles.createEntity(entity as never);
      },
      delete: async (partitionKey, rowKey) => {
        await throttles.deleteEntity(partitionKey, rowKey);
      },
      get: async (partitionKey, rowKey) => {
        const entity = await throttles.getEntity<{ count: number }>(
          partitionKey,
          rowKey,
        );
        return {
          count: entity.count,
          etag: entity.etag,
          partitionKey,
          rowKey,
        };
      },
      listExpired: (now) =>
        throttles.listEntities<{ count: number }>({
          queryOptions: { filter: odata`expiresAt lt ${now}` },
        }) as AsyncIterable<ThrottleEntity>,
      replace: async (entity, etag) => {
        await throttles.updateEntity(entity as never, 'Replace', { etag });
      },
    },
  );
}

export function createReminderSubscriptionHandler(
  createStore: () => ReminderSubscriptionStore = createAzureReminderSubscriptionStore,
) {
  return async (request: HttpRequest): Promise<HttpResponseInit> => {
    try {
      return await registerReminderSubscription(request, createStore());
    } catch {
      return response(503, 'Registration unavailable');
    }
  };
}

export function createReminderSubscriptionUpdateHandler(
  createStore: () => ReminderSubscriptionStore = createAzureReminderSubscriptionStore,
) {
  return async (request: HttpRequest): Promise<HttpResponseInit> =>
    updateReminderSubscription(
      request,
      createStore(),
      request.params.installationId,
    );
}

export const reminderSubscriptionOptions: HttpFunctionOptions = {
  authLevel: 'anonymous' as const,
  handler: createReminderSubscriptionHandler(),
  methods: ['POST'],
  route: 'reminder-subscriptions',
};

export const reminderSubscriptionUpdateOptions: HttpFunctionOptions = {
  authLevel: 'anonymous' as const,
  handler: createReminderSubscriptionUpdateHandler(),
  methods: ['PUT'],
  route: 'reminder-subscriptions/{installationId}',
};

export const reminderThrottleCleanupOptions: TimerFunctionOptions = {
  handler: async () => {
    await createAzureReminderSubscriptionStore().purgeExpiredThrottleRecords(
      new Date(),
    );
  },
  schedule: '0 17 3 * * *',
  useMonitor: true,
};
