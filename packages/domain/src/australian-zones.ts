import {
  activateTimeZoneDataPack,
  type ActivatedTimeZoneDataPack,
} from '@daylight-saviour/contracts';

export type AustralianZoneGroup =
  | 'mainland-and-state-regions'
  | 'islands-and-external-territories';

export interface AustralianZone {
  readonly aliases: readonly string[];
  readonly friendlyLabel: string;
  readonly group: AustralianZoneGroup;
  readonly id: string;
  readonly searchTerms: readonly string[];
}

export const australianZoneGroups = [
  {
    id: 'mainland-and-state-regions',
    label: 'Mainland & state regions',
  },
  {
    id: 'islands-and-external-territories',
    label: 'Islands & external territories',
  },
] as const;

export const australianZones: readonly AustralianZone[] = [
  {
    aliases: ['Australia/ACT', 'Australia/Canberra', 'Australia/NSW'],
    friendlyLabel: 'Sydney, Canberra & most of NSW',
    group: 'mainland-and-state-regions',
    id: 'Australia/Sydney',
    searchTerms: ['sydney', 'canberra', 'new south wales', 'nsw', 'act'],
  },
  {
    aliases: ['Australia/Yancowinna'],
    friendlyLabel: 'Broken Hill & far-western NSW',
    group: 'mainland-and-state-regions',
    id: 'Australia/Broken_Hill',
    searchTerms: ['broken hill', 'far western nsw', 'yancowinna'],
  },
  {
    aliases: ['Australia/Victoria'],
    friendlyLabel: 'Melbourne & Victoria',
    group: 'mainland-and-state-regions',
    id: 'Australia/Melbourne',
    searchTerms: ['melbourne', 'victoria', 'vic'],
  },
  {
    aliases: ['Australia/Tasmania', 'Australia/Currie'],
    friendlyLabel: 'Hobart & Tasmania',
    group: 'mainland-and-state-regions',
    id: 'Australia/Hobart',
    searchTerms: ['hobart', 'tasmania', 'tas', 'currie', 'king island'],
  },
  {
    aliases: ['Australia/Queensland'],
    friendlyLabel: 'Brisbane & most of Queensland',
    group: 'mainland-and-state-regions',
    id: 'Australia/Brisbane',
    searchTerms: ['brisbane', 'queensland', 'qld'],
  },
  {
    aliases: [],
    friendlyLabel: 'Whitsunday Islands',
    group: 'mainland-and-state-regions',
    id: 'Australia/Lindeman',
    searchTerms: ['whitsunday', 'lindeman', 'queensland islands'],
  },
  {
    aliases: ['Australia/South'],
    friendlyLabel: 'Adelaide & South Australia',
    group: 'mainland-and-state-regions',
    id: 'Australia/Adelaide',
    searchTerms: ['adelaide', 'south australia', 'sa'],
  },
  {
    aliases: ['Australia/North'],
    friendlyLabel: 'Darwin & Northern Territory',
    group: 'mainland-and-state-regions',
    id: 'Australia/Darwin',
    searchTerms: ['darwin', 'northern territory', 'nt'],
  },
  {
    aliases: ['Australia/West'],
    friendlyLabel: 'Perth & most of Western Australia',
    group: 'mainland-and-state-regions',
    id: 'Australia/Perth',
    searchTerms: ['perth', 'western australia', 'wa'],
  },
  {
    aliases: [],
    friendlyLabel: 'Eucla & south-eastern WA',
    group: 'mainland-and-state-regions',
    id: 'Australia/Eucla',
    searchTerms: ['eucla', 'south eastern wa', 'western australia border'],
  },
  {
    aliases: ['Australia/LHI'],
    friendlyLabel: 'Lord Howe Island',
    group: 'islands-and-external-territories',
    id: 'Australia/Lord_Howe',
    searchTerms: ['lord howe', 'lhi', 'island'],
  },
  {
    aliases: [],
    friendlyLabel: 'Macquarie Island',
    group: 'islands-and-external-territories',
    id: 'Antarctica/Macquarie',
    searchTerms: ['macquarie', 'tasmanian island', 'subantarctic'],
  },
  {
    aliases: [],
    friendlyLabel: 'Norfolk Island',
    group: 'islands-and-external-territories',
    id: 'Pacific/Norfolk',
    searchTerms: ['norfolk', 'kingston', 'pacific island'],
  },
  {
    aliases: [],
    friendlyLabel: 'Christmas Island',
    group: 'islands-and-external-territories',
    id: 'Indian/Christmas',
    searchTerms: ['christmas island', 'indian ocean'],
  },
  {
    aliases: [],
    friendlyLabel: 'Cocos (Keeling) Islands',
    group: 'islands-and-external-territories',
    id: 'Indian/Cocos',
    searchTerms: ['cocos', 'keeling', 'indian ocean'],
  },
  {
    aliases: [],
    friendlyLabel: 'Casey Station, Australian Antarctic Territory',
    group: 'islands-and-external-territories',
    id: 'Antarctica/Casey',
    searchTerms: [
      'casey station',
      'antarctica',
      'australian antarctic territory',
    ],
  },
  {
    aliases: [],
    friendlyLabel: 'Davis Station, Australian Antarctic Territory',
    group: 'islands-and-external-territories',
    id: 'Antarctica/Davis',
    searchTerms: [
      'davis station',
      'antarctica',
      'australian antarctic territory',
    ],
  },
  {
    aliases: [],
    friendlyLabel: 'Mawson Station, Australian Antarctic Territory',
    group: 'islands-and-external-territories',
    id: 'Antarctica/Mawson',
    searchTerms: [
      'mawson station',
      'antarctica',
      'australian antarctic territory',
    ],
  },
];

const zonesById = new Map(australianZones.map((zone) => [zone.id, zone]));
const canonicalIdsByAcceptedId = new Map<string, string>();
for (const zone of australianZones) {
  canonicalIdsByAcceptedId.set(zone.id, zone.id);
  for (const alias of zone.aliases) {
    canonicalIdsByAcceptedId.set(alias, zone.id);
  }
}

export function normalizeAustralianZoneId(candidate: string) {
  return canonicalIdsByAcceptedId.get(candidate) ?? null;
}

export function getAustralianZone(candidate: string) {
  const canonicalId = normalizeAustralianZoneId(candidate);
  return canonicalId === null ? null : (zonesById.get(canonicalId) ?? null);
}

export function searchAustralianZones(query: string) {
  const needle = query.trim().toLocaleLowerCase('en-AU');
  if (needle.length === 0) {
    return australianZones;
  }

  return australianZones.filter((zone) =>
    [zone.friendlyLabel, zone.id, ...zone.aliases, ...zone.searchTerms].some(
      (value) => value.toLocaleLowerCase('en-AU').includes(needle),
    ),
  );
}

export class AustralianCoverageValidationError extends Error {
  constructor(problem: string) {
    super(`Invalid Australian Coverage: ${problem}`);
    this.name = 'AustralianCoverageValidationError';
  }
}

export function activateAustralianTimeZoneDataPack(
  value: unknown,
): ActivatedTimeZoneDataPack {
  const pack = activateTimeZoneDataPack(value);
  const expectedIds = new Set(australianZones.map((zone) => zone.id));

  if (pack.zones.length !== australianZones.length) {
    throw new AustralianCoverageValidationError(
      `expected ${australianZones.length} canonical zones`,
    );
  }

  for (const packedZone of pack.zones) {
    const catalogueZone = zonesById.get(packedZone.id);
    if (catalogueZone === undefined) {
      throw new AustralianCoverageValidationError(
        `unexpected zone ${packedZone.id}`,
      );
    }
    if (packedZone.friendlyLabel !== catalogueZone.friendlyLabel) {
      throw new AustralianCoverageValidationError(
        `label mismatch for ${packedZone.id}`,
      );
    }
    expectedIds.delete(packedZone.id);
  }

  if (expectedIds.size > 0) {
    throw new AustralianCoverageValidationError(
      `missing zones ${[...expectedIds].join(', ')}`,
    );
  }

  return pack;
}
