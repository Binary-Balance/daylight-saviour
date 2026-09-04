import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const allowedImageSizeUrls = new Set([
  'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr',
  'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq',
]);
const decoderAdvisoryUrl = 'https://github.com/advisories/GHSA-vcc3-ghjq-m6fr';
const severities = new Set(['moderate', 'high', 'critical']);
const validSeverities = new Set(['info', 'low', ...severities]);

const isMetroImageSize = (vulnerability, advisory) =>
  vulnerability.effects?.length === 1 &&
  vulnerability.effects[0] === 'metro' &&
  vulnerability.nodes?.length === 1 &&
  vulnerability.nodes[0] === 'node_modules/image-size' &&
  advisory.name === 'image-size' &&
  advisory.dependency === 'image-size';

const hasExactValues = (actual, expected) =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);

const isExpoRouterDecoder = (vulnerability, advisory) =>
  vulnerability.severity === 'moderate' &&
  hasExactValues(vulnerability.effects, ['query-string']) &&
  hasExactValues(vulnerability.nodes, ['node_modules/decode-uri-component']) &&
  advisory.url === decoderAdvisoryUrl &&
  advisory.name === 'decode-uri-component' &&
  advisory.dependency === 'decode-uri-component' &&
  advisory.severity === 'moderate';

const isAllowedAdvisory = (packageName, vulnerability, advisory) =>
  (packageName === 'image-size' &&
    allowedImageSizeUrls.has(advisory.url) &&
    isMetroImageSize(vulnerability, advisory)) ||
  (packageName === 'decode-uri-component' &&
    isExpoRouterDecoder(vulnerability, advisory));

const hasLockedExpoRouterDecoder = (lock) => {
  const packages = lock?.packages;
  return (
    packages?.['node_modules/expo-router']?.version === '57.0.16' &&
    packages?.['node_modules/expo-router']?.dependencies?.['query-string'] ===
      '^7.1.3' &&
    packages['node_modules/query-string']?.version === '7.1.3' &&
    packages['node_modules/query-string']?.dependencies?.[
      'decode-uri-component'
    ] === '^0.2.2' &&
    packages['node_modules/decode-uri-component']?.version === '0.2.2'
  );
};

const hasExactExpoRouterDecoderPath = (audit) => {
  const queryString = audit.vulnerabilities['query-string'];
  const expoRouter = audit.vulnerabilities['expo-router'];
  return (
    queryString?.severity === 'moderate' &&
    hasExactValues(queryString.via, ['decode-uri-component']) &&
    hasExactValues(queryString.effects, ['expo-router']) &&
    hasExactValues(queryString.nodes, ['node_modules/query-string']) &&
    expoRouter?.severity === 'moderate' &&
    hasExactValues(expoRouter.via, ['query-string']) &&
    hasExactValues(expoRouter.effects, []) &&
    hasExactValues(expoRouter.nodes, ['node_modules/expo-router'])
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

  // ponytail: temporary image-size exception; remove when a compatible patched image-size release is published.
  const allowedImageSize = new Set();
  let allowedDecoder = false;
  const unexpected = entries.flatMap(([packageName, vulnerability]) =>
    (vulnerability.via ?? []).filter((advisory) => {
      if (typeof advisory === 'string' || !severities.has(advisory.severity))
        return false;
      const isAllowed = isAllowedAdvisory(packageName, vulnerability, advisory);
      if (isAllowed && packageName === 'image-size')
        allowedImageSize.add(advisory.url);
      if (isAllowed && packageName === 'decode-uri-component')
        allowedDecoder = true;
      return !isAllowed;
    }),
  );

  if (unexpected.length) {
    throw new Error(
      `Unexpected advisories: ${unexpected.map(({ url, name }) => url ?? name).join(', ')}`,
    );
  }
  if (!allowedImageSize.size) {
    throw new Error(
      'Temporary image-size exception changed; remove it when a compatible patched release is available',
    );
  }
  // ponytail: Expo Router uses this CommonJS decoder for client navigation query parsing.
  // GHSA records CPU availability impact. Remove when Router adopts a compatible patched parser.
  if (
    !allowedDecoder ||
    !hasExactExpoRouterDecoderPath(audit) ||
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
          isAllowedAdvisory(packageName, vulnerability, advisory),
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

  if (
    !lock?.packages?.['node_modules/image-size'] ||
    !lock.packages['node_modules/metro']?.dependencies?.['image-size']
  ) {
    throw new Error(
      'The image-size exception must remain rooted through installed Metro',
    );
  }
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
