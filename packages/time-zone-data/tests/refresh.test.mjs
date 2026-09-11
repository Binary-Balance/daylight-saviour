import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import { activateTimeZoneDataPack } from '@daylight-saviour/contracts';

import {
  assertReviewedSemanticDiff,
  generateAustralianCandidate,
  MAX_UNCOMPRESSED_BYTES,
  parseIanaArchive,
  runConformance,
  semanticDiff,
} from '../scripts/iana-candidate-engine.mjs';
import {
  refreshAustralianPack,
  verifyIanaDetachedSignature,
} from '../scripts/refresh-australian-pack.mjs';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const fixtureDirectory = join(packageDirectory, 'test-fixtures');
const archivePath = join(fixtureDirectory, 'tzdata2026c.tar.gz');
const signaturePath = join(fixtureDirectory, 'tzdata2026c.tar.gz.asc');
const trustedKeyPath = join(
  fixtureDirectory,
  'paul-eggert-2026c-public-key.asc',
);
const signingKeyPath = join(fixtureDirectory, 'TEST-ONLY-ed25519-private.pem');
const configurationPath = join(
  fixtureDirectory,
  '..',
  'source/tzdb-2026c-australian-coverage.json',
);
const baselinePath = join(
  fixtureDirectory,
  '..',
  'generated/australian-coverage.pack.json',
);
const fingerprint = '7E3792A9D8ACF7D633BC1588ED97E90E62AA7E34';

async function fixtureConfiguration() {
  return JSON.parse(await readFile(configurationPath, 'utf8'));
}

async function fixtureBaseline() {
  return activateTimeZoneDataPack(
    JSON.parse(await readFile(baselinePath, 'utf8')),
  );
}

async function refreshOptions(outputDirectory, extras = {}) {
  return {
    archivePath,
    baselinePath,
    configurationPath,
    gpgPath: 'gpg',
    outputDirectory,
    signaturePath,
    trustedFingerprint: fingerprint,
    trustedKeyPath,
    ...extras,
  };
}

async function snapshotFiles(root) {
  const files = new Map();
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = join(prefix, entry.name);
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else {
        files.set(relativePath, await readFile(absolutePath));
      }
    }
  }
  await visit(root);
  return [...files.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

describe('verified IANA Australian candidate refresh', () => {
  it('verifies the recorded archive and produces the reviewed pack exactly', async () => {
    const archiveBytes = await readFile(archivePath);
    const verification = await verifyIanaDetachedSignature({
      archivePath,
      gpgPath: 'gpg',
      signaturePath,
      trustedFingerprint: fingerprint,
      trustedKeyPath,
    });
    assert.deepEqual(verification, { fingerprint, verifier: 'gpg' });

    const outputDirectory = join(
      await mkdtemp(join(tmpdir(), 'daylight-iana-refresh-')),
      'candidate',
    );
    const result = await refreshAustralianPack(
      await refreshOptions(outputDirectory),
    );
    assert.equal(result.status, 'published');
    assert.equal(
      result.archiveSha256,
      createHash('sha256').update(archiveBytes).digest('hex'),
    );
    assert.equal(result.conformance.zones, 18);
    assert.match(result.diff, /Civil-time changes: none\./);

    const generated = await readFile(baselinePath);
    const candidate = await readFile(
      join(outputDirectory, 'candidate.pack.json'),
    );
    assert.deepEqual(candidate, generated);
    const provenance = JSON.parse(
      await readFile(join(outputDirectory, 'provenance.json'), 'utf8'),
    );
    assert.equal(provenance.archive.sha256, result.archiveSha256);
    assert.equal(provenance.conformance.zones, 18);

    const secondOutputDirectory = join(
      await mkdtemp(join(tmpdir(), 'daylight-iana-deterministic-')),
      'candidate',
    );
    await refreshAustralianPack(await refreshOptions(secondOutputDirectory));
    assert.deepEqual(
      await snapshotFiles(secondOutputDirectory),
      await snapshotFiles(outputDirectory),
    );
  });

  it('returns no-change only after verifying the same identity and complete output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'daylight-iana-no-change-'));
    const outputDirectory = join(root, 'candidate');
    await refreshAustralianPack(await refreshOptions(outputDirectory));
    const before = await readFile(join(outputDirectory, 'provenance.json'));

    const result = await refreshAustralianPack(
      await refreshOptions(outputDirectory),
    );
    assert.equal(result.status, 'no-change');
    assert.deepEqual(
      await readFile(join(outputDirectory, 'provenance.json')),
      before,
    );

    await rm(join(outputDirectory, 'semantic-diff.txt'));
    await assert.rejects(
      refreshAustralianPack(await refreshOptions(outputDirectory)),
      /existing output is incomplete/,
    );
  });

  it('uses the digest of authenticated archive bytes, never a config claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'daylight-iana-digest-'));
    const configuration = await fixtureConfiguration();
    configuration.source.archiveSha256 = '0'.repeat(64);
    const claimedConfigurationPath = join(root, 'claimed-config.json');
    await writeFile(
      claimedConfigurationPath,
      `${JSON.stringify(configuration, null, 2)}\n`,
    );
    const result = await refreshAustralianPack(
      await refreshOptions(join(root, 'candidate'), {
        configurationPath: claimedConfigurationPath,
      }),
    );
    assert.equal(
      result.archiveSha256,
      'e4a178a4477f3d0ea77cc31828ff72aa38feff8d61aa13e7e99e142e9d902be4',
    );
  });

  it('authenticates and parses the same archive byte snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'daylight-iana-snapshot-'));
    const mutableArchivePath = join(root, 'mutable.tar.gz');
    const archiveBytes = await readFile(archivePath);
    const alteredArchiveBytes = Uint8Array.from(archiveBytes);
    alteredArchiveBytes[alteredArchiveBytes.length - 1] ^= 1;
    await writeFile(mutableArchivePath, archiveBytes);
    let verifiedArchivePath;

    const result = await refreshAustralianPack(
      await refreshOptions(join(root, 'candidate'), {
        archivePath: mutableArchivePath,
        verifySignature: async (options) => {
          verifiedArchivePath = options.archivePath;
          await writeFile(mutableArchivePath, alteredArchiveBytes);
          return verifyIanaDetachedSignature(options);
        },
      }),
    );

    assert.notEqual(verifiedArchivePath, mutableArchivePath);
    assert.equal(
      result.archiveSha256,
      createHash('sha256').update(archiveBytes).digest('hex'),
    );
    const candidate = JSON.parse(
      await readFile(join(root, 'candidate/candidate.pack.json'), 'utf8'),
    );
    assert.equal(candidate.source.archiveSha256, result.archiveSha256);
  });

  it('rejects altered archive bytes and a non-matching signer before output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'daylight-iana-auth-'));
    const alteredArchive = join(root, 'altered.tar.gz');
    const bytes = await readFile(archivePath);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(alteredArchive, bytes);
    const outputDirectory = join(root, 'candidate');

    await assert.rejects(
      refreshAustralianPack(
        await refreshOptions(outputDirectory, { archivePath: alteredArchive }),
      ),
      /detached signature verification failed/,
    );
    await assert.rejects(
      verifyIanaDetachedSignature({
        archivePath,
        gpgPath: 'gpg',
        signaturePath,
        trustedFingerprint: 'E78E2E21104851C6D01934BC3706DA463F348748',
        trustedKeyPath,
      }),
      /primary fingerprint .* does not match trusted/,
    );
  });

  it('preserves the previous output when the signing seam fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'daylight-iana-signing-'));
    const outputDirectory = join(root, 'candidate');
    await refreshAustralianPack(await refreshOptions(outputDirectory));
    const before = await snapshotFiles(outputDirectory);

    await assert.rejects(
      refreshAustralianPack(
        await refreshOptions(outputDirectory, {
          keyId: 'test-only-2026-a',
          privateKeyPath: trustedKeyPath,
        }),
      ),
      /Invalid key object|DECODER routines|bad decrypt|requested signing key/i,
    );
    assert.deepEqual(await snapshotFiles(outputDirectory), before);
  });

  it('verifies requested signing material and existing signatures before no-change', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'daylight-iana-signature-check-'),
    );
    const outputDirectory = join(root, 'candidate');
    const options = await refreshOptions(outputDirectory, {
      keyId: 'test-only-2026-a',
      privateKeyPath: signingKeyPath,
    });
    await refreshAustralianPack(options);
    const original = await snapshotFiles(outputDirectory);

    const missingKeyOptions = {
      ...options,
      privateKeyPath: join(root, 'missing-private-key.pem'),
    };
    await assert.rejects(
      refreshAustralianPack(missingKeyOptions),
      /requested signing key is unreadable/,
    );
    assert.deepEqual(await snapshotFiles(outputDirectory), original);

    const { privateKey } = generateKeyPairSync('ed25519');
    const wrongKeyPath = join(root, 'wrong-private-key.pem');
    await writeFile(
      wrongKeyPath,
      privateKey.export({ format: 'pem', type: 'pkcs8' }),
    );
    await assert.rejects(
      refreshAustralianPack({ ...options, privateKeyPath: wrongKeyPath }),
      /existing signed output signature does not verify/,
    );
    assert.deepEqual(await snapshotFiles(outputDirectory), original);

    const manifestPath = join(outputDirectory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.signature.value = Buffer.alloc(64).toString('base64');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const corrupt = await snapshotFiles(outputDirectory);
    await assert.rejects(
      refreshAustralianPack(options),
      /existing signed output signature does not verify/,
    );
    assert.deepEqual(await snapshotFiles(outputDirectory), corrupt);
  });

  it('publishes and rechecks the optional signed artifact set atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'daylight-iana-signed-'));
    const outputDirectory = join(root, 'candidate');
    const options = await refreshOptions(outputDirectory, {
      keyId: 'test-only-2026-a',
      privateKeyPath: signingKeyPath,
    });
    const first = await refreshAustralianPack(options);
    assert.equal(first.status, 'published');
    assert.deepEqual((await readdir(outputDirectory)).sort(), [
      'manifest.json',
      'packs',
      'provenance.json',
      'semantic-diff.txt',
    ]);
    const before = await snapshotFiles(outputDirectory);
    const second = await refreshAustralianPack(options);
    assert.equal(second.status, 'no-change');
    assert.deepEqual(await snapshotFiles(outputDirectory), before);
  });

  it('fails before replacing a good output when generation inputs change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'daylight-iana-atomic-'));
    const outputDirectory = join(root, 'candidate');
    await refreshAustralianPack(await refreshOptions(outputDirectory));
    const before = await readFile(join(outputDirectory, 'provenance.json'));
    const beforePack = JSON.parse(
      await readFile(join(outputDirectory, 'candidate.pack.json'), 'utf8'),
    );

    const configuration = await fixtureConfiguration();
    configuration.generation.generatedAt = '2026-07-20T00:00:00.000Z';
    const changedConfigurationPath = join(root, 'changed-config.json');
    await writeFile(
      changedConfigurationPath,
      `${JSON.stringify(configuration, null, 2)}\n`,
    );
    const result = await refreshAustralianPack(
      await refreshOptions(outputDirectory, {
        configurationPath: changedConfigurationPath,
      }),
    );
    assert.equal(result.status, 'published');
    assert.notDeepEqual(
      await readFile(join(outputDirectory, 'provenance.json')),
      before,
    );
    const afterPack = JSON.parse(
      await readFile(join(outputDirectory, 'candidate.pack.json'), 'utf8'),
    );
    assert.notEqual(afterPack.packVersion, beforePack.packVersion);
  });

  it('captures the state at coverage start when the horizon ends in the opposite season', async () => {
    const configuration = await fixtureConfiguration();
    configuration.generation.lastYear = 2027;
    configuration.generation.validUntil = '2027-07-01T00:00:00.000Z';
    const parsed = parseIanaArchive(
      await readFile(archivePath),
      configuration.source.files,
    );
    const candidate = generateAustralianCandidate({
      archive: parsed,
      archiveSha256: 'a'.repeat(64),
      configuration,
    });
    const sydney = candidate.zones.find(
      (zone) => zone.id === 'Australia/Sydney',
    );
    assert.deepEqual(sydney.initial, {
      abbreviation: 'AEDT',
      daylightSaving: true,
      utcOffsetSeconds: 39600,
    });
    assert.equal(sydney.transitions.length, 5);
    assert.equal(sydney.transitions.at(-1).at, '2027-04-03T16:00:00.000Z');
  });

  it('rejects an unsupported future Zone segment before output', async () => {
    const configuration = await fixtureConfiguration();
    const archiveBytes = await readFile(archivePath);
    const parsed = parseIanaArchive(archiveBytes, configuration.source.files);
    parsed.zones.get('Australia/Sydney').segments[1].until = ['2025', 'Jun'];
    assert.throws(
      () =>
        generateAustralianCandidate({
          archive: parsed,
          archiveSha256: 'a'.repeat(64),
          configuration,
        }),
      /Zone segment boundary.*coverage start/,
    );
  });

  it('fails closed for malformed source, schema, and configuration inputs', async () => {
    assert.throws(
      () => parseIanaArchive(new Uint8Array([0x1f, 0x8b, 0x08])),
      /archive is not valid gzip/,
    );

    const configuration = await fixtureConfiguration();
    const archiveBytes = await readFile(archivePath);
    const parsed = parseIanaArchive(archiveBytes, configuration.source.files);
    parsed.rules.get('AN')[0].type = 'unsupported';
    assert.throws(
      () =>
        generateAustralianCandidate({
          archive: parsed,
          archiveSha256: 'a'.repeat(64),
          configuration,
        }),
      /unsupported Rule TYPE/,
    );

    const candidate = generateAustralianCandidate({
      archive: parseIanaArchive(archiveBytes, configuration.source.files),
      archiveSha256: 'a'.repeat(64),
      configuration,
    });
    candidate.schemaVersion = 3;
    assert.throws(
      () => activateTimeZoneDataPack(candidate),
      /unsupported version 3/,
    );

    const root = await mkdtemp(join(tmpdir(), 'daylight-iana-config-'));
    const outputDirectory = join(root, 'candidate');
    const malformedConfigurationPath = join(root, 'malformed-config.json');
    await writeFile(malformedConfigurationPath, '{}\n');
    await assert.rejects(
      refreshAustralianPack(
        await refreshOptions(outputDirectory, {
          configurationPath: malformedConfigurationPath,
        }),
      ),
      /configuration source\.files/,
    );
    await assert.rejects(readFile(outputDirectory), { code: 'ENOENT' });
  });

  it('bounds gzip inflation before allocating an oversized archive', () => {
    const oversized = gzipSync(Buffer.alloc(MAX_UNCOMPRESSED_BYTES + 1));
    assert.throws(
      () => parseIanaArchive(oversized),
      /uncompressed archive exceeds the .*byte limit/,
    );
  });

  it('does not accept a copied snapshot as the reviewed baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'daylight-iana-baseline-'));
    const copiedBaselinePath = join(root, 'copied-baseline.pack.json');
    await writeFile(copiedBaselinePath, await readFile(baselinePath));
    await assert.rejects(
      refreshAustralianPack(
        await refreshOptions(join(root, 'candidate'), {
          baselinePath: copiedBaselinePath,
        }),
      ),
      /committed baseline|reviewed candidate/,
    );
  });

  it('runs independent boundary, no-event, external-territory, and alias checks', async () => {
    const configuration = await fixtureConfiguration();
    const archiveBytes = await readFile(archivePath);
    const parsed = parseIanaArchive(archiveBytes, configuration.source.files);
    const candidate = generateAustralianCandidate({
      archive: parsed,
      archiveSha256: 'a'.repeat(64),
      configuration,
    });
    const activated = activateTimeZoneDataPack(candidate);
    const report = runConformance(
      activated,
      configuration,
      parsed,
      await fixtureBaseline(),
    );
    assert.equal(report.status, 'passed');
    assert.equal(report.zones, 18);
    assert.ok(report.boundaryChecks >= 100);
    assert.equal(
      activated.zones.find((zone) => zone.id === 'Australia/Brisbane')
        .transitions.length,
      0,
    );
    assert.equal(
      activated.zones.find((zone) => zone.id === 'Australia/Lord_Howe')
        .transitions[0].utcOffsetSeconds,
      37800,
    );
  });

  it('rejects self-consistent shifted transitions against reviewed civil-time values', async () => {
    const configuration = await fixtureConfiguration();
    const parsed = parseIanaArchive(
      await readFile(archivePath),
      configuration.source.files,
    );
    const candidate = generateAustralianCandidate({
      archive: parsed,
      archiveSha256: 'a'.repeat(64),
      configuration,
    });
    const shifted = structuredClone(candidate);
    for (const zone of shifted.zones) {
      for (const transition of zone.transitions) {
        transition.at = new Date(
          Date.parse(transition.at) + 3_600_000,
        ).toISOString();
      }
    }
    const baseline = await fixtureBaseline();
    assert.throws(
      () =>
        runConformance(
          activateTimeZoneDataPack(shifted),
          configuration,
          parsed,
          baseline,
        ),
      /reviewed baseline or exact reviewed changes/,
    );
  });

  it('allows a supported changed rule only with exact reviewed boundary evidence', async () => {
    const configuration = await fixtureConfiguration();
    const parsed = parseIanaArchive(
      await readFile(archivePath),
      configuration.source.files,
    );
    const changedRule = parsed.rules.get('AS').at(-1);
    changedRule.at = '3:00s';
    const changedCandidate = generateAustralianCandidate({
      archive: parsed,
      archiveSha256: 'a'.repeat(64),
      configuration,
    });
    const baseline = await fixtureBaseline();
    const diff = semanticDiff(baseline, changedCandidate);
    assert.ok(diff.differences.length > 0);
    assert.throws(
      () =>
        runConformance(
          activateTimeZoneDataPack(changedCandidate),
          configuration,
          parsed,
          baseline,
        ),
      /reviewed baseline or exact reviewed changes/,
    );
    const expected = {
      archiveSha256: 'a'.repeat(64),
      differences: diff.differences,
      evidence: [
        {
          url: 'https://www.iana.org/time-zones',
          description: 'Reviewed source rule boundary evidence',
          supports: diff.differences.map((_, index) => index),
        },
      ],
      explanation: 'The reviewed source rule moved the civil-time boundary.',
      sourceVersion: '2026c',
    };
    assert.doesNotThrow(() =>
      assertReviewedSemanticDiff(
        expected,
        diff,
        changedCandidate.source.archiveSha256,
        changedCandidate.source.version,
      ),
    );
    assert.doesNotThrow(() =>
      runConformance(
        activateTimeZoneDataPack(changedCandidate),
        configuration,
        parsed,
        baseline,
        diff.differences,
      ),
    );
  });

  it('carries an approved final-state change through the horizon conformance check', async () => {
    const configuration = await fixtureConfiguration();
    const parsed = parseIanaArchive(
      await readFile(archivePath),
      configuration.source.files,
    );
    parsed.zones.get('Australia/Darwin').segments.at(-1).gmtoff = '10:00';
    // This synthetic mutation exercises the review-reference seam. It is not
    // evidence that the recorded IANA release changed Darwin.
    const reviewedDifferences = [
      {
        after: {
          abbreviation: 'ACST',
          daylightSaving: false,
          utcOffsetSeconds: 36_000,
        },
        before: {
          abbreviation: 'ACST',
          daylightSaving: false,
          utcOffsetSeconds: 34_200,
        },
        kind: 'initial-state-changed',
        zone: 'Australia/Darwin',
      },
    ];
    const changedCandidate = generateAustralianCandidate({
      archive: parsed,
      archiveSha256: 'a'.repeat(64),
      configuration,
    });
    const baseline = await fixtureBaseline();
    const diff = semanticDiff(baseline, changedCandidate);
    assert.deepEqual(diff.differences, reviewedDifferences);
    const expected = {
      archiveSha256: 'a'.repeat(64),
      differences: reviewedDifferences,
      evidence: [
        {
          url: 'https://www.iana.org/time-zones',
          description: 'Test-only synthetic Darwin final-state evidence',
          supports: [0],
        },
      ],
      explanation:
        'Test-only synthetic change exercises a reviewed UTC+10 final state.',
      sourceVersion: '2026c',
    };
    assert.doesNotThrow(() =>
      assertReviewedSemanticDiff(
        expected,
        diff,
        changedCandidate.source.archiveSha256,
        changedCandidate.source.version,
      ),
    );
    assert.doesNotThrow(() =>
      runConformance(
        activateTimeZoneDataPack(changedCandidate),
        configuration,
        parsed,
        baseline,
        reviewedDifferences,
      ),
    );
  });

  it('requires reviewed structured evidence for every civil-time difference', () => {
    const before = {
      coverage: {
        startsAt: '2025-01-01T00:00:00.000Z',
        validUntil: '2026-01-01T00:00:00.000Z',
      },
      source: { archiveSha256: 'a'.repeat(64), version: '2026c' },
      zones: [
        {
          id: 'Australia/Test',
          initial: {
            abbreviation: 'AEST',
            daylightSaving: false,
            utcOffsetSeconds: 36000,
          },
          transitions: [],
        },
      ],
    };
    const after = structuredClone(before);
    after.zones[0].initial = {
      abbreviation: 'AEDT',
      daylightSaving: true,
      utcOffsetSeconds: 39600,
    };
    after.zones[0].transitions.push({
      abbreviation: 'AEDT',
      at: '2025-10-04T16:00:00.000Z',
      daylightSaving: true,
      offsetBeforeSeconds: 36000,
      utcOffsetSeconds: 39600,
    });
    const diff = semanticDiff(before, after);
    assert.throws(
      () =>
        assertReviewedSemanticDiff(undefined, diff, 'b'.repeat(64), '2026d'),
      /unexplained civil-time difference/,
    );
    assert.throws(
      () =>
        assertReviewedSemanticDiff(
          {
            archiveSha256: 'b'.repeat(64),
            differences: [],
            evidence: [
              {
                url: 'https://example.test/review',
                description: 'review',
                supports: [0],
              },
            ],
            explanation: 'reviewed change',
            sourceVersion: '2026d',
          },
          diff,
          'b'.repeat(64),
          '2026d',
        ),
      /cover every change|reviewed expected diff does not match/,
    );
    const expected = {
      archiveSha256: 'b'.repeat(64),
      differences: diff.differences,
      evidence: [
        {
          url: 'https://example.test/review',
          description: 'review',
          supports: [0],
        },
      ],
      explanation: 'reviewed change',
      sourceVersion: '2026d',
    };
    assert.throws(
      () =>
        assertReviewedSemanticDiff(
          { ...expected, differences: diff.differences },
          diff,
          'b'.repeat(64),
          '2026d',
        ),
      /cover every change/,
    );
    expected.evidence[0].supports = [0, 1];
    assert.doesNotThrow(() =>
      assertReviewedSemanticDiff(expected, diff, 'b'.repeat(64), '2026d'),
    );
  });
});
