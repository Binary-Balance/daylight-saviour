import { gunzipSync } from 'node:zlib';

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

export const DEFAULT_SOURCE_FILES = Object.freeze([
  'antarctica',
  'asia',
  'australasia',
  'backward',
  'zone.tab',
  'zone1970.tab',
]);

// This command owns the reviewed Australian Coverage catalogue. Keeping the
// set fixed here prevents a caller from reducing the conformance scope by
// supplying a smaller configuration.
const EXPECTED_AUSTRALIAN_ZONE_IDS = Object.freeze([
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

const MONTHS = new Map(
  [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ].map((month, index) => [month, index + 1]),
);
const WEEKDAYS = new Map(
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, index) => [
    day,
    index,
  ]),
);

const REVIEWED_ALIASES = Object.freeze({
  'Australia/ACT': 'Australia/Sydney',
  'Australia/Canberra': 'Australia/Sydney',
  'Australia/NSW': 'Australia/Sydney',
  'Australia/LHI': 'Australia/Lord_Howe',
  'Australia/North': 'Australia/Darwin',
  'Australia/Queensland': 'Australia/Brisbane',
  'Australia/South': 'Australia/Adelaide',
  'Australia/Tasmania': 'Australia/Hobart',
  'Australia/Currie': 'Australia/Hobart',
  'Australia/Victoria': 'Australia/Melbourne',
  'Australia/West': 'Australia/Perth',
  'Australia/Yancowinna': 'Australia/Broken_Hill',
});

function fail(problem) {
  throw new Error(`IANA candidate validation failed: ${problem}`);
}

function strictUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

function field(bytes, start, length) {
  return new TextDecoder('ascii').decode(bytes.slice(start, start + length));
}

function readTar(bytes) {
  const files = new Map();
  let offset = 0;
  let zeroBlocks = 0;

  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) break;
      continue;
    }
    zeroBlocks = 0;

    const name = field(header, 0, 100).replace(/\0.*$/s, '');
    const prefix = field(header, 345, 155).replace(/\0.*$/s, '');
    const path = prefix.length === 0 ? name : `${prefix}/${name}`;
    const type = header[156];
    const checksumText = field(header, 148, 8).replace(/\0.*$/s, '').trim();
    if (!/^\d+$/.test(checksumText)) {
      fail(`invalid archive checksum for ${path}`);
    }
    const checksum = header.reduce(
      (total, byte, index) =>
        total + (index >= 148 && index < 156 ? 0x20 : byte),
      0,
    );
    if (checksum !== Number.parseInt(checksumText, 8)) {
      fail(`archive checksum does not match for ${path}`);
    }
    const sizeText = field(header, 124, 12).replace(/\0.*$/s, '').trim();
    if (
      path.length === 0 ||
      path.startsWith('/') ||
      path.split('/').some((part) => part === '.' || part === '..') ||
      !/^[A-Za-z0-9._/-]+$/.test(path)
    ) {
      fail(`unsupported archive path ${JSON.stringify(path)}`);
    }
    if (type !== 0 && type !== 48) {
      fail(`unsupported archive entry type for ${path}`);
    }
    if (!/^\d+$/.test(sizeText)) fail(`invalid archive size for ${path}`);
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size > MAX_UNCOMPRESSED_BYTES) {
      fail(`archive entry is too large: ${path}`);
    }
    if (offset + size > bytes.byteLength)
      fail(`truncated archive entry: ${path}`);
    if (files.has(path)) fail(`duplicate archive entry: ${path}`);
    files.set(path, bytes.slice(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }

  if (zeroBlocks < 2) fail('archive is missing its end marker');
  return files;
}

function parseRuleLine(tokens, file, lineNumber) {
  if (tokens.length !== 10) {
    fail(`unsupported Rule syntax in ${file}:${lineNumber}`);
  }
  return {
    name: tokens[1],
    from: tokens[2],
    to: tokens[3],
    type: tokens[4],
    month: tokens[5],
    on: tokens[6],
    at: tokens[7],
    save: tokens[8],
    letters: tokens[9],
    file,
    lineNumber,
  };
}

function parseZoneFields(tokens, file, lineNumber) {
  if (tokens.length < 3) {
    fail(`unsupported Zone syntax in ${file}:${lineNumber}`);
  }
  const [gmtoff, rules, format, ...until] = tokens;
  return {
    gmtoff,
    rules,
    format,
    until: until.length === 0 ? null : until,
    file,
    lineNumber,
  };
}

function parseSourceFile(text, file, result) {
  let currentZone = null;
  for (const [index, originalLine] of text.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = originalLine.replace(/#.*/, '').trimEnd();
    if (line.trim().length === 0) continue;
    const continuation = /^\s/.test(line);
    const tokens = line.trim().split(/\s+/);

    if (continuation) {
      if (currentZone === null) {
        fail(`orphan Zone continuation in ${file}:${lineNumber}`);
      }
      currentZone.segments.push(parseZoneFields(tokens, file, lineNumber));
      continue;
    }

    currentZone = null;
    if (tokens[0] === 'Rule') {
      const rule = parseRuleLine(tokens, file, lineNumber);
      const rules = result.rules.get(rule.name) ?? [];
      rules.push(rule);
      result.rules.set(rule.name, rules);
      continue;
    }
    if (tokens[0] === 'Zone') {
      if (tokens.length < 5) {
        fail(`unsupported Zone syntax in ${file}:${lineNumber}`);
      }
      const name = tokens[1];
      if (result.zones.has(name)) fail(`duplicate Zone ${name}`);
      const zone = {
        name,
        segments: [parseZoneFields(tokens.slice(2), file, lineNumber)],
      };
      result.zones.set(name, zone);
      currentZone = zone;
      continue;
    }
    if (tokens[0] === 'Link') {
      if (tokens.length !== 3) {
        fail(`unsupported Link syntax in ${file}:${lineNumber}`);
      }
      const [target, alias] = tokens.slice(1);
      if (result.links.has(alias)) fail(`duplicate Link ${alias}`);
      result.links.set(alias, target);
      continue;
    }
    fail(`unsupported IANA directive ${tokens[0]} in ${file}:${lineNumber}`);
  }
}

export function parseIanaArchive(
  archiveBytes,
  sourceFiles = DEFAULT_SOURCE_FILES,
) {
  if (!(archiveBytes instanceof Uint8Array)) fail('archive must be bytes');
  if (
    archiveBytes.byteLength < 1 ||
    archiveBytes.byteLength > MAX_ARCHIVE_BYTES
  ) {
    fail('archive size is outside the supported limit');
  }

  let unpacked;
  try {
    unpacked = gunzipSync(archiveBytes);
  } catch {
    fail('archive is not valid gzip');
  }
  if (unpacked.byteLength > MAX_UNCOMPRESSED_BYTES) {
    fail('uncompressed archive is too large');
  }
  const files = readTar(unpacked);
  if (!Array.isArray(sourceFiles)) fail('source files must be an array');
  const requested = [...sourceFiles];
  if (
    requested.length === 0 ||
    new Set(requested).size !== requested.length ||
    requested.some((name) => !/^[A-Za-z0-9._-]+$/.test(name))
  ) {
    fail('source files must be unique portable names');
  }

  const result = {
    files,
    links: new Map(),
    rules: new Map(),
    zones: new Map(),
  };
  for (const name of requested) {
    const bytes = files.get(name);
    if (bytes === undefined) fail(`archive is missing source file ${name}`);
    if (name !== 'zone.tab' && name !== 'zone1970.tab') {
      parseSourceFile(strictUtf8(bytes, name), name, result);
    }
  }
  const versionBytes = files.get('version');
  if (versionBytes === undefined) fail('archive is missing version');
  const version = strictUtf8(versionBytes, 'version').trim();
  if (!/^20\d{2}[a-z]$/.test(version)) {
    fail(`unsupported IANA release version ${JSON.stringify(version)}`);
  }
  return {
    files,
    links: result.links,
    rules: result.rules,
    version,
    zones: result.zones,
  };
}

export function resolveIanaLink(name, parsed) {
  const seen = new Set();
  let current = name;
  while (parsed.links.has(current)) {
    if (seen.has(current)) fail(`cyclic Link involving ${name}`);
    seen.add(current);
    current = parsed.links.get(current);
  }
  return current;
}

function parseSeconds(value, kind) {
  const match = /^([+-]?)(\d{1,6})(?::(\d{1,2}))?(?::(\d{1,2}))?$/.exec(value);
  if (match === null)
    fail(`unsupported ${kind} value ${JSON.stringify(value)}`);
  const [, sign, hoursText, minutesText = '0', secondsText = '0'] = match;
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  if (minutes > 59 || seconds > 59) fail(`invalid ${kind} value ${value}`);
  const total = hours * 3600 + minutes * 60 + seconds;
  return sign === '-' ? -total : total;
}

function parseClock(value) {
  const suffixMatch = /([a-z])$/.exec(value);
  const suffix = suffixMatch?.[1] ?? 'w';
  const clock = suffixMatch === null ? value : value.slice(0, -1);
  const basis =
    suffix === 's'
      ? 'standard'
      : suffix === 'w'
        ? 'wall'
        : suffix === 'u' || suffix === 'g' || suffix === 'z'
          ? 'utc'
          : null;
  if (basis === null) fail(`unsupported Rule time basis ${value}`);
  return { basis, seconds: parseSeconds(clock, 'Rule time') };
}

function parseYear(value, from) {
  if (value === 'only') return from;
  if (value === 'max') return Number.POSITIVE_INFINITY;
  if (/^\d{4}$/.test(value)) return Number(value);
  fail(`unsupported Rule year ${value}`);
}

function canonicalInstant(value, label) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    fail(`${label} must be a canonical ISO 8601 UTC instant`);
  }
  return milliseconds;
}

function validateConfiguration(configuration) {
  if (
    typeof configuration !== 'object' ||
    configuration === null ||
    Array.isArray(configuration)
  ) {
    fail('configuration must be an object');
  }

  const source = configuration.source;
  if (
    typeof source !== 'object' ||
    source === null ||
    !Array.isArray(source.files) ||
    source.files.length !== DEFAULT_SOURCE_FILES.length ||
    source.files.some((name, index) => name !== DEFAULT_SOURCE_FILES[index])
  ) {
    fail(
      `configuration source.files must be ${DEFAULT_SOURCE_FILES.join(', ')}`,
    );
  }

  const generation = configuration.generation;
  if (
    typeof generation !== 'object' ||
    generation === null ||
    !Number.isSafeInteger(generation.schemaVersion) ||
    !Number.isSafeInteger(generation.firstYear) ||
    !Number.isSafeInteger(generation.lastYear) ||
    generation.firstYear > generation.lastYear
  ) {
    fail('configuration generation bounds are invalid');
  }
  const coverageStartMs = canonicalInstant(
    generation.coverageStartsAt,
    'configuration coverageStartsAt',
  );
  const validityHorizonMs = canonicalInstant(
    generation.validUntil,
    'configuration validUntil',
  );
  canonicalInstant(generation.generatedAt, 'configuration generatedAt');
  if (coverageStartMs >= validityHorizonMs) {
    fail('configuration Validity Horizon must follow coverage start');
  }

  if (!Array.isArray(configuration.zones)) {
    fail('configuration zones must be an array');
  }
  const zoneIds = configuration.zones.map((zone) => zone?.id);
  if (
    zoneIds.length !== EXPECTED_AUSTRALIAN_ZONE_IDS.length ||
    zoneIds.some((id, index) => id !== EXPECTED_AUSTRALIAN_ZONE_IDS[index])
  ) {
    fail('configuration zones must contain the reviewed 18-zone catalogue');
  }
  if (
    configuration.zones.some(
      (zone) =>
        typeof zone !== 'object' ||
        zone === null ||
        typeof zone.id !== 'string' ||
        typeof zone.friendlyLabel !== 'string' ||
        zone.friendlyLabel.trim().length === 0,
    )
  ) {
    fail('configuration zones must have IDs and friendly labels');
  }
  return { coverageStartMs, validityHorizonMs };
}

function dayOnOrBefore(year, month, weekday, day) {
  const actual = new Date(utcDateMs(year, month - 1, day)).getUTCDay();
  return day - ((actual - weekday + 7) % 7);
}

function dayOnOrAfter(year, month, weekday, day) {
  const actual = new Date(utcDateMs(year, month - 1, day)).getUTCDay();
  return day + ((weekday - actual + 7) % 7);
}

function utcDateMs(year, monthIndex, day) {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  return date.getTime();
}

function resolveRuleDay(year, month, value) {
  const daysInMonth = new Date(utcDateMs(year, month, 0)).getUTCDate();
  if (/^\d{1,2}$/.test(value)) {
    const day = Number(value);
    if (day < 1 || day > daysInMonth) {
      fail(`invalid Rule day ${value} for month ${month}`);
    }
    return day;
  }
  const last = /^last([A-Z][a-z]{2})$/.exec(value);
  if (last !== null) {
    const weekday = WEEKDAYS.get(last[1]);
    if (weekday === undefined) fail(`unsupported Rule day ${value}`);
    const day = dayOnOrBefore(year, month, weekday, daysInMonth);
    return day;
  }
  const weekday = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)([<>]=)(\d{1,2})$/.exec(value);
  if (weekday === null) fail(`unsupported Rule day ${value}`);
  const weekdayNumber = WEEKDAYS.get(weekday[1]);
  if (weekdayNumber === undefined) fail(`unsupported Rule day ${value}`);
  const baseDay = Number(weekday[3]);
  if (baseDay < 1 || baseDay > 31) {
    fail(`invalid Rule day ${value}`);
  }
  const resolvedDay =
    weekday[2] === '>='
      ? dayOnOrAfter(year, month, weekdayNumber, baseDay)
      : dayOnOrBefore(year, month, weekdayNumber, baseDay);
  if (resolvedDay < 1 || resolvedDay > daysInMonth) {
    fail(`invalid Rule day ${value} for month ${month}`);
  }
  return resolvedDay;
}

function parseRelevantRule(raw) {
  if (raw.type !== '-')
    fail(
      `${raw.file}:${raw.lineNumber} uses unsupported Rule TYPE ${raw.type}`,
    );
  if (!/^\d{4}$/.test(raw.from) && raw.from !== 'minimum') {
    fail(
      `${raw.file}:${raw.lineNumber} uses unsupported Rule FROM ${raw.from}`,
    );
  }
  const from = raw.from === 'minimum' ? 0 : Number(raw.from);
  const month = MONTHS.get(raw.month);
  if (month === undefined)
    fail(`${raw.file}:${raw.lineNumber} uses unsupported month ${raw.month}`);
  const save = parseSeconds(raw.save, 'Rule SAVE');
  const at = parseClock(raw.at);
  const to = parseYear(raw.to, from);
  if (Number.isFinite(to) && to < from) {
    fail(`${raw.file}:${raw.lineNumber} has a Rule TO before FROM`);
  }
  return {
    atBasis: at.basis,
    atSeconds: at.seconds,
    from,
    letters: raw.letters === '-' ? '' : raw.letters,
    month,
    on: raw.on,
    saveAfterSeconds: save,
    to,
  };
}

function formatOffset(seconds) {
  const sign = seconds < 0 ? '-' : '+';
  const absolute = Math.abs(seconds);
  const hours = Math.floor(absolute / 3600);
  const minutes = Math.floor((absolute % 3600) / 60);
  const remainder = absolute % 60;
  return `${sign}${String(hours).padStart(2, '0')}${minutes === 0 && remainder === 0 ? '' : String(minutes).padStart(2, '0')}${remainder === 0 ? '' : String(remainder).padStart(2, '0')}`;
}

function abbreviation(format, letters, offsetSeconds) {
  const placeholders = [...format.matchAll(/%./g)].map((match) => match[0]);
  if (placeholders.some((value) => value !== '%s' && value !== '%z')) {
    fail(`unsupported Zone FORMAT ${format}`);
  }
  if (placeholders.includes('%s') && placeholders.includes('%z')) {
    fail(`unsupported Zone FORMAT ${format}`);
  }
  return format
    .replace('%s', letters)
    .replace('%z', formatOffset(offsetSeconds));
}

function generateZone(
  configZone,
  parsed,
  firstYear,
  lastYear,
  coverageStartMs,
  validityHorizonMs,
) {
  const sourceName = resolveIanaLink(configZone.id, parsed);
  const definition = parsed.zones.get(sourceName);
  if (definition === undefined)
    fail(`archive has no Zone for ${configZone.id}`);
  const coverageStartYear = new Date(coverageStartMs).getUTCFullYear();
  for (const segment of definition.segments.slice(0, -1)) {
    const untilYear = Number(segment.until?.[0]);
    if (!Number.isInteger(untilYear) || untilYear >= coverageStartYear) {
      fail(
        `Zone segment boundary for ${configZone.id} is inside or after the supported coverage start`,
      );
    }
  }
  const segment = definition.segments.at(-1);
  if (segment === undefined || segment.until !== null) {
    fail(`final Zone segment for ${configZone.id} must have no UNTIL`);
  }
  const baseOffsetSeconds = parseSeconds(segment.gmtoff, 'Zone offset');
  const ruleName = segment.rules;
  const rawRules = ruleName === '-' ? [] : parsed.rules.get(ruleName);
  if (ruleName !== '-' && (rawRules === undefined || rawRules.length === 0)) {
    fail(`archive has no Rule set ${ruleName} for ${configZone.id}`);
  }
  const rules = (rawRules ?? []).map(parseRelevantRule);
  // Include the first applicable rule year so a zone whose final segment uses
  // a historical, finite rule set still starts with its correct final state.
  const earliestYear = Math.min(
    firstYear - 1,
    ...rules.map((rule) => rule.from),
  );
  const occurrences = [];
  for (let year = earliestYear; year <= lastYear; year += 1) {
    for (const [index, rule] of rules.entries()) {
      if (year < rule.from || year > rule.to) continue;
      const day = resolveRuleDay(year, rule.month, rule.on);
      const localMs =
        utcDateMs(year, rule.month - 1, day) + rule.atSeconds * 1000;
      occurrences.push({ index, localMs, rule });
    }
  }
  occurrences.sort(
    (left, right) => left.localMs - right.localMs || left.index - right.index,
  );

  let saveAfterSeconds = 0;
  let letters = '';
  const transitions = [];
  for (const occurrence of occurrences) {
    const { rule } = occurrence;
    const offsetBeforeSeconds = baseOffsetSeconds + saveAfterSeconds;
    const interpretationOffsetSeconds =
      rule.atBasis === 'standard'
        ? baseOffsetSeconds
        : rule.atBasis === 'wall'
          ? offsetBeforeSeconds
          : 0;
    const instantMs = occurrence.localMs - interpretationOffsetSeconds * 1000;
    const nextOffsetSeconds = baseOffsetSeconds + rule.saveAfterSeconds;
    if (instantMs <= coverageStartMs) {
      saveAfterSeconds = rule.saveAfterSeconds;
      letters = rule.letters;
      continue;
    }
    if (instantMs > validityHorizonMs) continue;
    transitions.push({
      abbreviation: abbreviation(
        segment.format,
        rule.letters,
        nextOffsetSeconds,
      ),
      at: new Date(instantMs).toISOString(),
      daylightSaving: rule.saveAfterSeconds > 0,
      offsetBeforeSeconds,
      utcOffsetSeconds: nextOffsetSeconds,
    });
    saveAfterSeconds = rule.saveAfterSeconds;
    letters = rule.letters;
  }

  const initialOffsetSeconds = baseOffsetSeconds + saveAfterSeconds;
  return {
    friendlyLabel: configZone.friendlyLabel,
    id: configZone.id,
    initial: {
      abbreviation: abbreviation(segment.format, letters, initialOffsetSeconds),
      daylightSaving: saveAfterSeconds > 0,
      utcOffsetSeconds: initialOffsetSeconds,
    },
    transitions,
  };
}

export function generateAustralianCandidate({
  archive,
  archiveSha256,
  configuration,
  generatedAt,
}) {
  const { coverageStartMs, validityHorizonMs } =
    validateConfiguration(configuration);
  const resolvedGeneratedAt =
    generatedAt ?? configuration.generation.generatedAt;
  const firstYear = configuration.generation.firstYear;
  const lastYear = configuration.generation.lastYear;
  const zones = configuration.zones.map((zone) =>
    generateZone(
      zone,
      archive,
      firstYear,
      lastYear,
      coverageStartMs,
      validityHorizonMs,
    ),
  );
  return {
    coverage: {
      startsAt: configuration.generation.coverageStartsAt,
      validUntil: configuration.generation.validUntil,
    },
    generatedAt: resolvedGeneratedAt,
    packVersion: `${archive.version}-australian-coverage-${firstYear}-${lastYear}.1`,
    schemaVersion: configuration.generation.schemaVersion,
    source: {
      archiveSha256,
      files: [...configuration.source.files],
      name: 'IANA Time Zone Database',
      version: archive.version,
      versionUrl: `https://data.iana.org/time-zones/releases/tzdata${archive.version}.tar.gz`,
    },
    zones,
  };
}

function stateAt(zone, instantMs) {
  let state = zone.initial;
  for (const transition of zone.transitions) {
    if (Date.parse(transition.at) > instantMs) break;
    state = transition;
  }
  return state;
}

function sameState(left, right) {
  return (
    left.abbreviation === right.abbreviation &&
    left.daylightSaving === right.daylightSaving &&
    left.utcOffsetSeconds === right.utcOffsetSeconds
  );
}

export function runConformance(pack, configuration, parsed) {
  validateConfiguration(configuration);
  const failures = [];
  const expectedZones = configuration.zones;
  if (pack.zones.length !== expectedZones.length) {
    failures.push(
      `expected ${expectedZones.length} zones, got ${pack.zones.length}`,
    );
  }
  const coverageStartMs = Date.parse(pack.coverage.startsAt);
  const validityHorizonMs = Date.parse(pack.coverage.validUntil);
  let boundaryChecks = 0;
  for (const expected of expectedZones) {
    const zone = pack.zones.find((candidate) => candidate.id === expected.id);
    if (zone === undefined) {
      failures.push(`missing ${expected.id}`);
      continue;
    }
    if (zone.friendlyLabel !== expected.friendlyLabel) {
      failures.push(`label changed for ${expected.id}`);
    }
    let previous = zone.initial;
    let previousAt = coverageStartMs;
    for (const transition of zone.transitions) {
      const at = Date.parse(transition.at);
      if (!(at > previousAt && at <= validityHorizonMs)) {
        failures.push(`invalid transition ordering for ${expected.id}`);
      }
      if (transition.offsetBeforeSeconds !== previous.utcOffsetSeconds) {
        failures.push(
          `offset discontinuity for ${expected.id} at ${transition.at}`,
        );
      }
      if (transition.utcOffsetSeconds === transition.offsetBeforeSeconds) {
        failures.push(
          `no offset change for ${expected.id} at ${transition.at}`,
        );
      }
      if (transition.daylightSaving === previous.daylightSaving) {
        failures.push(
          `Daylight Saving Status did not change for ${expected.id} at ${transition.at}`,
        );
      }
      if (!sameState(stateAt(zone, at - 1), previous)) {
        failures.push(
          `before boundary mismatch for ${expected.id} at ${transition.at}`,
        );
      }
      if (!sameState(stateAt(zone, at), transition)) {
        failures.push(
          `exact boundary mismatch for ${expected.id} at ${transition.at}`,
        );
      }
      if (!sameState(stateAt(zone, at + 1), transition)) {
        failures.push(
          `after boundary mismatch for ${expected.id} at ${transition.at}`,
        );
      }
      boundaryChecks += 3;
      previous = transition;
      previousAt = at;
    }
    if (!sameState(stateAt(zone, coverageStartMs), zone.initial)) {
      failures.push(`coverage start mismatch for ${expected.id}`);
    }
    if (!sameState(stateAt(zone, validityHorizonMs), previous)) {
      failures.push(`Validity Horizon mismatch for ${expected.id}`);
    }
    boundaryChecks += 2;
  }

  if (parsed !== undefined) {
    for (const [alias, expected] of Object.entries(REVIEWED_ALIASES)) {
      if (resolveIanaLink(alias, parsed) !== expected) {
        failures.push(`alias ${alias} does not resolve to ${expected}`);
      }
    }
    const tabText = parsed.files.get('zone1970.tab');
    const legacyTabText = parsed.files.get('zone.tab');
    const tabIds = new Set();
    for (const bytes of [tabText, legacyTabText]) {
      if (bytes === undefined) continue;
      for (const line of strictUtf8(bytes, 'zone table').split(/\r?\n/)) {
        if (line.startsWith('#') || line.trim() === '') continue;
        const columns = line.split('\t');
        if (columns[2] !== undefined) tabIds.add(columns[2]);
      }
    }
    for (const expected of expectedZones) {
      if (!tabIds.has(expected.id))
        failures.push(`zone table omits ${expected.id}`);
    }
  }

  if (failures.length > 0) fail(failures.join('; '));
  return {
    boundaryChecks,
    zones: expectedZones.length,
    status: 'passed',
  };
}

function transitionMap(zone) {
  return new Map(
    zone.transitions.map((transition) => [transition.at, transition]),
  );
}

function stateSummary(state) {
  return {
    abbreviation: state.abbreviation,
    daylightSaving: state.daylightSaving,
    utcOffsetSeconds: state.utcOffsetSeconds,
  };
}

export function semanticDiff(before, after) {
  const lines = [
    `Source: ${before.source.version} (${before.source.archiveSha256}) -> ${after.source.version} (${after.source.archiveSha256})`,
    `Coverage: ${before.coverage.startsAt} -> ${after.coverage.startsAt}`,
    `Validity Horizon: ${before.coverage.validUntil} -> ${after.coverage.validUntil}`,
  ];
  const differences = [];
  if (before.coverage.startsAt !== after.coverage.startsAt) {
    differences.push({
      after: after.coverage.startsAt,
      before: before.coverage.startsAt,
      field: 'startsAt',
      kind: 'coverage-changed',
    });
  }
  if (before.coverage.validUntil !== after.coverage.validUntil) {
    differences.push({
      after: after.coverage.validUntil,
      before: before.coverage.validUntil,
      field: 'validUntil',
      kind: 'validity-changed',
    });
  }

  const beforeZones = new Map(before.zones.map((zone) => [zone.id, zone]));
  const afterZones = new Map(after.zones.map((zone) => [zone.id, zone]));
  const allIds = [
    ...new Set([...beforeZones.keys(), ...afterZones.keys()]),
  ].sort();
  for (const id of allIds) {
    const previous = beforeZones.get(id);
    const current = afterZones.get(id);
    if (previous === undefined) {
      lines.push(`Zone added: ${id}`);
      differences.push({ id, kind: 'zone-added' });
      continue;
    }
    if (current === undefined) {
      lines.push(`Zone removed: ${id}`);
      differences.push({ id, kind: 'zone-removed' });
      continue;
    }
    const zoneLines = [];
    if (previous.friendlyLabel !== current.friendlyLabel) {
      zoneLines.push(
        `  label: ${previous.friendlyLabel} -> ${current.friendlyLabel}`,
      );
      differences.push({
        after: current.friendlyLabel,
        before: previous.friendlyLabel,
        kind: 'zone-label-changed',
        zone: id,
      });
    }
    if (!sameState(previous.initial, current.initial)) {
      zoneLines.push(
        `  initial state: ${previous.initial.abbreviation} ${previous.initial.utcOffsetSeconds}/${previous.initial.daylightSaving} -> ${current.initial.abbreviation} ${current.initial.utcOffsetSeconds}/${current.initial.daylightSaving}`,
      );
      differences.push({
        after: stateSummary(current.initial),
        before: stateSummary(previous.initial),
        kind: 'initial-state-changed',
        zone: id,
      });
    }
    const previousTransitions = transitionMap(previous);
    const currentTransitions = transitionMap(current);
    const transitionTimes = [
      ...new Set([...previousTransitions.keys(), ...currentTransitions.keys()]),
    ].sort();
    for (const at of transitionTimes) {
      const oldTransition = previousTransitions.get(at);
      const newTransition = currentTransitions.get(at);
      if (oldTransition === undefined) {
        zoneLines.push(
          `  transition added: ${at} ${newTransition.abbreviation} offset ${newTransition.offsetBeforeSeconds} -> ${newTransition.utcOffsetSeconds}, DST ${newTransition.daylightSaving}`,
        );
        differences.push({
          at,
          kind: 'transition-added',
          transition: { ...newTransition },
          zone: id,
        });
      } else if (newTransition === undefined) {
        zoneLines.push(
          `  transition removed: ${at} ${oldTransition.abbreviation} offset ${oldTransition.offsetBeforeSeconds} -> ${oldTransition.utcOffsetSeconds}, DST ${oldTransition.daylightSaving}`,
        );
        differences.push({
          at,
          kind: 'transition-removed',
          transition: { ...oldTransition },
          zone: id,
        });
      } else if (
        oldTransition.offsetBeforeSeconds !==
          newTransition.offsetBeforeSeconds ||
        oldTransition.utcOffsetSeconds !== newTransition.utcOffsetSeconds ||
        oldTransition.daylightSaving !== newTransition.daylightSaving ||
        oldTransition.abbreviation !== newTransition.abbreviation
      ) {
        zoneLines.push(
          `  transition changed: ${at} ${oldTransition.abbreviation} -> ${newTransition.abbreviation}, offset ${oldTransition.offsetBeforeSeconds}/${oldTransition.utcOffsetSeconds} -> ${newTransition.offsetBeforeSeconds}/${newTransition.utcOffsetSeconds}, DST ${oldTransition.daylightSaving} -> ${newTransition.daylightSaving}`,
        );
        differences.push({
          after: { ...newTransition },
          at,
          before: { ...oldTransition },
          kind: 'transition-changed',
          zone: id,
        });
      }
    }
    if (zoneLines.length > 0) lines.push(`Zone ${id}:`, ...zoneLines);
  }
  if (differences.length === 0) {
    lines.push('Civil-time changes: none.');
  } else {
    lines.unshift(`Civil-time changes: ${differences.length}`);
  }
  return { text: `${lines.join('\n')}\n`, differences };
}

export function assertReviewedSemanticDiff(
  expected,
  actual,
  archiveSha256,
  sourceVersion,
) {
  if (actual.differences.length === 0) return;
  if (expected === undefined) {
    fail(
      'unexplained civil-time difference; reviewed expected diff with evidence is required',
    );
  }
  if (
    typeof expected !== 'object' ||
    expected === null ||
    Array.isArray(expected)
  ) {
    fail('reviewed expected diff must be an object');
  }
  if (
    expected.sourceVersion !== sourceVersion ||
    expected.archiveSha256 !== archiveSha256
  ) {
    fail('reviewed expected diff does not identify this verified archive');
  }
  if (
    typeof expected.explanation !== 'string' ||
    expected.explanation.trim().length === 0
  ) {
    fail('reviewed expected diff requires a human explanation');
  }
  if (!Array.isArray(expected.evidence) || expected.evidence.length === 0) {
    fail('reviewed expected diff requires IANA evidence');
  }
  for (const evidence of expected.evidence) {
    if (
      typeof evidence !== 'object' ||
      evidence === null ||
      typeof evidence.url !== 'string' ||
      !/^https:\/\//.test(evidence.url) ||
      typeof evidence.description !== 'string' ||
      evidence.description.trim().length === 0 ||
      !Array.isArray(evidence.supports) ||
      evidence.supports.length === 0 ||
      evidence.supports.some(
        (index) =>
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= actual.differences.length,
      )
    ) {
      fail(
        'reviewed expected diff evidence must contain an HTTPS URL, explanation, and supported change indexes',
      );
    }
  }
  const supportedChanges = new Set(
    expected.evidence.flatMap((evidence) => evidence.supports),
  );
  if (actual.differences.some((_, index) => !supportedChanges.has(index))) {
    fail('reviewed expected diff evidence must cover every change');
  }
  if (
    !Array.isArray(expected.differences) ||
    JSON.stringify(expected.differences) !== JSON.stringify(actual.differences)
  ) {
    fail(
      'reviewed expected diff does not match generated semantic differences',
    );
  }
}

export { REVIEWED_ALIASES };
