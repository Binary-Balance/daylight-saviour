export const timeZoneDataPackSchemaVersion = 1 as const;

export type TimeZoneDataPackSchemaVersion =
  typeof timeZoneDataPackSchemaVersion;

export interface TimeZoneState {
  readonly abbreviation: string;
  readonly daylightSaving: boolean;
  readonly utcOffsetSeconds: number;
}

export interface TimeZoneTransition extends TimeZoneState {
  readonly at: string;
  readonly offsetBeforeSeconds: number;
}

export interface TimeZoneData {
  readonly friendlyLabel: string;
  readonly id: string;
  readonly initial: TimeZoneState;
  readonly transitions: readonly TimeZoneTransition[];
}

export interface ActivatedTimeZoneDataPack {
  readonly coverage: {
    readonly startsAt: string;
    readonly validUntil: string;
  };
  readonly generatedAt: string;
  readonly packVersion: string;
  readonly schemaVersion: TimeZoneDataPackSchemaVersion;
  readonly source: {
    readonly name: 'IANA Time Zone Database';
    readonly rulesFile: string;
    readonly version: string;
    readonly versionUrl: string;
  };
  readonly zones: readonly TimeZoneData[];
}

export class TimeZoneDataPackValidationError extends Error {
  constructor(path: string, problem: string) {
    super(`Invalid Time-Zone Data Pack at ${path}: ${problem}`);
    this.name = 'TimeZoneDataPackValidationError';
  }
}

const supportedZoneLabels = new Map([
  ['Australia/Sydney', 'Sydney, Canberra & most of NSW'],
]);
const activatedPacks = new WeakSet<object>();

type JsonObject = Record<string, unknown>;

function fail(path: string, problem: string): never {
  throw new TimeZoneDataPackValidationError(path, problem);
}

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(path, 'expected an object');
  }

  return value as JsonObject;
}

function exactKeys(object: JsonObject, path: string, expected: string[]) {
  const actual = Object.keys(object).sort();
  const sortedExpected = [...expected].sort();

  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    fail(path, `expected keys ${sortedExpected.join(', ')}`);
  }
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    return fail(path, 'expected a non-empty string');
  }

  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    return fail(path, 'expected a boolean');
  }

  return value;
}

function integerAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return fail(path, 'expected a safe integer');
  }

  return value;
}

function instantAt(value: unknown, path: string): string {
  const instant = stringAt(value, path);
  const milliseconds = Date.parse(instant);

  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== instant
  ) {
    return fail(path, 'expected a canonical ISO 8601 UTC instant');
  }

  return instant;
}

function offsetAt(value: unknown, path: string): number {
  const seconds = integerAt(value, path);

  if (Math.abs(seconds) > 24 * 60 * 60) {
    return fail(path, 'offset must be between UTC-24:00 and UTC+24:00');
  }

  return seconds;
}

function stateAt(value: unknown, path: string): TimeZoneState {
  const state = objectAt(value, path);
  exactKeys(state, path, [
    'abbreviation',
    'daylightSaving',
    'utcOffsetSeconds',
  ]);

  const abbreviation = stringAt(state.abbreviation, `${path}.abbreviation`);
  if (!/^[A-Z+-]{2,8}$/.test(abbreviation)) {
    fail(`${path}.abbreviation`, 'expected a civil-time abbreviation');
  }

  return {
    abbreviation,
    daylightSaving: booleanAt(state.daylightSaving, `${path}.daylightSaving`),
    utcOffsetSeconds: offsetAt(
      state.utcOffsetSeconds,
      `${path}.utcOffsetSeconds`,
    ),
  };
}

function transitionAt(value: unknown, path: string): TimeZoneTransition {
  const transition = objectAt(value, path);
  exactKeys(transition, path, [
    'abbreviation',
    'at',
    'daylightSaving',
    'offsetBeforeSeconds',
    'utcOffsetSeconds',
  ]);

  const state = stateAt(
    {
      abbreviation: transition.abbreviation,
      daylightSaving: transition.daylightSaving,
      utcOffsetSeconds: transition.utcOffsetSeconds,
    },
    path,
  );

  return {
    ...state,
    at: instantAt(transition.at, `${path}.at`),
    offsetBeforeSeconds: offsetAt(
      transition.offsetBeforeSeconds,
      `${path}.offsetBeforeSeconds`,
    ),
  };
}

function zoneAt(
  value: unknown,
  path: string,
  coverageStartMs: number,
  validityHorizonMs: number,
): TimeZoneData {
  const zone = objectAt(value, path);
  exactKeys(zone, path, ['friendlyLabel', 'id', 'initial', 'transitions']);

  const id = stringAt(zone.id, `${path}.id`);
  const expectedLabel = supportedZoneLabels.get(id);
  if (expectedLabel === undefined) {
    fail(`${path}.id`, `unsupported zone ${id}`);
  }

  const friendlyLabel = stringAt(zone.friendlyLabel, `${path}.friendlyLabel`);
  if (friendlyLabel !== expectedLabel) {
    fail(`${path}.friendlyLabel`, `expected ${expectedLabel}`);
  }

  const initial = stateAt(zone.initial, `${path}.initial`);
  if (!Array.isArray(zone.transitions) || zone.transitions.length === 0) {
    fail(`${path}.transitions`, 'expected at least one transition');
  }

  let previousAt = coverageStartMs;
  let previousState = initial;
  const transitions = zone.transitions.map((value, index) => {
    const transitionPath = `${path}.transitions[${index}]`;
    const transition = transitionAt(value, transitionPath);
    const transitionMs = Date.parse(transition.at);

    if (transitionMs <= previousAt) {
      fail(`${transitionPath}.at`, 'transitions must be strictly ordered');
    }
    if (transitionMs > validityHorizonMs) {
      fail(`${transitionPath}.at`, 'transition exceeds Validity Horizon');
    }
    if (transition.offsetBeforeSeconds !== previousState.utcOffsetSeconds) {
      fail(
        `${transitionPath}.offsetBeforeSeconds`,
        'transition does not continue previous offset',
      );
    }
    if (transition.utcOffsetSeconds === transition.offsetBeforeSeconds) {
      fail(
        `${transitionPath}.utcOffsetSeconds`,
        'transition changes no offset',
      );
    }
    if (transition.daylightSaving === previousState.daylightSaving) {
      fail(
        `${transitionPath}.daylightSaving`,
        'Change Event must change Daylight Saving Status',
      );
    }

    const delta = Math.abs(
      transition.utcOffsetSeconds - transition.offsetBeforeSeconds,
    );
    if (delta > 3 * 60 * 60) {
      fail(
        `${transitionPath}.utcOffsetSeconds`,
        'offset delta exceeds 3 hours',
      );
    }

    previousAt = transitionMs;
    previousState = transition;
    return transition;
  });

  return { friendlyLabel, id, initial, transitions };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }

  return value;
}

export function activateTimeZoneDataPack(
  value: unknown,
): ActivatedTimeZoneDataPack {
  const pack = objectAt(value, '$');
  exactKeys(pack, '$', [
    'coverage',
    'generatedAt',
    'packVersion',
    'schemaVersion',
    'source',
    'zones',
  ]);

  const schemaVersion = integerAt(pack.schemaVersion, '$.schemaVersion');
  if (schemaVersion !== timeZoneDataPackSchemaVersion) {
    fail('$.schemaVersion', `unsupported version ${schemaVersion}`);
  }

  const coverage = objectAt(pack.coverage, '$.coverage');
  exactKeys(coverage, '$.coverage', ['startsAt', 'validUntil']);
  const startsAt = instantAt(coverage.startsAt, '$.coverage.startsAt');
  const validUntil = instantAt(coverage.validUntil, '$.coverage.validUntil');
  const coverageStartMs = Date.parse(startsAt);
  const validityHorizonMs = Date.parse(validUntil);
  if (coverageStartMs >= validityHorizonMs) {
    fail('$.coverage', 'Validity Horizon must follow coverage start');
  }

  const source = objectAt(pack.source, '$.source');
  exactKeys(source, '$.source', ['name', 'rulesFile', 'version', 'versionUrl']);
  const sourceName = stringAt(source.name, '$.source.name');
  if (sourceName !== 'IANA Time Zone Database') {
    fail('$.source.name', 'unsupported source');
  }
  const rulesFile = stringAt(source.rulesFile, '$.source.rulesFile');
  if (rulesFile !== 'australasia') {
    fail('$.source.rulesFile', 'expected australasia');
  }
  const sourceVersion = stringAt(source.version, '$.source.version');
  if (!/^20\d{2}[a-z]$/.test(sourceVersion)) {
    fail('$.source.version', 'expected an IANA release version');
  }
  const versionUrl = stringAt(source.versionUrl, '$.source.versionUrl');
  if (
    versionUrl !==
    `https://data.iana.org/time-zones/releases/tzdata${sourceVersion}.tar.gz`
  ) {
    fail('$.source.versionUrl', 'URL does not match source version');
  }
  const packVersion = stringAt(pack.packVersion, '$.packVersion');
  if (!packVersion.startsWith(`${sourceVersion}-`)) {
    fail('$.packVersion', 'version does not identify source version');
  }

  if (!Array.isArray(pack.zones) || pack.zones.length !== 1) {
    fail('$.zones', 'Sydney slice requires exactly one zone');
  }
  const zones = pack.zones.map((zone, index) =>
    zoneAt(zone, `$.zones[${index}]`, coverageStartMs, validityHorizonMs),
  );

  const activated: ActivatedTimeZoneDataPack = {
    coverage: { startsAt, validUntil },
    generatedAt: instantAt(pack.generatedAt, '$.generatedAt'),
    packVersion,
    schemaVersion,
    source: {
      name: sourceName,
      rulesFile,
      version: sourceVersion,
      versionUrl,
    },
    zones,
  };

  activatedPacks.add(activated);
  return deepFreeze(activated) as ActivatedTimeZoneDataPack;
}

export function assertActivatedTimeZoneDataPack(
  value: ActivatedTimeZoneDataPack,
): asserts value is ActivatedTimeZoneDataPack {
  if (!activatedPacks.has(value)) {
    throw new TypeError(
      'Time-Zone Data Pack must be activated before domain calculation',
    );
  }
}
