import type {
  HttpFunctionOptions,
  HttpRequest,
  HttpResponseInit,
} from '@azure/functions';

import {
  createFcmChangeReminderSender,
  createFetchFcmHttpTransport,
  type FcmChangeReminderLogEvent,
} from './fcm-change-reminder-sender.js';
import {
  createKeylessFcmAccessTokenProvider,
  type KeylessFcmFetch,
  type KeylessFcmLogEvent,
  type ManagedIdentityAssertionCredential,
} from './keyless-fcm-access-token.js';
import { createFcmTransportProof } from './fcm-transport-proof.js';
import {
  createAzureReminderSubscriptionStore,
  type ReminderSubscriptionStore,
} from './reminder-subscriptions.js';

const proofInstallationIdPattern = /^[A-Za-z0-9_-]{32,128}$/;

export type FcmRuntimeLogEvent = FcmChangeReminderLogEvent | KeylessFcmLogEvent;

interface FcmRuntimeLogger {
  readonly write: (event: FcmRuntimeLogEvent) => void;
}

interface RuntimeFetchInit {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: 'POST';
  readonly signal?: AbortSignal;
}

type RuntimeFetch = (
  input: string,
  init: RuntimeFetchInit,
) => Promise<{
  readonly status: number;
  readonly text: () => Promise<string>;
}>;

export interface FcmRuntimeDependencies {
  readonly clock?: () => Date;
  readonly createCredential?: (
    clientId: string,
  ) => ManagedIdentityAssertionCredential;
  readonly createStore?: (
    environment: NodeJS.ProcessEnv,
  ) => ReminderSubscriptionStore;
  readonly fetch?: RuntimeFetch;
  readonly logger: FcmRuntimeLogger;
  readonly timeoutMs?: number;
}

interface FcmProofConfiguration {
  readonly entraAssertionAudience: string;
  readonly installationId: string;
  readonly managedIdentityClientId: string;
  readonly projectId: string;
  readonly serviceAccountEmail: string;
  readonly workloadIdentityProvider: string;
}

function response(
  status: number,
  jsonBody: Record<string, string>,
): HttpResponseInit {
  return {
    status,
    headers: { 'Cache-Control': 'no-store' },
    jsonBody,
  };
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function proofConfiguration(
  environment: NodeJS.ProcessEnv,
): FcmProofConfiguration {
  const installationId = required(environment, 'FCM_PROOF_INSTALLATION_ID');
  if (!proofInstallationIdPattern.test(installationId)) {
    throw new Error('FCM_PROOF_INSTALLATION_ID is invalid');
  }
  return {
    entraAssertionAudience: required(
      environment,
      'FCM_ENTRA_ASSERTION_AUDIENCE',
    ),
    installationId,
    managedIdentityClientId: required(
      environment,
      'REMINDER_MANAGED_IDENTITY_CLIENT_ID',
    ),
    projectId: required(environment, 'FCM_PROJECT_ID'),
    serviceAccountEmail: required(environment, 'FCM_SERVICE_ACCOUNT_EMAIL'),
    workloadIdentityProvider: required(
      environment,
      'FCM_WORKLOAD_IDENTITY_PROVIDER',
    ),
  };
}

function defaultRuntimeFetch(
  input: string,
  init: RuntimeFetchInit,
): ReturnType<RuntimeFetch> {
  return fetch(input, init);
}

function createRuntime(
  environment: NodeJS.ProcessEnv,
  configuration: FcmProofConfiguration,
  dependencies: FcmRuntimeDependencies,
) {
  const runtimeFetch = dependencies.fetch ?? defaultRuntimeFetch;
  const store =
    dependencies.createStore?.(environment) ??
    createAzureReminderSubscriptionStore(environment);
  const accessTokenProvider = createKeylessFcmAccessTokenProvider(
    {
      entraAssertionAudience: configuration.entraAssertionAudience,
      managedIdentityClientId: configuration.managedIdentityClientId,
      serviceAccountEmail: configuration.serviceAccountEmail,
      workloadIdentityProvider: configuration.workloadIdentityProvider,
    },
    {
      ...(dependencies.clock === undefined
        ? {}
        : { clock: dependencies.clock }),
      ...(dependencies.createCredential === undefined
        ? {}
        : { createCredential: dependencies.createCredential }),
      fetch: runtimeFetch as KeylessFcmFetch,
      logger: dependencies.logger,
      ...(dependencies.timeoutMs === undefined
        ? {}
        : { timeoutMs: dependencies.timeoutMs }),
    },
  );
  const sender = createFcmChangeReminderSender(configuration.projectId, {
    accessTokenProvider,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    logger: dependencies.logger,
    subscriptionRemover: store,
    transport: createFetchFcmHttpTransport(runtimeFetch, {
      ...(dependencies.timeoutMs === undefined
        ? { timeoutMs: 10_000 }
        : { timeoutMs: dependencies.timeoutMs }),
    }),
  });
  return createFcmTransportProof(configuration.installationId, {
    registrationResolver: store,
    sender,
  });
}

export function createFcmProofHandler(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: FcmRuntimeDependencies = defaultFcmRuntimeDependencies,
) {
  return async (_request: HttpRequest): Promise<HttpResponseInit> => {
    if (
      environment.FCM_RUNTIME_ENABLED?.trim() !== 'true' ||
      environment.FCM_PROOF_ENABLED?.trim() !== 'true'
    ) {
      return response(404, { error: 'Not found' });
    }
    try {
      const configuration = proofConfiguration(environment);
      const result = await createRuntime(
        environment,
        configuration,
        dependencies,
      ).send();
      if (result === null) {
        return response(404, { error: 'Registration unavailable' });
      }
      if (result.kind === 'accepted') {
        return response(200, { outcome: 'accepted' });
      }
      if (result.kind === 'permanent-invalid-token') {
        return response(502, {
          cleanupStatus: result.cleanupStatus,
          outcome: result.kind,
        });
      }
      return response(502, { outcome: result.kind });
    } catch {
      return response(503, { error: 'Proof unavailable' });
    }
  };
}

const defaultFcmRuntimeDependencies: FcmRuntimeDependencies = {
  logger: {
    write(event) {
      console.info(event);
    },
  },
};

export const fcmProofOptions: HttpFunctionOptions = {
  authLevel: 'function',
  handler: createFcmProofHandler(),
  methods: ['POST'],
  route: 'internal/fcm-proof',
};
