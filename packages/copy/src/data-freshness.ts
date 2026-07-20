export type DataFreshnessState =
  | 'checking'
  | 'current'
  | 'stale-valid'
  | 'offline-valid'
  | 'retry-failed'
  | 'expired'
  | 'decision-unavailable';

export type DataPackSource = 'bundled' | 'cached' | 'remote';

const statusByState = {
  checking: 'Checking for verified data…',
  'decision-unavailable': 'Freshness not determined · decision unavailable',
  expired: 'Validity Horizon passed · refresh required',
  'offline-valid': 'Offline · verified data remains valid',
  'retry-failed': 'Refresh failed · verified data remains active',
  'stale-valid': 'Verified data due for refresh',
} as const satisfies Record<Exclude<DataFreshnessState, 'current'>, string>;

export const dataFreshness = Object.freeze({
  accessibility: Object.freeze({
    description: (facts: {
      readonly freshness: DataFreshnessState | string;
      readonly source: DataPackSource;
    }) => {
      if (facts.freshness === 'expired') {
        return 'validity expired, refresh required';
      }
      return dataFreshness.status(facts).toLocaleLowerCase('en-AU');
    },
    pack: (facts: {
      readonly description: string;
      readonly packVersion: string;
      readonly validUntil: string;
    }) =>
      `Time-Zone Data Pack ${facts.packVersion}, ${facts.description}, valid until ${facts.validUntil}`,
    retryHint: 'Checks for a newer verified Time-Zone Data Pack',
    retryLabel: 'Retry Time-Zone Data Pack refresh',
  }),
  heading: 'DATA FRESHNESS',
  packDetails: (facts: {
    readonly packVersion: string;
    readonly validUntil: string;
  }) => `Pack ${facts.packVersion} · Valid through ${facts.validUntil}`,
  retry: Object.freeze({
    checkingButton: 'CHECKING…',
    checkButton: 'CHECK FOR VERIFIED DATA',
  }),
  status: (facts: {
    readonly freshness: DataFreshnessState | string;
    readonly source: DataPackSource;
  }) => {
    if (facts.freshness === 'current') {
      return facts.source === 'bundled'
        ? 'Bundled data current'
        : 'Verified data current';
    }
    return Object.prototype.hasOwnProperty.call(statusByState, facts.freshness)
      ? statusByState[facts.freshness as Exclude<DataFreshnessState, 'current'>]
      : 'Freshness not determined · decision unavailable';
  },
});
