import {
  activateSignedTimeZoneDataPackManifest,
  activateSignedTimeZoneDataPackManifestBytes,
  maximumTimeZoneDataPackBytes,
  verifySignedTimeZoneDataPackBytes,
  type ActivatedSignedTimeZoneDataPackManifest,
  type ActivatedTimeZoneDataPack,
  type TrustedTimeZoneDataPackKeyRing,
} from '@daylight-saviour/contracts';
import { activateAustralianTimeZoneDataPack } from '@daylight-saviour/domain';

const foregroundCheckIntervalMs = 24 * 60 * 60 * 1_000;
const maximumManifestBytes = 64 * 1024;

export type TimeZoneDataPackFreshness =
  | 'checking'
  | 'current'
  | 'stale-valid'
  | 'offline-valid'
  | 'retry-failed'
  | 'expired';

export type TimeZoneDataPackSource = 'bundled' | 'cached' | 'remote';
export type TimeZoneDataPackErrorCode = 'refresh-failed';
export type TimeZoneDataPackRefreshTrigger =
  | 'cold-launch'
  | 'foreground'
  | 'manual';

export interface TimeZoneDataPackSnapshot {
  readonly freshness: TimeZoneDataPackFreshness;
  readonly lastCheckedAt: string | null;
  readonly lastError: TimeZoneDataPackErrorCode | null;
  readonly pack: ActivatedTimeZoneDataPack;
  readonly remoteEnabled: boolean;
  readonly source: TimeZoneDataPackSource;
}

export interface TimeZoneDataPackStorage {
  readonly load: () => Promise<string | null>;
  readonly save: (value: string) => Promise<void>;
}

export interface TimeZoneDataPackRemoteConfig {
  readonly manifestUrl: string;
  readonly trustedKeys: TrustedTimeZoneDataPackKeyRing;
}

interface HttpResponse {
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
  readonly headers: { readonly get: (name: string) => string | null };
  readonly status: number;
}

interface TimeZoneDataPackManagerOptions {
  readonly bundledPack: unknown;
  readonly now?: () => Date;
  readonly remoteConfig: TimeZoneDataPackRemoteConfig | null;
  readonly request?: (
    url: string,
    init: { readonly headers: Readonly<Record<string, string>> },
  ) => Promise<HttpResponse>;
  readonly storage: TimeZoneDataPackStorage;
}

export interface TimeZoneDataPackManager {
  readonly getSnapshot: () => TimeZoneDataPackSnapshot;
  readonly initialize: () => Promise<void>;
  readonly refresh: (trigger: TimeZoneDataPackRefreshTrigger) => Promise<void>;
  readonly subscribe: (listener: () => void) => () => void;
}

interface CachedArtifact {
  readonly manifest: ActivatedSignedTimeZoneDataPackManifest;
  readonly packBase64: string;
}

interface PersistedState {
  readonly artifact: CachedArtifact | null;
  readonly cacheVersion: 1;
  readonly etag: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastModified: string | null;
  readonly manifestPackVersion: string | null;
}

class TimeZoneDataPackTransportError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown) {
  return value === null || typeof value === 'string';
}

function parsePersistedState(value: string | null): PersistedState | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      parsed.cacheVersion !== 1 ||
      !nullableString(parsed.etag) ||
      !nullableString(parsed.lastCheckedAt) ||
      !nullableString(parsed.lastModified) ||
      !nullableString(parsed.manifestPackVersion) ||
      (parsed.lastCheckedAt !== null &&
        new Date(parsed.lastCheckedAt).toISOString() !== parsed.lastCheckedAt)
    ) {
      return null;
    }
    let artifact: CachedArtifact | null = null;
    if (parsed.artifact !== null) {
      if (
        !isRecord(parsed.artifact) ||
        typeof parsed.artifact.packBase64 !== 'string'
      ) {
        return null;
      }
      artifact = {
        manifest: activateSignedTimeZoneDataPackManifest(
          parsed.artifact.manifest,
        ),
        packBase64: parsed.artifact.packBase64,
      };
    }
    return {
      artifact,
      cacheVersion: 1,
      etag: parsed.etag,
      lastCheckedAt: parsed.lastCheckedAt,
      lastModified: parsed.lastModified,
      manifestPackVersion: parsed.manifestPackVersion,
    } as PersistedState;
  } catch {
    return null;
  }
}

function packVersionParts(pack: ActivatedTimeZoneDataPack) {
  const source = /^(\d{4})([a-z])$/.exec(pack.source.version);
  if (source === null) {
    throw new Error('Time-Zone Data Pack version cannot be ordered');
  }
  return [Number(source[1]), source[2]!.charCodeAt(0)] as const;
}

function isNewerPack(
  candidate: ActivatedTimeZoneDataPack,
  active: ActivatedTimeZoneDataPack,
) {
  const candidateParts = packVersionParts(candidate);
  const activeParts = packVersionParts(active);
  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index]! !== activeParts[index]!) {
      return candidateParts[index]! > activeParts[index]!;
    }
  }
  const generatedDifference =
    Date.parse(candidate.generatedAt) - Date.parse(active.generatedAt);
  return generatedDifference > 0;
}

function contentLength(response: HttpResponse, maximum: number) {
  const header = response.headers.get('content-length');
  if (header === null) return;
  if (!/^\d+$/.test(header) || Number(header) > maximum) {
    throw new Error('Response exceeds maximum byte length');
  }
}

function encodeBase64(bytes: Uint8Array) {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const chunks: string[] = [];
  let chunk = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const value =
      (bytes[index]! << 16) |
      ((bytes[index + 1] ?? 0) << 8) |
      (bytes[index + 2] ?? 0);
    chunk += alphabet.charAt((value >>> 18) & 63);
    chunk += alphabet.charAt((value >>> 12) & 63);
    chunk += remaining > 1 ? alphabet.charAt((value >>> 6) & 63) : '=';
    chunk += remaining > 2 ? alphabet.charAt(value & 63) : '=';
    if (chunk.length >= 4_096) {
      chunks.push(chunk);
      chunk = '';
    }
  }
  chunks.push(chunk);
  return chunks.join('');
}

function decodeBase64(value: string, maximumBytes: number) {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return null;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedLength = (value.length / 4) * 3 - padding;
  if (decodedLength > maximumBytes) return null;
  if (
    (padding === 2 &&
      (base64Value(value.charAt(value.length - 3)) & 15) !== 0) ||
    (padding === 1 && (base64Value(value.charAt(value.length - 2)) & 3) !== 0)
  ) {
    return null;
  }
  const bytes = new Uint8Array(decodedLength);
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const first = base64Value(value.charAt(index));
    const second = base64Value(value.charAt(index + 1));
    const third =
      value.charAt(index + 2) === '='
        ? 0
        : base64Value(value.charAt(index + 2));
    const fourth =
      value.charAt(index + 3) === '='
        ? 0
        : base64Value(value.charAt(index + 3));
    const decoded = (first << 18) | (second << 12) | (third << 6) | fourth;
    if (outputIndex < decodedLength) bytes[outputIndex++] = decoded >>> 16;
    if (outputIndex < decodedLength) bytes[outputIndex++] = decoded >>> 8;
    if (outputIndex < decodedLength) bytes[outputIndex++] = decoded;
  }
  return bytes;
}

async function responseBytes(response: HttpResponse, maximum: number) {
  contentLength(response, maximum);
  let buffer: ArrayBuffer;
  try {
    buffer = await response.arrayBuffer();
  } catch {
    throw new TimeZoneDataPackTransportError();
  }
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength > maximum) {
    throw new Error('Response exceeds maximum byte length');
  }
  return bytes;
}

function expired(pack: ActivatedTimeZoneDataPack, now: Date) {
  return now.getTime() > Date.parse(pack.coverage.validUntil);
}

function baseFreshness(
  pack: ActivatedTimeZoneDataPack,
  now: Date,
  remoteEnabled: boolean,
  lastCheckedAt: string | null,
): TimeZoneDataPackFreshness {
  if (expired(pack, now)) return 'expired';
  if (!remoteEnabled) return 'current';
  if (lastCheckedAt === null) return 'stale-valid';
  return now.getTime() - Date.parse(lastCheckedAt) >= foregroundCheckIntervalMs
    ? 'stale-valid'
    : 'current';
}

export function createTimeZoneDataPackManager(
  options: TimeZoneDataPackManagerOptions,
): TimeZoneDataPackManager {
  const now = options.now ?? (() => new Date());
  const request =
    options.request ??
    ((url, init) => fetch(url, init) as unknown as Promise<HttpResponse>);
  const remoteEnabled = options.remoteConfig !== null;
  const bundledPack = activateAustralianTimeZoneDataPack(options.bundledPack);
  let snapshot: TimeZoneDataPackSnapshot = Object.freeze({
    freshness: baseFreshness(bundledPack, now(), remoteEnabled, null),
    lastCheckedAt: null,
    lastError: null,
    pack: bundledPack,
    remoteEnabled,
    source: 'bundled',
  });
  let persisted: PersistedState = {
    artifact: null,
    cacheVersion: 1,
    etag: null,
    lastCheckedAt: null,
    lastModified: null,
    manifestPackVersion: null,
  };
  let initializePromise: Promise<void> | null = null;
  let refreshPromise: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  function update(next: TimeZoneDataPackSnapshot) {
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  }

  async function savePersisted(next: PersistedState) {
    await options.storage.save(JSON.stringify(next));
    persisted = next;
  }

  async function doRefresh(trigger: TimeZoneDataPackRefreshTrigger) {
    const checkedAt = now();
    if (
      trigger === 'foreground' &&
      snapshot.lastCheckedAt !== null &&
      checkedAt.getTime() - Date.parse(snapshot.lastCheckedAt) <
        foregroundCheckIntervalMs
    ) {
      return;
    }
    if (options.remoteConfig === null) {
      update({
        ...snapshot,
        freshness: baseFreshness(
          snapshot.pack,
          checkedAt,
          false,
          snapshot.lastCheckedAt,
        ),
      });
      return;
    }

    update({ ...snapshot, freshness: 'checking', lastError: null });
    const checkedAtIso = checkedAt.toISOString();
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (persisted.etag !== null) headers['If-None-Match'] = persisted.etag;
      if (persisted.lastModified !== null) {
        headers['If-Modified-Since'] = persisted.lastModified;
      }
      let manifestResponse: HttpResponse;
      try {
        manifestResponse = await request(options.remoteConfig.manifestUrl, {
          headers,
        });
      } catch {
        throw new TimeZoneDataPackTransportError();
      }
      if (manifestResponse.status === 304) {
        if (persisted.etag === null && persisted.lastModified === null) {
          throw new Error('Unexpected 304 without a conditional validator');
        }
        const nextPersisted = { ...persisted, lastCheckedAt: checkedAtIso };
        await savePersisted(nextPersisted);
        update({
          ...snapshot,
          freshness: expired(snapshot.pack, checkedAt) ? 'expired' : 'current',
          lastCheckedAt: checkedAtIso,
          lastError: null,
        });
        return;
      }
      if (manifestResponse.status !== 200) {
        throw new Error(`Manifest request returned ${manifestResponse.status}`);
      }

      const manifestBytes = await responseBytes(
        manifestResponse,
        maximumManifestBytes,
      );
      const manifest =
        activateSignedTimeZoneDataPackManifestBytes(manifestBytes);
      const nextEtag = manifestResponse.headers.get('etag') ?? persisted.etag;
      const nextLastModified =
        manifestResponse.headers.get('last-modified') ?? persisted.lastModified;

      if (manifest.pack.packVersion === snapshot.pack.packVersion) {
        const nextPersisted = {
          ...persisted,
          etag: nextEtag,
          lastCheckedAt: checkedAtIso,
          lastModified: nextLastModified,
          manifestPackVersion: manifest.pack.packVersion,
        };
        await savePersisted(nextPersisted);
        update({
          ...snapshot,
          freshness: expired(snapshot.pack, checkedAt) ? 'expired' : 'current',
          lastCheckedAt: checkedAtIso,
          lastError: null,
        });
        return;
      }

      const packUrl = new URL(
        manifest.pack.path,
        options.remoteConfig.manifestUrl,
      );
      if (packUrl.origin !== new URL(options.remoteConfig.manifestUrl).origin) {
        throw new Error('Pack URL must share manifest origin');
      }
      let packResponse: HttpResponse;
      try {
        packResponse = await request(packUrl.toString(), {
          headers: { Accept: 'application/json' },
        });
      } catch {
        throw new TimeZoneDataPackTransportError();
      }
      if (packResponse.status !== 200) {
        throw new Error(`Pack request returned ${packResponse.status}`);
      }
      contentLength(packResponse, manifest.pack.byteLength);
      const packBytes = await responseBytes(
        packResponse,
        maximumTimeZoneDataPackBytes,
      );
      const verified = verifySignedTimeZoneDataPackBytes(
        manifest,
        packBytes,
        options.remoteConfig.trustedKeys,
      );
      const candidate = activateAustralianTimeZoneDataPack(verified);
      if (!isNewerPack(candidate, snapshot.pack)) {
        throw new Error('Remote pack is not newer than active pack');
      }

      const artifact = {
        manifest,
        packBase64: encodeBase64(packBytes),
      };
      const nextPersisted: PersistedState = {
        artifact,
        cacheVersion: 1,
        etag: nextEtag,
        lastCheckedAt: checkedAtIso,
        lastModified: nextLastModified,
        manifestPackVersion: manifest.pack.packVersion,
      };
      await savePersisted(nextPersisted);
      update({
        freshness: expired(candidate, checkedAt) ? 'expired' : 'current',
        lastCheckedAt: checkedAtIso,
        lastError: null,
        pack: candidate,
        remoteEnabled: true,
        source: 'remote',
      });
    } catch (error) {
      const nextPersisted = { ...persisted, lastCheckedAt: checkedAtIso };
      try {
        await savePersisted(nextPersisted);
      } catch {
        // Active pack remains in memory when noncritical check metadata fails.
      }
      update({
        ...snapshot,
        freshness: expired(snapshot.pack, checkedAt)
          ? 'expired'
          : trigger !== 'manual' &&
              error instanceof TimeZoneDataPackTransportError
            ? 'offline-valid'
            : 'retry-failed',
        lastCheckedAt: checkedAtIso,
        lastError: 'refresh-failed',
      });
    }
  }

  function refresh(trigger: TimeZoneDataPackRefreshTrigger) {
    if (refreshPromise !== null) return refreshPromise;
    refreshPromise = doRefresh(trigger).finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  function initialize() {
    if (initializePromise !== null) return initializePromise;
    initializePromise = (async () => {
      let loaded: PersistedState | null = null;
      try {
        loaded = parsePersistedState(await options.storage.load());
      } catch {
        loaded = null;
      }
      if (loaded !== null) {
        persisted = loaded;
        if (loaded.artifact !== null && options.remoteConfig !== null) {
          try {
            const bytes = decodeBase64(
              loaded.artifact.packBase64,
              maximumTimeZoneDataPackBytes,
            );
            if (bytes === null) {
              throw new Error('Cached pack bytes are invalid');
            }
            const verified = verifySignedTimeZoneDataPackBytes(
              loaded.artifact.manifest,
              bytes,
              options.remoteConfig.trustedKeys,
            );
            const cached = activateAustralianTimeZoneDataPack(verified);
            if (isNewerPack(cached, snapshot.pack)) {
              update({
                freshness: baseFreshness(
                  cached,
                  now(),
                  remoteEnabled,
                  loaded.lastCheckedAt,
                ),
                lastCheckedAt: loaded.lastCheckedAt,
                lastError: null,
                pack: cached,
                remoteEnabled,
                source: 'cached',
              });
            }
          } catch {
            persisted = {
              artifact: null,
              cacheVersion: 1,
              etag: null,
              lastCheckedAt: null,
              lastModified: null,
              manifestPackVersion: null,
            };
          }
        }
      }
      await refresh('cold-launch');
    })();
    return initializePromise;
  }

  return {
    getSnapshot: () => snapshot,
    initialize,
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function base64Value(character: string) {
  const code = character.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return character === '+' ? 62 : 63;
}

function isCanonicalRawPublicKey(value: unknown): value is string {
  return (
    typeof value === 'string' && decodeBase64(value, 32)?.byteLength === 32
  );
}

export function parseTimeZoneDataPackRemoteConfig({
  manifestUrl,
  trustedKeysJson,
}: {
  readonly manifestUrl: string | undefined;
  readonly trustedKeysJson: string | undefined;
}): TimeZoneDataPackRemoteConfig | null {
  if (manifestUrl === undefined || trustedKeysJson === undefined) return null;
  try {
    const url = new URL(manifestUrl);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null;
    }
    const parsed: unknown = JSON.parse(trustedKeysJson);
    if (!isRecord(parsed)) return null;
    const entries = Object.entries(parsed);
    if (
      entries.length === 0 ||
      entries.some(
        ([keyId, publicKey]) =>
          !/^[A-Za-z0-9._-]{1,100}$/.test(keyId) ||
          !isCanonicalRawPublicKey(publicKey),
      )
    ) {
      return null;
    }
    return {
      manifestUrl: url.toString(),
      trustedKeys: Object.freeze(Object.fromEntries(entries)) as Readonly<
        Record<string, string>
      >,
    };
  } catch {
    return null;
  }
}
