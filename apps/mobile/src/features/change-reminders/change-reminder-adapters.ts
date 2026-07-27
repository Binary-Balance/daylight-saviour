export type ChangeReminderEnableResult =
  | { readonly kind: 'enabled' }
  | { readonly kind: 'permission-denied' }
  | { readonly kind: 'os-blocked' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed' };

interface StoredChangeReminderBase {
  readonly attemptGeneration: number;
  readonly deviceToken: string;
  readonly homeTimeZone: string;
  readonly oneDayEnabled: boolean;
  readonly oneWeekEnabled: boolean;
  readonly registrationRequestId: string;
  readonly version: 3;
}

export interface StoredChangeReminderPending extends StoredChangeReminderBase {
  readonly state: 'pending';
}

export interface StoredChangeReminderRegistration extends StoredChangeReminderBase {
  readonly credential: string;
  readonly installationId: string;
  readonly state: 'registered';
}

export interface StoredLegacyChangeReminderRegistration {
  readonly attemptGeneration: number;
  readonly credential: string;
  readonly homeTimeZone: string;
  readonly installationId: string;
  readonly oneDayEnabled: boolean;
  readonly oneWeekEnabled: boolean;
  readonly registrationRequestId: string;
  readonly state: 'registered';
  readonly version: 2;
}

export interface StoredLegacyChangeReminderPending {
  readonly attemptGeneration: number;
  readonly homeTimeZone: string;
  readonly oneDayEnabled: boolean;
  readonly oneWeekEnabled: boolean;
  readonly registrationRequestId: string;
  readonly state: 'pending';
  readonly version: 2;
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
      readonly registration:
        | StoredChangeReminderRegistration
        | StoredLegacyChangeReminderRegistration;
    };

export type StoredChangeReminderState =
  | StoredChangeReminderPending
  | StoredChangeReminderRegistration
  | StoredLegacyChangeReminderPending
  | StoredLegacyChangeReminderRegistration;

export interface ChangeReminderAdapters {
  readonly enable: (
    homeTimeZone: string,
  ) => Promise<ChangeReminderEnableResult>;
  readonly openSettings: () => Promise<void>;
  readonly restore: () => Promise<ChangeReminderRestoreResult>;
  /** Starts one native token listener; callers must remove it on unmount. */
  readonly startTokenRefresh: (homeTimeZone: string) => () => void;
}
