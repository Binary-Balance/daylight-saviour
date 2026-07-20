# Copy

`@daylight-saviour/copy` is the dependency-light, reviewed Australian-English
catalogue for product interface text. It owns visible interface wording,
accessibility wording, validation and safe error messages, civil-time
presentation grammar, and deterministic secondary copy.

## Public API

The package exports one immutable value, `australianEnglish`. Mobile code
imports it as `copy`. Its stable semantic paths follow user concepts:

- `copy.homeTimeZone`
- `copy.livingDossier`
- `copy.dataFreshness`
- `copy.settings`

Static messages are constants. Dynamic messages are typed functions accepting
structured facts and returning one complete plain string. There is no mutable
locale, generic message dispatcher, runtime localization framework, AI, network,
storage, React, React Native, Expo, or Azure dependency. Notification copy will
be added only with implemented notification journeys.

## Ownership boundaries

The canonical domain and contract packages continue to own Friendly Zone
Labels, Daylight Saving Status values, Change Direction, IANA identifiers, pack
versions, transition calculations, persistence values, and typed failure
reasons. View models pass those structured facts into copy functions; they do
not assemble translated sentence fragments.

Formatting is explicitly Australian English. Civil-time functions receive a
Home Time Zone context and explicit device 12/24-hour preference. They never
read ambient machine locale or time zone. Accessibility paths remain literal
and separate from playful secondary prose when their wording differs.

Known error codes have exhaustive reviewed mappings. Unknown runtime values use
a reviewed safe fallback. Raw exception messages remain diagnostic-only and are
never passed to a rendered copy function.

## Deterministic secondary copy

Secondary selection receives an opaque installation seed, Home Time Zone local
date, canonical zone ID, Daylight Saving Status, Living Dossier phase, and
optional Change Event identity. Ordinary and no-event pools contain at least 30
broad-status variants plus eligible regional supplements. Cycling by Home Time
Zone date guarantees no repetition during 30 consecutive ordinary days while
the eligible pool is unchanged. Event variants are eligible by proximity and
direction and remain stable for an event phase.

Mobile generates and stores the opaque seed locally. It is not derived from a
device or account identifier, transmitted, logged, or included in diagnostics.
If persistence fails, one opaque in-memory seed remains stable for the app
session; copy variety never blocks saved Home Time Zone data or factual output.

## Tests

Package tests own exact wording, interpolation, Australian-English date/time
formatting, pluralisation, punctuation, error fallbacks, catalogue counts,
regional and proximity eligibility, deterministic selection, and the 30-day
repetition rule. Screen tests retain responsibility for roles, actions, layout,
critical facts, and integration with the catalogue without becoming prose
snapshots.
