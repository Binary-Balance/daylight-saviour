---
status: accepted
---

# Distribute time-zone data independently of app releases

Daylight Saviour will derive transition data from IANA tzdb and distribute a compact, signed Time-Zone Data Pack independently of executable application releases. A scheduled GitHub Action will detect IANA updates, generate and validate supported-zone data, then publish it to Azure static storage. The app will bundle a known-good pack, periodically fetch newer packs, verify their signature and schema, activate them atomically, and preserve the last known-good version on failure.

## Consequences

- Daylight-saving rule changes do not require App Store or Google Play releases.
- Generated data must identify its tzdb version, schema version, generation time, and validity horizon.
- Validation must cover Australian observing and non-observing zones, non-hour transitions such as Lord Howe Island, and unchanged-zone regressions.
- Local reminders must be rescheduled after an active pack changes.
- Offline or long-inactive devices may retain stale data; notification design must account for that limitation.
- Failed downloads never replace a known-good pack, and expired data must produce an explicit degraded state rather than treating absence of a known transition as proof that none exists.
- Notification dispatch must not schedule beyond the active pack's declared validity horizon.
- The app checks the signed manifest on cold launch and on foreground resume when its previous check is at least 24 hours old; freshness details also expose manual retry.
- Manifest requests use HTTP validators, and immutable versioned packs download only after a newer valid manifest is observed.
- Mobile background execution is not required for correctness. The remote reminder service updates independently, and foreground refresh keeps visible app data current when the user returns.
- Validity expiry means the current instant has passed the pack's declared coverage horizon; it is distinct from an old last-check timestamp or knowledge that a newer pack exists.
- After validity expiry, the app retains zone selection, reminder configuration, pack metadata, and recovery controls but suppresses its clock, status, offset, event, and countdown claims until valid data is restored.
