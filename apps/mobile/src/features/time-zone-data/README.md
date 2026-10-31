# Mobile Time-Zone Data Pack refresh

`createTimeZoneDataPackManager` is refresh/cache module interface. UI knows
only current snapshot and `initialize`, `refresh`, `subscribe`, and
`getSnapshot`; HTTP, AsyncStorage, signature checks, and activation ordering
stay behind that seam.

Startup order is bundled known-good pack, then newer verified cache, then newer
verified remote pack. Candidate persistence completes before in-memory
activation. Every failure keeps active pack. Cached bytes are reverified with
current build-configured trusted keys and Australian Coverage before restore.
Signed downgrades never activate.

Cold launch always checks configured manifest. Active foreground event checks
only when previous attempt is at least 24 hours old. Manual retry bypasses that
gate. Requests carry saved ETag and Last-Modified validators; 304 updates check
time without downloading immutable pack. Concurrent checks share one flight.
Each check has a 30-second deadline covering both requests and their bodies.
At the deadline it aborts the requests, stops waiting even if the network
ignores the abort, and fails as a transport loss. The flight is then released,
so a manual retry starts a new check, and a late response is ignored.

Snapshots distinguish checking, current, stale-valid, offline-valid,
retry-failed, and expired. Transport loss during automatic check yields
offline-valid; HTTP, validation, persistence, and manual failures yield
retry-failed. Validity Horizon expiry dominates and UI suppresses every
civil-time claim while retaining pack metadata and recovery control.

Response bodies are read as streams with a running byte count: 64 KiB for the
manifest, and for a pack the length its manifest declares, at most 2 MiB. The
reader cancels a body as soon as it crosses its limit, whatever `Content-Length`
says, so it keeps at most the limit and never parses or verifies an oversize
body. Bytes Expo has received but the reader has not yet counted can exceed the
limit briefly: native code queues them without a limit before the first read,
and a busy JavaScript thread widens that window later. The check then fails like
any other HTTP failure: the active pack stays and manual retry works. A response
with no stream body fails closed instead of falling back to `arrayBuffer`. When
a check ends it aborts any request still open, so a response rejected on its
headers stops downloading.

Production adapter uses Expo fetch, whose native and web responses expose a
stream body, and one atomic AsyncStorage cache record. Remote refresh enables
only when both public build variables parse successfully:

- `EXPO_PUBLIC_TIME_ZONE_DATA_MANIFEST_URL` — credential-free HTTPS manifest
  URL without query or fragment.
- `EXPO_PUBLIC_TIME_ZONE_DATA_TRUSTED_KEYS_JSON` — JSON object mapping stable
  key IDs to raw 32-byte Ed25519 public keys encoded as canonical base64.

Missing or invalid configuration disables network refresh and reports valid
bundled data as current. Actual endpoints and production keys are environment-owned
configuration and are never committed here. Root `.env.example` contains only
reserved-domain and deliberately unusable placeholders.
