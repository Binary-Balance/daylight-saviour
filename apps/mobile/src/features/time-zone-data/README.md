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

Snapshots distinguish checking, current, stale-valid, offline-valid,
retry-failed, and expired. Transport loss during automatic check yields
offline-valid; HTTP, validation, persistence, and manual failures yield
retry-failed. Validity Horizon expiry dominates and UI suppresses every
civil-time claim while retaining pack metadata and recovery control.

Production adapter uses Expo fetch for binary response bytes and one atomic
AsyncStorage cache record. Remote refresh enables only when both public build
variables parse successfully:

- `EXPO_PUBLIC_TIME_ZONE_DATA_MANIFEST_URL` — credential-free HTTPS manifest
  URL without query or fragment.
- `EXPO_PUBLIC_TIME_ZONE_DATA_TRUSTED_KEYS_JSON` — JSON object mapping stable
  key IDs to raw 32-byte Ed25519 public keys encoded as canonical base64.

Missing or invalid configuration disables network refresh and reports valid
bundled data as current. Actual endpoints and production keys are environment-owned
configuration and are never committed here. Root `.env.example` contains only
reserved-domain and deliberately unusable placeholders.
