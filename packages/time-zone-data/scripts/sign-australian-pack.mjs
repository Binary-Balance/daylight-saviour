import { createHash, createPrivateKey, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  activateSignedTimeZoneDataPackManifest,
  activateTimeZoneDataPack,
} from '@daylight-saviour/contracts';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultPackPath = resolve(
  packageDirectory,
  'generated/australian-coverage.pack.json',
);

export async function publishSignedPack({
  keyId,
  outputDirectory,
  packPath = defaultPackPath,
  privateKeyPath,
}) {
  if (!privateKeyPath || !keyId) {
    throw new Error('Explicit private key path and key ID are required');
  }
  if (!outputDirectory) {
    throw new Error('Explicit output directory is required');
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(keyId)) {
    throw new Error('Key ID must be a portable identifier');
  }

  const [packBytes, privateKeyPem] = await Promise.all([
    readFile(packPath),
    readFile(privateKeyPath, 'utf8'),
  ]);
  let packValue;
  try {
    packValue = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(packBytes),
    );
  } catch {
    throw new Error('Time-Zone Data Pack must be UTF-8 JSON');
  }
  const pack = activateTimeZoneDataPack(packValue);
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Private key must be Ed25519');
  }

  const relativePackPath = `packs/${pack.packVersion}.pack.json`;
  const manifest = activateSignedTimeZoneDataPackManifest({
    manifestVersion: 1,
    pack: {
      byteLength: packBytes.byteLength,
      packVersion: pack.packVersion,
      path: relativePackPath,
      schemaVersion: pack.schemaVersion,
      sha256: createHash('sha256').update(packBytes).digest('hex'),
    },
    signature: {
      algorithm: 'Ed25519',
      keyId,
      value: sign(null, packBytes, privateKey).toString('base64'),
    },
  });

  const packOutputPath = join(outputDirectory, manifest.pack.path);
  const manifestPath = join(outputDirectory, 'manifest.json');
  await mkdir(dirname(packOutputPath), { recursive: true });
  await writeFile(packOutputPath, packBytes, { flag: 'wx' });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
  });
  return { manifestPath, packPath: packOutputPath };
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  await publishSignedPack({
    keyId: readOption('--key-id'),
    outputDirectory: readOption('--output-directory'),
    packPath: readOption('--pack') ?? defaultPackPath,
    privateKeyPath: readOption('--private-key'),
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
