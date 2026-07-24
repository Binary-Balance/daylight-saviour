export type ChangeReminderEnableResult =
  | { readonly kind: 'enabled' }
  | { readonly kind: 'permission-denied' }
  | { readonly kind: 'os-blocked' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed' };

interface StoredChangeReminderBase {
  readonly attemptGeneration: number;
  readonly homeTimeZone: string;
  readonly oneDayEnabled: boolean;
  readonly oneWeekEnabled: boolean;
  readonly registrationRequestId: string;
  readonly version: 2;
}

export interface StoredChangeReminderPending extends StoredChangeReminderBase {
  readonly state: 'pending';
}

export interface StoredChangeReminderRegistration extends StoredChangeReminderBase {
  readonly credential: string;
  readonly installationId: string;
  readonly state: 'registered';
}

export type ChangeReminderRestoreResult =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unregistered' }
  | {
      readonly homeTimeZone: string;
      readonly kind: 'pending';
    }
  | {
      readonly kind: 'registered';
      readonly notificationPermissionGranted: boolean;
      readonly registration: StoredChangeReminderRegistration;
    };

export type StoredChangeReminderState =
  | StoredChangeReminderPending
  | StoredChangeReminderRegistration;

export interface ChangeReminderAdapters {
  readonly enable: (
    homeTimeZone: string,
  ) => Promise<ChangeReminderEnableResult>;
  readonly openSettings: () => Promise<void>;
  readonly restore: () => Promise<ChangeReminderRestoreResult>;
}
