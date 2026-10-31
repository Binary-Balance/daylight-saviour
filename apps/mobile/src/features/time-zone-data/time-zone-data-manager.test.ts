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

// JSON ignores trailing whitespace, so padding lets a valid manifest or signed
// pack sit exactly on a byte limit.
function padded(bytes: Uint8Array, length: number) {
  const result = new Uint8Array(Math.max(bytes.byteLength, length)).fill(0x20);
  result.set(bytes);
  return result;
}

function signedArtifacts(pack = newerPack(), length = 0) {
  const bytes = padded(
    new TextEncoder().encode(`${JSON.stringify(pack, null, 2)}\n`),
    length,
  );
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
  body: Uint8Array | Uint8Array[] | string = '',
  headers: Record<string, string> = {},
) {
  const chunks = Array.isArray(body)
    ? body
    : [typeof body === 'string' ? new TextEncoder().encode(body) : body];
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  // A high water mark of 0 stops the stream reading ahead, so `pulled` counts
  // exactly the chunks the manager asked for. The rest stay unread.
  const reads = { cancelled: false, pulled: 0 };
  return {
    body: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[reads.pulled];
          if (chunk === undefined) {
            controller.close();
          } else {
            reads.pulled += 1;
            controller.enqueue(chunk);
          }
        },
        cancel() {
          reads.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    headers: {
      get: (name: string) => normalized.get(name.toLowerCase()) ?? null,
    },
    reads,
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

describe('Time-Zone Data Pack download bounds', () => {
  const limits = { manifest: 64 * 1024, pack: 2 * 1024 * 1024 };
  const targets = ['manifest', 'pack'] as const;
  type Target = (typeof targets)[number];
  const chunkSize = 16 * 1024;
  const unread = 3;

  function chunksOf(bytes: Uint8Array) {
    return Array.from(
      { length: Math.ceil(bytes.byteLength / chunkSize) },
      (_, index) => bytes.subarray(index * chunkSize, (index + 1) * chunkSize),
    );
  }

  // Valid content that is exactly at the target's limit, with the artifacts
  // it belongs to.
  function atLimit(target: Target) {
    const artifacts = signedArtifacts(
      newerPack(),
      target === 'pack' ? limits.pack : 0,
    );
    const body =
      target === 'pack'
        ? artifacts.bytes
        : padded(
            new TextEncoder().encode(JSON.stringify(artifacts.manifest)),
            limits.manifest,
          );
    return { artifacts, body };
  }

  // The same content plus one more byte, then chunks that must stay unread.
  // Only its length is wrong, so a manager that truncated at the limit or read
  // past it would accept it.
  function overLimit(body: Uint8Array) {
    const spaces = (length: number) => new Uint8Array(length).fill(0x20);
    return [
      ...chunksOf(body),
      spaces(1),
      ...Array.from({ length: unread }, () => spaces(chunkSize)),
    ];
  }

  // Serves `served` as the target's response and valid ones for the other
  // request, then runs the cold-launch check.
  async function check(
    target: Target,
    served: unknown,
    artifacts = signedArtifacts(),
  ) {
    const request = jest
      .fn()
      .mockResolvedValueOnce(
        target === 'manifest'
          ? served
          : response(200, JSON.stringify(artifacts.manifest)),
      )
      .mockResolvedValueOnce(
        target === 'pack' ? served : response(200, artifacts.bytes),
      );
    const storage = memoryStorage();
    const manager = managerWith({ request, storage });
    await manager.initialize();
    return { manager, request, storage };
  }

  // A rejected body is an HTTP-style failure, not a lost connection.
  function expectRetryFailed(manager: ReturnType<typeof managerWith>) {
    expect(manager.getSnapshot()).toMatchObject({
      freshness: 'retry-failed',
      lastError: 'refresh-failed',
      pack: { packVersion: bundledAustralianDataPack.packVersion },
      source: 'bundled',
    });
  }

  it.each<[Target, string, Record<string, string>]>([
    ['manifest', 'no Content-Length', {}],
    ['manifest', 'an understated Content-Length', { 'content-length': '1' }],
    ['pack', 'no Content-Length', {}],
    ['pack', 'an understated Content-Length', { 'content-length': '1' }],
  ])(
    'cancels a %s body past its limit with %s',
    async (target, _label, headers) => {
      const { artifacts, body } = atLimit(target);
      const chunks = overLimit(body);
      const served = response(200, chunks, headers);

      const { manager, request, storage } = await check(
        target,
        served,
        artifacts,
      );

      expect(served.reads).toEqual({
        cancelled: true,
        pulled: chunks.length - unread,
      });
      expect(served.body.locked).toBe(false);
      expect(request).toHaveBeenCalledTimes(target === 'manifest' ? 1 : 2);
      expectRetryFailed(manager);
      expect(storage.value).not.toContain('2026d');

      // The failed check leaves a manual retry usable.
      const retry = signedArtifacts();
      request
        .mockReset()
        .mockResolvedValueOnce(response(200, JSON.stringify(retry.manifest)))
        .mockResolvedValueOnce(response(200, retry.bytes));
      await manager.refresh('manual');
      expect(manager.getSnapshot()).toMatchObject({
        freshness: 'current',
        lastError: null,
        pack: { packVersion: '2026d-australian-v1' },
        source: 'remote',
      });
    },
  );

  it.each<[Target, string, string]>([
    ['manifest', 'a malformed', '12abc'],
    ['manifest', 'a malformed', 'abc12'],
    ['manifest', 'an excessive', String(limits.manifest + 1)],
    ['pack', 'a malformed', '12abc'],
    ['pack', 'a malformed', 'abc12'],
    ['pack', 'an excessive', String(limits.pack + 1)],
  ])(
    'rejects a %s response with %s Content-Length without reading its body',
    async (target, _label, contentLength) => {
      const artifacts = signedArtifacts();
      const served = response(
        200,
        target === 'pack'
          ? artifacts.bytes
          : JSON.stringify(artifacts.manifest),
        { 'content-length': contentLength },
      );

      const { manager, request } = await check(target, served, artifacts);

      expect(served.reads.pulled).toBe(0);
      // Nothing reads the body, so aborting the request is what stops a
      // download that the native layer would keep buffering.
      expect(request.mock.calls[0][1].signal.aborted).toBe(true);
      expectRetryFailed(manager);
    },
  );

  it('rejects a pack longer than its manifest declares without reading it', async () => {
    const artifacts = signedArtifacts();
    const served = response(200, artifacts.bytes, {
      'content-length': String(artifacts.bytes.byteLength + 1),
    });

    const { manager } = await check('pack', served, artifacts);

    expect(served.reads.pulled).toBe(0);
    expectRetryFailed(manager);
  });

  it.each(targets)('accepts a %s body of exactly its limit', async (target) => {
    const { artifacts, body } = atLimit(target);
    const served = response(200, chunksOf(body), {
      'content-length': String(body.byteLength),
    });

    const { manager } = await check(target, served, artifacts);

    expect(manager.getSnapshot()).toMatchObject({
      freshness: 'current',
      pack: { packVersion: '2026d-australian-v1' },
      source: 'remote',
    });
    expect(served.reads.cancelled).toBe(false);
    expect(served.body.locked).toBe(false);
  });

  it.each(targets)(
    'fails closed instead of buffering a %s response with no stream body',
    async (target) => {
      const artifacts = signedArtifacts();
      const arrayBuffer = jest.fn();
      const served = {
        ...response(
          200,
          target === 'pack'
            ? artifacts.bytes
            : JSON.stringify(artifacts.manifest),
        ),
        arrayBuffer,
        body: null,
      };

      const { manager } = await check(target, served, artifacts);

      expect(arrayBuffer).not.toHaveBeenCalled();
      expectRetryFailed(manager);
    },
  );

  it('treats a body that fails mid-read as a transport loss and releases the reader', async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new Error('connection lost'));
        } else {
          sent = true;
          controller.enqueue(new Uint8Array(16));
        }
      },
    });

    const { manager } = await check('manifest', { ...response(200), body });

    expect(manager.getSnapshot()).toMatchObject({
      freshness: 'offline-valid',
      lastError: 'refresh-failed',
      source: 'bundled',
    });
    expect(body.locked).toBe(false);
  });

  it('rejects a body that Expo delivers as one oversize chunk', async () => {
    const served = response(200, [new Uint8Array(64 * 1024 + 1)]);

    const { manager } = await check('manifest', served);

    expect(served.reads).toEqual({ cancelled: true, pulled: 1 });
    expect(served.body.locked).toBe(false);
    expectRetryFailed(manager);
  });

  it('stops a pack body at the length its manifest declares', async () => {
    const artifacts = signedArtifacts();
    const space = new Uint8Array(1).fill(0x20);
    const served = response(200, [artifacts.bytes, space, space]);

    const { manager } = await check('pack', served, artifacts);

    expect(served.reads).toEqual({ cancelled: true, pulled: 2 });
    expect(served.body.locked).toBe(false);
    expectRetryFailed(manager);
  });

  it('rejects a chunk that is not bytes and cancels the body', async () => {
    const served = response(200, ['not bytes' as never, new Uint8Array(1)]);

    const { manager } = await check('manifest', served);

    expect(served.reads).toEqual({ cancelled: true, pulled: 1 });
    expect(served.body.locked).toBe(false);
    expectRetryFailed(manager);
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

describe('Time-Zone Data Pack refresh deadline', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // Records when a refresh settles, so a refresh that never settles fails
  // an assertion instead of hanging the test.
  function tracked(refresh: Promise<void>) {
    const state = { settled: false };
    void refresh.then(() => {
      state.settled = true;
    });
    return state;
  }

  it.each([
    ['manifest', 0],
    ['pack', 1],
  ])(
    'fails a %s request that never returns headers at the deadline',
    async (_name, stalledCall) => {
      const artifacts = signedArtifacts();
      const signals: AbortSignal[] = [];
      const request = jest.fn(
        (_url: string, init: { readonly signal: AbortSignal }) => {
          const call = signals.push(init.signal) - 1;
          // Like a network implementation that ignores abort and never settles.
          return call === stalledCall
            ? new Promise<never>(() => undefined)
            : Promise.resolve(
                response(200, JSON.stringify(artifacts.manifest)),
              );
        },
      );
      const manager = managerWith({ request });

      const refresh = tracked(manager.refresh('cold-launch'));
      await jest.advanceTimersByTimeAsync(29_999);
      expect(refresh.settled).toBe(false);
      expect(signals[stalledCall]?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);

      expect(refresh.settled).toBe(true);
      expect(signals[stalledCall]?.aborted).toBe(true);
      expect(manager.getSnapshot()).toMatchObject({
        freshness: 'offline-valid',
        lastError: 'refresh-failed',
        source: 'bundled',
      });
    },
  );

  it.each([
    ['manifest', 0],
    ['pack', 1],
  ])(
    'fails a %s whose body stalls part way through as a transport loss',
    async (_name, stalledCall) => {
      const artifacts = signedArtifacts();
      const responses = [
        response(200, JSON.stringify(artifacts.manifest)),
        response(200, artifacts.bytes),
      ];
      // Like a network implementation that ignores abort and never settles.
      let sent = false;
      const stalledBody = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return new Promise<never>(() => undefined);
          sent = true;
          controller.enqueue(new Uint8Array(16));
        },
      });
      const signals: AbortSignal[] = [];
      const request = jest.fn(
        async (_url: string, init: { readonly signal: AbortSignal }) => {
          const call = signals.push(init.signal) - 1;
          return call === stalledCall
            ? { ...responses[call]!, body: stalledBody }
            : responses[call]!;
        },
      );
      const manager = managerWith({ request });

      const refresh = tracked(manager.refresh('cold-launch'));
      await jest.advanceTimersByTimeAsync(30_000);

      expect(refresh.settled).toBe(true);
      expect(signals[stalledCall]?.aborted).toBe(true);
      expect(manager.getSnapshot()).toMatchObject({
        freshness: 'offline-valid',
        lastError: 'refresh-failed',
        source: 'bundled',
      });
    },
  );

  it('lets a manual retry start a new check and ignores the late response', async () => {
    const artifacts = signedArtifacts();
    let respondLate: (late: ReturnType<typeof response>) => void = () =>
      undefined;
    const request = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            respondLate = resolve;
          }),
      )
      .mockResolvedValueOnce(response(200, JSON.stringify(artifacts.manifest)))
      .mockResolvedValueOnce(response(200, artifacts.bytes));
    const manager = managerWith({ request });

    const first = tracked(manager.refresh('foreground'));
    await jest.advanceTimersByTimeAsync(30_000);
    expect(first.settled).toBe(true);

    await manager.refresh('manual');
    expect(manager.getSnapshot()).toMatchObject({
      freshness: 'current',
      pack: { packVersion: '2026d-australian-v1' },
      source: 'remote',
    });

    respondLate(response(500));
    await jest.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(3);
    expect(manager.getSnapshot()).toMatchObject({
      freshness: 'current',
      lastError: null,
      pack: { packVersion: '2026d-australian-v1' },
      source: 'remote',
    });
  });
});
