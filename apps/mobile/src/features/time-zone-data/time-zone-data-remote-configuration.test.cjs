const assert = require('node:assert/strict');
const test = require('node:test');

const {
  decodeCanonicalBase64,
  parseTimeZoneDataPackRemoteConfig,
} = require('./time-zone-data-remote-configuration.cjs');

const manifestUrl =
  'https://time-zone-data.example.invalid/time-zone/manifest.json';
const trustedKeysJson =
  '{"synthetic-key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}';

test('decodes canonical base64 within its byte limit', () => {
  assert.deepEqual(decodeCanonicalBase64('AA==', 1), new Uint8Array([0]));
});

for (const [value, maximumBytes, description] of [
  ['AB==', 1, 'noncanonical padding bits'],
  ['not-base64', 32, 'malformed alphabet or length'],
  ['AAAA', 2, 'decoded value over byte limit'],
]) {
  test(`rejects base64 with ${description}`, () => {
    assert.equal(decodeCanonicalBase64(value, maximumBytes), null);
  });
}

test('parses HTTPS manifest and canonical Ed25519 key ring', () => {
  const parsed = parseTimeZoneDataPackRemoteConfig({
    manifestUrl,
    trustedKeysJson,
  });

  assert.deepEqual(parsed, {
    manifestUrl,
    trustedKeys: {
      'synthetic-key': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    },
  });
  assert.equal(Object.isFrozen(parsed.trustedKeys), true);
});

for (const [candidateManifestUrl, candidateKeys, description] of [
  [undefined, undefined, 'missing pair'],
  [manifestUrl, undefined, 'partial pair'],
  [
    'http://time-zone-data.example.invalid/manifest.json',
    trustedKeysJson,
    'non-HTTPS manifest',
  ],
  [
    'https://user@time-zone-data.example.invalid/manifest.json',
    trustedKeysJson,
    'credential-bearing manifest',
  ],
  [`${manifestUrl}?latest=1`, trustedKeysJson, 'manifest query'],
  [`${manifestUrl}#latest`, trustedKeysJson, 'manifest fragment'],
  [manifestUrl, '{bad', 'malformed JSON'],
  [manifestUrl, '[]', 'non-record key ring'],
  [manifestUrl, '{}', 'empty key ring'],
  [
    manifestUrl,
    '{"bad key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
    'invalid key ID',
  ],
  [manifestUrl, '{"synthetic-key":"not-a-public-key"}', 'invalid public key'],
]) {
  test(`rejects remote configuration with ${description}`, () => {
    assert.equal(
      parseTimeZoneDataPackRemoteConfig({
        manifestUrl: candidateManifestUrl,
        trustedKeysJson: candidateKeys,
      }),
      null,
    );
  });
}
