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
- `@daylight-saviour/copy` exposes one immutable `australianEnglish` catalogue,
  which mobile aliases as `copy`; semantic user-concept paths are stable message
  identifiers, constants own static messages, and typed functions return
  complete plain strings for structured facts.
- The copy package may type-import canonical domain or contract types but has no
  React, React Native, Expo, Azure, storage, network, runtime AI, mutable locale,
  generic dispatcher, or localization-framework dependency.
- Domain and contract modules retain Friendly Zone Labels, Daylight Saving
  Status values, IANA identifiers, pack versions, calculations, and persistence
  values. View models supply structured facts and typed failure states; raw
  exception text is diagnostic-only and never rendered.
- Formatting functions receive explicit Australian-English civil-time inputs,
  including Home Time Zone context and device 12/24-hour preference where
  relevant. Accessibility wording has separate stable paths when playful copy
  would obscure an operable fact.
- Known errors use exhaustive reviewed mappings and unknown runtime values use a
  reviewed safe fallback. Copy tests own exact prose, interpolation,
  pluralisation, formatting edges, selection determinism, eligibility, counts,
  and repetition rules; screen tests own behaviour, roles, actions, layout, and
  critical facts.
- Deterministic secondary copy uses a local opaque seed plus Home Time Zone day,
  zone, status, phase, and Change Event inputs. The seed is not derived from a
  device identifier, transmitted, logged, or exposed in diagnostics; an
  in-memory session fallback preserves factual UI if local persistence fails.
- Notification templates enter this catalogue only when corresponding
  notification journeys exist and can be reviewed end to end.
