import type { AustralianZoneGroup } from '@daylight-saviour/domain';

export type HomeTimeZoneNoticeCode =
  | 'device-zone-outside-coverage'
  | 'saved-zone-invalid';

export type HomeTimeZoneErrorCode = 'load-failed' | 'save-failed';

const groupHeadings = {
  'islands-and-external-territories': 'Islands & external territories',
  'mainland-and-state-regions': 'Mainland & state regions',
} as const satisfies Record<AustralianZoneGroup, string>;

const notices = {
  'device-zone-outside-coverage':
    'Device time zone is outside Australian Coverage. Choose without a location guess.',
  'saved-zone-invalid':
    'Saved Home Time Zone is unsupported or invalid. Choose a region again.',
} as const satisfies Record<HomeTimeZoneNoticeCode, string>;

const errors = {
  'load-failed': 'Could not load saved Home Time Zone.',
  'save-failed': 'Could not save Home Time Zone. Try again.',
} as const satisfies Record<HomeTimeZoneErrorCode, string>;

export const homeTimeZone = Object.freeze({
  accessibility: Object.freeze({
    cancelHint: 'Returns to the current Home Time Zone without saving',
    cancelLabel: 'Cancel Home Time Zone selection',
    currentTime: (facts: {
      readonly abbreviation: string;
      readonly clock: string;
    }) => `${facts.clock} ${facts.abbreviation}`,
    searchLabel: 'Search Australian Home Time Zones',
    zoneOption: (facts: {
      readonly friendlyLabel: string;
      readonly zoneId: string;
    }) => `${facts.friendlyLabel}, ${facts.zoneId}`,
    zoneOptionHint: 'Saves this canonical Home Time Zone',
  }),
  chooser: Object.freeze({
    cancelButton: 'Cancel',
    emptyResult: 'No matching Australian Home Time Zone.',
    groupHeading: (group: AustralianZoneGroup) => groupHeadings[group],
    heading: 'Choose Home Time Zone',
    introduction:
      'Friendly geography first. Canonical IANA identifier shown for precision.',
    searchPlaceholder: 'Search region or identifier',
  }),
  confirmation: Object.freeze({
    chooseAnotherButton: 'Choose another region',
    explanation:
      'No location permission needed. Suggestion comes from device civil-time settings.',
    heading: 'SUGGESTED HOME TIME ZONE',
    useSuggestedButton: 'Use this Home Time Zone',
  }),
  errorMessage: (code: HomeTimeZoneErrorCode) =>
    Object.prototype.hasOwnProperty.call(errors, code)
      ? errors[code as HomeTimeZoneErrorCode]
      : 'Something went wrong with Home Time Zone settings. Try again.',
  loading: Object.freeze({
    message: 'Loading Home Time Zone…',
    retryButton: 'Retry',
  }),
  notice: (code: HomeTimeZoneNoticeCode) =>
    Object.prototype.hasOwnProperty.call(notices, code)
      ? notices[code as HomeTimeZoneNoticeCode]
      : 'Home Time Zone needs attention. Choose an Australian region.',
});
