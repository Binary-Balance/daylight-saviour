// Seshat coverage adapter for Node's built-in test runner, adapted from
// Seshat's workspace example. It instruments TypeScript directly rather than
// transpiling first: transpiler source maps lose the end of multi-line
// operands, which leaves Seshat unable to match those branches to source.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import coverage from 'istanbul-lib-coverage';
import instrument from 'istanbul-lib-instrument';

const report = process.env.SESHAT_COVERAGE_REPORT;
const sourceList = process.env.SESHAT_SOURCES;
assert.ok(report && sourceList, 'Seshat coverage environment is missing');

const directory = dirname(report);
const counters = join(directory, 'counters');
mkdirSync(counters, { recursive: true });

const initial = coverage.createCoverageMap({});
const instrumenter = instrument.createInstrumenter({
  esModules: true,
  parserPlugins: ['typescript', 'importAttributes'],
});
const prepared = {};

for (const path of JSON.parse(readFileSync(sourceList, 'utf8'))) {
  prepared[pathToFileURL(path).href] = instrumenter.instrumentSync(
    readFileSync(path, 'utf8'),
    path,
  );
  initial.addFileCoverage(instrumenter.lastFileCoverage());
}

const hook = join(directory, 'hook.mjs');
writeFileSync(
  hook,
  `import {registerHooks} from 'node:module';import {writeFileSync} from 'node:fs';
const prepared=${JSON.stringify(prepared)};
registerHooks({load(url,context,next){return Object.hasOwn(prepared,url)?{format:'module-typescript',shortCircuit:true,source:prepared[url]}:next(url,context);}});
process.on('exit',()=>{if(globalThis.__coverage__)writeFileSync(${JSON.stringify(counters)}+'/'+process.pid+'.json',JSON.stringify(globalThis.__coverage__));});`,
);

const run = spawnSync(
  process.execPath,
  [
    '--import',
    pathToFileURL(hook).href,
    '--test',
    '--test-concurrency=1',
    `--test-reporter=${process.env.SESHAT_NODE_REPORTER}`,
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);
assert.ifError(run.error);
if (run.status !== 0) process.exit(run.status ?? 2);

for (const name of readdirSync(counters)) {
  initial.merge(JSON.parse(readFileSync(join(counters, name), 'utf8')));
}
writeFileSync(report, JSON.stringify(initial.toJSON()));
