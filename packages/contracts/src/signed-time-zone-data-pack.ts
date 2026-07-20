import * as ed25519 from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';

import type { ActivatedTimeZoneDataPack } from './index.ts';
import {
  timeZoneDataPackSchemaVersion,
  type TimeZoneDataPackSchemaVersion,
} from './time-zone-data-pack-version.ts';

export const signedTimeZoneDataPackManifestVersion = 1 as const;
export const maximumTimeZoneDataPackBytes = 2 * 1024 * 1024;

export type TrustedTimeZoneDataPackKeyRing = Readonly<Record<string, string>>;

export interface ActivatedSignedTimeZoneDataPackManifest {
  readonly manifestVersion: typeof signedTimeZoneDataPackManifestVersion;
  readonly pack: {
    readonly byteLength: number;
    readonly packVersion: string;
    readonly path: string;
    readonly schemaVersion: TimeZoneDataPackSchemaVersion;
    readonly sha256: string;
  };
  readonly signature: {
    readonly algorithm: 'Ed25519';
    readonly keyId: string;
    readonly value: string;
  };
}

export class SignedTimeZoneDataPackValidationError extends Error {
  constructor(path: string, problem: string) {
    super(`Invalid signed Time-Zone Data Pack at ${path}: ${problem}`);
    this.name = 'SignedTimeZoneDataPackValidationError';
  }
}

type JsonObject = Record<string, unknown>;
const activatedManifests = new WeakSet<object>();

function fail(path: string, problem: string): never {
  throw new SignedTimeZoneDataPackValidationError(path, problem);
}

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(path, 'expected an object');
  }
  return value as JsonObject;
}

function exactKeys(object: JsonObject, path: string, expected: string[]) {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(path, `expected keys ${wanted.join(', ')}`);
  }
}

function nonEmptyStringAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    return fail(path, 'expected a non-empty string');
  }
  return value;
}

function safeIntegerAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return fail(path, 'expected a safe integer');
  }
  return value;
}

function canonicalBase64BytesAt(
  value: unknown,
  path: string,
  expectedLength: number,
): Uint8Array {
  const encoded = nonEmptyStringAt(value, path);
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    return fail(path, 'expected canonical base64');
  }

  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const decodedLength = (encoded.length / 4) * 3 - padding;
  if (decodedLength !== expectedLength) {
    return fail(path, `expected ${expectedLength} decoded bytes`);
  }

  const valueOf = (character: string) => {
    const code = character.charCodeAt(0);
    if (code >= 65 && code <= 90) return code - 65;
    if (code >= 97 && code <= 122) return code - 71;
    if (code >= 48 && code <= 57) return code + 4;
    return character === '+' ? 62 : 63;
  };
  if (
    (padding === 2 &&
      (valueOf(encoded.charAt(encoded.length - 3)) & 15) !== 0) ||
    (padding === 1 && (valueOf(encoded.charAt(encoded.length - 2)) & 3) !== 0)
  ) {
    return fail(path, 'expected canonical base64');
  }

  const bytes = new Uint8Array(decodedLength);
  let outputIndex = 0;
  for (let index = 0; index < encoded.length; index += 4) {
    const first = valueOf(encoded.charAt(index));
    const second = valueOf(encoded.charAt(index + 1));
    const third =
      encoded.charAt(index + 2) === '='
        ? 0
        : valueOf(encoded.charAt(index + 2));
    const fourth =
      encoded.charAt(index + 3) === '='
        ? 0
        : valueOf(encoded.charAt(index + 3));
    const value = (first << 18) | (second << 12) | (third << 6) | fourth;
    if (outputIndex < decodedLength) bytes[outputIndex++] = value >>> 16;
    if (outputIndex < decodedLength) bytes[outputIndex++] = value >>> 8;
    if (outputIndex < decodedLength) bytes[outputIndex++] = value;
  }
  return bytes;
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function strictUtf8(bytes: Uint8Array, path: string) {
  const chunks: string[] = [];
  let chunk = '';
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index]!;
    let codePoint: number;
    let width: number;
    if (first <= 0x7f) {
      codePoint = first;
      width = 1;
    } else if (first >= 0xc2 && first <= 0xdf) {
      const second = bytes[index + 1];
      if (second === undefined || (second & 0xc0) !== 0x80) {
        return fail(path, 'expected UTF-8 JSON');
      }
      codePoint = ((first & 0x1f) << 6) | (second & 0x3f);
      width = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      if (
        second === undefined ||
        third === undefined ||
        (second & 0xc0) !== 0x80 ||
        (third & 0xc0) !== 0x80 ||
        (first === 0xe0 && second < 0xa0) ||
        (first === 0xed && second >= 0xa0)
      ) {
        return fail(path, 'expected UTF-8 JSON');
      }
      codePoint =
        ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
      width = 3;
    } else if (first >= 0xf0 && first <= 0xf4) {
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      const fourth = bytes[index + 3];
      if (
        second === undefined ||
        third === undefined ||
        fourth === undefined ||
        (second & 0xc0) !== 0x80 ||
        (third & 0xc0) !== 0x80 ||
        (fourth & 0xc0) !== 0x80 ||
        (first === 0xf0 && second < 0x90) ||
        (first === 0xf4 && second >= 0x90)
      ) {
        return fail(path, 'expected UTF-8 JSON');
      }
      codePoint =
        ((first & 0x07) << 18) |
        ((second & 0x3f) << 12) |
        ((third & 0x3f) << 6) |
        (fourth & 0x3f);
      width = 4;
    } else {
      return fail(path, 'expected UTF-8 JSON');
    }
    chunk += String.fromCodePoint(codePoint);
    if (chunk.length >= 4_096) {
      chunks.push(chunk);
      chunk = '';
    }
    index += width;
  }
  chunks.push(chunk);
  return chunks.join('');
}

export function activateSignedTimeZoneDataPackManifestBytes(
  bytes: Uint8Array,
): ActivatedSignedTimeZoneDataPackManifest {
  try {
    return activateSignedTimeZoneDataPackManifest(
      JSON.parse(strictUtf8(bytes, '$')),
    );
  } catch (error) {
    if (error instanceof SignedTimeZoneDataPackValidationError) throw error;
    return fail('$', 'expected UTF-8 JSON');
  }
}

export function activateSignedTimeZoneDataPackManifest(
  value: unknown,
): ActivatedSignedTimeZoneDataPackManifest {
  const manifest = objectAt(value, '$');
  exactKeys(manifest, '$', ['manifestVersion', 'pack', 'signature']);

  const manifestVersion = safeIntegerAt(
    manifest.manifestVersion,
    '$.manifestVersion',
  );
  if (manifestVersion !== signedTimeZoneDataPackManifestVersion) {
    fail('$.manifestVersion', `unsupported version ${manifestVersion}`);
  }

  const pack = objectAt(manifest.pack, '$.pack');
  exactKeys(pack, '$.pack', [
    'byteLength',
    'packVersion',
    'path',
    'schemaVersion',
    'sha256',
  ]);
  const byteLength = safeIntegerAt(pack.byteLength, '$.pack.byteLength');
  if (byteLength < 1 || byteLength > maximumTimeZoneDataPackBytes) {
    fail(
      '$.pack.byteLength',
      `must be between 1 and maximum ${maximumTimeZoneDataPackBytes}`,
    );
  }
  const packVersion = nonEmptyStringAt(pack.packVersion, '$.pack.packVersion');
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(packVersion)) {
    fail('$.pack.packVersion', 'expected a portable version identifier');
  }
  const path = nonEmptyStringAt(pack.path, '$.pack.path');
  if (path.length > 240 || !/^packs\/[A-Za-z0-9._-]+\.pack\.json$/.test(path)) {
    fail('$.pack.path', 'expected an immutable relative path under packs/');
  }
  if (path !== `packs/${packVersion}.pack.json`) {
    fail('$.pack.path', 'path must identify pack version');
  }
  const schemaVersion = safeIntegerAt(
    pack.schemaVersion,
    '$.pack.schemaVersion',
  );
  if (schemaVersion !== timeZoneDataPackSchemaVersion) {
    fail('$.pack.schemaVersion', `unsupported version ${schemaVersion}`);
  }
  const digest = nonEmptyStringAt(pack.sha256, '$.pack.sha256');
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    fail('$.pack.sha256', 'expected a lowercase SHA-256 digest');
  }

  const signature = objectAt(manifest.signature, '$.signature');
  exactKeys(signature, '$.signature', ['algorithm', 'keyId', 'value']);
  const algorithm = nonEmptyStringAt(
    signature.algorithm,
    '$.signature.algorithm',
  );
  if (algorithm !== 'Ed25519') {
    fail('$.signature.algorithm', 'unsupported algorithm');
  }
  const keyId = nonEmptyStringAt(signature.keyId, '$.signature.keyId');
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(keyId)) {
    fail('$.signature.keyId', 'expected a portable key identifier');
  }
  const signatureValue = nonEmptyStringAt(signature.value, '$.signature.value');
  canonicalBase64BytesAt(signatureValue, '$.signature.value', 64);

  const activated = Object.freeze({
    manifestVersion,
    pack: Object.freeze({
      byteLength,
      packVersion,
      path,
      schemaVersion,
      sha256: digest,
    }),
    signature: Object.freeze({
      algorithm,
      keyId,
      value: signatureValue,
    }),
  });
  activatedManifests.add(activated);
  return activated;
}

export function verifySignedTimeZoneDataPackBytes(
  manifest: ActivatedSignedTimeZoneDataPackManifest,
  bytes: Uint8Array,
  trustedKeys: TrustedTimeZoneDataPackKeyRing,
  activate: (value: unknown) => ActivatedTimeZoneDataPack,
): ActivatedTimeZoneDataPack {
  if (!activatedManifests.has(manifest)) {
    fail('$', 'manifest must be activated before verification');
  }
  if (bytes.byteLength !== manifest.pack.byteLength) {
    fail('$pack', 'byte length mismatch');
  }
  if (hex(sha256(bytes)) !== manifest.pack.sha256) {
    fail('$pack', 'SHA-256 mismatch');
  }

  const encodedPublicKey = trustedKeys[manifest.signature.keyId];
  if (encodedPublicKey === undefined) {
    fail('$.signature.keyId', 'unknown trusted key');
  }
  const publicKey = canonicalBase64BytesAt(
    encodedPublicKey,
    `$trustedKeys.${manifest.signature.keyId}`,
    32,
  );
  const signature = canonicalBase64BytesAt(
    manifest.signature.value,
    '$.signature.value',
    64,
  );

  ed25519.hashes.sha512 = sha512;
  let verified = false;
  try {
    verified = ed25519.verify(signature, bytes, publicKey, { zip215: false });
  } catch {
    verified = false;
  }
  if (!verified) {
    fail('$pack', 'Ed25519 signature mismatch');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(strictUtf8(bytes, '$pack'));
  } catch {
    return fail('$pack', 'expected UTF-8 JSON');
  }
  const activated = activate(parsed);
  if (activated.packVersion !== manifest.pack.packVersion) {
    fail('$.pack.packVersion', 'does not match signed pack');
  }
  if (activated.schemaVersion !== manifest.pack.schemaVersion) {
    fail('$.pack.schemaVersion', 'does not match signed pack');
  }
  return activated;
}
