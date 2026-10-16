import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateAudit } from './audit.mjs';

const bracesUrl = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';

const advisory = (name, url, severity) => ({
  source: 1,
  name,
  dependency: name,
  severity,
  url,
});

const leaf = (name, url, severity) => ({
  severity,
  via: [advisory(name, url, severity)],
  effects: [],
  nodes: [`node_modules/${name}`],
});

const audit = () => ({
  metadata: { vulnerabilities: { high: 2, moderate: 5 } },
  vulnerabilities: {
    braces: {
      severity: 'high',
      via: [advisory('braces', bracesUrl, 'high')],
      effects: ['micromatch'],
      nodes: ['node_modules/braces'],
    },
    micromatch: {
      severity: 'high',
      via: ['braces'],
      effects: [],
      nodes: ['node_modules/micromatch'],
    },
    'decode-uri-component': {
      severity: 'moderate',
      via: [
        advisory(
          'decode-uri-component',
          'https://github.com/advisories/GHSA-vcc3-ghjq-m6fr',
          'moderate',
        ),
      ],
      effects: ['query-string'],
      nodes: ['node_modules/decode-uri-component'],
    },
    'query-string': {
      severity: 'moderate',
      via: ['decode-uri-component'],
      effects: ['expo-router'],
      nodes: ['node_modules/query-string'],
    },
    'expo-router': {
      severity: 'moderate',
      via: ['query-string'],
      effects: [],
      nodes: ['node_modules/expo-router'],
    },
    'node-forge': leaf(
      'node-forge',
      'https://github.com/advisories/GHSA-86w9-cpqp-85rv',
      'high',
    ),
    'sprintf-js': leaf(
      'sprintf-js',
      'https://github.com/advisories/GHSA-hp3w-g68c-fv3c',
      'moderate',
    ),
  },
});

const lock = {
  packages: {
    'node_modules/micromatch': { dependencies: { braces: '^3.0.3' } },
    'node_modules/expo-router': {
      version: '57.0.28',
      dependencies: { 'query-string': '^7.1.3' },
    },
    'node_modules/query-string': {
      version: '7.1.3',
      dependencies: { 'decode-uri-component': '^0.2.2' },
    },
    'node_modules/decode-uri-component': { version: '0.2.2' },
    'node_modules/@expo/cli': { dependencies: { 'node-forge': '^1.3.3' } },
    'node_modules/@expo/code-signing-certificates': {
      dependencies: { 'node-forge': '^1.3.3' },
    },
    'node_modules/@istanbuljs/load-nyc-config/node_modules/argparse': {
      dependencies: { 'sprintf-js': '~1.0.2' },
    },
  },
};

const withPackage = (path, entry) => ({
  packages: { ...lock.packages, [path]: entry },
});

test('allows only the temporary exceptions', () => {
  assert.doesNotThrow(() => validateAudit(audit(), lock));
});

test('rejects an unexpected moderate-or-higher advisory', () => {
  const report = audit();
  report.vulnerabilities.braces.via.push(
    advisory('braces', 'https://github.com/advisories/GHSA-other', 'high'),
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
  report.vulnerabilities.micromatch.via = ['missing'];
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
  report.vulnerabilities.braces.effects = ['micromatch', 'evil'];
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
  report.vulnerabilities.evil = { severity: 'urgent', via: ['braces'] };
  assert.throws(
    () => validateAudit(report, lock),
    /invalid npm audit vulnerabilities/i,
  );
});

test('rejects an advisory without a valid severity', () => {
  const report = audit();
  report.vulnerabilities.braces.via.push({
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
  delete report.vulnerabilities.braces;
  delete report.vulnerabilities.micromatch;
  assert.throws(
    () => validateAudit(report, lock),
    /no longer apply: braces; remove them/i,
  );
});

test('rejects an excepted advisory whose severity changed', () => {
  const report = audit();
  report.vulnerabilities.braces.severity = 'critical';
  report.vulnerabilities.braces.via[0].severity = 'critical';
  assert.throws(() => validateAudit(report, lock), /unexpected advisories/i);
});

test('rejects a second installed copy of an excepted package', () => {
  const report = audit();
  report.vulnerabilities.braces.nodes.push('node_modules/other/braces');
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
          withPackage('node_modules/other', { [field]: { braces: '' } }),
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
      version: '57.0.29',
    }),
  ]) {
    assert.throws(
      () => validateAudit(audit(), selectedLock),
      /temporary decode-uri-component exception changed/i,
    );
  }
});
