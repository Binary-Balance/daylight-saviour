import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
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
  maximumTimeZoneDataPackBytes,
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

const base64Digits =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// The final digit before padding carries unused low bits that canonical
// base64 sets to zero, so the next digit sets one of them.
function nextBase64Digit(digit) {
  return base64Digits[base64Digits.indexOf(digit) + 1];
}

function packBytes(pack) {
  return new TextEncoder().encode(`${JSON.stringify(pack)}\n`);
}

function signedFixture(
  privateKey = testOnlyPrivateKey,
  keyId = 'test-only-2026-a',
  bytes = packBytes(validPack),
) {
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

  it('accepts declared pack sizes from one byte to the maximum', () => {
    for (const byteLength of [1, maximumTimeZoneDataPackBytes]) {
      const fixture = signedFixture();
      fixture.manifest.pack.byteLength = byteLength;

      assert.equal(
        activateSignedTimeZoneDataPackManifest(fixture.manifest).pack
          .byteLength,
        byteLength,
      );
    }
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
      'renamed manifest fields',
      (fixture) => {
        fixture.manifest.signatures = fixture.manifest.signature;
        delete fixture.manifest.signature;
      },
      /expected keys manifestVersion, pack, signature/,
    ],
    [
      'missing manifest fields',
      (fixture) => delete fixture.manifest.signature,
      /expected keys manifestVersion, pack, signature/,
    ],
    [
      'null objects',
      (fixture) => (fixture.manifest.pack = null),
      /\$\.pack: expected an object/,
    ],
    [
      'array objects',
      (fixture) => (fixture.manifest.signature = []),
      /\$\.signature: expected an object/,
    ],
    [
      'fractional versions',
      (fixture) => (fixture.manifest.manifestVersion = 1.5),
      /expected a safe integer/,
    ],
    [
      'empty strings',
      (fixture) => (fixture.manifest.pack.packVersion = ''),
      /expected a non-empty string/,
    ],
    [
      'empty declared packs',
      (fixture) => (fixture.manifest.pack.byteLength = 0),
      /must be between 1 and maximum/,
    ],
    [
      'overlong pack paths',
      (fixture) =>
        (fixture.manifest.pack.path = `packs/${'a'.repeat(225)}.pack.json`),
      /immutable relative path/,
    ],
    [
      'pack paths at the length limit that name another version',
      (fixture) =>
        (fixture.manifest.pack.path = `packs/${'a'.repeat(224)}.pack.json`),
      /must identify pack version/,
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
    [
      'signatures with non-zero padding bits',
      (fixture) => {
        const value = fixture.manifest.signature.value;
        fixture.manifest.signature.value =
          value.slice(0, -3) + nextBase64Digit(value.at(-3)) + '==';
      },
      /signature\.value: expected canonical base64/,
    ],
    [
      'signatures of the wrong length',
      (fixture) => (fixture.manifest.signature.value = 'AAAA'),
      /expected 64 decoded bytes/,
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
  it('rejects a small-order key that would verify any pack', () => {
    // The identity point with a zero scalar satisfies the cofactored
    // ZIP-215 equation for every message; strict verification refuses it.
    const identityPoint = Buffer.alloc(32);
    identityPoint[0] = 1;
    const fixture = signedFixture();
    fixture.manifest.signature.value = Buffer.concat([
      identityPoint,
      Buffer.alloc(32),
    ]).toString('base64');

    assert.throws(
      () =>
        verifySignedTimeZoneDataPackBytes(
          activateSignedTimeZoneDataPackManifest(fixture.manifest),
          fixture.bytes,
          { 'test-only-2026-a': identityPoint.toString('base64') },
        ),
      /signature mismatch/,
    );
  });

  for (const [name, encode, expected] of [
    [
      'with non-zero padding bits',
      (key) => key.slice(0, -2) + nextBase64Digit(key.at(-2)) + '=',
      /trustedKeys\.test-only-2026-a: expected canonical base64/,
    ],
    [
      'of the wrong length',
      (key) => Buffer.from(key, 'base64').subarray(1).toString('base64'),
      /expected 32 decoded bytes/,
    ],
  ]) {
    it(`rejects trusted keys ${name}`, () => {
      const fixture = signedFixture();

      assert.throws(
        () =>
          verifySignedTimeZoneDataPackBytes(
            activateSignedTimeZoneDataPackManifest(fixture.manifest),
            fixture.bytes,
            { 'test-only-2026-a': encode(rawPublicKey(testOnlyPrivateKey)) },
          ),
        expected,
      );
    });
  }
});

describe('signed Time-Zone Data Pack UTF-8 decoding', () => {
  const quoted = (sequence) => Uint8Array.from([0x22, ...sequence, 0x22]);
  const manifestProblem = (bytes) => {
    try {
      activateSignedTimeZoneDataPackManifestBytes(bytes);
      return 'accepted';
    } catch (error) {
      return error.message.replace(/^.*: /, '');
    }
  };
  // Node's fatal WHATWG decoder rejects every ill-formed UTF-8 sequence, so
  // it is the reference for what the portable decoder must reject.
  const reference = new TextDecoder('utf-8', { fatal: true });
  const referenceProblem = (bytes) => {
    try {
      JSON.parse(reference.decode(bytes));
      return 'expected an object';
    } catch {
      return 'expected UTF-8 JSON';
    }
  };

  it('decodes every sequence width up to the highest code point', () => {
    const friendlyLabel = `${String.fromCodePoint(
      0x7f,
      0x80,
      0x7ff,
      0x800,
      0xd7ff,
      0xe000,
      0xffff,
      0x10000,
      0x10ffff,
    )} Sydney ${'é€😀'.repeat(2_000)}`;
    const fixture = signedFixture(
      testOnlyPrivateKey,
      'test-only-2026-a',
      packBytes({
        ...validPack,
        zones: [{ ...validPack.zones[0], friendlyLabel }],
      }),
    );

    const pack = verifySignedTimeZoneDataPackBytes(
      activateSignedTimeZoneDataPackManifest(fixture.manifest),
      fixture.bytes,
      { 'test-only-2026-a': rawPublicKey(testOnlyPrivateKey) },
    );

    assert.equal(pack.zones[0].friendlyLabel, friendlyLabel);
  });

  for (const [name, sequences] of [
    ['lone continuation bytes', [[0x80], [0xbf]]],
    [
      'overlong encodings',
      [
        [0xc0, 0xaf],
        [0xc1, 0xbf],
        [0xe0, 0x80, 0xaf],
        [0xe0, 0x9f, 0xbf],
        [0xf0, 0x80, 0x80, 0xaf],
        [0xf0, 0x8f, 0xbf, 0xbf],
      ],
    ],
    [
      'surrogate code points',
      [
        [0xed, 0xa0, 0x80],
        [0xed, 0xbf, 0xbf],
      ],
    ],
    [
      'code points above U+10FFFF',
      [[0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xff]],
    ],
    ['truncated sequences', [[0xc3], [0xe2, 0x82], [0xf0, 0x9f, 0x98]]],
    [
      'invalid continuation bytes',
      [
        [0xc3, 0x41],
        [0xe2, 0x41, 0xac],
        [0xe2, 0x82, 0x41],
        [0xf0, 0x41, 0x98, 0x80],
        [0xf0, 0x9f, 0x41, 0x80],
        [0xf0, 0x9f, 0x98, 0x41],
      ],
    ],
  ]) {
    it(`rejects ${name}`, () => {
      for (const sequence of sequences) {
        const bytes = quoted(sequence);
        assert.equal(referenceProblem(bytes), 'expected UTF-8 JSON');
        assert.equal(manifestProblem(bytes), 'expected UTF-8 JSON');
      }
    });
  }

  it('accepts and rejects the same sequences as a fatal UTF-8 decoder', () => {
    const continuations = [
      0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xff,
    ];
    const tails = [0x41, 0x80, 0xbf];
    const mismatches = [];
    for (let lead = 0; lead <= 0xff; lead += 1) {
      // Test one byte past the longest sequence a lead byte can start (one
      // byte below 0xC0, two below 0xE0); longer cases repeat shorter ones.
      const maxLength = lead < 0xc0 ? 2 : lead < 0xe0 ? 3 : 4;
      const sequences = [[lead]];
      for (const second of continuations) {
        sequences.push([lead, second]);
        for (const third of maxLength > 2 ? tails : []) {
          sequences.push([lead, second, third]);
          for (const fourth of maxLength > 3 ? tails : []) {
            sequences.push([lead, second, third, fourth]);
          }
        }
      }
      for (const sequence of sequences) {
        const bytes = quoted(sequence);
        if (manifestProblem(bytes) !== referenceProblem(bytes)) {
          mismatches.push(sequence.map((byte) => byte.toString(16)).join(' '));
        }
      }
    }

    assert.deepEqual(mismatches, []);
  });

  it('rejects signed pack bytes that are not UTF-8', () => {
    const fixture = signedFixture(
      testOnlyPrivateKey,
      'test-only-2026-a',
      quoted([0xed, 0xa0, 0x80]),
    );

    assert.throws(
      () =>
        verifySignedTimeZoneDataPackBytes(
          activateSignedTimeZoneDataPackManifest(fixture.manifest),
          fixture.bytes,
          { 'test-only-2026-a': rawPublicKey(testOnlyPrivateKey) },
        ),
      /at \$pack: expected UTF-8 JSON/,
    );
  });
});
