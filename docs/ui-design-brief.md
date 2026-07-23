# Daylight Saviour UI Design Brief

_Status: accepted MVP design direction._

## Design Proposition

Daylight Saviour should feel like civil-time paperwork designed by someone with excellent taste and limited patience for clock interference. One glance answers: does daylight saving apply, what happens next, and will reminders arrive? Facts dominate; humour follows. Bureaucratic cues provide hierarchy without implying government affiliation.

## Screen Composition

Use one safe-area-aware column on an 8-point grid with roughly 20–24 logical pixels of horizontal margin.

1. **Utility header:** small `DAYLIGHT SAVIOUR` document label, subtle rule/reference mark, and accessible settings control.
2. **Home Time Zone:** full-width control showing friendly geography first and IANA identifier as metadata.
3. **Status hero:** large Home Time Zone clock without seconds, literal Daylight Saving Status, restrained fictional stamp, then one humorous line.
4. **Change Event section:** unambiguous date, local-time transformation, direction word and arrow, UTC offset equation, explicit offset amount, countdown, and Home Time Zone qualifier.
5. **Change Reminders:** compact state card showing both timing preferences or contextual opt-in action.
6. **Freshness footer:** plain verified/checking/stale state opening pack details and manual retry.

No-event zones receive an intentional Change Event record stating that no event is scheduled within current verified data. Never show an empty countdown. Expired data replaces affected claims with a prominent refresh-required state rather than claiming no event exists.

Reminder controls remain available in no-event zones. Explain: “No change scheduled. Keep reminders on and we’ll warn you if that changes.” Enabled subscriptions remain visibly dormant rather than appearing broken or pending.

## First Launch & Settings

Use one focused Home Time Zone confirmation screen, not a carousel. Show suggested friendly zone, current local time, subdued IANA identifier, and “No location permission needed.” If device zone is outside Australian Coverage, open chooser without guessing a nearby Australian zone.

Settings remains a compact pushed screen or native sheet: Home Time Zone, Change Reminders, data freshness, diagnostic summary, help/privacy/reporting/source, version, and acknowledgements. Zone selection uses a searchable full-screen list grouped by friendly geography, with regional exceptions and external territories explicit. Each row presents a reviewed label such as “Sydney, Canberra & most of NSW” before its canonical IANA identifier. Device aliases normalize to canonical zones; rows never group solely by current UTC offset.

## Visual System

Use native system sans-serif typography: San Francisco on iOS, Roboto on Android, and system fallbacks for Expo web tests. Personality comes from scale, tabular figures, rules, labels, spacing, and motion—not fragile font loading.

- Clock: responsive 72–104, heavy, tabular figures.
- Status: 30–42, bold; uppercase only when short.
- Event date: 26–34, semibold.
- Section heading: 18–22.
- Body: 17 minimum.
- Metadata: 12–14 tracked capitals; remove tracking at large text sizes.

Candidate colour tokens, subject to on-device contrast validation:

| Role | Light | Dark |
| --- | --- | --- |
| Background | Civic White `#F7F8FA` | Midnight navy `#081426` |
| Surface | White record `#FFFFFF` | Navy `#101F35` |
| Primary ink | `#101B2D` | `#F6F0DE` |
| Secondary ink | `#5B6678` | `#B6C0CF` |
| Rules and neutral controls | `#AAB2BC` | `#405067` |
| Solar-gold text | `#A66F00` | Signal coral `#FF6A4D` |
| Solar-gold structure | `#C99A22` | `#405067` |
| Fictional phase stamp | Signal red `#E5482D` | Signal coral `#FF6A4D` |

In light appearance, Solar Gold guides the eye from active Time-Zone Data Pack provenance through the utility-header divider to the next Change Event's direction, top rule, and left rail. Signal red is reserved for fictional phase stamps so it remains recognisably stamped. Settings, Home Time Zone controls, and unrelated rules remain neutral. Colour never carries meaning alone: direction, pack provenance, and status remain textual. Preserve the existing dark palette and behaviour. Prefer rules and tonal surfaces over shadows; avoid beige, cream, manila, parchment, sepia, gradients, metallic effects, decorative sun motifs, and implied government affiliation.

## Semantic Motion

Motion occurs once when information enters or meaning changes; nothing loops.

- **Forward Change:** figures advance with 220–300 ms acceleration and one small grid skip.
- **Backward Change:** figures reverse with one fading echo suggesting repeated wall time.
- **Status change:** old status exits and replacement locks into its stamp position; factual content changes atomically.
- **Countdown:** changes only at displayed-unit boundaries through short crossfade or directional digit replacement.
- **No event:** composition settles once, then remains deliberately still.
- **Refresh:** last known-good content stays visible while a small freshness treatment updates.

Reduced motion uses instant replacement or a very short fade. Remove skips, reversal, echoes, rotation, parallax, and distortion while retaining direction words, arrows, offset equation, and explicit amount.

## Required States

Design and test:

- Home: initial, ready, refreshing-valid, offline-valid, refresh-required, recoverable error.
- Status: daylight saving, standard time, decision unavailable.
- Event: forward, backward, no upcoming event, validity expired.
- Reminder: untouched, explainer, permission request, both enabled, one enabled, disabled, OS-blocked, saving, registration failed.
- Freshness: current, checking, stale-valid, offline-valid, expired, retry failed.
- Notification tap: event upcoming, event passed, Home Time Zone changed since send.

Errors remain literal and preserve last known-good facts. Each offers one clear recovery action.

## Ethical Engagement

Treat the screen as a Civil Time Report whose hierarchy, copy, and one-shot motion change only when civil time meaningfully changes.

- **Ordinary:** more than 28 days before Change Event.
- **Approaching:** 28 days through 7 days before.
- **Reminder Week:** 7 days through 24 hours before.
- **Reminder Day:** final 24 hours.
- **Event instant:** facts replace atomically; play one semantic animation only if app is open.
- **Aftermath:** first opening within 48 hours briefly confirms what changed.
- **New Event:** normal report resumes after 48 hours.

No persistent “underway” phase exists because Change Event is instantaneous.

Ordinary secondary copy changes deterministically once per Home Time Zone day without unread markers, promises, or prompts to return. Home Time clock supplies quiet year-round utility, especially while travelling. Reminder taps open the matching event phase and immediately explain what changes, when, which interval disappears or repeats, remaining duration, and reminder state.

Post-MVP candidates are a compact event explainer, private calendar export, widgets, and local share cards. Exclude streaks, engagement notifications, fake urgency, looping attention motion, feeds, runtime AI, and information withholding.

## Reminder Consent

Use two stages. In-app sheet first explains both default timings, Home Time Zone behavior while travelling, best-effort delivery, minimal stored data, and lack of account. Only “Enable reminders” invokes OS permission. Result states never claim reminders are active until server registration succeeds. OS-blocked state links to system settings; registration failure offers retry. Disabling final timing confirms remote-data deletion; re-enabling creates fresh registration.

## Accessibility

Focus order follows zone, status, event, countdown, reminders, freshness, settings. Expose status and event as headings. Hide decorative rules, stamps, echoes, and duplicate digits from accessibility tree. Clock updates never create live-region chatter. Layouts stack at large text sizes and avoid fixed text heights. Direction, amount, reminder state, errors, and actions remain textual; humour never carries required meaning.

## Settled Design Decisions

- Countdown is calculated between UTC instants rather than local wall-clock fields. It shows the largest two useful units, so a removed or repeated hour remains mathematically visible.
- Zones without a scheduled Change Event may enable dormant reminders for future verified rule changes. Missed historical timings never generate catch-up pushes.
- After pack validity expiry, retain zone name, reminder configuration, pack details, and retry controls; suppress all potentially wrong civil-time facts and omit humour until recovery.
- Engagement follows genuine event phases. Ordinary humour changes once per Home Time Zone day; no habit mechanics or promotional notifications are used.
- Zone selection uses reviewed geographic labels as primary text, canonical IANA identifiers as secondary text, and separate mainland/state versus island/territory groups.
- Civil Time Report phases use fixed 28-day, 7-day, 24-hour, event-instant, and 48-hour boundaries; Change Event itself has no durable underway state.
