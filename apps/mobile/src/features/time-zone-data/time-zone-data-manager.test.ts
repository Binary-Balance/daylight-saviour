import * as ed25519 from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bundledAustralianDataPack } from '@daylight-saviour/time-zone-data';

import {
  createTimeZoneDataPackManager,
  parseTimeZoneDataPackRemoteConfig,
  type TimeZoneDataPackStorage,
} from './time-zone-data-manager';

ed25519.hashes.sha512 = sha512;
const testOnlyPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index);
const trustedKeys = {
  'test-only-2026-a': 'A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=',
};

function newerPack() {
  const pack = structuredClone(bundledAustralianDataPack);
  pack.generatedAt = '2026-07-20T00:00:00.000Z';
  pack.packVersion = '2026d-australian-v1';
  pack.source.version = '2026d';
  pack.source.versionUrl =
    'https://data.iana.org/time-zones/releases/tzdata2026d.tar.gz';
  return pack;
}

function signedArtifacts(pack = newerPack()) {
  const bytes = new TextEncoder().encode(`${JSON.stringify(pack, null, 2)}\n`);
  const manifest = {
    manifestVersion: 1,
    pack: {
      byteLength: bytes.byteLength,
      packVersion: pack.packVersion,
      path: `packs/${pack.packVersion}.pack.json`,
      schemaVersion: pack.schemaVersion,
      sha256: Array.from(sha256(bytes), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(''),
    },
    signature: {
      algorithm: 'Ed25519',
      keyId: 'test-only-2026-a',
      value: base64(ed25519.sign(bytes, testOnlyPrivateKey)),
    },
  };
  return { bytes, manifest };
}

function base64(bytes: Uint8Array) {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const value =
      (bytes[index]! << 16) |
      ((bytes[index + 1] ?? 0) << 8) |
      (bytes[index + 2] ?? 0);
    encoded += alphabet[(value >>> 18) & 63];
    encoded += alphabet[(value >>> 12) & 63];
    encoded += remaining > 1 ? alphabet[(value >>> 6) & 63] : '=';
    encoded += remaining > 2 ? alphabet[value & 63] : '=';
  }
  return encoded;
}

function response(
  status: number,
  body: Uint8Array | string = '',
  headers: Record<string, string> = {},
) {
  const bytes =
    typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    headers: {
      get: (name: string) => normalized.get(name.toLowerCase()) ?? null,
    },
    status,
  };
}

function memoryStorage(
  initial: string | null = null,
): TimeZoneDataPackStorage & { value: string | null } {
  return {
    value: initial,
    async load() {
      return this.value;
    },
    async save(value) {
      this.value = value;
    },
  };
}

function managerWith({
  now = new Date('2026-07-20T01:00:00.000Z'),
  request,
  storage = memoryStorage(),
}: {
  now?: Date;
  request: jest.Mock;
  storage?: TimeZoneDataPackStorage;
}) {
  return createTimeZoneDataPackManager({
    bundledPack: bundledAustralianDataPack,
    now: () => now,
    remoteConfig: {
      manifestUrl: 'https://data.example.test/time-zone/manifest.json',
      trustedKeys,
    },
    request,
    storage,
  });
}

describe('Time-Zone Data Pack manager', () => {
  it('checks manifest then atomically activates and caches a newer verified pack', async () => {
    const artifacts = signedArtifacts();
    const storage = memoryStorage();
    const request = jest
      .fn()
      .mockResolvedValueOnce(
        response(200, JSON.stringify(artifacts.manifest), {
          etag: '"manifest-v2"',
          'last-modified': 'Mon, 20 Jul 2026 00:00:00 GMT',
        }),
      )
      .mockResolvedValueOnce(response(200, artifacts.bytes));
    const manager = managerWith({ request, storage });

    await manager.initialize();

    expect(manager.getSnapshot()).toMatchObject({
      freshness: 'current',
      pack: { packVersion: '2026d-australian-v1' },
      source: 'remote',
    });
    expect(request.mock.calls[1]?.[0]).toBe(
      'https://data.example.test/time-zone/packs/2026d-australian-v1.pack.json',
    );
    expect(storage.value).toContain('2026d-australian-v1');
  });

  it('restores a cached verified pack before making its cold-launch check', async () => {
    const artifacts = signedArtifacts();
    const storage = memoryStorage();
    const seedRequest = jest
      .fn()
      .mockResolvedValueOnce(
        response(200, JSON.stringify(artifacts.manifest), {
          etag: '"manifest-v2"',
        }),
      )
      .mockResolvedValueOnce(response(200, artifacts.bytes));
    await managerWith({ request: seedRequest, storage }).initialize();

    let restoredManager: ReturnType<typeof managerWith>;
    const request = jest.fn(async () => {
      expect(restoredManager.getSnapshot()).toMatchObject({
        pack: { packVersion: '2026d-australian-v1' },
        source: 'cached',
      });
      return response(304);
    });
    restoredManager = managerWith({ request, storage });
    await restoredManager.initialize();

    expect(restoredManager.getSnapshot().pack.packVersion).toBe(
      '2026d-australian-v1',
    );
  });

  it('preserves active last-known-good data when a later refresh fails', async () => {
    const artifacts = signedArtifacts();
    const request = jest
      .fn()
      .mockResolvedValueOnce(response(200, JSON.stringify(artifacts.manifest)))
      .mockResolvedValueOnce(response(200, artifacts.bytes))
      .mockRejectedValueOnce(new Error('offline'));
    const manager = managerWith({ request });
    await manager.initialize();

    await manager.refresh('manual');

    expect(manager.getSnapshot()).toMatchObject({
      freshness: 'retry-failed',
      pack: { packVersion: '2026d-australian-v1' },
      source: 'remote',
    });
  });

  it('reports automatic HTTP failure without claiming device is offline', async () => {
    const manager = managerWith({
      request: jest.fn().mockResolvedValue(response(500)),
    });

    await manager.initialize();

    expect(manager.getSnapshot()).toMatchObject({
      freshness: 'retry-failed',
      pack: { packVersion: bundledAustralianDataPack.packVersion },
    });
  });

  it('keeps valid facts available offline after an automatic transport failure', async () => {
    const manager = managerWith({
      request: jest.fn().mockRejectedValue(new Error('offline')),
    });

    await manager.initialize();

    expect(manager.getSnapshot()).toMatchObject({
      freshness: 'offline-valid',
      pack: { packVersion: bundledAustralianDataPack.packVersion },
      source: 'bundled',
    });
  });

  it('keeps bundled data current when remote build config is disabled', async () => {
    const request = jest.fn();
    const manager = createTimeZoneDataPackManager({
      bundledPack: bundledAustralianDataPack,
      now: () => new Date('2026-07-20T01:00:00.000Z'),
      remoteConfig: null,
      request,
      storage: memoryStorage(),
    });

    await manager.initialize();

    expect(manager.getSnapshot()).toMatchObject({
      freshness: 'current',
      remoteEnabled: false,
      source: 'bundled',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [
      'corrupt bytes',
      (artifacts: ReturnType<typeof signedArtifacts>) => {
        artifacts.bytes[0] ^= 1;
      },
    ],
    [
      'bad signature',
      (artifacts: ReturnType<typeof signedArtifacts>) => {
        artifacts.manifest.signature.value = `${'A'.repeat(86)}==`;
      },
    ],
    [
      'schema-incompatible content',
      (artifacts: ReturnType<typeof signedArtifacts>) => {
        const pack = newerPack();
        pack.schemaVersion = 3;
        Object.assign(artifacts, signedArtifacts(pack));
      },
    ],
    [
      'incomplete Australian Coverage',
      (artifacts: ReturnType<typeof signedArtifacts>) => {
        const pack = newerPack();
        pack.zones.pop();
        Object.assign(artifacts, signedArtifacts(pack));
      },
    ],
  ])('never activates %s', async (_name, mutate) => {
    const artifacts = signedArtifacts();
    mutate(artifacts);
    const request = jest
      .fn()
      .mockResolvedValueOnce(response(200, JSON.stringify(artifacts.manifest)))
      .mockResolvedValueOnce(response(200, artifacts.bytes));
    const manager = managerWith({ request });

    await manager.initialize();

    expect(manager.getSnapshot()).toMatchObject({
      freshness: 'retry-failed',
      pack: { packVersion: bundledAustralianDataPack.packVersion },
      source: 'bundled',
    });
  });

  it('rejects a valid signed downgrade', async () => {
    const oldPack = structuredClone(bundledAustralianDataPack);
    oldPack.generatedAt = '2026-07-18T00:00:00.000Z';
    oldPack.packVersion = '2026b-australian-v1';
    oldPack.source.version = '2026b';
    oldPack.source.versionUrl =
      'https://data.iana.org/time-zones/releases/tzdata2026b.tar.gz';
    const artifacts = signedArtifacts(oldPack);
    const request = jest
      .fn()
      .mockResolvedValueOnce(response(200, JSON.stringify(artifacts.manifest)))
      .mockResolvedValueOnce(response(200, artifacts.bytes));
    const manager = managerWith({ request });

    await manager.initialize();

    expect(manager.getSnapshot()).toMatchObject({
      freshness: 'retry-failed',
      pack: { packVersion: bundledAustralianDataPack.packVersion },
    });
  });

  it('rejects ambiguous same-source versions without a newer generation instant', async () => {
    const ambiguous = structuredClone(bundledAustralianDataPack);
    ambiguous.packVersion = '2026c-z-lexically-higher-v999';
    const artifacts = signedArtifacts(ambiguous);
    const request = jest
      .fn()
      .mockResolvedValueOnce(response(200, JSON.stringify(artifacts.manifest)))
      .mockResolvedValueOnce(response(200, artifacts.bytes));
    const manager = managerWith({ request });

    await manager.initialize();

    expect(manager.getSnapshot()).toMatchObject({
      freshness: 'retry-failed',
      pack: { packVersion: bundledAustralianDataPack.packVersion },
    });
  });

  it('sends ETag and Last-Modified validators and accepts 304', async () => {
    const artifacts = signedArtifacts();
    const request = jest
      .fn()
      .mockResolvedValueOnce(
        response(200, JSON.stringify(artifacts.manifest), {
          etag: '"manifest-v2"',
          'last-modified': 'Mon, 20 Jul 2026 00:00:00 GMT',
        }),
      )
      .mockResolvedValueOnce(response(200, artifacts.bytes));
    const manager = managerWith({ request });
    await manager.initialize();
    request.mockResolvedValueOnce(response(304));

    await manager.refresh('manual');

    expect(request.mock.calls.at(-1)?.[1]?.headers).toMatchObject({
      'If-Modified-Since': 'Mon, 20 Jul 2026 00:00:00 GMT',
      'If-None-Match': '"manifest-v2"',
    });
    expect(manager.getSnapshot().freshness).toBe('current');
  });

  it('checks every cold launch but gates foreground checks for 24 hours', async () => {
    let now = new Date('2026-07-20T01:00:00.000Z');
    const request = jest.fn().mockResolvedValue(response(304));
    const manager = createTimeZoneDataPackManager({
      bundledPack: bundledAustralianDataPack,
      now: () => now,
      remoteConfig: {
        manifestUrl: 'https://data.example.test/time-zone/manifest.json',
        trustedKeys,
      },
      request,
      storage: memoryStorage(),
    });
    await manager.initialize();
    expect(request).toHaveBeenCalledTimes(1);

    now = new Date('2026-07-21T00:59:59.999Z');
    await manager.refresh('foreground');
    expect(request).toHaveBeenCalledTimes(1);

    now = new Date('2026-07-21T01:00:00.000Z');
    await manager.refresh('foreground');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent refreshes into one manifest request', async () => {
    let resolveRequest: (value: ReturnType<typeof response>) => void = () => {};
    const request = jest.fn(
      () =>
        new Promise<ReturnType<typeof response>>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const manager = managerWith({ request });

    const first = manager.refresh('manual');
    const second = manager.refresh('manual');
    resolveRequest(response(304));
    await Promise.all([first, second]);

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('fails closed after Validity Horizon while preserving pack metadata', async () => {
    const request = jest.fn().mockRejectedValue(new Error('offline'));
    const manager = managerWith({
      now: new Date('2031-01-01T00:00:00.000Z'),
      request,
    });

    await manager.initialize();

    expect(manager.getSnapshot()).toMatchObject({
      freshness: 'expired',
      pack: { packVersion: bundledAustralianDataPack.packVersion },
    });
  });
});

describe('remote build configuration', () => {
  it('accepts HTTPS URL and build-configured trusted key ring', () => {
    expect(
      parseTimeZoneDataPackRemoteConfig({
        manifestUrl: 'https://data.example.test/time-zone/manifest.json',
        trustedKeysJson: JSON.stringify(trustedKeys),
      }),
    ).toEqual({
      manifestUrl: 'https://data.example.test/time-zone/manifest.json',
      trustedKeys,
    });
  });

  it.each([
    [undefined, undefined],
    ['http://data.example.test/manifest.json', JSON.stringify(trustedKeys)],
    ['https://user@example.test/manifest.json', JSON.stringify(trustedKeys)],
    [
      'https://data.example.test/manifest.json?latest=1',
      JSON.stringify(trustedKeys),
    ],
    ['https://data.example.test/manifest.json', '{}'],
    ['https://data.example.test/manifest.json', '{bad'],
  ])(
    'disables remote refresh for invalid or missing config',
    (manifestUrl, keys) => {
      expect(
        parseTimeZoneDataPackRemoteConfig({
          manifestUrl,
          trustedKeysJson: keys,
        }),
      ).toBeNull();
    },
  );
});
