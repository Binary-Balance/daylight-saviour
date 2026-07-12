---
status: accepted
---

# Make civil-time correctness a release gate

Daylight Saviour will use one shared deterministic conformance suite to verify Time-Zone Data Pack generation, mobile presentation, and reminder scheduling. An unexplained civil-time difference blocks both application releases and production data promotion.

## Consequences

- Fixtures cover every zone in Australian Coverage, including external territories and regional exceptions.
- Tests evaluate instants immediately before, at, and after each Change Event across the pack horizon.
- Explicit cases cover Lord Howe's non-hour offset change, observing and non-observing regions, ambiguous repeated wall times, skipped wall times, and packs reaching their validity horizon.
- App and notification service consume shared contracts and must produce identical Daylight Saving Status, next Change Event, direction, offset delta, and local presentation inputs for each fixture.
- Generator output is deterministic: identical source version, schema, horizon, and configuration produce byte-identical unsigned content.
- Candidate review shows semantic transition differences rather than opaque binary or JSON changes.
- Expected fixture changes require reviewed evidence tied to the relevant IANA release; snapshots are never refreshed merely to make CI pass.
