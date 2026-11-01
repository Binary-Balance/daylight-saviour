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

import { decodeCanonicalBase64 } from './time-zone-data-remote-configuration.cjs';
export { parseTimeZoneDataPackRemoteConfig } from './time-zone-data-remote-configuration.cjs';

const foregroundCheckIntervalMs = 24 * 60 * 60 * 1_000;
const maximumManifestBytes = 64 * 1024;
// Covers a whole check: both requests and their bodies. Packs are tens of
// kilobytes, so this is generous on a slow mobile network.
const refreshTimeoutMs = 30_000;

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
  readonly body: ReadableStream<Uint8Array> | null;
  readonly headers: { readonly get: (name: string) => string | null };
  readonly status: number;
}

interface TimeZoneDataPackManagerOptions {
  readonly bundledPack: unknown;
  readonly now?: () => Date;
  readonly remoteConfig: TimeZoneDataPackRemoteConfig | null;
  readonly request?: (
    url: string,
    init: {
      readonly headers: Readonly<Record<string, string>>;
      readonly signal: AbortSignal;
    },
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

// Content-Length can be missing or wrong, so the body itself is counted and
// cancelled as soon as it crosses the maximum. A response with no stream
// cannot be bounded before its bytes are in memory, so it fails closed
// instead of falling back to arrayBuffer().
async function responseBytes(response: HttpResponse, maximum: number) {
  contentLength(response, maximum);
  if (response.body === null) {
    throw new Error('Response body cannot be read as a stream');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new TimeZoneDataPackTransportError();
      }
      if (chunk.done) break;
      // A chunk that is not bytes cannot be counted, so it is rejected too.
      if (
        !(chunk.value instanceof Uint8Array) ||
        total + chunk.value.byteLength > maximum
      ) {
        await reader.cancel();
        throw new Error('Response exceeds maximum byte length');
      }
      total += chunk.value.byteLength;
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Ends the wait at the deadline even when the network implementation ignores
// the abort and never settles. A listener added after the abort never fires,
// so between starting the timer and each call, run only synchronous code or
// an earlier beforeDeadline wait.
function beforeDeadline<T>(signal: AbortSignal, work: Promise<T>) {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) =>
      signal.addEventListener('abort', () =>
        reject(new TimeZoneDataPackTransportError()),
      ),
    ),
  ]);
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
  const request = options.request ?? ((url, init) => fetch(url, init));
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

  // A request that fails before it returns a response, including by running
  // past the deadline, is a transport loss.
  async function fetchResponse(
    url: string,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ) {
    try {
      return await beforeDeadline(signal, request(url, { headers, signal }));
    } catch {
      throw new TimeZoneDataPackTransportError();
    }
  }

  async function downloadPack(
    manifestUrl: string,
    manifest: ActivatedSignedTimeZoneDataPackManifest,
    signal: AbortSignal,
  ) {
    const packUrl = new URL(manifest.pack.path, manifestUrl);
    if (packUrl.origin !== new URL(manifestUrl).origin) {
      throw new Error('Pack URL must share manifest origin');
    }
    const response = await fetchResponse(
      packUrl.toString(),
      { Accept: 'application/json' },
      signal,
    );
    if (response.status !== 200) {
      throw new Error(`Pack request returned ${response.status}`);
    }
    return beforeDeadline(
      signal,
      responseBytes(response, manifest.pack.byteLength),
    );
  }

  // The manifest names nothing newer than the active pack, so only the check
  // is recorded.
  async function keepActivePack(next: PersistedState, checkedAt: Date) {
    await savePersisted(next);
    update({
      ...snapshot,
      freshness: expired(snapshot.pack, checkedAt) ? 'expired' : 'current',
      lastCheckedAt: next.lastCheckedAt,
      lastError: null,
    });
  }

  async function refreshFromRemote(
    config: TimeZoneDataPackRemoteConfig,
    checkedAt: Date,
    signal: AbortSignal,
  ) {
    const checkedAtIso = checkedAt.toISOString();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (persisted.etag !== null) headers['If-None-Match'] = persisted.etag;
    if (persisted.lastModified !== null) {
      headers['If-Modified-Since'] = persisted.lastModified;
    }
    const manifestResponse = await fetchResponse(
      config.manifestUrl,
      headers,
      signal,
    );
    if (manifestResponse.status === 304) {
      if (persisted.etag === null && persisted.lastModified === null) {
        throw new Error('Unexpected 304 without a conditional validator');
      }
      await keepActivePack(
        { ...persisted, lastCheckedAt: checkedAtIso },
        checkedAt,
      );
      return;
    }
    if (manifestResponse.status !== 200) {
      throw new Error(`Manifest request returned ${manifestResponse.status}`);
    }

    const manifestBytes = await beforeDeadline(
      signal,
      responseBytes(manifestResponse, maximumManifestBytes),
    );
    const manifest = activateSignedTimeZoneDataPackManifestBytes(manifestBytes);
    const checked: PersistedState = {
      ...persisted,
      etag: manifestResponse.headers.get('etag') ?? persisted.etag,
      lastCheckedAt: checkedAtIso,
      lastModified:
        manifestResponse.headers.get('last-modified') ?? persisted.lastModified,
      manifestPackVersion: manifest.pack.packVersion,
    };
    if (manifest.pack.packVersion === snapshot.pack.packVersion) {
      await keepActivePack(checked, checkedAt);
      return;
    }

    const packBytes = await downloadPack(config.manifestUrl, manifest, signal);
    // Digest, signature, key trust and schema, then Australian Coverage, then
    // the downgrade check. Nothing is saved or activated until all pass.
    const verified = verifySignedTimeZoneDataPackBytes(
      manifest,
      packBytes,
      config.trustedKeys,
    );
    const candidate = activateAustralianTimeZoneDataPack(verified);
    if (!isNewerPack(candidate, snapshot.pack)) {
      throw new Error('Remote pack is not newer than active pack');
    }

    // Saving comes first, so a pack that cannot be cached is never activated.
    await savePersisted({
      ...checked,
      artifact: { manifest, packBase64: encodeBase64(packBytes) },
    });
    update({
      freshness: expired(candidate, checkedAt) ? 'expired' : 'current',
      lastCheckedAt: checkedAtIso,
      lastError: null,
      pack: candidate,
      remoteEnabled: true,
      source: 'remote',
    });
  }

  async function recordFailure(
    error: unknown,
    trigger: TimeZoneDataPackRefreshTrigger,
    checkedAt: Date,
  ) {
    const checkedAtIso = checkedAt.toISOString();
    try {
      await savePersisted({ ...persisted, lastCheckedAt: checkedAtIso });
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
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), refreshTimeoutMs);
    try {
      await refreshFromRemote(options.remoteConfig, checkedAt, deadline.signal);
    } catch (error) {
      await recordFailure(error, trigger, checkedAt);
    } finally {
      clearTimeout(timer);
      // Expo buffers an unread body in native memory, and on iOS cancelling a
      // body stream does not stop the transfer. Aborting ends any request the
      // check left open, such as one rejected on its headers. It runs after
      // the outcome is decided, so it cannot turn an oversize body into a lost
      // connection.
      deadline.abort();
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
            const bytes = decodeCanonicalBase64(
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
