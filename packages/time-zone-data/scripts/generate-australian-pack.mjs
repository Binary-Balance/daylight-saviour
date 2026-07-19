import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultSourcePath = resolve(
  packageDirectory,
  'source/tzdb-2026c-australian-coverage.json',
);
const defaultOutputPath = resolve(
  packageDirectory,
  'generated/australian-coverage.pack.json',
);

function firstWeekdayOnOrAfter(year, month, day, weekday) {
  const candidateWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return day + ((weekday - candidateWeekday + 7) % 7);
}

function transitionInstant(year, rule, zone, offsetBeforeSeconds) {
  const day = firstWeekdayOnOrAfter(
    year,
    rule.month,
    rule.onOrAfterDay,
    rule.weekday,
  );
  const localMilliseconds =
    Date.UTC(year, rule.month - 1, day) + rule.atSeconds * 1_000;
  const interpretationOffset =
    rule.atBasis === 'standard' ? zone.baseOffsetSeconds : offsetBeforeSeconds;

  return new Date(
    localMilliseconds - interpretationOffset * 1_000,
  ).toISOString();
}

function generateTransitions(source, zone) {
  if (zone.ruleSet === null) {
    return [];
  }

  const ruleSet = source.ruleSets[zone.ruleSet];
  const transitions = [];
  let offsetBeforeSeconds =
    zone.baseOffsetSeconds + ruleSet.daylightSaveSeconds;

  for (
    let year = source.generation.firstYear;
    year <= source.generation.lastYear;
    year += 1
  ) {
    for (const rule of ruleSet.rules) {
      const daylightSaving = rule.saveAfterSeconds > 0;
      const utcOffsetSeconds = zone.baseOffsetSeconds + rule.saveAfterSeconds;
      transitions.push({
        abbreviation: daylightSaving
          ? zone.daylightAbbreviation
          : zone.standardAbbreviation,
        at: transitionInstant(year, rule, zone, offsetBeforeSeconds),
        daylightSaving,
        offsetBeforeSeconds,
        utcOffsetSeconds,
      });
      offsetBeforeSeconds = utcOffsetSeconds;
    }
  }

  return transitions;
}

export function generateAustralianPack(source) {
  return {
    coverage: {
      startsAt: source.generation.coverageStartsAt,
      validUntil: source.generation.validUntil,
    },
    generatedAt: source.generation.generatedAt,
    packVersion: source.generation.packVersion,
    schemaVersion: source.generation.schemaVersion,
    source: source.source,
    zones: source.zones.map((zone) => {
      const ruleSet =
        zone.ruleSet === null ? null : source.ruleSets[zone.ruleSet];
      const daylightSaving = ruleSet !== null;
      return {
        friendlyLabel: zone.friendlyLabel,
        id: zone.id,
        initial: {
          abbreviation: daylightSaving
            ? zone.daylightAbbreviation
            : zone.standardAbbreviation,
          daylightSaving,
          utcOffsetSeconds:
            zone.baseOffsetSeconds + (ruleSet?.daylightSaveSeconds ?? 0),
        },
        transitions: generateTransitions(source, zone),
      };
    }),
  };
}

export async function generateAustralianPackBytes(
  sourcePath = defaultSourcePath,
) {
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  return `${JSON.stringify(generateAustralianPack(source), null, 2)}\n`;
}

async function main() {
  await writeFile(
    defaultOutputPath,
    await generateAustralianPackBytes(),
    'utf8',
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
