import { spawnSync } from 'node:child_process';

export const ACCEPTED_ADVISORY_SOURCE = 1124334;
export const ACCEPTED_ADVISORY_ID = 'GHSA-mh99-v99m-4gvg';
export const ACCEPTED_ADVISORY_EXPIRES_AT = '2026-08-31T23:59:59.999Z';
export const ACCEPTED_AFFECTED_PACKAGES = new Set([
  '@eslint/config-array',
  '@eslint/eslintrc',
  '@jest/core',
  '@jest/expect',
  '@jest/globals',
  '@jest/reporters',
  '@jest/transform',
  '@react-native/jest-preset',
  '@react-native/virtualized-lists',
  '@testing-library/react-native',
  'babel-jest',
  'babel-plugin-istanbul',
  'brace-expansion',
  'create-jest',
  'eslint',
  'eslint-config-expo',
  'eslint-plugin-expo',
  'eslint-plugin-import',
  'eslint-plugin-react',
  'expo-router',
  'glob',
  'jest',
  'jest-circus',
  'jest-cli',
  'jest-config',
  'jest-expo',
  'jest-resolve-dependencies',
  'jest-runner',
  'jest-runtime',
  'jest-snapshot',
  'jest-watch-typeahead',
  'minimatch',
  'react-native',
  'test-exclude',
]);

const severityRank = { critical: 3, high: 2, moderate: 1, low: 0 };

function isAcceptedAdvisory(via) {
  return (
    typeof via === 'object' &&
    via !== null &&
    via.source === ACCEPTED_ADVISORY_SOURCE &&
    typeof via.url === 'string' &&
    via.url.includes(ACCEPTED_ADVISORY_ID)
  );
}

function isExpired(now) {
  return now.getTime() > Date.parse(ACCEPTED_ADVISORY_EXPIRES_AT);
}

function isAllowedRootBraceExpansion(name, vulnerability, via, now) {
  return (
    !isExpired(now) &&
    name === 'brace-expansion' &&
    Array.isArray(vulnerability.nodes) &&
    vulnerability.nodes.length > 0 &&
    vulnerability.nodes.every(
      (node) => node === 'node_modules/brace-expansion',
    ) &&
    isAcceptedAdvisory(via)
  );
}

function isAllowedVulnerability(name, vulnerabilities, now) {
  const visited = new Set();
  let reachesAcceptedAdvisory = false;

  function visit(currentName) {
    if (visited.has(currentName)) return true;
    visited.add(currentName);

    if (!ACCEPTED_AFFECTED_PACKAGES.has(currentName)) return false;
    const vulnerability = vulnerabilities[currentName];
    if (vulnerability === undefined || !Array.isArray(vulnerability.via)) {
      return false;
    }
    if (vulnerability.via.length === 0) return false;

    return vulnerability.via.every((via) => {
      if (typeof via === 'string') return visit(via);
      if (isAllowedRootBraceExpansion(currentName, vulnerability, via, now)) {
        reachesAcceptedAdvisory = true;
        return true;
      }
      return false;
    });
  }

  return visit(name) && reachesAcceptedAdvisory;
}

export function evaluateAuditReport(report, now = new Date()) {
  if (
    typeof report !== 'object' ||
    report === null ||
    typeof report.vulnerabilities !== 'object' ||
    report.vulnerabilities === null
  ) {
    throw new Error('npm audit returned invalid JSON');
  }

  const failures = [];
  const vulnerabilities = report.vulnerabilities;
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    if (
      typeof vulnerability !== 'object' ||
      vulnerability === null ||
      typeof vulnerability.severity !== 'string'
    ) {
      throw new Error(
        `npm audit returned invalid vulnerability data for ${name}`,
      );
    }
    if ((severityRank[vulnerability.severity] ?? 1) < severityRank.moderate) {
      continue;
    }
    if (!isAllowedVulnerability(name, vulnerabilities, now)) {
      failures.push(`${name} (${vulnerability.severity})`);
    }
  }
  return failures;
}

export function assertAuditReport(report, now = new Date()) {
  const failures = evaluateAuditReport(report, now);
  if (failures.length > 0) {
    throw new Error(
      `npm audit found unaccepted advisories: ${failures.join(', ')}`,
    );
  }
}

function containsAcceptedAdvisory(report) {
  return Object.values(report.vulnerabilities).some(
    (vulnerability) =>
      typeof vulnerability === 'object' &&
      vulnerability !== null &&
      Array.isArray(vulnerability.via) &&
      vulnerability.via.some(isAcceptedAdvisory),
  );
}

function run() {
  const result = spawnSync(
    'npm',
    ['audit', '--json', '--audit-level=moderate'],
    {
      encoding: 'utf8',
    },
  );
  if (result.error !== undefined) throw result.error;

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error('npm audit did not return valid JSON');
  }
  assertAuditReport(report);
  if (containsAcceptedAdvisory(report)) {
    console.log(
      `Accepted ${ACCEPTED_ADVISORY_ID} only for Expo SDK 57 Jest/ESLint tooling; remove by ${ACCEPTED_ADVISORY_EXPIRES_AT}.`,
    );
  } else {
    console.log('npm audit found no accepted advisories.');
  }
}

if (import.meta.main) run();
