// Summarises a Seshat JSON report as Markdown: threshold results and the
// functions that miss them, which Seshat's own report does not list.
import { readFileSync } from 'node:fs';

const [path] = process.argv.slice(2);
const report = JSON.parse(readFileSync(path, 'utf8'));
const limits = Object.fromEntries(
  (report.quality?.checks ?? []).map((check) => [check.metric, check.limit]),
);
const round = (value) =>
  typeof value === 'number' ? Number(value.toFixed(1)) : 'n/a';

console.log(`### Seshat \`${report.command}\`: ${report.quality?.state}`);
console.log(`\nComplete: ${report.complete}`);
if (report.result?.error) console.log(`\nError: ${report.result.error}`);

console.log(
  '\n| Check | Limit | Actual | State |\n| --- | ---: | ---: | --- |',
);
for (const check of report.quality?.checks ?? []) {
  console.log(
    `| ${check.metric} | ${check.limit} | ${round(check.actual)} | ${check.state} |`,
  );
}

const overLimit = (report.result?.sources ?? []).flatMap((source) =>
  (source.result.functions ?? [])
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
