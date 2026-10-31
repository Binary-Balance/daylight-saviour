import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exceptions, validateAudit } from './audit.mjs';

const zodUrl = 'https://github.com/advisories/GHSA-mrhx-c7xc-m3w5';
const decoderUrl = 'https://github.com/advisories/GHSA-qr28-fpjm-wq7f';
const nodesOf = (packageName) => [
  ...exceptions.find(({ name }) => name === packageName).nodes,
];

const advisory = (name, url, severity) => ({
  source: 1,
  name,
  dependency: name,
  severity,
  url,
});

const audit = () => ({
  metadata: { vulnerabilities: { high: 5, moderate: 2 } },
  vulnerabilities: {
    zod: {
      severity: 'high',
      via: [advisory('zod', zodUrl, 'high')],
      effects: ['@expo/cli'],
      nodes: ['node_modules/zod'],
    },
    '@expo/cli': {
      severity: 'high',
      via: ['zod'],
      effects: [],
      nodes: ['node_modules/@expo/cli'],
    },
    'decode-uri-component': {
      severity: 'high',
      via: [
        advisory(
          'decode-uri-component',
          'https://github.com/advisories/GHSA-vcc3-ghjq-m6fr',
          'moderate',
        ),
        advisory('decode-uri-component', decoderUrl, 'high'),
      ],
      effects: ['query-string'],
      nodes: ['node_modules/decode-uri-component'],
    },
    'query-string': {
      severity: 'high',
      via: ['decode-uri-component'],
      effects: ['expo-router'],
      nodes: ['node_modules/query-string'],
    },
    'expo-router': {
      severity: 'high',
      via: ['query-string'],
      effects: [],
      nodes: ['node_modules/expo-router'],
    },
    glob: {
      severity: 'moderate',
      via: [
        advisory(
          'glob',
          'https://github.com/advisories/GHSA-3g3m-2fjr-6pw4',
          'moderate',
        ),
        'minimatch',
      ],
      effects: [],
      nodes: nodesOf('glob').reverse(),
    },
    minimatch: {
      severity: 'moderate',
      via: [
        advisory(
          'minimatch',
          'https://github.com/advisories/GHSA-g3hv-75wg-m249',
          'moderate',
        ),
      ],
      effects: ['glob'],
      nodes: nodesOf('minimatch'),
    },
  },
});

const lock = {
  packages: {
    'node_modules/expo-router': {
      version: '57.0.29',
      dependencies: { 'query-string': '^7.1.3' },
    },
    'node_modules/query-string': {
      version: '7.1.3',
      dependencies: { 'decode-uri-component': '^0.2.2' },
    },
    'node_modules/decode-uri-component': { version: '0.2.2' },
  },
};
for (const { name, dependents } of exceptions) {
  for (const path of dependents) {
    const entry = (lock.packages[path] ??= {});
    entry.dependencies = { [name]: '*', ...entry.dependencies };
  }
}

const withPackage = (path, entry) => ({
  packages: { ...lock.packages, [path]: entry },
});

test('allows only the temporary exceptions', () => {
  assert.doesNotThrow(() => validateAudit(audit(), lock));
});

test('rejects an unexpected moderate-or-higher advisory', () => {
  const report = audit();
  report.vulnerabilities.zod.via.push(
    advisory('zod', 'https://github.com/advisories/GHSA-other', 'high'),
  );
  assert.throws(() => validateAudit(report, lock), /unexpected advisories/i);
});

test('rejects malformed audit output and audit endpoint errors', () => {
  assert.throws(() => validateAudit({}, lock), /invalid npm audit output/i);
  assert.throws(
    () => validateAudit({ error: { summary: 'offline' } }, lock),
    /npm audit failed/i,
  );
});

test('rejects unresolved audit references', () => {
  const report = audit();
  report.vulnerabilities['@expo/cli'].via = ['missing'];
  assert.throws(
    () => validateAudit(report, lock),
    /unresolved npm audit references/i,
  );
});

test('rejects an audit edge missing its reciprocal effect', () => {
  const report = audit();
  report.vulnerabilities.evil = {
    severity: 'critical',
    via: ['decode-uri-component'],
    effects: [],
    nodes: ['node_modules/evil'],
  };
  assert.throws(
    () => validateAudit(report, lock),
    /unreciprocated npm audit references/i,
  );
});

test('rejects an audit effect missing its reciprocal reference', () => {
  const report = audit();
  report.vulnerabilities.zod.effects = ['@expo/cli', 'evil'];
  assert.throws(
    () => validateAudit(report, lock),
    /unreciprocated npm audit effects/i,
  );
});

test('rejects a moderate-or-higher record without an advisory chain', () => {
  const report = audit();
  report.vulnerabilities.evil = { severity: 'critical', via: [] };
  assert.throws(
    () => validateAudit(report, lock),
    /unexpected npm audit vulnerability chains/i,
  );
});

test('rejects a vulnerability record without a valid severity', () => {
  const report = audit();
  report.vulnerabilities.evil = { severity: 'urgent', via: ['zod'] };
  assert.throws(
    () => validateAudit(report, lock),
    /invalid npm audit vulnerabilities/i,
  );
});

test('rejects an advisory without a valid severity', () => {
  const report = audit();
  report.vulnerabilities.zod.via.push({
    name: 'other',
    dependency: 'other',
    url: 'https://example.test/other',
  });
  assert.throws(
    () => validateAudit(report, lock),
    /invalid npm audit advisories/i,
  );
});

test('requires every temporary exception to still apply', () => {
  const report = audit();
  delete report.vulnerabilities.zod;
  delete report.vulnerabilities['@expo/cli'];
  assert.throws(
    () => validateAudit(report, lock),
    /no longer apply: zod; remove them/i,
  );
});

test('requires each exception for a package with two advisories', () => {
  const report = audit();
  report.vulnerabilities['decode-uri-component'].via.pop();
  assert.throws(
    () => validateAudit(report, lock),
    /no longer apply: decode-uri-component; remove them/i,
  );
});

test('rejects an unlisted advisory on a package with an exception', () => {
  const report = audit();
  report.vulnerabilities.glob.via.push(
    advisory('glob', 'https://example.com/other', 'moderate'),
  );
  assert.throws(() => validateAudit(report, lock), /unexpected advisories/i);
});

test('rejects an excepted advisory whose severity changed', () => {
  const report = audit();
  report.vulnerabilities.zod.severity = 'critical';
  report.vulnerabilities.zod.via[0].severity = 'critical';
  assert.throws(() => validateAudit(report, lock), /unexpected advisories/i);
});

test('rejects a second installed copy of an excepted package', () => {
  const report = audit();
  report.vulnerabilities.zod.nodes.push('node_modules/other/zod');
  assert.throws(() => validateAudit(report, lock), /unexpected advisories/i);
});

test('rejects a new installed copy of a package with several', () => {
  const report = audit();
  report.vulnerabilities.glob.nodes.push('node_modules/other/glob');
  assert.throws(() => validateAudit(report, lock), /unexpected advisories/i);
});

test('rejects a removed installed copy of a package with several', () => {
  const report = audit();
  report.vulnerabilities.minimatch.nodes.pop();
  assert.throws(() => validateAudit(report, lock), /unexpected advisories/i);
});

test('rejects a replaced installed copy of a package with several', () => {
  const report = audit();
  report.vulnerabilities.minimatch.nodes[0] = 'node_modules/other/minimatch';
  assert.throws(() => validateAudit(report, lock), /unexpected advisories/i);
});

test('rejects an excepted package with a new direct dependent', () => {
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    assert.throws(
      () =>
        validateAudit(
          audit(),
          withPackage('node_modules/other', { [field]: { zod: '' } }),
        ),
      /unexpected advisories/i,
      field,
    );
  }
});

test('rejects a changed decoder chain or lockfile version', () => {
  for (const selectedLock of [
    withPackage('node_modules/other', {
      dependencies: { 'query-string': '*' },
    }),
    withPackage('node_modules/query-string', {
      ...lock.packages['node_modules/query-string'],
      version: '7.1.4',
    }),
    withPackage('node_modules/expo-router', {
      ...lock.packages['node_modules/expo-router'],
      version: '57.0.30',
    }),
  ]) {
    assert.throws(
      () => validateAudit(audit(), selectedLock),
      /temporary decode-uri-component exception changed/i,
    );
  }
});
