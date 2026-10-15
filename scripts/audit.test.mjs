import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateAudit } from './audit.mjs';

const allowedAdvisory = (url) => ({
  source: 1,
  name: 'image-size',
  dependency: 'image-size',
  severity: 'high',
  url,
});

const decoderAdvisory = (overrides = {}) => ({
  source: 2,
  name: 'decode-uri-component',
  dependency: 'decode-uri-component',
  severity: 'moderate',
  url: 'https://github.com/advisories/GHSA-vcc3-ghjq-m6fr',
  ...overrides,
});

const toolingAdvisory = (name, url, severity = 'high') => ({
  severity,
  via: [{ source: 3, name, dependency: name, severity, url }],
  effects: [],
  nodes: [`node_modules/${name}`],
});

const audit = (via, options = {}) => ({
  metadata: { vulnerabilities: { high: 1 } },
  vulnerabilities: {
    'image-size': {
      severity: 'high',
      via,
      effects: options.imageEffects ?? ['metro'],
      nodes: options.imageNodes ?? ['node_modules/image-size'],
    },
    metro: {
      severity: 'high',
      via: ['image-size'],
      effects: [],
      nodes: ['node_modules/metro'],
    },
    'decode-uri-component': {
      severity: options.decoderSeverity ?? 'moderate',
      via: [decoderAdvisory(options.decoderAdvisory)],
      effects: ['query-string'],
      nodes: options.decoderNodes ?? ['node_modules/decode-uri-component'],
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
    braces: toolingAdvisory(
      'braces',
      'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
    ),
    'node-forge': toolingAdvisory(
      'node-forge',
      'https://github.com/advisories/GHSA-86w9-cpqp-85rv',
    ),
    'sprintf-js': toolingAdvisory(
      'sprintf-js',
      'https://github.com/advisories/GHSA-hp3w-g68c-fv3c',
      'moderate',
    ),
  },
});

const lock = {
  packages: {
    'node_modules/image-size': { version: '1.2.1' },
    'node_modules/metro': { dependencies: { 'image-size': '^1.0.2' } },
    'node_modules/expo-router': {
      version: '57.0.27',
      dependencies: { 'query-string': '^7.1.3' },
    },
    'node_modules/query-string': {
      version: '7.1.3',
      dependencies: { 'decode-uri-component': '^0.2.2' },
    },
    'node_modules/decode-uri-component': { version: '0.2.2' },
    'node_modules/micromatch': { dependencies: { braces: '^3.0.3' } },
    'node_modules/@expo/cli': { dependencies: { 'node-forge': '^1.3.3' } },
    'node_modules/@expo/code-signing-certificates': {
      dependencies: { 'node-forge': '^1.3.3' },
    },
    'node_modules/@istanbuljs/load-nyc-config/node_modules/argparse': {
      dependencies: { 'sprintf-js': '~1.0.2' },
    },
  },
};

const withDependent = (path, name) => ({
  packages: {
    ...lock.packages,
    [path]: { dependencies: { [name]: '*' } },
  },
});

test('allows only the temporary exceptions', () => {
  assert.doesNotThrow(() =>
    validateAudit(
      audit([
        allowedAdvisory('https://github.com/advisories/GHSA-w3rx-r6r6-pgpr'),
        allowedAdvisory('https://github.com/advisories/GHSA-5p2g-fcmc-qvqq'),
      ]),
      lock,
    ),
  );
});

test('rejects an unexpected moderate-or-higher advisory', () => {
  assert.throws(
    () =>
      validateAudit(
        audit([
          allowedAdvisory('https://github.com/advisories/GHSA-w3rx-r6r6-pgpr'),
          {
            ...allowedAdvisory('https://github.com/advisories/GHSA-other'),
            name: 'other',
          },
        ]),
        lock,
      ),
    /unexpected advisories/i,
  );
});

test('rejects malformed audit output and audit endpoint errors', () => {
  assert.throws(() => validateAudit({}, lock), /invalid npm audit output/i);
  assert.throws(
    () => validateAudit({ error: { summary: 'offline' } }, lock),
    /npm audit failed/i,
  );
});

test('rejects unresolved audit references', () => {
  const report = audit([
    allowedAdvisory('https://github.com/advisories/GHSA-w3rx-r6r6-pgpr'),
    allowedAdvisory('https://github.com/advisories/GHSA-5p2g-fcmc-qvqq'),
  ]);
  report.vulnerabilities.metro = { severity: 'high', via: ['missing'] };
  assert.throws(
    () => validateAudit(report, lock),
    /unresolved npm audit references/i,
  );
});

test('rejects an audit edge missing its reciprocal effect', () => {
  const report = audit([
    allowedAdvisory('https://github.com/advisories/GHSA-w3rx-r6r6-pgpr'),
  ]);
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
  const report = audit([
    allowedAdvisory('https://github.com/advisories/GHSA-w3rx-r6r6-pgpr'),
  ]);
  report.vulnerabilities['image-size'].effects = ['metro', 'evil'];
  assert.throws(
    () => validateAudit(report, lock),
    /unreciprocated npm audit effects/i,
  );
});

test('rejects a moderate-or-higher record without an advisory chain', () => {
  const report = audit([
    allowedAdvisory('https://github.com/advisories/GHSA-w3rx-r6r6-pgpr'),
  ]);
  report.vulnerabilities.evil = { severity: 'critical', via: [] };
  assert.throws(
    () => validateAudit(report, lock),
    /unexpected npm audit vulnerability chains/i,
  );
});

test('rejects a vulnerability record without a valid severity', () => {
  const report = audit([
    allowedAdvisory('https://github.com/advisories/GHSA-w3rx-r6r6-pgpr'),
  ]);
  report.vulnerabilities.evil = { severity: 'urgent', via: ['image-size'] };
  assert.throws(
    () => validateAudit(report, lock),
    /invalid npm audit vulnerabilities/i,
  );
});

test('rejects an advisory without a valid severity', () => {
  const report = audit([
    allowedAdvisory('https://github.com/advisories/GHSA-w3rx-r6r6-pgpr'),
    { name: 'other', dependency: 'other', url: 'https://example.test/other' },
  ]);
  assert.throws(
    () => validateAudit(report, lock),
    /invalid npm audit advisories/i,
  );
});

test('requires every temporary exception to still apply', () => {
  assert.throws(
    () => validateAudit(audit([]), lock),
    /no longer apply: image-size/i,
  );
});

test('rejects an excepted package reached through another dependent', () => {
  assert.throws(
    () =>
      validateAudit(
        audit([
          allowedAdvisory('https://github.com/advisories/GHSA-w3rx-r6r6-pgpr'),
        ]),
        withDependent('node_modules/other', 'braces'),
      ),
    /unexpected advisories/i,
  );
});

test('rejects the exception outside the installed Metro path', () => {
  const report = audit(
    [allowedAdvisory('https://github.com/advisories/GHSA-w3rx-r6r6-pgpr')],
    {
      imageEffects: ['other'],
      imageNodes: ['node_modules/other/image-size'],
    },
  );
  report.vulnerabilities.other = {
    severity: 'high',
    via: ['image-size'],
    effects: [],
    nodes: ['node_modules/other'],
  };
  delete report.vulnerabilities.metro;
  assert.throws(() => validateAudit(report, lock), /unexpected advisories/i);
});

test('allows only the exact temporary Expo Router decoder chain', () => {
  assert.doesNotThrow(() =>
    validateAudit(
      audit([
        allowedAdvisory('https://github.com/advisories/GHSA-w3rx-r6r6-pgpr'),
      ]),
      lock,
    ),
  );
});

test('rejects a changed decoder advisory, path, node, or lockfile version', () => {
  for (const [report, selectedLock] of [
    [
      audit(
        [allowedAdvisory('https://github.com/advisories/GHSA-w3rx-r6r6-pgpr')],
        {
          decoderAdvisory: { url: 'https://github.com/advisories/GHSA-other' },
        },
      ),
      lock,
    ],
    [
      audit(
        [allowedAdvisory('https://github.com/advisories/GHSA-w3rx-r6r6-pgpr')],
        {
          decoderNodes: ['node_modules/other/decode-uri-component'],
        },
      ),
      lock,
    ],
    [
      audit([
        allowedAdvisory('https://github.com/advisories/GHSA-w3rx-r6r6-pgpr'),
      ]),
      withDependent('node_modules/other', 'query-string'),
    ],
    [
      audit([
        allowedAdvisory('https://github.com/advisories/GHSA-w3rx-r6r6-pgpr'),
      ]),
      {
        packages: {
          ...lock.packages,
          'node_modules/query-string': {
            ...lock.packages['node_modules/query-string'],
            version: '7.1.4',
          },
        },
      },
    ],
    [
      audit([
        allowedAdvisory('https://github.com/advisories/GHSA-w3rx-r6r6-pgpr'),
      ]),
      {
        packages: {
          ...lock.packages,
          'node_modules/expo-router': {
            ...lock.packages['node_modules/expo-router'],
            version: '57.0.19',
          },
        },
      },
    ],
  ]) {
    assert.throws(
      () => validateAudit(report, selectedLock),
      /temporary decode-uri-component exception changed|unexpected advisories/i,
    );
  }
});
