import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCEPTED_ADVISORY_SOURCE,
  assertAuditReport,
  evaluateAuditReport,
} from './audit-dependencies.mjs';

const beforeExpiry = new Date('2026-07-26T00:00:00.000Z');
const acceptedReport = {
  vulnerabilities: {
    'brace-expansion': {
      severity: 'high',
      nodes: ['node_modules/brace-expansion'],
      via: [
        {
          source: ACCEPTED_ADVISORY_SOURCE,
          url: 'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
        },
      ],
    },
    minimatch: {
      severity: 'high',
      nodes: ['node_modules/minimatch'],
      via: ['brace-expansion'],
    },
  },
};

test('allows only the accepted root old-API advisory and its recursive effects', () => {
  assert.deepEqual(evaluateAuditReport(acceptedReport, beforeExpiry), []);
});

test('rejects the accepted advisory after its expiry', () => {
  assert.throws(() =>
    assertAuditReport(acceptedReport, new Date('2026-09-01T00:00:00.000Z')),
  );
});

test('rejects another advisory on an otherwise affected package', () => {
  const report = structuredClone(acceptedReport);
  report.vulnerabilities.minimatch.via.push({
    source: 999,
    url: 'https://example.test/GHSA-other',
  });
  assert.deepEqual(evaluateAuditReport(report, beforeExpiry), [
    'minimatch (high)',
  ]);
});

test('rejects an accepted advisory outside the root old-API installation', () => {
  const report = structuredClone(acceptedReport);
  report.vulnerabilities['brace-expansion'].nodes = [
    'node_modules/glob/node_modules/brace-expansion',
  ];
  assert.deepEqual(evaluateAuditReport(report, beforeExpiry), [
    'brace-expansion (high)',
    'minimatch (high)',
  ]);
});

test('rejects a new consumer even when it reaches the accepted advisory', () => {
  const report = structuredClone(acceptedReport);
  report.vulnerabilities['product-runtime-consumer'] = {
    severity: 'high',
    nodes: ['node_modules/product-runtime-consumer'],
    via: ['brace-expansion'],
  };
  assert.deepEqual(evaluateAuditReport(report, beforeExpiry), [
    'product-runtime-consumer (high)',
  ]);
});

test('allows an expected cycle when its closure reaches the accepted root', () => {
  const report = structuredClone(acceptedReport);
  report.vulnerabilities['react-native'] = {
    severity: 'high',
    nodes: ['node_modules/react-native'],
    via: ['@react-native/virtualized-lists'],
  };
  report.vulnerabilities['@react-native/virtualized-lists'] = {
    severity: 'high',
    nodes: ['node_modules/@react-native/virtualized-lists'],
    via: ['react-native', 'brace-expansion'],
  };
  assert.deepEqual(evaluateAuditReport(report, beforeExpiry), []);
});

test('rejects an allowlisted cycle that never reaches the accepted advisory', () => {
  const report = { vulnerabilities: {} };
  report.vulnerabilities['react-native'] = {
    severity: 'high',
    nodes: ['node_modules/react-native'],
    via: ['@react-native/virtualized-lists'],
  };
  report.vulnerabilities['@react-native/virtualized-lists'] = {
    severity: 'high',
    nodes: ['node_modules/@react-native/virtualized-lists'],
    via: ['react-native'],
  };
  assert.deepEqual(evaluateAuditReport(report, beforeExpiry), [
    'react-native (high)',
    '@react-native/virtualized-lists (high)',
  ]);
});

test('rejects a cycle containing another advisory', () => {
  const report = structuredClone(acceptedReport);
  report.vulnerabilities['react-native'] = {
    severity: 'high',
    nodes: ['node_modules/react-native'],
    via: ['@react-native/virtualized-lists'],
  };
  report.vulnerabilities['@react-native/virtualized-lists'] = {
    severity: 'high',
    nodes: ['node_modules/@react-native/virtualized-lists'],
    via: ['react-native', { source: 999, url: 'https://example.test/other' }],
  };
  assert.deepEqual(evaluateAuditReport(report, beforeExpiry), [
    'react-native (high)',
    '@react-native/virtualized-lists (high)',
  ]);
});

test('fails closed on malformed audit JSON', () => {
  assert.throws(() => evaluateAuditReport({}));
});
