import {
  parseFcmTransportProofNotification,
  type FcmTransportProofPresentation,
} from '@daylight-saviour/contracts';
import { australianEnglish as copy } from '@daylight-saviour/copy';
import { canonicalAustralianZoneId } from '@daylight-saviour/domain/australian-zone-runtime';

export const fcmTransportProofBackgroundTaskName =
  'daylight-saviour-fcm-transport-proof-v1';

export interface FcmTransportProofLocalNotificationRequest {
  readonly content: {
    readonly body: string;
    readonly data: FcmTransportProofPresentation;
    readonly sound: 'default';
    readonly title: string;
  };
  readonly trigger: { readonly channelId: 'change-reminders' };
}

export type FcmTransportProofBackgroundResult =
  | 'failed'
  | 'new-data'
  | 'no-data';

interface BackgroundTaskPayload {
  readonly data?: { readonly dataString?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseFcmTransportProofBackgroundData(value: unknown) {
  if (!isRecord(value) || !isRecord(value.data)) return null;
  const dataString = value.data.dataString;
  if (typeof dataString !== 'string' || dataString.length > 4_096) return null;
  try {
    const notification = parseFcmTransportProofNotification(
      JSON.parse(dataString),
    );
    return canonicalAustralianZoneId(notification.homeTimeZone) ===
      notification.homeTimeZone
      ? notification
      : null;
  } catch {
    return null;
  }
}

export function createFcmTransportProofBackgroundHandler({
  proofBuild,
  schedule,
}: {
  readonly proofBuild: boolean;
  readonly schedule: (
    request: FcmTransportProofLocalNotificationRequest,
  ) => Promise<unknown>;
}) {
  return async ({
    data,
    error,
  }: {
    readonly data: BackgroundTaskPayload | unknown;
    readonly error: unknown;
  }): Promise<FcmTransportProofBackgroundResult> => {
    if (!proofBuild || (error !== null && error !== undefined)) {
      return 'no-data';
    }
    const proof = parseFcmTransportProofBackgroundData(data);
    if (proof === null) return 'no-data';
    try {
      await schedule({
        content: {
          body: copy.changeReminders.transportProof.notification.body,
          data: {
            ...proof,
            presentationKind: 'local-notification',
          },
          sound: 'default',
          title: copy.changeReminders.transportProof.notification.title,
        },
        trigger: { channelId: 'change-reminders' },
      });
      return 'new-data';
    } catch {
      return 'failed';
    }
  };
}

export async function synchronizeFcmTransportProofBackgroundTask({
  available,
  isRegistered,
  proofBuild,
  register,
  unregister,
}: {
  readonly available: () => Promise<boolean>;
  readonly isRegistered: () => Promise<boolean>;
  readonly proofBuild: boolean;
  readonly register: () => Promise<unknown>;
  readonly unregister: () => Promise<unknown>;
}) {
  if (!(await available())) return;
  const registered = await isRegistered();
  if (proofBuild && !registered) await register();
  if (!proofBuild && registered) await unregister();
}
