import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  activateSignedTimeZoneDataPackManifest,
  verifySignedTimeZoneDataPackBytes,
} from '@daylight-saviour/contracts';

import { publishSignedPack } from '../scripts/sign-australian-pack.mjs';

const packageDirectory = new URL('../', import.meta.url);
const packPath = new URL(
  '../generated/australian-coverage.pack.json',
  import.meta.url,
);
const privateKeyPath = new URL(
  '../test-fixtures/TEST-ONLY-ed25519-private.pem',
  import.meta.url,
);

describe('signed Time-Zone Data Pack publisher', () => {
  it('emits byte-stable immutable artifacts signed over exact pack bytes', async () => {
    const first = await mkdtemp(join(tmpdir(), 'daylight-pack-first-'));
    const second = await mkdtemp(join(tmpdir(), 'daylight-pack-second-'));

    const firstResult = await publishSignedPack({
      keyId: 'test-only-2026-a',
      outputDirectory: first,
      packPath,
      privateKeyPath,
    });
    const secondResult = await publishSignedPack({
      keyId: 'test-only-2026-a',
      outputDirectory: second,
      packPath,
      privateKeyPath,
    });

    const [firstManifestBytes, secondManifestBytes, originalPackBytes] =
      await Promise.all([
        readFile(firstResult.manifestPath),
        readFile(secondResult.manifestPath),
        readFile(packPath),
      ]);
    assert.deepEqual(firstManifestBytes, secondManifestBytes);
    assert.deepEqual(await readFile(firstResult.packPath), originalPackBytes);
    assert.deepEqual(await readFile(secondResult.packPath), originalPackBytes);

    const manifest = activateSignedTimeZoneDataPackManifest(
      JSON.parse(firstManifestBytes.toString('utf8')),
    );
    const activated = verifySignedTimeZoneDataPackBytes(
      manifest,
      originalPackBytes,
      {
        'test-only-2026-a': 'A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=',
      },
    );
    assert.equal(
      manifest.pack.path,
      `packs/${activated.packVersion}.pack.json`,
    );
    assert.deepEqual((await readdir(first)).sort(), ['manifest.json', 'packs']);
    assert.equal(
      (await readdir(join(first, 'packs'))).includes(
        'TEST-ONLY-ed25519-private.pem',
      ),
      false,
    );
  });

  it('requires explicit private-key, key-ID, and output inputs', async () => {
    await assert.rejects(
      () =>
        publishSignedPack({
          outputDirectory: new URL('unused', packageDirectory),
          packPath,
        }),
      /private key path and key ID are required/,
    );
  });

  it('rejects unsafe pack versions before writing output paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'daylight-pack-unsafe-'));
    const pack = JSON.parse(await readFile(packPath, 'utf8'));
    pack.packVersion = '2026c-../../escape';
    const unsafePackPath = join(directory, 'unsafe.pack.json');
    await writeFile(unsafePackPath, `${JSON.stringify(pack, null, 2)}\n`);

    await assert.rejects(
      () =>
        publishSignedPack({
          keyId: 'test-only-2026-a',
          outputDirectory: join(directory, 'output'),
          packPath: unsafePackPath,
          privateKeyPath,
        }),
      /portable version identifier/,
    );
  });

  it('rejects malformed UTF-8 before signing or writing artifacts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'daylight-pack-utf8-'));
    const bytes = await readFile(packPath);
    const labelIndex = bytes.indexOf('Sydney');
    assert.notEqual(labelIndex, -1);
    bytes[labelIndex] = 0xff;
    const malformedPackPath = join(directory, 'malformed.pack.json');
    await writeFile(malformedPackPath, bytes);

    await assert.rejects(
      () =>
        publishSignedPack({
          keyId: 'test-only-2026-a',
          outputDirectory: join(directory, 'output'),
          packPath: malformedPackPath,
          privateKeyPath,
        }),
      /must be UTF-8 JSON/,
    );
  });
});
