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

export interface ChangeReminderAdapters {
  readonly enable: (
    homeTimeZone: string,
  ) => Promise<ChangeReminderEnableResult>;
  readonly load: () => Promise<StoredChangeReminderRegistration | null>;
  readonly openSettings: () => Promise<void>;
}
