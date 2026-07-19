import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultSourcePath = resolve(
  packageDirectory,
  'source/tzdb-2026c-australia-sydney.json',
);
const defaultOutputPath = resolve(
  packageDirectory,
  'generated/australia-sydney.pack.json',
);

function firstWeekdayOnOrAfter(year, month, day, weekday) {
  const candidateWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return day + ((weekday - candidateWeekday + 7) % 7);
}

function transitionInstant(year, rule, standardOffsetSeconds) {
  const day = firstWeekdayOnOrAfter(
    year,
    rule.month,
    rule.onOrAfterDay,
    rule.weekday,
  );
  const localStandardMilliseconds =
    Date.UTC(year, rule.month - 1, day) + rule.atStandardSeconds * 1_000;

  return new Date(
    localStandardMilliseconds - standardOffsetSeconds * 1_000,
  ).toISOString();
}

export function generateSydneyPack(source) {
  const transitions = [];
  let offsetBeforeSeconds = source.zone.initial.utcOffsetSeconds;

  for (
    let year = source.generation.firstYear;
    year <= source.generation.lastYear;
    year += 1
  ) {
    for (const rule of source.zone.rules) {
      const utcOffsetSeconds =
        source.zone.standardOffsetSeconds + rule.saveAfterSeconds;
      transitions.push({
        abbreviation: rule.abbreviationAfter,
        at: transitionInstant(year, rule, source.zone.standardOffsetSeconds),
        daylightSaving: rule.daylightSavingAfter,
        offsetBeforeSeconds,
        utcOffsetSeconds,
      });
      offsetBeforeSeconds = utcOffsetSeconds;
    }
  }

  return {
    coverage: {
      startsAt: source.generation.coverageStartsAt,
      validUntil: source.generation.validUntil,
    },
    generatedAt: source.generation.generatedAt,
    packVersion: source.generation.packVersion,
    schemaVersion: source.generation.schemaVersion,
    source: source.source,
    zones: [
      {
        friendlyLabel: source.zone.friendlyLabel,
        id: source.zone.id,
        initial: source.zone.initial,
        transitions,
      },
    ],
  };
}

export async function generateSydneyPackBytes(sourcePath = defaultSourcePath) {
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  return `${JSON.stringify(generateSydneyPack(source), null, 2)}\n`;
}

async function main() {
  await writeFile(defaultOutputPath, await generateSydneyPackBytes(), 'utf8');
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
