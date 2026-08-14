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

const audit = (via, options = {}) => ({
  metadata: { vulnerabilities: { high: 1 } },
  vulnerabilities: {
    'image-size': {
      severity: 'high',
      via,
      effects: options.effects ?? ['metro'],
      nodes: options.nodes ?? ['node_modules/image-size'],
    },
  },
});

const lock = {
  packages: {
    'node_modules/image-size': { version: '1.2.1' },
    'node_modules/metro': { dependencies: { 'image-size': '^1.0.2' } },
  },
};

test('allows only the two image-size advisories through Metro', () => {
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
  report.vulnerabilities.metro = { via: ['missing'] };
  assert.throws(
    () => validateAudit(report, lock),
    /unresolved npm audit references/i,
  );
});

test('requires an active temporary image-size advisory', () => {
  assert.throws(
    () => validateAudit(audit([]), lock),
    /temporary image-size exception changed/i,
  );
});

test('rejects the exception outside the installed Metro path', () => {
  assert.throws(
    () =>
      validateAudit(
        audit(
          [
            allowedAdvisory(
              'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr',
            ),
          ],
          { effects: ['other'], nodes: ['node_modules/other/image-size'] },
        ),
        lock,
      ),
    /unexpected advisories/i,
  );
});
