export const canonicalAustralianZoneIds = Object.freeze([
  'Australia/Sydney',
  'Australia/Broken_Hill',
  'Australia/Melbourne',
  'Australia/Hobart',
  'Australia/Brisbane',
  'Australia/Lindeman',
  'Australia/Adelaide',
  'Australia/Darwin',
  'Australia/Perth',
  'Australia/Eucla',
  'Australia/Lord_Howe',
  'Antarctica/Macquarie',
  'Pacific/Norfolk',
  'Indian/Christmas',
  'Indian/Cocos',
  'Antarctica/Casey',
  'Antarctica/Davis',
  'Antarctica/Mawson',
]);

const canonicalIds = new Set(canonicalAustralianZoneIds);

export function canonicalAustralianZoneId(candidate) {
  return canonicalIds.has(candidate) ? candidate : null;
}
