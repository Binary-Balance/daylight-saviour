export type ChangeReminderEnableResult =
  | { readonly kind: 'enabled' }
  | { readonly kind: 'permission-denied' }
  | { readonly kind: 'os-blocked' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed' };

export interface ChangeReminderAdapters {
  readonly enable: (
    homeTimeZone: string,
  ) => Promise<ChangeReminderEnableResult>;
  readonly openSettings: () => Promise<void>;
}
