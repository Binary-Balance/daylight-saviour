export type ChangeReminderEnableResult =
  | { readonly kind: 'enabled' }
  | { readonly kind: 'permission-denied' }
  | { readonly kind: 'os-blocked' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed' };

export interface StoredChangeReminderRegistration {
  readonly credential: string;
  readonly homeTimeZone: string;
  readonly installationId: string;
  readonly oneDayEnabled: boolean;
  readonly oneWeekEnabled: boolean;
  readonly version: 1;
}

export type ChangeReminderRestoreResult =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unregistered' }
  | {
      readonly kind: 'registered';
      readonly notificationPermissionGranted: boolean;
      readonly registration: StoredChangeReminderRegistration;
    };

export interface ChangeReminderAdapters {
  readonly enable: (
    homeTimeZone: string,
  ) => Promise<ChangeReminderEnableResult>;
  readonly openSettings: () => Promise<void>;
  readonly restore: () => Promise<ChangeReminderRestoreResult>;
}
