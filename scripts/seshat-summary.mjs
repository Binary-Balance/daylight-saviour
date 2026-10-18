// Summarises a Seshat JSON report as Markdown: threshold results, the
// functions that miss them and the type-safety sites, which Seshat's own
// report does not list.
import { readFileSync } from 'node:fs';

const [path] = process.argv.slice(2);
const report = JSON.parse(readFileSync(path, 'utf8'));
const limits = Object.fromEntries(
  (report.quality?.checks ?? []).map((check) => [check.metric, check.limit]),
);
const round = (value) =>
  typeof value === 'number' ? Number(value.toFixed(1)) : 'n/a';

console.log(
  `### Seshat \`${report.command}\`: ${report.quality?.state ?? 'not evaluated'}`,
);
console.log(`\nComplete: ${report.complete}`);
if (report.result?.error) console.log(`\nError: ${report.result.error}`);

console.log(
  '\n| Check | Limit | Actual | State |\n| --- | ---: | ---: | --- |',
);
const checks = report.quality?.checks ?? [];
for (const check of checks) {
  const metric = check.setup
    ? `${check.metric} (${check.setup})`
    : check.metric;
  console.log(
    `| ${metric} | ${check.limit} | ${round(check.actual)} | ${check.state} |`,
  );
}
for (const check of checks.filter(
  (check) => check.error && check.error !== report.result?.error,
)) {
  console.log(`\n${check.metric}: ${check.error}`);
}

const sources = report.result?.sources ?? [];
for (const source of sources.filter((source) => source.error)) {
  console.log(`\nError in \`${source.path}\`: ${source.error}`);
}

const overLimit = sources.flatMap((source) =>
  (source.result?.functions ?? [])
    .filter(
      (fn) =>
        fn.crap > limits.maxCrap ||
        fn.cognitiveComplexity > limits.maxCognitiveComplexity,
    )
    .map(
      (fn) =>
        `- \`${source.path}\` \`${fn.name}\`: CRAP ${round(fn.crap)}, cognitive ${fn.cognitiveComplexity}`,
    ),
);
if (overLimit.length > 0) {
  console.log(`\nFunctions over a limit (${overLimit.length}):\n`);
  console.log(overLimit.join('\n'));
}

// Function rows hold their own sites; a source's own typeSafety holds the
// sites outside any function.
const inferredAny = (typeSafety) =>
  (typeSafety?.inferredAny ?? []).reduce(
    (sum, { count }) => sum + (count ?? 0),
    0,
  );
const escapes = (counts) =>
  (counts?.explicitAny ?? 0) +
  (counts?.tsIgnore ?? 0) +
  (counts?.tsExpectError ?? 0) +
  (counts?.tsNocheck ?? 0);
const typeSites = sources
  .flatMap((source) => [
    ...(source.result?.functions ?? []).map((fn) => ({
      path: source.path,
      name: fn.name,
      any: inferredAny(fn.typeSafety),
      escapes: escapes(fn.typeSafety),
    })),
    {
      path: source.path,
      name: '(outside functions)',
      any: inferredAny(source.result?.typeSafety),
      escapes: escapes(source.result?.typeSafety?.unowned),
    },
  ])
  .filter((site) => site.any > 0 || site.escapes > 0)
  .map(
    (site) =>
      `- \`${site.path}\` \`${site.name}\`: inferred any ${site.any}, escapes ${site.escapes}`,
  );
if (typeSites.length > 0) {
  console.log(`\nType-safety sites (${typeSites.length}):\n`);
  console.log(typeSites.join('\n'));
}

const mutation = report.result?.mutation;
if (mutation) {
  const score =
    mutation.score === null ? 'withheld' : `${round(mutation.score)}%`;
  console.log(
    `\nMutation score: ${score} (killed ${mutation.killed}, survived ${mutation.survived}, unresolved ${mutation.unresolved})`,
  );
}
const pseudo = report.result?.pseudoTesting;
if (pseudo?.pseudoTested > 0) {
  console.log(`\nPseudo-tested functions: ${pseudo.pseudoTested}`);
}
