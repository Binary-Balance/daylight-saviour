---
status: accepted
---

# Launch in Australian English with localization boundaries

MVP will ship in Australian English only. All interface strings, accessibility text, notification templates, and playful copy catalogues will live outside components behind stable message identifiers, preserving a clean path to later localization without expanding launch scope.

## Consequences

- Copy uses Australian spelling and editorial conventions.
- Dates use explicit day-month order and unambiguous month names where practical.
- Times respect the device's 12-hour or 24-hour preference while remaining anchored to the Home Time Zone.
- UI copy never constructs sentences by concatenating translated fragments; messages accept typed values for dates, offsets, directions, and zone names.
- IANA identifiers, UTC instants, offset arithmetic, persistence, and service contracts remain locale-independent.
- Adding another language later requires complete reviewed interface and notification catalogues rather than partial machine translation.
