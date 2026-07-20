import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { publishSignedPack } from '../scripts/sign-australian-pack.mjs';
import { createSignedPackTestDeployment } from '../scripts/serve-test-deployment.mjs';
import { createTimeZoneDataPackManager } from '../../../apps/mobile/src/features/time-zone-data/time-zone-data-manager.ts';

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('local signed-pack test deployment', () => {
  it('serves conditional manifest and immutable versioned pack bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'daylight-pack-http-'));
    const published = await publishSignedPack({
      keyId: 'test-only-2026-a',
      outputDirectory: directory,
      packPath: new URL(
        '../generated/australian-coverage.pack.json',
        import.meta.url,
      ),
      privateKeyPath: new URL(
        '../test-fixtures/TEST-ONLY-ed25519-private.pem',
        import.meta.url,
      ),
    });
    const server = await createSignedPackTestDeployment({ directory });
    servers.push(server);

    const manifestResponse = await fetch(`${server.url}/manifest.json`);
    assert.equal(manifestResponse.status, 200);
    assert.equal(manifestResponse.headers.get('cache-control'), 'no-cache');
    const etag = manifestResponse.headers.get('etag');
    const lastModified = manifestResponse.headers.get('last-modified');
    assert.ok(etag);
    assert.ok(lastModified);

    const notModified = await fetch(`${server.url}/manifest.json`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(notModified.status, 304);

    const manifest = await manifestResponse.json();
    const packResponse = await fetch(`${server.url}/${manifest.pack.path}`);
    assert.equal(packResponse.status, 200);
    assert.equal(
      packResponse.headers.get('cache-control'),
      'public, max-age=31536000, immutable',
    );
    assert.deepEqual(
      new Uint8Array(await packResponse.arrayBuffer()),
      Uint8Array.from(await readFile(published.packPath)),
    );
    assert.equal((await fetch(`${server.url}/latest.json`)).status, 404);
  });

  it('refreshes manager through real HTTP then receives conditional 304', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'daylight-pack-e2e-'));
    const bundledPack = JSON.parse(
      await readFile(
        new URL('../generated/australian-coverage.pack.json', import.meta.url),
        'utf8',
      ),
    );
    const candidate = structuredClone(bundledPack);
    candidate.generatedAt = '2026-07-20T00:00:00.000Z';
    candidate.packVersion = '2026d-australian-v1';
    candidate.source.version = '2026d';
    candidate.source.versionUrl =
      'https://data.iana.org/time-zones/releases/tzdata2026d.tar.gz';
    const candidatePath = join(directory, 'candidate.pack.json');
    await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);

    const deploymentDirectory = join(directory, 'deployment');
    await publishSignedPack({
      keyId: 'test-only-2026-a',
      outputDirectory: deploymentDirectory,
      packPath: candidatePath,
      privateKeyPath: new URL(
        '../test-fixtures/TEST-ONLY-ed25519-private.pem',
        import.meta.url,
      ),
    });
    const server = await createSignedPackTestDeployment({
      directory: deploymentDirectory,
    });
    servers.push(server);

    const exchanges = [];
    const request = async (url, init) => {
      const result = await fetch(url, init);
      exchanges.push({ headers: init.headers, status: result.status, url });
      return result;
    };
    let stored = null;
    const manager = createTimeZoneDataPackManager({
      bundledPack,
      now: () => new Date('2026-07-20T01:00:00.000Z'),
      remoteConfig: {
        manifestUrl: `${server.url}/manifest.json`,
        trustedKeys: {
          'test-only-2026-a': 'A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=',
        },
      },
      request,
      storage: {
        load: async () => stored,
        save: async (value) => {
          stored = value;
        },
      },
    });

    await manager.initialize();
    assert.equal(manager.getSnapshot().pack.packVersion, candidate.packVersion);
    assert.equal(manager.getSnapshot().source, 'remote');
    await manager.refresh('manual');

    assert.deepEqual(
      exchanges.map(({ status }) => status),
      [200, 200, 304],
    );
    assert.equal(exchanges[2].headers['If-None-Match'].startsWith('"'), true);
    assert.equal(
      exchanges[2].headers['If-Modified-Since'].endsWith('GMT'),
      true,
    );
  });
});
