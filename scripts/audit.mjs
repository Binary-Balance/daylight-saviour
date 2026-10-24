import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// ponytail: temporary exceptions for advisories without a compatible patched
// release; docs/development.md records why each is acceptable. Each lists the
// only lockfile packages that may depend directly on the affected package, so
// a new direct dependent fails the audit, as does a change in severity.
// Remove an exception once a patch is available.
const exceptions = [
  {
    name: 'decode-uri-component',
    url: 'https://github.com/advisories/GHSA-vcc3-ghjq-m6fr',
    severity: 'moderate',
    dependents: ['node_modules/query-string'],
  },
  {
    name: 'node-forge',
    url: 'https://github.com/advisories/GHSA-86w9-cpqp-85rv',
    severity: 'high',
    dependents: [
      'node_modules/@expo/cli',
      'node_modules/@expo/code-signing-certificates',
    ],
  },
  {
    name: '@azure/msal-node',
    url: 'https://github.com/advisories/GHSA-xcx6-jx8p-x3h5',
    severity: 'high',
    dependents: ['node_modules/@azure/identity'],
  },
  {
    name: 'zod',
    url: 'https://github.com/advisories/GHSA-mrhx-c7xc-m3w5',
    severity: 'high',
    dependents: [
      'node_modules/@expo/cli',
      'node_modules/eslint-plugin-react-hooks',
      'node_modules/zod-validation-error',
    ],
  },
];
const severities = new Set(['moderate', 'high', 'critical']);
const validSeverities = new Set(['info', 'low', ...severities]);

const hasExactValues = (actual, expected) =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);

const dependentsOf = (packageName, lock) =>
  Object.entries(lock?.packages ?? {})
    .filter(([, entry]) =>
      [
        entry.dependencies,
        entry.devDependencies,
        entry.optionalDependencies,
        entry.peerDependencies,
      ].some((dependencies) => Object.hasOwn(dependencies ?? {}, packageName)),
    )
    .map(([path]) => path)
    .sort();

const isAllowedAdvisory = (packageName, vulnerability, advisory, lock) => {
  const exception = exceptions.find(({ name }) => name === packageName);
  return (
    exception !== undefined &&
    advisory.url === exception.url &&
    advisory.severity === exception.severity &&
    advisory.name === packageName &&
    advisory.dependency === packageName &&
    hasExactValues(vulnerability.nodes, [`node_modules/${packageName}`]) &&
    hasExactValues(
      dependentsOf(packageName, lock),
      exception.dependents.toSorted(),
    )
  );
};

const hasLockedExpoRouterDecoder = (lock) => {
  const packages = lock?.packages;
  return (
    packages?.['node_modules/expo-router']?.version === '57.0.29' &&
    packages?.['node_modules/expo-router']?.dependencies?.['query-string'] ===
      '^7.1.3' &&
    packages['node_modules/query-string']?.version === '7.1.3' &&
    packages['node_modules/query-string']?.dependencies?.[
      'decode-uri-component'
    ] === '^0.2.2' &&
    packages['node_modules/decode-uri-component']?.version === '0.2.2'
  );
};

export function validateAudit(audit, lock) {
  if (audit?.error)
    throw new Error(
      `npm audit failed: ${audit.error.summary ?? 'unknown error'}`,
    );
  if (
    !audit?.metadata?.vulnerabilities ||
    !audit.vulnerabilities ||
    Array.isArray(audit.vulnerabilities)
  ) {
    throw new Error('Invalid npm audit output');
  }

  const entries = Object.entries(audit.vulnerabilities);
  const malformed = entries
    .filter(
      ([, vulnerability]) =>
        !validSeverities.has(vulnerability.severity) ||
        (severities.has(vulnerability.severity) &&
          !Array.isArray(vulnerability.via)),
    )
    .map(([packageName]) => packageName);
  if (malformed.length)
    throw new Error(
      `Invalid npm audit vulnerabilities: ${malformed.join(', ')}`,
    );

  const references = entries.flatMap(([, vulnerability]) =>
    (vulnerability.via ?? []).filter(
      (advisory) => typeof advisory === 'string',
    ),
  );
  const unresolved = references.filter(
    (reference) => !audit.vulnerabilities[reference],
  );
  if (unresolved.length)
    throw new Error(
      `Unresolved npm audit references: ${unresolved.join(', ')}`,
    );

  const unreciprocated = entries.flatMap(([packageName, vulnerability]) =>
    (vulnerability.via ?? [])
      .filter(
        (reference) =>
          typeof reference === 'string' &&
          !audit.vulnerabilities[reference].effects?.includes(packageName),
      )
      .map((reference) => `${packageName} -> ${reference}`),
  );
  if (unreciprocated.length)
    throw new Error(
      `Unreciprocated npm audit references: ${unreciprocated.join(', ')}`,
    );

  const unreciprocatedEffects = entries.flatMap(
    ([packageName, vulnerability]) =>
      (vulnerability.effects ?? [])
        .filter(
          (effect) =>
            !audit.vulnerabilities[effect]?.via?.includes(packageName),
        )
        .map((effect) => `${packageName} -> ${effect}`),
  );
  if (unreciprocatedEffects.length)
    throw new Error(
      `Unreciprocated npm audit effects: ${unreciprocatedEffects.join(', ')}`,
    );

  const malformedAdvisories = entries.flatMap(([packageName, vulnerability]) =>
    (vulnerability.via ?? [])
      .filter(
        (advisory) =>
          typeof advisory !== 'string' &&
          (!advisory || !validSeverities.has(advisory.severity)),
      )
      .map(() => packageName),
  );
  if (malformedAdvisories.length)
    throw new Error(
      `Invalid npm audit advisories: ${malformedAdvisories.join(', ')}`,
    );

  const allowedPackages = new Set();
  const unexpected = entries.flatMap(([packageName, vulnerability]) =>
    (vulnerability.via ?? []).filter((advisory) => {
      if (typeof advisory === 'string' || !severities.has(advisory.severity))
        return false;
      const isAllowed = isAllowedAdvisory(
        packageName,
        vulnerability,
        advisory,
        lock,
      );
      if (isAllowed) allowedPackages.add(packageName);
      return !isAllowed;
    }),
  );

  if (unexpected.length) {
    throw new Error(
      `Unexpected advisories, or exceptions outside their allowed packages or severity: ${unexpected.map(({ url, name }) => url ?? name).join(', ')}`,
    );
  }
  const stale = exceptions
    .map(({ name }) => name)
    .filter((name) => !allowedPackages.has(name));
  if (stale.length) {
    throw new Error(
      `Temporary audit exceptions no longer apply: ${stale.join(', ')}; remove them`,
    );
  }
  // ponytail: Standard Router parsing uses URL/URLSearchParams, so this shipped decoder is dormant.
  // External navigation text risks CPU exhaustion only if core fallback or query-string.parse is used.
  // Remove when Router adopts a compatible patched parser.
  if (
    !hasExactValues(dependentsOf('query-string', lock), [
      'node_modules/expo-router',
    ]) ||
    !hasLockedExpoRouterDecoder(lock)
  ) {
    throw new Error(
      'Temporary decode-uri-component exception changed; remove it when Expo Router adopts a compatible patched query parser',
    );
  }

  const reachesAllowedAdvisory = (packageName, seen = new Set()) => {
    if (seen.has(packageName)) return false;
    const vulnerability = audit.vulnerabilities[packageName];
    const nextSeen = new Set(seen).add(packageName);
    return vulnerability.via.some((advisory) =>
      typeof advisory === 'string'
        ? reachesAllowedAdvisory(advisory, nextSeen)
        : severities.has(advisory.severity) &&
          isAllowedAdvisory(packageName, vulnerability, advisory, lock),
    );
  };
  const disconnected = entries
    .filter(
      ([packageName, vulnerability]) =>
        severities.has(vulnerability.severity) &&
        !reachesAllowedAdvisory(packageName),
    )
    .map(([packageName]) => packageName);
  if (disconnected.length)
    throw new Error(
      `Unexpected npm audit vulnerability chains: ${disconnected.join(', ')}`,
    );
}

if (import.meta.main) {
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['audit', '--json', '--audit-level=moderate'],
    {
      encoding: 'utf8',
    },
  );
  if (result.error || ![0, 1].includes(result.status))
    throw result.error ?? new Error(result.stderr);
  validateAudit(
    JSON.parse(result.stdout),
    JSON.parse(readFileSync('package-lock.json', 'utf8')),
  );
}
