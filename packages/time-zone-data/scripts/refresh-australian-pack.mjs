import {
  createHash,
  createPrivateKey,
  createPublicKey,
  verify as verifyEd25519,
} from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  activateSignedTimeZoneDataPackManifest,
  activateTimeZoneDataPack,
  maximumTimeZoneDataPackBytes,
} from '@daylight-saviour/contracts';

import {
  DEFAULT_SOURCE_FILES,
  assertReviewedSemanticDiff,
  generateAustralianCandidate,
  parseIanaArchive,
  runConformance,
  semanticDiff,
} from './iana-candidate-engine.mjs';
import { publishSignedPack } from './sign-australian-pack.mjs';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultConfigurationPath = resolve(
  packageDirectory,
  'source/tzdb-2026c-australian-coverage.json',
);
const defaultBaselinePath = resolve(
  packageDirectory,
  'generated/australian-coverage.pack.json',
);
const reviewedBaselineSha256 =
  '5f60ca0a183524f4f960820bd8744fc9a56ea97d66c15873849d9d584039be40';

function fail(problem) {
  throw new Error(`IANA candidate refresh failed: ${problem}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--'))
    fail(`${name} needs a value`);
  return value;
}

function normalizedFingerprint(value) {
  if (typeof value !== 'string') {
    fail(
      'trusted fingerprint must be a full 40-character hexadecimal fingerprint',
    );
  }
  const fingerprint = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-F0-9]{40}$/.test(fingerprint)) {
    fail(
      'trusted fingerprint must be a full 40-character hexadecimal fingerprint',
    );
  }
  return fingerprint;
}

function runCommand(command, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', rejectCommand);
    child.once('close', (code, signal) =>
      resolveCommand({
        code,
        signal,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      }),
    );
  });
}

function statusLines(output, name) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`[GNUPG:] ${name} `));
}

export async function verifyIanaDetachedSignature({
  archivePath,
  signaturePath,
  trustedKeyPath,
  trustedFingerprint,
  gpgPath = 'gpg',
}) {
  if (!archivePath || !signaturePath || !trustedKeyPath) {
    fail('archive, detached signature, and trusted key paths are required');
  }
  const fingerprint = normalizedFingerprint(trustedFingerprint ?? '');
  const gpgHome = await mkdtemp(join(tmpdir(), 'daylight-iana-gpg-'));
  try {
    const imported = await runCommand(gpgPath, [
      '--batch',
      '--no-options',
      '--no-autostart',
      '--homedir',
      gpgHome,
      '--import',
      trustedKeyPath,
    ]);
    if (imported.code !== 0) {
      fail(
        `trusted key material could not be imported: ${imported.stderr.trim()}`,
      );
    }

    const listed = await runCommand(gpgPath, [
      '--batch',
      '--no-options',
      '--no-autostart',
      '--homedir',
      gpgHome,
      '--with-colons',
      '--list-keys',
    ]);
    const importedFingerprints = listed.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('fpr:::::::::'))
      .map((line) => line.split(':')[9]?.toUpperCase())
      .filter((value) => value !== undefined);
    if (!importedFingerprints.includes(fingerprint)) {
      fail('trusted key material does not contain the requested fingerprint');
    }

    const verified = await runCommand(gpgPath, [
      '--batch',
      '--no-options',
      '--no-autostart',
      '--homedir',
      gpgHome,
      '--no-auto-key-retrieve',
      '--status-fd=1',
      '--verify',
      signaturePath,
      archivePath,
    ]);
    const validSignatures = statusLines(verified.stdout, 'VALIDSIG');
    if (verified.code !== 0 || validSignatures.length !== 1) {
      fail(`detached signature verification failed: ${verified.stderr.trim()}`);
    }
    const fields = validSignatures[0].trim().split(/\s+/);
    const primaryFingerprint = fields.at(-1)?.toUpperCase();
    if (primaryFingerprint !== fingerprint) {
      fail(
        `detached signature primary fingerprint ${primaryFingerprint ?? '<missing>'} does not match trusted ${fingerprint}`,
      );
    }
    return { fingerprint, verifier: 'gpg' };
  } catch (error) {
    if (error?.code === 'ENOENT')
      fail(`signature verifier ${gpgPath} is unavailable`);
    throw error;
  } finally {
    await rm(gpgHome, { recursive: true, force: true });
  }
}

function identityFor({
  archiveSha256,
  configurationBytes,
  configuration,
  generatedAt,
  keyId,
  verificationFingerprint,
}) {
  return {
    archiveSha256,
    configurationSha256: sha256(configurationBytes),
    coverageStartsAt: configuration.generation.coverageStartsAt,
    generatedAt,
    signatureKeyId: keyId ?? null,
    schemaVersion: configuration.generation.schemaVersion,
    validUntil: configuration.generation.validUntil,
    verificationFingerprint,
  };
}

function sameIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reviewArtifact(expected) {
  if (expected === undefined) return null;
  return {
    archiveSha256: expected.archiveSha256,
    differences: expected.differences,
    evidence: expected.evidence,
    explanation: expected.explanation,
    sourceVersion: expected.sourceVersion,
  };
}

async function loadSigningMaterial(privateKeyPath, keyId) {
  let privateKeyPem;
  try {
    privateKeyPem = await readFile(privateKeyPath, 'utf8');
  } catch {
    fail('requested signing key is unreadable');
  }

  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    fail('requested signing key is invalid');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    fail('requested signing key must be Ed25519');
  }
  return { keyId, publicKey: createPublicKey(privateKey) };
}

function verifyExistingSignature(manifest, packBytes, signingMaterial) {
  const signature = Buffer.from(manifest.signature.value, 'base64');
  let verified = false;
  try {
    verified = verifyEd25519(
      null,
      packBytes,
      signingMaterial.publicKey,
      signature,
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    fail(
      'existing signed output signature does not verify with the requested key',
    );
  }
}

function relativeArtifactPath(root, candidate) {
  const value = relative(root, candidate);
  if (
    value.length === 0 ||
    value.startsWith(`..${sep}`) ||
    value === '..' ||
    value.includes(`..${sep}`) ||
    value.startsWith(sep)
  ) {
    fail('existing artifact path escapes output directory');
  }
  return value;
}

async function readRegularFile(path, problem) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    fail(problem);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(problem);
  try {
    return await readFile(path);
  } catch {
    fail(problem);
  }
}

async function existingOutputIdentity(
  outputDirectory,
  expectedPackBytes,
  expectedDiff,
  expectedIdentity,
  expectedReview,
  signingMaterial,
) {
  let metadata;
  try {
    metadata = await lstat(outputDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail('output directory must be a real directory');
  }
  const provenancePath = join(outputDirectory, 'provenance.json');
  let provenance;
  try {
    provenance = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await readRegularFile(
          provenancePath,
          'existing output is incomplete: provenance.json is unreadable',
        ),
      ),
    );
  } catch {
    fail('existing output is incomplete: provenance.json is unreadable');
  }
  if (
    typeof provenance !== 'object' ||
    provenance === null ||
    typeof provenance.identity !== 'object' ||
    provenance.identity === null ||
    typeof provenance.packPath !== 'string' ||
    typeof provenance.packSha256 !== 'string'
  ) {
    fail('existing output has invalid provenance');
  }
  const packPath = resolve(outputDirectory, provenance.packPath);
  if (relativeArtifactPath(outputDirectory, packPath) !== provenance.packPath) {
    fail('existing output pack path is not relative');
  }
  const packBytes = await readRegularFile(
    packPath,
    'existing output is incomplete: candidate pack is unreadable',
  );
  if (sha256(packBytes) !== provenance.packSha256) {
    fail('existing output provenance does not match candidate bytes');
  }
  const isExpectedIdentity = sameIdentity(
    provenance.identity,
    expectedIdentity,
  );
  if (
    isExpectedIdentity &&
    !Buffer.from(packBytes).equals(Buffer.from(expectedPackBytes))
  ) {
    fail('existing output candidate does not match the verified generation');
  }
  if (packBytes.byteLength > maximumTimeZoneDataPackBytes) {
    fail('existing output candidate pack is too large');
  }
  let pack;
  try {
    pack = activateTimeZoneDataPack(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(packBytes)),
    );
  } catch {
    fail('existing output candidate pack is not valid activated JSON');
  }
  if (
    pack.source.archiveSha256 !== provenance.identity.archiveSha256 ||
    provenance.archive?.sha256 !== provenance.identity.archiveSha256 ||
    pack.packVersion !== provenance.packVersion ||
    pack.source.version !== provenance.archive?.version ||
    pack.coverage.startsAt !== provenance.identity.coverageStartsAt ||
    pack.coverage.validUntil !== provenance.identity.validUntil ||
    pack.generatedAt !== provenance.identity.generatedAt ||
    pack.schemaVersion !== provenance.identity.schemaVersion ||
    !Array.isArray(provenance.sourceFiles) ||
    JSON.stringify(pack.source.files) !==
      JSON.stringify(provenance.sourceFiles) ||
    provenance.conformance?.status !== 'passed' ||
    provenance.conformance?.reviewedCivilTime !== true ||
    !Array.isArray(provenance.semanticDiff) ||
    provenance.verification?.verifier !== 'gpg' ||
    !/^[A-F0-9]{40}$/.test(provenance.verification?.fingerprint ?? '') ||
    provenance.identity.verificationFingerprint !==
      provenance.verification.fingerprint ||
    (isExpectedIdentity &&
      JSON.stringify(provenance.review) !== JSON.stringify(expectedReview))
  ) {
    fail('existing output provenance does not identify a coherent candidate');
  }
  if (provenance.signature === null) {
    if (provenance.identity.signatureKeyId !== null) {
      fail('existing unsigned output has a signing identity');
    }
  } else if (
    typeof provenance.signature !== 'object' ||
    provenance.signature === null ||
    typeof provenance.signature.keyId !== 'string' ||
    provenance.identity.signatureKeyId !== provenance.signature.keyId
  ) {
    fail('existing output has an invalid signing identity');
  } else {
    let manifest;
    try {
      manifest = activateSignedTimeZoneDataPackManifest(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            await readRegularFile(
              join(outputDirectory, 'manifest.json'),
              'existing signed output is incomplete: manifest.json is unreadable',
            ),
          ),
        ),
      );
    } catch {
      fail('existing signed output is incomplete: manifest.json is unreadable');
    }
    if (
      manifest.pack.path !== provenance.packPath ||
      manifest.pack.packVersion !== pack.packVersion ||
      manifest.pack.schemaVersion !== pack.schemaVersion ||
      manifest.pack.byteLength !== packBytes.byteLength ||
      manifest.pack.sha256 !== provenance.packSha256 ||
      manifest.signature.keyId !== provenance.signature.keyId
    ) {
      fail('existing signed output manifest does not match candidate bytes');
    }
    if (isExpectedIdentity) {
      if (
        signingMaterial === null ||
        signingMaterial.keyId !== provenance.signature.keyId
      ) {
        fail(
          'requested signing material is required to verify no-change output',
        );
      }
      verifyExistingSignature(manifest, packBytes, signingMaterial);
    }
  }
  const semanticDiffBytes = await readRegularFile(
    join(outputDirectory, 'semantic-diff.txt'),
    'existing output is incomplete: semantic-diff.txt is unreadable',
  );
  if (
    isExpectedIdentity &&
    !Buffer.from(semanticDiffBytes).equals(Buffer.from(expectedDiff.text))
  ) {
    fail(
      'existing output semantic diff does not match the verified generation',
    );
  }
  return provenance.identity;
}

async function acquireLock(outputDirectory) {
  const lockPath = `${outputDirectory}.refresh.lock`;
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error?.code === 'EEXIST')
      fail('another candidate refresh is already running');
    throw error;
  }
  return async () => rm(lockPath, { recursive: true, force: true });
}

async function commitDirectory(stagingDirectory, outputDirectory) {
  let target;
  try {
    target = await lstat(outputDirectory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (
    target !== undefined &&
    (!target.isDirectory() || target.isSymbolicLink())
  ) {
    fail('output directory must be a real directory');
  }
  if (target === undefined) {
    await rename(stagingDirectory, outputDirectory);
    return;
  }

  const backupDirectory = await mkdtemp(
    join(dirname(outputDirectory), `.${target ? 'previous-' : ''}`),
  );
  await rm(backupDirectory, { recursive: true, force: true });
  let backedUp = false;
  try {
    await rename(outputDirectory, backupDirectory);
    backedUp = true;
    await rename(stagingDirectory, outputDirectory);
  } catch (error) {
    if (backedUp) {
      await rename(backupDirectory, outputDirectory).catch(() => undefined);
    }
    throw error;
  }
  await rm(backupDirectory, { recursive: true, force: true }).catch(
    () => undefined,
  );
}

export async function refreshAustralianPack({
  archivePath,
  signaturePath,
  trustedKeyPath,
  trustedFingerprint,
  outputDirectory,
  configurationPath = defaultConfigurationPath,
  baselinePath = defaultBaselinePath,
  expectedDiffPath,
  generatedAt,
  privateKeyPath,
  keyId,
  gpgPath,
  verifySignature = verifyIanaDetachedSignature,
}) {
  if (!outputDirectory) fail('explicit output directory is required');
  if (
    !archivePath ||
    !signaturePath ||
    !trustedKeyPath ||
    !trustedFingerprint
  ) {
    fail(
      'archive, detached signature, trusted key, and fingerprint are required',
    );
  }
  if ((privateKeyPath === undefined) !== (keyId === undefined)) {
    fail('private key and key ID must be supplied together');
  }
  const output = resolve(outputDirectory);
  if (
    output === dirname(output) ||
    output === resolve('/') ||
    output === resolve(process.cwd()) ||
    output === packageDirectory
  ) {
    fail('output directory must be a dedicated child directory');
  }
  const archiveSnapshotDirectory = await mkdtemp(
    join(tmpdir(), 'daylight-iana-archive-'),
  );
  try {
    // Verify the private snapshots so a replacement of either supplied path
    // cannot make the verifier and parser observe different bytes.
    const archiveBytes = await readFile(archivePath);
    const archiveSha256 = sha256(archiveBytes);
    const signatureBytes = await readFile(signaturePath);
    const archiveSnapshotPath = join(archiveSnapshotDirectory, 'tzdata.tar.gz');
    const signatureSnapshotPath = join(
      archiveSnapshotDirectory,
      'tzdata.tar.gz.asc',
    );
    await writeFile(archiveSnapshotPath, archiveBytes, {
      flag: 'wx',
      mode: 0o400,
    });
    await writeFile(signatureSnapshotPath, signatureBytes, {
      flag: 'wx',
      mode: 0o400,
    });
    if (typeof verifySignature !== 'function') {
      fail('signature verification seam is unavailable');
    }
    const verification = await verifySignature({
      archivePath: archiveSnapshotPath,
      gpgPath,
      signaturePath: signatureSnapshotPath,
      trustedFingerprint,
      trustedKeyPath,
    });
    const signingMaterial =
      privateKeyPath === undefined
        ? null
        : await loadSigningMaterial(privateKeyPath, keyId);

    if (resolve(baselinePath) !== defaultBaselinePath) {
      fail('baseline must be the committed reviewed candidate');
    }
    const [configurationBytes, baselineBytes] = await Promise.all([
      readFile(configurationPath),
      readRegularFile(defaultBaselinePath, 'committed baseline is unreadable'),
    ]);
    if (sha256(baselineBytes) !== reviewedBaselineSha256) {
      fail('committed baseline digest is not the reviewed candidate');
    }
    let configuration;
    let baseline;
    try {
      configuration = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(configurationBytes),
      );
    } catch {
      fail('configuration is not valid UTF-8 JSON');
    }
    try {
      baseline = activateTimeZoneDataPack(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(baselineBytes),
        ),
      );
    } catch {
      fail('baseline is not valid UTF-8 JSON or schema');
    }
    let expected;
    if (expectedDiffPath !== undefined) {
      try {
        expected = JSON.parse(await readFile(expectedDiffPath, 'utf8'));
      } catch {
        fail('reviewed expected diff is not readable JSON');
      }
    }
    const parsed = parseIanaArchive(
      archiveBytes,
      configuration.source?.files ?? DEFAULT_SOURCE_FILES,
    );
    const candidate = generateAustralianCandidate({
      archive: parsed,
      archiveSha256,
      configuration,
      generatedAt: generatedAt ?? configuration?.generation?.generatedAt,
    });
    const activatedCandidate = activateTimeZoneDataPack(candidate);
    const diff = semanticDiff(baseline, activatedCandidate);
    assertReviewedSemanticDiff(expected, diff, archiveSha256, parsed.version);
    const conformance = runConformance(
      activatedCandidate,
      configuration,
      parsed,
      baseline,
      expected?.differences ?? [],
    );

    const identity = identityFor({
      archiveSha256,
      configuration,
      configurationBytes,
      generatedAt: activatedCandidate.generatedAt,
      keyId,
      verificationFingerprint: verification.fingerprint,
    });
    const review = reviewArtifact(expected);
    const expectedPackBytes = Buffer.from(
      `${JSON.stringify(candidate, null, 2)}\n`,
    );
    await mkdir(dirname(output), { recursive: true });
    const unlock = await acquireLock(output);
    try {
      const existingIdentity = await existingOutputIdentity(
        output,
        expectedPackBytes,
        diff,
        identity,
        review,
        signingMaterial,
      );
      if (
        existingIdentity !== null &&
        sameIdentity(existingIdentity, identity)
      ) {
        return {
          archiveSha256,
          conformance,
          packVersion: activatedCandidate.packVersion,
          status: 'no-change',
        };
      }

      const stagingDirectory = await mkdtemp(
        join(dirname(output), `.${output.split(sep).at(-1)}.staging-`),
      );
      try {
        let packPath = 'candidate.pack.json';
        if (privateKeyPath !== undefined) {
          const unsignedPath = await writeStagedPack(
            stagingDirectory,
            candidate,
          );
          const published = await publishSignedPack({
            keyId,
            outputDirectory: stagingDirectory,
            packPath: unsignedPath,
            privateKeyPath,
          });
          await rm(unsignedPath, { force: true });
          packPath = relativeArtifactPath(stagingDirectory, published.packPath);
        } else {
          await writeFile(
            join(stagingDirectory, packPath),
            `${JSON.stringify(candidate, null, 2)}\n`,
            {
              flag: 'wx',
            },
          );
        }
        const packBytes = await readFile(join(stagingDirectory, packPath));
        if (!Buffer.from(packBytes).equals(expectedPackBytes)) {
          fail('signing seam changed candidate pack bytes');
        }
        const provenance = {
          archive: {
            sha256: archiveSha256,
            version: parsed.version,
          },
          conformance,
          generatedAt: activatedCandidate.generatedAt,
          identity,
          packPath,
          packSha256: sha256(packBytes),
          packVersion: activatedCandidate.packVersion,
          review,
          semanticDiff: diff.differences,
          signature: privateKeyPath === undefined ? null : { keyId },
          sourceFiles: [...configuration.source.files],
          verification,
        };
        await Promise.all([
          writeFile(
            join(stagingDirectory, 'provenance.json'),
            `${JSON.stringify(provenance, null, 2)}\n`,
            { flag: 'wx' },
          ),
          writeFile(join(stagingDirectory, 'semantic-diff.txt'), diff.text, {
            flag: 'wx',
          }),
        ]);
        await commitDirectory(stagingDirectory, output);
        return {
          archiveSha256,
          conformance,
          diff: diff.text,
          outputDirectory: output,
          packVersion: activatedCandidate.packVersion,
          status: 'published',
        };
      } catch (error) {
        await rm(stagingDirectory, { recursive: true, force: true });
        throw error;
      }
    } finally {
      await unlock();
    }
  } finally {
    await rm(archiveSnapshotDirectory, { recursive: true, force: true });
  }
}

async function writeStagedPack(stagingDirectory, candidate) {
  const path = join(stagingDirectory, 'candidate.pack.json');
  await writeFile(path, `${JSON.stringify(candidate, null, 2)}\n`, {
    flag: 'wx',
  });
  return path;
}

async function main() {
  const result = await refreshAustralianPack({
    archivePath: optionValue('--archive'),
    baselinePath: optionValue('--baseline'),
    configurationPath: optionValue('--config'),
    expectedDiffPath: optionValue('--expected-diff'),
    generatedAt: optionValue('--generated-at'),
    gpgPath: optionValue('--gpg'),
    keyId: optionValue('--key-id'),
    outputDirectory: optionValue('--output-directory'),
    privateKeyPath: optionValue('--private-key'),
    signaturePath: optionValue('--signature'),
    trustedFingerprint: optionValue('--trusted-fingerprint'),
    trustedKeyPath: optionValue('--trusted-key'),
  });
  if (result.status === 'no-change') {
    process.stdout.write(
      `NO CHANGE: verified ${result.packVersion} (${result.archiveSha256})\n`,
    );
    return;
  }
  process.stdout.write(
    `PUBLISHED: ${result.packVersion} -> ${result.outputDirectory}\n`,
  );
  process.stdout.write(result.diff);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

export { defaultBaselinePath, defaultConfigurationPath };
