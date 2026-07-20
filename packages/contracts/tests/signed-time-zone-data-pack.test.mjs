import assert from 'node:assert/strict';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import { describe, it } from 'node:test';

import {
  activateSignedTimeZoneDataPackManifestBytes,
  activateSignedTimeZoneDataPackManifest,
  SignedTimeZoneDataPackValidationError,
  verifySignedTimeZoneDataPackBytes,
} from '../src/index.ts';

const testOnlyPrivateKey = createPrivateKey(`-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f
-----END PRIVATE KEY-----`);
const rotatedTestOnlyPrivateKey = createPrivateKey(`-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEICAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/
-----END PRIVATE KEY-----`);

const validPack = {
  coverage: {
    startsAt: '2025-01-01T00:00:00.000Z',
    validUntil: '2027-01-01T00:00:00.000Z',
  },
  generatedAt: '2026-07-19T06:09:07.000Z',
  packVersion: '2026c-test-v1',
  schemaVersion: 2,
  source: {
    archiveSha256:
      'e4a178a4477f3d0ea77cc31828ff72aa38feff8d61aa13e7e99e142e9d902be4',
    files: ['australasia'],
    name: 'IANA Time Zone Database',
    version: '2026c',
    versionUrl: 'https://data.iana.org/time-zones/releases/tzdata2026c.tar.gz',
  },
  zones: [
    {
      friendlyLabel: 'Sydney, Canberra & most of NSW',
      id: 'Australia/Sydney',
      initial: {
        abbreviation: 'AEDT',
        daylightSaving: true,
        utcOffsetSeconds: 39_600,
      },
      transitions: [
        {
          abbreviation: 'AEST',
          at: '2025-04-05T16:00:00.000Z',
          daylightSaving: false,
          offsetBeforeSeconds: 39_600,
          utcOffsetSeconds: 36_000,
        },
      ],
    },
  ],
};

function rawPublicKey(privateKey) {
  return createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64');
}

function signedFixture(
  privateKey = testOnlyPrivateKey,
  keyId = 'test-only-2026-a',
) {
  const bytes = new TextEncoder().encode(`${JSON.stringify(validPack)}\n`);
  return {
    bytes,
    manifest: {
      manifestVersion: 1,
      pack: {
        byteLength: bytes.byteLength,
        packVersion: validPack.packVersion,
        path: `packs/${validPack.packVersion}.pack.json`,
        schemaVersion: validPack.schemaVersion,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      signature: {
        algorithm: 'Ed25519',
        keyId,
        value: sign(null, bytes, privateKey).toString('base64'),
      },
    },
  };
}

describe('signed Time-Zone Data Pack contract', () => {
  it('activates exact bytes signed by a configured trusted key', () => {
    const fixture = signedFixture();
    const pack = verifySignedTimeZoneDataPackBytes(
      activateSignedTimeZoneDataPackManifest(fixture.manifest),
      fixture.bytes,
      { 'test-only-2026-a': rawPublicKey(testOnlyPrivateKey) },
    );

    assert.equal(pack.packVersion, '2026c-test-v1');
    assert.equal(Object.isFrozen(pack), true);
  });

  it('supports key rotation only when both build-configured keys are trusted', () => {
    const oldFixture = signedFixture();
    const newFixture = signedFixture(
      rotatedTestOnlyPrivateKey,
      'test-only-2026-b',
    );
    const trustedKeys = {
      'test-only-2026-a': rawPublicKey(testOnlyPrivateKey),
      'test-only-2026-b': rawPublicKey(rotatedTestOnlyPrivateKey),
    };

    assert.equal(
      verifySignedTimeZoneDataPackBytes(
        activateSignedTimeZoneDataPackManifest(oldFixture.manifest),
        oldFixture.bytes,
        trustedKeys,
      ).packVersion,
      validPack.packVersion,
    );
    assert.equal(
      verifySignedTimeZoneDataPackBytes(
        activateSignedTimeZoneDataPackManifest(newFixture.manifest),
        newFixture.bytes,
        trustedKeys,
      ).packVersion,
      validPack.packVersion,
    );
    assert.throws(
      () =>
        verifySignedTimeZoneDataPackBytes(
          activateSignedTimeZoneDataPackManifest(newFixture.manifest),
          newFixture.bytes,
          { 'test-only-2026-a': rawPublicKey(testOnlyPrivateKey) },
        ),
      /unknown trusted key/,
    );
  });

  it('rejects a typed but unactivated manifest', () => {
    const fixture = signedFixture();

    assert.throws(
      () =>
        verifySignedTimeZoneDataPackBytes(
          structuredClone(fixture.manifest),
          fixture.bytes,
          { 'test-only-2026-a': rawPublicKey(testOnlyPrivateKey) },
        ),
      /manifest must be activated/,
    );
  });

  it('rejects malformed UTF-8 manifest bytes without runtime polyfills', () => {
    assert.throws(
      () =>
        activateSignedTimeZoneDataPackManifestBytes(
          Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
        ),
      /expected UTF-8 JSON/,
    );
  });

  for (const [name, mutate, expected] of [
    [
      'unknown manifest fields',
      (fixture) => (fixture.manifest.surprise = true),
      /expected keys/,
    ],
    [
      'unsupported manifest versions',
      (fixture) => (fixture.manifest.manifestVersion = 2),
      /unsupported version/,
    ],
    [
      'path traversal',
      (fixture) => (fixture.manifest.pack.path = '../pack.json'),
      /immutable relative path/,
    ],
    [
      'mutable pack paths',
      (fixture) => (fixture.manifest.pack.path = 'packs/latest.pack.json'),
      /must identify pack version/,
    ],
    [
      'oversized declared packs',
      (fixture) => (fixture.manifest.pack.byteLength = 2_097_153),
      /maximum/,
    ],
    [
      'non-canonical signatures',
      (fixture) => (fixture.manifest.signature.value += '\n'),
      /base64/,
    ],
  ]) {
    it(`rejects ${name}`, () => {
      const fixture = signedFixture();
      mutate(fixture);
      assert.throws(
        () => activateSignedTimeZoneDataPackManifest(fixture.manifest),
        (error) =>
          error instanceof SignedTimeZoneDataPackValidationError &&
          expected.test(error.message),
      );
    });
  }

  for (const [name, mutate, expected] of [
    [
      'changed exact bytes',
      (fixture) => (fixture.bytes[0] ^= 1),
      /SHA-256 mismatch/,
    ],
    [
      'wrong declared byte length',
      (fixture) => (fixture.manifest.pack.byteLength -= 1),
      /byte length mismatch/,
    ],
    [
      'bad signatures even with a matching digest',
      (fixture) => {
        fixture.bytes[0] ^= 1;
        fixture.manifest.pack.sha256 = createHash('sha256')
          .update(fixture.bytes)
          .digest('hex');
      },
      /signature mismatch/,
    ],
    [
      'manifest metadata inconsistent with signed pack',
      (fixture) => (fixture.manifest.pack.packVersion = '2026c-test-v2'),
      /must identify pack version|does not match signed pack/,
    ],
  ]) {
    it(`rejects ${name}`, () => {
      const fixture = signedFixture();
      mutate(fixture);
      assert.throws(
        () =>
          verifySignedTimeZoneDataPackBytes(
            activateSignedTimeZoneDataPackManifest(fixture.manifest),
            fixture.bytes,
            { 'test-only-2026-a': rawPublicKey(testOnlyPrivateKey) },
          ),
        (error) =>
          error instanceof SignedTimeZoneDataPackValidationError &&
          expected.test(error.message),
      );
    });
  }
});
