export type DataFreshnessState =
  | 'checking'
  | 'current'
  | 'stale-valid'
  | 'offline-valid'
  | 'retry-failed'
  | 'expired'
  | 'decision-unavailable';

export type DataPackSource = 'bundled' | 'cached' | 'remote';

interface FreshnessFacts {
  readonly freshness: DataFreshnessState;
  readonly source: DataPackSource;
}

interface PackFacts extends FreshnessFacts {
  readonly packVersion: string;
  readonly uses24hourClock: boolean;
  readonly validUntil: string;
}

const statusByState = {
  checking: 'Checking for verified data…',
  'decision-unavailable': 'Freshness not determined · decision unavailable',
  expired: 'Validity Horizon passed · refresh required',
  'offline-valid': 'Offline · verified data remains valid',
  'retry-failed': 'Refresh failed · verified data remains active',
  'stale-valid': 'Verified data due for refresh',
} as const satisfies Record<Exclude<DataFreshnessState, 'current'>, string>;

function freshnessStatus(facts: FreshnessFacts) {
  if (facts.freshness === 'current') {
    return facts.source === 'bundled'
      ? 'Bundled data current'
      : 'Verified data current';
  }
  return Object.prototype.hasOwnProperty.call(statusByState, facts.freshness)
    ? statusByState[facts.freshness as Exclude<DataFreshnessState, 'current'>]
    : 'Freshness not determined · decision unavailable';
}

function accessibilityDescription(facts: FreshnessFacts) {
  if (facts.freshness === 'expired') {
    return 'validity expired, refresh required';
  }
  return freshnessStatus(facts).toLocaleLowerCase('en-AU');
}

function formatUtcValidityHorizon(
  validUntil: string,
  uses24hourClock: boolean,
) {
  const instant = new Date(validUntil);
  if (Number.isNaN(instant.getTime())) return 'recorded UTC Validity Horizon';

  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    hour: 'numeric',
    hourCycle: uses24hourClock ? 'h23' : 'h12',
    minute: '2-digit',
    month: 'long',
    second: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
    year: 'numeric',
  }).format(instant);
}

export const dataFreshness = Object.freeze({
  accessibility: Object.freeze({
    pack: (facts: PackFacts) =>
      `Time-Zone Data Pack ${facts.packVersion}, ${accessibilityDescription(facts)}, valid until ${formatUtcValidityHorizon(facts.validUntil, facts.uses24hourClock)}`,
    retryHint: 'Checks for a newer verified Time-Zone Data Pack',
    retryLabel: 'Retry Time-Zone Data Pack refresh',
  }),
  heading: 'DATA FRESHNESS',
  packDetails: (
    facts: Pick<PackFacts, 'packVersion' | 'uses24hourClock' | 'validUntil'>,
  ) =>
    `Pack ${facts.packVersion} · Valid through ${formatUtcValidityHorizon(facts.validUntil, facts.uses24hourClock)}`,
  retry: Object.freeze({
    checkingButton: 'CHECKING…',
    checkButton: 'CHECK FOR VERIFIED DATA',
  }),
  status: freshnessStatus,
});
