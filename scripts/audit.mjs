import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const allowedUrls = new Set([
  'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr',
  'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq',
]);
const severities = new Set(['moderate', 'high', 'critical']);

const isMetroImageSize = (vulnerability, advisory) =>
  vulnerability.effects?.length === 1 &&
  vulnerability.effects[0] === 'metro' &&
  vulnerability.nodes?.length === 1 &&
  vulnerability.nodes[0] === 'node_modules/image-size' &&
  advisory.name === 'image-size' &&
  advisory.dependency === 'image-size';

const isAllowedAdvisory = (packageName, vulnerability, advisory) =>
  packageName === 'image-size' &&
  allowedUrls.has(advisory.url) &&
  isMetroImageSize(vulnerability, advisory);

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
        severities.has(vulnerability.severity) &&
        !Array.isArray(vulnerability.via),
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

  // ponytail: temporary image-size exception; remove when a compatible patched image-size release is published.
  const allowed = new Set();
  const unexpected = entries.flatMap(([packageName, vulnerability]) =>
    (vulnerability.via ?? []).filter((advisory) => {
      if (typeof advisory === 'string' || !severities.has(advisory.severity))
        return false;
      const isAllowed = isAllowedAdvisory(packageName, vulnerability, advisory);
      if (isAllowed) allowed.add(advisory.url);
      return !isAllowed;
    }),
  );

  if (unexpected.length) {
    throw new Error(
      `Unexpected advisories: ${unexpected.map(({ url, name }) => url ?? name).join(', ')}`,
    );
  }
  if (!allowed.size) {
    throw new Error(
      'Temporary image-size exception changed; remove it when a compatible patched release is available',
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
