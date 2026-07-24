import { createHash, randomBytes } from 'node:crypto';
import { DefaultAzureCredential } from '@azure/identity';
import { TableClient } from '@azure/data-tables';
import type {
  HttpFunctionOptions,
  HttpRequest,
  HttpResponseInit,
} from '@azure/functions';
import { parseReminderSubscriptionRegistration } from '@daylight-saviour/contracts/reminder-subscription-runtime';

const maxRequestBytes = 8 * 1024;
const throttleWindowMs = 10 * 60 * 1000;
const throttleLimit = 5;
const australianZones = new Set([
  'Australia/Sydney',
  'Australia/Broken_Hill',
  'Australia/Melbourne',
  'Australia/Hobart',
  'Australia/Brisbane',
  'Australia/Lindeman',
  'Australia/Adelaide',
  'Australia/Darwin',
  'Australia/Perth',
  'Australia/Eucla',
  'Australia/Lord_Howe',
  'Antarctica/Macquarie',
  'Pacific/Norfolk',
  'Indian/Christmas',
  'Indian/Cocos',
  'Antarctica/Casey',
  'Antarctica/Davis',
  'Antarctica/Mawson',
]);

interface ReminderSubscriptionRegistration {
  readonly deviceToken: string;
  readonly homeTimeZone: string;
  readonly oneDayEnabled: boolean;
  readonly oneWeekEnabled: boolean;
  readonly platform: 'android' | 'ios';
}

export interface ReminderSubscriptionStore {
  readonly saveSubscription: (record: {
    readonly credentialHash: string;
    readonly deviceToken: string;
    readonly homeTimeZone: string;
    readonly installationId: string;
    readonly oneDayEnabled: boolean;
    readonly oneWeekEnabled: boolean;
    readonly platform: string;
  }) => Promise<void>;
  readonly takeSourceAllowance: (
    sourceHash: string,
    now: Date,
  ) => Promise<boolean>;
}

export function opaqueRandomValue() {
  return randomBytes(32).toString('base64url');
}

export function hashOpaqueValue(value: string) {
  return createHash('sha256').update(value).digest('base64url');
}

export function sourceAddressHash(request: HttpRequest) {
  const forwarded = request.headers.get('x-forwarded-for');
  const source = forwarded?.split(',')[0]?.trim() || 'unavailable';
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

async function readRegistration(request: HttpRequest) {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new ReminderSubscriptionRequestError(
      415,
      'Expected application/json',
    );
  }
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxRequestBytes) {
    throw new ReminderSubscriptionRequestError(413, 'Request too large');
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > maxRequestBytes) {
    throw new ReminderSubscriptionRequestError(413, 'Request too large');
  }
  try {
    const input = parseReminderSubscriptionRegistration(
      JSON.parse(text),
    ) as ReminderSubscriptionRegistration;
    if (!australianZones.has(input.homeTimeZone)) throw new Error();
    return input;
  } catch {
    throw new ReminderSubscriptionRequestError(
      400,
      'Invalid registration request',
    );
  }
}

class ReminderSubscriptionRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
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
    const installationId = opaqueRandomValue();
    const credential = opaqueRandomValue();
    await store.saveSubscription({
      ...registration,
      credentialHash: hashOpaqueValue(credential),
      installationId,
    });
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

export function createAzureReminderSubscriptionStore(): ReminderSubscriptionStore {
  const accountName = process.env.REMINDER_STORAGE_ACCOUNT_NAME;
  if (accountName === undefined || accountName.length === 0) {
    throw new Error('REMINDER_STORAGE_ACCOUNT_NAME is required');
  }
  const endpoint = `https://${accountName}.table.core.windows.net`;
  const credential = new DefaultAzureCredential();
  const subscriptions = new TableClient(
    endpoint,
    'ReminderSubscriptions',
    credential,
  );
  const throttles = new TableClient(
    endpoint,
    'ReminderRegistrationThrottle',
    credential,
  );
  return {
    async saveSubscription(record) {
      await subscriptions.createEntity({
        partitionKey: record.homeTimeZone,
        rowKey: record.installationId,
        credentialHash: record.credentialHash,
        deviceToken: record.deviceToken,
        oneDayEnabled: record.oneDayEnabled,
        oneWeekEnabled: record.oneWeekEnabled,
        platform: record.platform,
      });
    },
    async takeSourceAllowance(sourceHash, now) {
      const window = Math.floor(now.getTime() / throttleWindowMs);
      const rowKey = String(window);
      try {
        const entity = await throttles.getEntity<{ count: number }>(
          sourceHash,
          rowKey,
        );
        if (entity.count >= throttleLimit) return false;
        await throttles.updateEntity(
          { partitionKey: sourceHash, rowKey, count: entity.count + 1 },
          'Replace',
        );
        return true;
      } catch {
        await throttles.createEntity({
          partitionKey: sourceHash,
          rowKey,
          count: 1,
        });
        return true;
      }
    },
  };
}

export const reminderSubscriptionOptions: HttpFunctionOptions = {
  authLevel: 'anonymous' as const,
  handler: (request: HttpRequest) =>
    registerReminderSubscription(
      request,
      createAzureReminderSubscriptionStore(),
    ),
  methods: ['POST'],
  route: 'reminder-subscriptions',
};
